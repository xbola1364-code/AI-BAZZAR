import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, getProducts } from '../server/database.js';
import { createDiscovery } from '../server/discovery.js';
import { createWebSearcher, validateSearchOffers } from '../server/web-search.js';
import { createApp } from '../server/index.js';

const config = { enabled: true, dailyLimit: 100, batchSize: 1, intervalMs: 3600000 };
const offer = { productName: 'Office Scanner Pro 300', category: 'elektronika', supplier: 'Real Store', price: 1200000, currency: 'UZS', priceType: 'wholesale', minQuantity: 2, available: true, unit: '1 dona', description: 'A4 skaner', paymentMethods: ['bank_transfer'], url: 'https://store.example/scanner', paymentEvidenceUrl: 'https://store.example/payment', priceEvidence: 'Price: 1,200,000 UZS', paymentEvidence: 'Payment by bank transfer' };
const report = `${offer.productName}. ${offer.priceEvidence}. ${offer.paymentEvidence}. In stock. ${offer.url} ${offer.paymentEvidenceUrl}`;
const sources = new Set([offer.url, offer.paymentEvidenceUrl]);

test('search extraction rejects uncited/fabricated prices and unsubstantiated bank transfer', () => {
  assert.equal(validateSearchOffers({ offers: [{ ...offer }] }, report, sources).length, 1);
  assert.equal(validateSearchOffers({ offers: [{ ...offer, price: 200000 }] }, report, sources).length, 0);
  assert.equal(validateSearchOffers({ offers: [{ ...offer, url: 'https://invented.example/item' }] }, report, sources).length, 0);
  assert.equal(validateSearchOffers({ offers: [{ ...offer, available: false }] }, report, sources).length, 0);
  assert.deepEqual(validateSearchOffers({ offers: [{ ...offer, paymentEvidence: 'Made up transfer' }] }, report, sources)[0].paymentMethods, []);
  assert.deepEqual(validateSearchOffers({ offers: [{ ...offer, paymentEvidenceUrl: 'https://other.example/payment' }] }, report, sources)[0].paymentMethods, []);
});

test('provider must actually search the web, then extract with structured output', async () => {
  const calls = [];
  const search = createWebSearcher({ apiKey: 'test-key', model: 'search-model', extractionModel: 'extract-model', fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify(calls.length === 1 ? {
      status: 'completed', output: [
        { type: 'web_search_call', action: { sources: [...sources].map(url => ({ url })) } },
        { type: 'message', content: [{ type: 'output_text', text: report }] }
      ]
    } : { status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ offers: [offer] }) }] }] }));
  } });
  assert.equal((await search('Office Scanner'))[0].price, offer.price);
  assert.equal(calls[0].tool_choice, 'required');
  assert.equal(calls[0].tools[0].external_web_access, true);
  assert.equal(calls[1].text.format.strict, true);
  assert.equal(calls[1].model, 'extract-model');
  const noWeb = createWebSearcher({ apiKey: 'test', model: 'test', fetchImpl: async () => new Response(JSON.stringify({ status: 'completed', output: [] })) });
  await assert.rejects(noWeb('scanner'), /not executed/);
});

test('missing product is discovered, persisted, deduplicated, cashless first; failed refresh retains timestamp', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bazzar-discovery-'));
  const filename = join(dir, 'catalog.sqlite');
  let db = openDatabase(filename);
  let calls = 0;
  let broken = false;
  const discovery = createDiscovery(db, config, { searcher: async () => {
    calls++;
    if (broken) throw new Error('Secret provider error must not leak');
    return [{ ...offer }, { ...offer, supplier: 'Cash Store', price: 900000, paymentMethods: ['cash'], url: 'https://cash.example/scanner', paymentEvidenceUrl: null }];
  } });
  try {
    const [a, b] = await Promise.all([discovery.search('office scanner'), discovery.search('office scanner')]);
    assert.equal(calls, 1);
    assert.equal(a.products[0].id, b.products[0].id);
    assert.equal(a.products[0].unitPrice, 1200000);
    assert.equal(a.products[0].sources[0].bankTransfer, true);
    const id = a.products[0].id;
    assert.equal(a.products[0].sources.length, 2);
    assert.equal((await discovery.search('office scanner')).source, 'local');
    assert.equal(calls, 1);
    await discovery.search('office scanner', { force: true });
    assert.equal(getProducts(db).filter(p => p.id === id).length, 1);
    assert.equal(getProducts(db).find(p => p.id === id).sources.length, 2);
    const checkedAt = getProducts(db).find(p => p.id === id).sources[0].checkedAt;
    broken = true;
    await assert.rejects(discovery.search('office scanner', { force: true }), error => error.status === 502 && !error.message.includes('Secret'));
    assert.equal(getProducts(db).find(p => p.id === id).sources[0].checkedAt, checkedAt);
    await discovery.stop();
    db.close();
    db = openDatabase(filename);
    assert.equal(getProducts(db).find(p => p.id === id).unitPrice, 1200000);
    assert.equal(db.prepare('SELECT count(*) AS n FROM products').get().n, 43);
  } finally { await discovery.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('negative cache, daily budget, disabled status and background durable rotation', async () => {
  const db = openDatabase(':memory:');
  let calls = 0;
  const discovery = createDiscovery(db, { ...config, dailyLimit: 2 }, { searcher: async () => { calls++; return []; } });
  try {
    assert.deepEqual((await discovery.search('unique absent item')).products, []);
    assert.equal((await discovery.search('unique absent item')).source, 'cache');
    assert.equal(calls, 1);
    await discovery.refresh();
    assert.equal(calls, 2);
    assert.ok(db.prepare('SELECT count(*) AS n FROM discovery_queries').get().n >= 43);
    await assert.rejects(discovery.search('another absent item'), error => error.status === 429);
    const disabled = createDiscovery(db, { ...config, enabled: false }, { searcher: null });
    assert.equal((await disabled.search('monitor')).source, 'local');
    await assert.rejects(disabled.search('missing random product'), error => error.status === 503);
    await disabled.stop();
  } finally { await discovery.stop(); db.close(); }
});

test('search HTTP API returns persisted results and validates requests; expanded categories are populated', async () => {
  const db = openDatabase(':memory:');
  const discovery = createDiscovery(db, config, { searcher: async () => [{ ...offer }] });
  const server = createApp(db, { discovery });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (query, headers = {}) => fetch(`${base}/api/search`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ query }) });
  try {
    const response = await post('office scanner');
    assert.equal(response.status, 200);
    assert.equal((await response.json()).source, 'internet');
    assert.equal((await post('x')).status, 400);
    assert.equal((await post('x'.repeat(161))).status, 400);
    assert.equal((await post('office scanner', { Origin: 'https://foreign.example' })).status, 403);
    assert.equal((await fetch(`${base}/assets/product-placeholder.svg`)).status, 200);
    const catalog = await (await fetch(`${base}/api/catalog`)).json();
    for (const category of ['maishiy', 'oziq-ovqat', 'qurilish', 'elektronika']) assert.ok(catalog.products.filter(p => p.category === category).length >= 9);
    assert.ok(catalog.products.some(p => p.name === offer.productName));
  } finally { await new Promise(resolve => server.close(resolve)); await discovery.stop(); db.close(); }
});
