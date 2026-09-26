import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { openDatabase, getCatalog } from '../server/database.js';

test('frontend loads stored B2B order, escapes supplier text, preserves data on outage', async () => {
  const db = openDatabase(':memory:');
  const data = getCatalog(db);
  db.close();
  const premium = data.products.find(p => p.id === 'notebook');
  premium.bankTransfer = true;
  premium.supplier = '<img src=x onerror=alert(1)>';
  premium.name = '<script>alert(1)</script>';
  data.products = [premium, ...data.products.filter(p => p.id !== premium.id)];
  const grid = { innerHTML: '' };
  let fail = false;
  const context = vm.createContext({
    document: { addEventListener() {}, getElementById() { return grid; } },
    location: { protocol: 'http:' }, AbortSignal,
    console: { warn() {} },
    fetch: async () => { if (fail) throw new Error('Offline'); return { ok: true, json: async () => data }; }
  });
  vm.runInContext(readFileSync(new URL('../js/app.js', import.meta.url), 'utf8'), context);
  await context.refreshCatalog(false);
  assert.equal(vm.runInContext('productsDatabase[0].id', context), 'notebook');
  context.renderHomeProducts('all');
  assert.ok(grid.innerHTML.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.equal(grid.innerHTML.includes('<img src=x onerror=alert(1)>'), false);
  assert.equal(grid.innerHTML.includes('<script>alert(1)</script>'), false);
  assert.ok(grid.innerHTML.includes("Bank o'tkazmasi"));
  assert.ok(grid.innerHTML.indexOf("selectProduct('notebook')") < grid.innerHTML.indexOf("selectProduct('dazmol')"));
  assert.doesNotThrow(() => context.highlightMatch('Test', '['));
  assert.equal(context.highlightMatch('<script>', 'none'), '&lt;script&gt;');
  fail = true;
  await context.refreshCatalog(false);
  assert.equal(vm.runInContext('productsDatabase[0].id', context), 'notebook');
});

test('frontend online search loads missing products and ignores obsolete query responses', async () => {
  const elements = new Map();
  const element = id => {
    if (id === 'catalogGrid') return null;
    if (!elements.has(id)) elements.set(id, { value: '', innerHTML: '', classList: { add() {}, remove() {}, contains() { return true; } } });
    return elements.get(id);
  };
  let resolveSearch;
  let opened;
  const product = { id: 'web-new', name: 'New Scanner', category: 'elektronika', keywords: ['new scanner'], bankTransfer: true, sources: [], available: true };
  const context = vm.createContext({
    document: { addEventListener() {}, getElementById: element }, location: { protocol: 'http:' },
    AbortSignal, AbortController, URL, clearTimeout, setTimeout, console: { warn() {} },
    fetch: async path => path === '/api/search' ? new Promise(resolve => { resolveSearch = resolve; }) : { ok: true, json: async () => ({ products: [product], markets: [], ticker: [] }) }
  });
  vm.runInContext(readFileSync(new URL('../js/app.js', import.meta.url), 'utf8'), context);
  context.renderHomeProducts = () => {};
  context.displayComparison = value => { opened = value; };
  element('searchInput').value = 'new scanner';
  const first = context.generateAIProductComparison('new scanner', true);
  resolveSearch({ ok: true, json: async () => ({ products: [product], source: 'internet' }) });
  await first;
  assert.equal(opened.id, 'web-new');
  assert.equal(vm.runInContext('productsDatabase[0].id', context), 'web-new');
  opened = undefined;
  const old = context.generateAIProductComparison('new scanner', true);
  element('searchInput').value = 'another query';
  resolveSearch({ ok: true, json: async () => ({ products: [product] }) });
  await old;
  assert.equal(opened, undefined);
  assert.equal(context.sourceLink('javascript:alert(1)', 'Source'), '');
  assert.ok(context.sourceLink('https://store.example/product', 'Source').includes('rel="noopener noreferrer"'));
});
