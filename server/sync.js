import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { createEnricher, readLimitedJson } from './ai.js';

export function loadSyncConfig(env = process.env) {
  const sources = env.PRODUCT_SOURCES_FILE ? JSON.parse(readFileSync(env.PRODUCT_SOURCES_FILE, 'utf8')) : [];
  if (!Array.isArray(sources) || sources.length > 10) throw new Error('Sources must be an array of at most 10 feeds');
  const ids = new Set();
  for (const s of sources) {
    if (!s || typeof s.id !== 'string' || !/^[a-z0-9_-]{1,60}$/.test(s.id) || ids.has(s.id) || typeof s.platform !== 'string' || s.platform.length < 1 || s.platform.length > 100) throw new Error('Invalid or duplicate source');
    ids.add(s.id);
    const url = new URL(s.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Feed URL must use HTTPS without credentials or fragment');
    if (s.tokenEnv && (!/^[A-Z][A-Z0-9_]*$/.test(s.tokenEnv) || !env[s.tokenEnv])) throw new Error(`Missing token for source ${s.id}`);
  }
  const intervalMs = Number(env.SYNC_INTERVAL_MINUTES || 60) * 60000;
  const staleMs = Number(env.SYNC_STALE_MINUTES || 120) * 60000;
  if (!Number.isFinite(intervalMs) || intervalMs < 60000 || intervalMs > 86400000) throw new Error('Sync interval must be 1–1440 minutes');
  if (!Number.isFinite(staleMs) || staleMs < intervalMs || staleMs > 604800000) throw new Error('Stale interval must be between sync interval and 7 days');
  return { sources, intervalMs, staleMs, requireAi: true, env };
}

export function validateFeed(payload, db) {
  if (!payload || !Array.isArray(payload.products) || payload.products.length > 500) throw new Error('Feed must contain products array (max 500)');
  const seen = new Set();
  for (const p of payload.products) {
    if (!p || typeof p.productId !== 'string' || seen.has(p.productId) || !db.prepare('SELECT 1 FROM products WHERE id = ?').get(p.productId)) throw new Error('Unknown or duplicate productId');
    seen.add(p.productId);
    if (p.currency !== 'UZS' || !Number.isSafeInteger(p.price) || p.price <= 0 || p.price > 1_000_000_000 || typeof p.available !== 'boolean') throw new Error('Invalid price, currency or availability');
    if (typeof p.description !== 'string' || p.description.length > 5000) throw new Error('Invalid description');
    if (p.paymentMethods !== undefined && (!Array.isArray(p.paymentMethods) || p.paymentMethods.length > 3 || p.paymentMethods.some(method => !['bank_transfer', 'cash', 'card'].includes(method)) || new Set(p.paymentMethods).size !== p.paymentMethods.length)) throw new Error('Invalid payment methods');
    const url = new URL(p.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Invalid product URL');
  }
  return payload.products;
}

export function createSynchronizer(db, config, { fetchImpl = fetch, enrich = createEnricher({ apiKey: config.env?.OPENAI_API_KEY, model: config.env?.OPENAI_MODEL, fetchImpl }) } = {}) {
  const requireAi = config.requireAi !== false;
  let pending = null;
  let stopped = false;
  let timer;
  const owner = randomUUID();
  async function sync() {
    if (!config.sources.length) return { status: 'not_configured' };
    if (requireAi && !enrich) return { status: 'ai_not_configured' };
    // A lease also protects against a second server process using this SQLite file.
    const now = Date.now();
    const lock = db.prepare(`INSERT INTO sync_lock(id, owner, expires_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
      WHERE sync_lock.expires_at < ?`).run(owner, now + 15 * 60000, now);
    if (!lock.changes) return { status: 'busy' };
    const results = [];
    try {
      for (const source of config.sources) {
        db.prepare('UPDATE sync_lock SET expires_at = ? WHERE id = 1 AND owner = ?').run(Date.now() + 15 * 60000, owner);
        const startedAt = new Date().toISOString();
        let aiErrors = 0;
        let pendingReviews = 0;
        try {
          const headers = { Accept: 'application/json' };
          if (source.tokenEnv) headers.Authorization = `Bearer ${config.env[source.tokenEnv]}`;
          const response = await fetchImpl(source.url, { headers, redirect: 'error', signal: AbortSignal.timeout(20000) });
          const items = validateFeed(await readLimitedJson(response), db);
          const prepared = [];
          for (const p of items) {
            db.prepare('UPDATE sync_lock SET expires_at = ? WHERE id = 1 AND owner = ?').run(Date.now() + 15 * 60000, owner);
            const paymentMethods = [...(p.paymentMethods || [])].sort();
            const hash = createHash('sha256').update(JSON.stringify([p.productId, p.description, p.price, p.currency, p.available, paymentMethods, p.url, config.env?.OPENAI_MODEL || '', 'review-v2'])).digest('hex');
            const cached = db.prepare('SELECT * FROM offers WHERE source_id = ? AND product_id = ?').get(source.id, p.productId);
            let summary = cached?.ai_hash === hash ? cached.ai_summary : '';
            let aiHash = cached?.ai_hash === hash ? hash : null;
            let approved = Boolean(aiHash);
            if (!aiHash && enrich) {
              try {
                const review = await enrich({ ...p, paymentMethods, name: db.prepare('SELECT name FROM products WHERE id = ?').get(p.productId).name });
                if (!review || typeof review.summary !== 'string' || review.summary.length > 300 || typeof review.approved !== 'boolean') throw new Error('Invalid AI review');
                approved = review.approved;
                summary = approved ? review.summary : '';
                if (approved) aiHash = hash;
                else aiErrors++;
              } catch { aiErrors++; summary = ''; }
            }
            if (requireAi && !approved) { pendingReviews++; continue; }
            prepared.push({ ...p, paymentMethods, summary, aiHash });
          }
          const checkedAt = new Date().toISOString();
          db.exec('BEGIN IMMEDIATE');
          try {
            const affected = new Set([...items.map(p => p.productId), ...db.prepare('SELECT product_id FROM offers WHERE source_id = ?').all(source.id).map(p => p.product_id)]);
            // A failed/rejected review preserves its previous record and timestamp.
            // Missing items in a full feed are delisted, without inventing a new offer.
            for (const previous of db.prepare('SELECT id, product_id FROM offers WHERE source_id = ?').all(source.id)) {
              if (!items.some(p => p.productId === previous.product_id)) db.prepare('UPDATE offers SET available = 0, checked_at = ? WHERE id = ?').run(checkedAt, previous.id);
            }
            for (const p of prepared) {
              db.prepare(`INSERT INTO offers(product_id, platform, price, description, rating, source_id, source_url, available, checked_at, ai_summary, ai_hash, payment_methods, bank_transfer)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(source_id, product_id) DO UPDATE SET platform = excluded.platform, price = excluded.price,
                description = excluded.description, source_url = excluded.source_url, available = excluded.available,
                checked_at = excluded.checked_at, ai_summary = excluded.ai_summary, ai_hash = excluded.ai_hash,
                payment_methods = excluded.payment_methods, bank_transfer = excluded.bank_transfer`).run(
                p.productId, source.platform, p.price, p.description, '—', source.id, p.url, Number(p.available), checkedAt, p.summary, p.aiHash, JSON.stringify(p.paymentMethods), Number(p.paymentMethods.includes('bank_transfer')));
            }
            for (const id of affected) {
              if (!prepared.some(p => p.productId === id)) continue;
              const price = db.prepare('SELECT price FROM offers WHERE product_id = ? AND source_id IS NOT NULL AND available = 1 ORDER BY bank_transfer DESC, price, id LIMIT 1').get(id)?.price;
              if (price !== undefined) db.prepare('INSERT INTO live_price_history(product_id, price, checked_at) VALUES (?, ?, ?)').run(id, price, checkedAt);
              db.prepare('DELETE FROM live_price_history WHERE product_id = ? AND id NOT IN (SELECT id FROM live_price_history WHERE product_id = ? ORDER BY id DESC LIMIT 500)').run(id, id);
            }
            db.prepare('INSERT INTO sync_runs(source_id, started_at, finished_at, status, item_count, ai_errors, pending_reviews) VALUES (?, ?, ?, ?, ?, ?, ?)').run(source.id, startedAt, checkedAt, pendingReviews ? 'pending_review' : 'ok', prepared.length, aiErrors, pendingReviews);
            db.exec('COMMIT');
          } catch (error) { db.exec('ROLLBACK'); throw error; }
          results.push({ sourceId: source.id, status: pendingReviews ? 'pending_review' : 'ok', count: prepared.length, aiErrors, pendingReviews });
        } catch (error) {
          // Never persist provider bodies, URLs or credentials in public status output.
          const reason = /^HTTP \d{3}$/.test(error.message) ? error.message : 'Fetch or validation failed';
          db.prepare('INSERT INTO sync_runs(source_id, started_at, finished_at, status, error) VALUES (?, ?, ?, ?, ?)').run(source.id, startedAt, new Date().toISOString(), 'error', reason);
          results.push({ sourceId: source.id, status: 'error', error: reason });
        }
      }
      db.prepare('DELETE FROM sync_runs WHERE id NOT IN (SELECT id FROM sync_runs ORDER BY id DESC LIMIT 500)').run();
      return { status: results.every(r => r.status === 'ok') ? 'ok' : 'partial_error', results };
    } finally { db.prepare('DELETE FROM sync_lock WHERE id = 1 AND owner = ?').run(owner); }
  }
  function runOnce() {
    if (stopped) return Promise.resolve({ status: 'stopped' });
    if (!pending) pending = sync().finally(() => { pending = null; });
    return pending;
  }
  async function tick() {
    const started = Date.now();
    try { await runOnce(); } catch { console.error('Product synchronization failed; will retry next interval.'); }
    if (!stopped) { timer = setTimeout(tick, Math.max(1000, config.intervalMs - (Date.now() - started))); timer.unref(); }
  }
  return {
    runOnce,
    start() { if (config.sources.length) void tick(); },
    async stop() { stopped = true; clearTimeout(timer); await pending; },
    status() {
      return { configured: config.sources.length > 0, aiConfigured: Boolean(enrich), aiRequired: requireAi, running: Boolean(pending), intervalMinutes: config.intervalMs / 60000,
        state: !config.sources.length ? 'not_configured' : requireAi && !enrich ? 'ai_not_configured' : 'ready',
        sources: config.sources.map(s => ({ id: s.id, lastRun: db.prepare('SELECT status, finished_at AS finishedAt, item_count AS itemCount, ai_errors AS aiErrors, pending_reviews AS pendingReviews, error FROM sync_runs WHERE source_id = ? ORDER BY id DESC LIMIT 1').get(s.id) || null,
          lastSuccess: db.prepare("SELECT finished_at FROM sync_runs WHERE source_id = ? AND status = 'ok' ORDER BY id DESC LIMIT 1").get(s.id)?.finished_at || null })) };
    }
  };
}
