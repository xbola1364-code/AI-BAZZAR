import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, getProducts, getCatalog } from '../server/database.js';
import { createSynchronizer, validateFeed, loadSyncConfig } from '../server/sync.js';
import { createEnricher } from '../server/ai.js';
import { createApp } from '../server/index.js';

const source = { id: 'supplier', platform: 'Actual Supplier', url: 'https://supplier.example/feed' };
const config = { sources: [source], intervalMs: 60000, staleMs: 7200000, requireAi: false, env: { OPENAI_MODEL: 'configured-model' } };
const item = { productId: 'dazmol', price: 280000, currency: 'UZS', available: true, description: '2000W iron', url: 'https://supplier.example/iron' };
const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

test('sync updates prices, caches AI, preserves offers on failure, handles sold out and return', async () => {
  const db = openDatabase(':memory:');
  let payload = { products: [item] };
  let calls = 0;
  let aiCalls = 0;
  const sync = createSynchronizer(db, config, {
    fetchImpl: async () => { calls++; return json(payload); },
    enrich: async input => { aiCalls++; assert.equal(typeof input.price, 'number'); return { summary: '2000W dazmol', approved: true, reason: '' }; }
  });
  try {
    assert.equal((await sync.runOnce()).status, 'ok');
    let p = getProducts(db)[0];
    assert.equal(p.unitPrice, 280000);
    assert.equal(p.demo, false);
    assert.equal(p.sources.length, 1); // No demo offers mixed into the live comparison.
    assert.equal(p.sources[0].desc, '2000W dazmol');
    assert.equal(p.sources[0].sourceUrl, item.url);
    assert.equal(p.stale, false);
    assert.equal(getCatalog(db).mixed, true);
    assert.equal(getCatalog(db).ticker[0].price, '280,000 UZS');
    const offerId = p.sources[0].id;
    payload = { products: [{ ...item, price: 270000 }] };
    await Promise.all([sync.runOnce(), sync.runOnce()]);
    assert.equal(calls, 2);
    assert.equal(aiCalls, 2);
    p = getProducts(db)[0];
    assert.equal(p.unitPrice, 270000);
    assert.deepEqual(p.chartData, [280000, 270000]);
    assert.equal(p.sources[0].id, offerId);
    payload = { products: [{ ...item, price: -10 }] };
    assert.equal((await sync.runOnce()).status, 'partial_error');
    assert.equal(getProducts(db)[0].unitPrice, 270000);
    assert.equal(sync.status().sources[0].lastRun.status, 'error');
    assert.ok(sync.status().sources[0].lastSuccess);
    payload = { products: [] };
    await sync.runOnce();
    assert.equal(getProducts(db)[0].available, false);
    assert.equal(getProducts(db)[0].demo, false);
    payload = { products: [item] };
    await sync.runOnce();
    assert.equal(getProducts(db)[0].sources[0].id, offerId);
    assert.equal(aiCalls, 3);
    db.prepare('UPDATE offers SET checked_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', offerId);
    assert.equal(getProducts(db)[0].stale, true);
  } finally { await sync.stop(); db.close(); }
});

test('invalid feed is rejected atomically, AI failure does not prevent authoritative price updates', async () => {
  const db = openDatabase(':memory:');
  const sync = createSynchronizer(db, config, { fetchImpl: async () => json({ products: [item] }), enrich: async () => { throw new Error('AI unavailable'); } });
  try {
    for (const value of [{ ...item, currency: 'USD' }, { ...item, productId: 'unknown' }, { ...item, url: 'javascript:alert(1)' }, { ...item, available: 'yes' }, { ...item, price: 1.5 }]) {
      assert.throws(() => validateFeed({ products: [value] }, db));
    }
    assert.throws(() => validateFeed({ products: [item, item] }, db));
    await sync.runOnce();
    assert.equal(getProducts(db)[0].unitPrice, item.price);
    assert.equal(getProducts(db)[0].sources[0].desc, item.description);
    assert.equal(sync.status().sources[0].lastRun.aiErrors, 1);
    assert.equal(db.prepare('SELECT ai_hash FROM offers WHERE source_id = ?').get(source.id).ai_hash, null);
  } finally { await sync.stop(); db.close(); }
});

test('database lease prevents overlapping workers and releases after completion', async () => {
  const db = openDatabase(':memory:');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const one = createSynchronizer(db, config, { fetchImpl: async () => { await gate; return json({ products: [item] }); }, enrich: null });
  const two = createSynchronizer(db, config, { fetchImpl: async () => { throw new Error('Must not fetch'); }, enrich: null });
  try {
    const first = one.runOnce();
    assert.equal((await two.runOnce()).status, 'busy');
    release();
    assert.equal((await first).status, 'ok');
    assert.equal(db.prepare('SELECT count(*) AS count FROM sync_lock').get().count, 0);
  } finally { release(); await one.stop(); await two.stop(); db.close(); }
});

test('AI uses Responses structured output and rejects refusals/incomplete output', async () => {
  let answer = { status: 'completed', output: [{ content: [{ type: 'output_text', text: '{"summary":"2000W dazmol","approved":true,"reason":""}' }] }] };
  const enrich = createEnricher({ apiKey: 'test-only', model: 'configured-model', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const body = JSON.parse(options.body);
    assert.equal(body.store, false);
    assert.equal(body.text.format.strict, true);
    assert.equal(body.model, 'configured-model');
    assert.equal(options.redirect, 'error');
    return json(answer);
  } });
  assert.equal((await enrich({ name: 'Iron', description: '2000W' })).summary, '2000W dazmol');
  answer = { status: 'incomplete' };
  await assert.rejects(enrich({ name: 'Iron', description: '2000W' }));
  answer = { status: 'completed', output: [{ content: [{ type: 'refusal' }] }] };
  await assert.rejects(enrich({ name: 'Iron', description: '2000W' }));
  assert.equal(createEnricher({ model: 'configured-model' }), null);
  assert.equal(loadSyncConfig({}).sources.length, 0);
  assert.equal(loadSyncConfig({}).intervalMs, 3600000);
  assert.equal(loadSyncConfig({}).requireAi, true);
  assert.throws(() => loadSyncConfig({ SYNC_INTERVAL_MINUTES: 'NaN' }));
});

