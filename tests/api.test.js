import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/database.js';
import { createApp } from '../server/index.js';

test('catalog, order validation, server pricing and persistence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bazzar-test-'));
  const filename = join(dir, 'test.sqlite');
  let db = openDatabase(filename);
  const server = createApp(db);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = body => fetch(`${base}/api/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const catalog = await (await fetch(`${base}/api/catalog`)).json();
    assert.equal(catalog.products.length, 42);
    assert.ok(catalog.markets.length > 0);
    assert.equal((await (await fetch(`${base}/api/products?q=notebook`)).json())[0].id, 'notebook');
    assert.deepEqual(await (await fetch(`${base}/api/products?q=unknown`)).json(), []);
    assert.equal((await fetch(`${base}/server/seed.json`)).status, 404);
    assert.equal((await fetch(`${base}/data/bazzar.sqlite`)).status, 404);
    const p = catalog.products[0];
    const input = { productId: p.id, offerId: p.sources[1].id, quantity: 2, includeVat: true, customerName: 'Test User', phone: '+998901234567', unitPrice: 1, total: 1 };
    const response = await post(input);
    assert.equal(response.status, 201);
    const order = await response.json();
    assert.equal(order.total, p.sources[1].price * 2 + Math.round(p.sources[1].price * 2 * 0.12) + 24000);
    assert.equal((await post({ ...input, quantity: -1 })).status, 400);
    assert.equal((await post({ ...input, quantity: 1.5 })).status, 400);
    assert.equal((await post({ ...input, phone: '-------' })).status, 400);
    assert.equal((await post({ ...input, productId: 'un' })).status, 404);
    assert.equal((await post(null)).status, 400);
    assert.equal((await fetch(`${base}/api/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
    assert.equal((await fetch(`${base}/api/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ huge: 'x'.repeat(9000) }) })).status, 413);
    assert.equal((await fetch(`${base}/api/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' }, body: JSON.stringify(input) })).status, 403);
    await new Promise(resolve => server.close(resolve));
    db.close();
    db = openDatabase(filename);
    assert.equal(db.prepare('SELECT total FROM orders WHERE id = ?').get(order.id).total, order.total);
    assert.equal(db.prepare('SELECT count(*) AS count FROM products').get().count, 42);
    assert.equal(db.prepare('SELECT count(*) AS count FROM orders').get().count, 1);
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
