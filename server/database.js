import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { expandCatalog } from './catalog-seed.js';

export function openDatabase(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY, category TEXT NOT NULL, name TEXT NOT NULL,
      image TEXT NOT NULL, supplier TEXT NOT NULL, keywords TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS offers (
      id INTEGER PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
      platform TEXT NOT NULL, price INTEGER NOT NULL CHECK(price > 0),
      description TEXT NOT NULL, rating TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS price_history (
      product_id TEXT NOT NULL REFERENCES products(id), position INTEGER NOT NULL,
      price INTEGER NOT NULL, PRIMARY KEY(product_id, position)
    );
    CREATE TABLE IF NOT EXISTS markets (id INTEGER PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
      offer_id INTEGER NOT NULL REFERENCES offers(id), quantity INTEGER NOT NULL CHECK(quantity > 0),
      unit_price INTEGER NOT NULL, vat INTEGER NOT NULL, delivery INTEGER NOT NULL,
      total INTEGER NOT NULL, customer_name TEXT NOT NULL, phone TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, status TEXT NOT NULL DEFAULT 'new'
    );
    CREATE TABLE IF NOT EXISTS live_price_history (
      id INTEGER PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
      price INTEGER NOT NULL, checked_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_runs (
      id INTEGER PRIMARY KEY, source_id TEXT NOT NULL, started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL, status TEXT NOT NULL, item_count INTEGER DEFAULT 0,
      ai_errors INTEGER DEFAULT 0, error TEXT
    );
    CREATE TABLE IF NOT EXISTS sync_lock (id INTEGER PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS discovery_queries (
      query TEXT PRIMARY KEY, product_ids TEXT NOT NULL DEFAULT '[]', checked_at TEXT,
      attempted_at TEXT, status TEXT NOT NULL DEFAULT 'new', error TEXT,
      lease_until INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS discovery_budget (day TEXT PRIMARY KEY, count INTEGER NOT NULL);
  `);
  const columns = new Set(db.prepare('PRAGMA table_info(offers)').all().map(c => c.name));
  for (const [name, type] of Object.entries({ source_id: 'TEXT', source_url: 'TEXT', available: 'INTEGER NOT NULL DEFAULT 1', checked_at: 'TEXT', ai_summary: "TEXT NOT NULL DEFAULT ''", ai_hash: 'TEXT', payment_methods: "TEXT NOT NULL DEFAULT '[]'", bank_transfer: 'INTEGER NOT NULL DEFAULT 0' })) {
    if (!columns.has(name)) db.exec(`ALTER TABLE offers ADD COLUMN ${name} ${type}`);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS offers_source_product ON offers(source_id, product_id)');
  if (!db.prepare('PRAGMA table_info(sync_runs)').all().some(c => c.name === 'pending_reviews')) db.exec('ALTER TABLE sync_runs ADD COLUMN pending_reviews INTEGER NOT NULL DEFAULT 0');
  for (const [name, type] of Object.entries({ price_type: "TEXT NOT NULL DEFAULT 'unknown'", unit: "TEXT NOT NULL DEFAULT ''", min_quantity: 'INTEGER NOT NULL DEFAULT 1', payment_evidence_url: 'TEXT' })) {
    if (!columns.has(name)) db.exec(`ALTER TABLE offers ADD COLUMN ${name} ${type}`);
  }
  if (!db.prepare("SELECT 1 FROM metadata WHERE key = 'seed_version'").get()) {
    const seed = JSON.parse(readFileSync(new URL('./seed.json', import.meta.url), 'utf8'));
    db.exec('BEGIN');
    try {
      for (const p of seed.products) {
        db.prepare('INSERT INTO products VALUES (?, ?, ?, ?, ?, ?)').run(p.id, p.category, p.name, p.image, p.supplier, JSON.stringify(p.keywords));
        for (const s of p.sources) db.prepare('INSERT INTO offers (product_id, platform, price, description, rating) VALUES (?, ?, ?, ?, ?)').run(p.id, s.platform, s.price, s.desc, s.rating);
        p.chartData.forEach((price, i) => db.prepare('INSERT INTO price_history VALUES (?, ?, ?)').run(p.id, i, price));
      }
      for (const market of seed.markets) db.prepare('INSERT INTO markets(data) VALUES (?)').run(JSON.stringify(market));
      db.prepare('INSERT INTO metadata VALUES (?, ?)').run('ticker', JSON.stringify(seed.ticker));
      db.prepare('INSERT INTO metadata VALUES (?, ?)').run('seed_version', '1');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  }
  expandCatalog(db);
  return db;
}

export function getProducts(db, staleMs = 7200000) {
  return db.prepare('SELECT * FROM products ORDER BY rowid').all().map(p => {
    const all = db.prepare(`SELECT id, platform, price, CASE WHEN ai_summary != '' THEN ai_summary ELSE description END AS "desc", rating,
      source_id AS sourceId, source_url AS sourceUrl, available, checked_at AS checkedAt, ai_summary != '' AS aiEnriched,
      payment_methods AS paymentMethods, bank_transfer AS bankTransfer, ai_hash IS NOT NULL AS aiVerified,
      price_type AS priceType, unit, min_quantity AS minQuantity, payment_evidence_url AS paymentEvidenceUrl
      FROM offers WHERE product_id = ? ORDER BY price, id`).all(p.id);
    const demo = !all.some(s => s.sourceId);
    const sources = all.filter(s => Boolean(s.available) && (demo ? !s.sourceId : s.sourceId)).map(s => ({ ...s, bankTransfer: Boolean(s.bankTransfer), paymentMethods: JSON.parse(s.paymentMethods), stale: !s.checkedAt || Date.now() - Date.parse(s.checkedAt) > staleMs })).sort((a, b) => Number(b.bankTransfer) - Number(a.bankTransfer) || a.price - b.price);
    const history = demo ? [] : db.prepare('SELECT price, checked_at FROM live_price_history WHERE product_id = ? ORDER BY id DESC LIMIT 5').all(p.id).reverse();
    return { ...p, supplier: demo ? p.supplier : sources[0]?.platform || p.supplier, keywords: JSON.parse(p.keywords), unitPrice: sources[0]?.price ?? 0, demo, available: sources.length > 0, bankTransfer: sources.some(s => s.bankTransfer),
      stale: sources.length === 0 || sources.some(s => s.stale),
      sources: sources.map((s, i) => ({ ...s, preferred: i === 0, best: s.price === Math.min(...sources.map(o => o.price)) })),
      chartLabels: demo ? ['09:00', '11:00', '13:00', '15:00', '17:00'] : history.map(h => h.checked_at),
      chartData: demo ? db.prepare('SELECT price FROM price_history WHERE product_id = ? ORDER BY position').all(p.id).map(h => h.price) : history.map(h => h.price) };
  }).sort((a, b) => Number(b.bankTransfer) - Number(a.bankTransfer));
}

export function getCatalog(db, staleMs) {
  const products = getProducts(db, staleMs);
  const hasLive = products.some(p => !p.demo);
  const ticker = hasLive ? products.filter(p => !p.demo && p.available).map(p => {
    const previous = p.chartData.at(-2) || p.unitPrice;
    const change = ((p.unitPrice - previous) / previous * 100).toFixed(1);
    return { name: p.name, price: `${p.unitPrice.toLocaleString('en-US')} UZS`, change: `${Number(change) > 0 ? '+' : ''}${change}%`, up: Number(change) >= 0 };
  }) : JSON.parse(db.prepare("SELECT value FROM metadata WHERE key = 'ticker'").get().value);
  return { products, markets: db.prepare('SELECT data FROM markets ORDER BY id').all().map(m => JSON.parse(m.data)), ticker,
    demo: !hasLive, mixed: hasLive && products.some(p => p.demo) };
}