test('bank transfer ranks before cheaper cash/card offers and moves product to top', async () => {
  const db = openDatabase(':memory:');
  const cashSource = { ...source, id: 'cash-seller', platform: 'Cash Seller' };
  const transferSource = { ...source, id: 'transfer-seller', platform: 'Transfer Seller' };
  const feed = { products: [{ ...item, productId: 'notebook', price: 1000000, paymentMethods: ['cash', 'card'] }] };
  const cash = createSynchronizer(db, { ...config, sources: [cashSource], requireAi: true }, { fetchImpl: async () => json(feed), enrich: async () => ({ approved: true, summary: 'Tovar', reason: '' }) });
  const transfer = createSynchronizer(db, { ...config, sources: [transferSource], requireAi: true }, { fetchImpl: async () => json({ products: [{ ...feed.products[0], price: 1500000, paymentMethods: ['bank_transfer'] }] }), enrich: async () => ({ approved: true, summary: 'Tovar', reason: '' }) });
  try {
    await cash.runOnce();
    await transfer.runOnce();
    const products = getProducts(db);
    assert.equal(products[0].id, 'notebook');
    assert.equal(products[0].unitPrice, 1500000);
    assert.equal(products[0].sources[0].platform, 'Transfer Seller');
    assert.equal(products[0].sources[0].preferred, true);
    assert.equal(products[0].sources[0].best, false);
    assert.equal(products[0].sources[1].best, true);
    assert.equal(products[0].sources[1].bankTransfer, false);
    assert.equal(products[0].supplier, 'Transfer Seller');
    assert.equal(products[0].chartData.at(-1), 1500000);
    assert.equal(products[1].bankTransfer, false); // Demo/unknown payment is never inferred.
  } finally { await cash.stop(); await transfer.stop(); db.close(); }
});

test('required AI review gates changed prices/payment; failure preserves checked_at', async () => {
  const db = openDatabase(':memory:');
  let record = { ...item, paymentMethods: ['cash'] };
  let decision = { approved: true, summary: 'Dazmol', reason: '' };
  let aiCalls = 0;
  const sync = createSynchronizer(db, { ...config, requireAi: true }, {
    fetchImpl: async () => json({ products: [record] }),
    enrich: async () => { aiCalls++; if (decision instanceof Error) throw decision; return decision; }
  });
  try {
    await sync.runOnce();
    const original = getProducts(db)[0].sources[0];
    await sync.runOnce();
    assert.equal(aiCalls, 1); // Same feed rechecked; its identical AI review is reused.
    record = { ...record, price: 450000, paymentMethods: ['bank_transfer'] };
    decision = { approved: false, summary: '', reason: 'Contradiction' };
    const before = getProducts(db)[0].sources[0].checkedAt;
    assert.equal((await sync.runOnce()).results[0].status, 'pending_review');
    assert.equal(getProducts(db)[0].unitPrice, original.price);
    assert.equal(getProducts(db)[0].bankTransfer, false);
    assert.equal(getProducts(db)[0].sources[0].checkedAt, before);
    decision = new Error('Provider timeout');
    await sync.runOnce();
    assert.equal(getProducts(db)[0].sources[0].checkedAt, before);
    decision = { approved: true, summary: 'Dazmol', reason: '' };
    await sync.runOnce();
    assert.equal(getProducts(db)[0].unitPrice, 450000);
    assert.equal(getProducts(db)[0].bankTransfer, true);
    assert.equal(getProducts(db)[0].sources[0].id, original.id);
    assert.equal(aiCalls, 4);
    const disabled = createSynchronizer(db, { ...config, requireAi: true }, { fetchImpl: async () => { throw new Error('Must not fetch'); }, enrich: null });
    assert.equal((await disabled.runOnce()).status, 'ai_not_configured');
    assert.equal(disabled.status().state, 'ai_not_configured');
    await disabled.stop();
  } finally { await sync.stop(); db.close(); }
});

test('orders reject stale and unavailable source offers; status excludes credentials', async () => {
  const db = openDatabase(':memory:');
  const sync = createSynchronizer(db, config, { fetchImpl: async () => json({ products: [item] }), enrich: null });
  await sync.runOnce();
  const server = createApp(db, { synchronizer: sync });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const offer = getProducts(db)[0].sources[0];
  const body = { productId: item.productId, offerId: offer.id, quantity: 2, includeVat: false, customerName: 'Test User', phone: '+998901234567' };
  const post = () => fetch(`${base}/api/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await post()).status, 201);
    db.prepare('UPDATE offers SET available = 0 WHERE id = ?').run(offer.id);
    assert.equal((await post()).status, 409);
    db.prepare('UPDATE offers SET available = 1, checked_at = ? WHERE id = ?').run('2020-01-01T00:00:00Z', offer.id);
    assert.equal((await post()).status, 409);
    const status = await (await fetch(`${base}/api/sync/status`)).json();
    assert.equal(status.configured, true);
    assert.equal(JSON.stringify(status).includes('supplier.example'), false);
    assert.equal((await fetch(`${base}/.env`)).status, 404);
    assert.equal((await fetch(`${base}/sources.local.json`)).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); await sync.stop(); db.close(); }
});
