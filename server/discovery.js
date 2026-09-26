import { createHash } from 'node:crypto';
import { getProducts } from './database.js';
import { createWebSearcher } from './web-search.js';

const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 24);
const fail = (status, message) => Object.assign(new Error(message), { status });
export const normalizeQuery = query => typeof query === 'string' ? query.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase() : '';

export function loadDiscoveryConfig(env = process.env) {
  const dailyLimit = Number(env.ONLINE_SEARCH_DAILY_LIMIT || 100);
  const batchSize = Number(env.ONLINE_SEARCH_BACKGROUND_BATCH || 10);
  if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 10000 || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new Error('Invalid discovery limits');
  return { enabled: env.ONLINE_SEARCH_ENABLED === 'true', dailyLimit, batchSize, intervalMs: 3600000,
    apiKey: env.OPENAI_API_KEY, model: env.OPENAI_SEARCH_MODEL || env.OPENAI_MODEL, extractionModel: env.OPENAI_MODEL };
}

export function createDiscovery(db, config, { searcher = createWebSearcher(config) } = {}) {
  const pending = new Map();
  let stopped = false;
  let timer;
  let background;
  const configured = config.enabled && Boolean(searcher);
  function matching(query) {
    const cached = db.prepare('SELECT product_ids FROM discovery_queries WHERE query = ?').get(query);
    const ids = cached ? JSON.parse(cached.product_ids) : [];
    return getProducts(db).filter(p => p.available && (ids.includes(p.id) || [p.name, ...p.keywords].some(s => normalizeQuery(s).includes(query))));
  }
  function persist(query, offers) {
    const ids = new Set();
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const o of offers) {
        const candidateId = `web-${hash(normalizeQuery(o.productName) + '|' + normalizeQuery(o.unit))}`;
        const existing = db.prepare('SELECT product_id, unit FROM offers WHERE source_url = ? LIMIT 1').get(o.url);
        const sameName = db.prepare('SELECT id, name FROM products').all().find(p => normalizeQuery(p.name) === normalizeQuery(o.productName) && (!p.id.startsWith('web-') || p.id === candidateId));
        const id = (existing && normalizeQuery(existing.unit) === normalizeQuery(o.unit) ? existing.product_id : null) || sameName?.id || candidateId;
        ids.add(id);
        db.prepare('INSERT OR IGNORE INTO products(id, category, name, image, supplier, keywords) VALUES (?, ?, ?, ?, ?, ?)').run(id, o.category, o.productName, '/assets/product-placeholder.svg', o.supplier, JSON.stringify([query, o.productName]));
        const keywords = JSON.parse(db.prepare('SELECT keywords FROM products WHERE id=?').get(id).keywords);
        if (!keywords.includes(query)) db.prepare('UPDATE products SET keywords=? WHERE id=?').run(JSON.stringify([...keywords.slice(0, 19), query]), id);
        db.prepare(`INSERT INTO offers(product_id, platform, price, description, rating, source_id, source_url, available, checked_at, ai_hash, payment_methods, bank_transfer, price_type, unit, min_quantity, payment_evidence_url)
          VALUES (?, ?, ?, ?, '—', ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(source_id, product_id) DO UPDATE SET platform=excluded.platform, price=excluded.price, description=excluded.description,
          available=1, checked_at=excluded.checked_at, ai_hash=excluded.ai_hash, payment_methods=excluded.payment_methods,
          bank_transfer=excluded.bank_transfer, price_type=excluded.price_type, unit=excluded.unit, min_quantity=excluded.min_quantity,
          payment_evidence_url=excluded.payment_evidence_url`).run(id, o.supplier, o.price, o.description, `web:${hash(o.url)}`, o.url, now, hash(JSON.stringify(o)), JSON.stringify(o.paymentMethods), Number(o.paymentMethods.includes('bank_transfer')), o.priceType, o.unit, o.minQuantity, o.paymentEvidenceUrl);
      }
      for (const id of ids) {
        const price = db.prepare('SELECT price FROM offers WHERE product_id = ? AND source_id IS NOT NULL AND available=1 ORDER BY bank_transfer DESC, price LIMIT 1').get(id).price;
        db.prepare('INSERT INTO live_price_history(product_id, price, checked_at) VALUES (?, ?, ?)').run(id, price, now);
        db.prepare('DELETE FROM live_price_history WHERE product_id=? AND id NOT IN (SELECT id FROM live_price_history WHERE product_id=? ORDER BY id DESC LIMIT 500)').run(id, id);
      }
      db.prepare('UPDATE discovery_queries SET product_ids=?, checked_at=?, status=?, error=NULL WHERE query=?').run(JSON.stringify([...ids]), now, ids.size ? 'ok' : 'empty', query);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return [...ids];
  }
  async function discover(query) {
    const now = Date.now();
    const day = new Date().toISOString().slice(0, 10);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT OR IGNORE INTO discovery_queries(query) VALUES (?)').run(query);
      const locked = db.prepare('UPDATE discovery_queries SET lease_until=?, attempted_at=? WHERE query=? AND lease_until < ?').run(now + 180000, new Date().toISOString(), query, now);
      if (!locked.changes) throw fail(409, 'Qidiruv davom etmoqda. Birozdan keyin qayta urinib ko‘ring.');
      db.prepare('INSERT OR IGNORE INTO discovery_budget(day,count) VALUES (?,0)').run(day);
      if (!db.prepare('UPDATE discovery_budget SET count=count+1 WHERE day=? AND count < ?').run(day, config.dailyLimit).changes) throw fail(429, 'Bugungi onlayn qidiruv limiti tugadi.');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    try {
      const offers = await searcher(query);
      const ids = persist(query, offers);
      return { products: getProducts(db).filter(p => ids.includes(p.id)), source: 'internet' };
    } catch {
      db.prepare("UPDATE discovery_queries SET status='error', error='Online search failed' WHERE query=?").run(query);
      throw fail(502, 'Internet qidiruvi bajarilmadi. Keyinroq qayta urinib ko‘ring.');
    } finally { db.prepare('UPDATE discovery_queries SET lease_until=0 WHERE query=?').run(query); }
  }
  async function search(rawQuery, { force = false } = {}) {
    const query = normalizeQuery(rawQuery);
    if (query.length < 2 || query.length > 160 || /[\u0000-\u001f]/.test(query)) throw fail(400, 'Qidiruv 2–160 belgidan iborat bo‘lishi kerak.');
    const local = matching(query);
    if (!force && local.length) return { products: local, source: 'local' };
    if (stopped || !configured) throw fail(503, 'Onlayn qidiruv ulanmagan. Serverda AI kaliti va qidiruv modelini sozlang.');
    const cached = db.prepare('SELECT * FROM discovery_queries WHERE query=?').get(query);
    if (!force && cached && Date.now() - Date.parse(cached.checked_at) < 3600000) return { products: local, source: 'cache' };
    if (pending.has(query)) return pending.get(query);
    if (cached?.status === 'error' && Date.now() - Date.parse(cached.attempted_at) < 60000) throw fail(503, 'Onlayn qidiruv vaqtincha ishlamayapti. Bir daqiqadan keyin qayta urining.');
    if (pending.size >= 2) throw fail(429, 'Qidiruv band. Birozdan keyin qayta urinib ko‘ring.');
    const task = discover(query).finally(() => pending.delete(query));
    pending.set(query, task);
    return task;
  }
  async function refresh() {
    if (!configured || stopped) return;
    // Add every catalog item to the durable rotation, as well as successful user searches.
    for (const p of db.prepare('SELECT name FROM products').all()) db.prepare('INSERT OR IGNORE INTO discovery_queries(query) VALUES (?)').run(normalizeQuery(p.name));
    const due = db.prepare('SELECT query FROM discovery_queries WHERE lease_until < ? AND (attempted_at IS NULL OR attempted_at < ?) ORDER BY attempted_at IS NOT NULL, attempted_at, query LIMIT ?').all(Date.now(), new Date(Date.now() - config.intervalMs).toISOString(), config.batchSize);
    for (const { query } of due) {
      if (stopped) break;
      try { await search(query, { force: true }); } catch (error) { if (error.status === 429) break; }
    }
  }
  async function tick() {
    const start = Date.now();
    background = refresh();
    try { await background; } catch { console.error('Background internet search failed.'); }
    if (!stopped) { timer = setTimeout(tick, Math.max(1000, config.intervalMs - (Date.now() - start))); timer.unref(); }
  }
  return {
    search, refresh,
    start() { if (configured) void tick(); },
    async stop() { stopped = true; clearTimeout(timer); await Promise.allSettled([...pending.values(), background]); },
    status() { return { configured, running: pending.size, intervalMinutes: config.intervalMs / 60000, backgroundBatch: config.batchSize, dailyLimit: config.dailyLimit,
      searchesToday: db.prepare('SELECT count FROM discovery_budget WHERE day=?').get(new Date().toISOString().slice(0, 10))?.count || 0,
      lastRun: db.prepare('SELECT status, checked_at AS checkedAt, attempted_at AS attemptedAt, error FROM discovery_queries WHERE attempted_at IS NOT NULL ORDER BY attempted_at DESC LIMIT 1').get() || null }; }
  };
}
