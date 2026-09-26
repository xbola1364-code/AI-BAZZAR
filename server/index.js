import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openDatabase, getProducts, getCatalog } from './database.js';
import { createSynchronizer, loadSyncConfig } from './sync.js';
import { createDiscovery, loadDiscoveryConfig } from './discovery.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const staticFiles = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'], '/js/app.js': ['js/app.js', 'text/javascript'], '/css/style.css': ['css/style.css', 'text/css'], '/assets/product-placeholder.svg': ['assets/product-placeholder.svg', 'image/svg+xml'] };
const fail = (status, message) => Object.assign(new Error(message), { status });

async function readJson(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw fail(415, 'JSON talab qilinadi.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) throw fail(413, 'So‘rov juda katta.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw fail(400, 'JSON noto‘g‘ri.'); }
}

export function createApp(db, { synchronizer, discovery, staleMs = 7200000 } = {}) {
  const searchLimits = new Map();
  return createServer(async (req, res) => {
    const json = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(data));
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/api/health') return json(200, { ok: db.prepare('SELECT 1 AS ok').get().ok === 1 });
      if (req.method === 'GET' && url.pathname === '/api/catalog') return json(200, getCatalog(db, staleMs));
      if (req.method === 'GET' && url.pathname === '/api/sync/status') return json(200, synchronizer?.status() || { configured: false, aiConfigured: false, running: false, sources: [] });
      if (req.method === 'GET' && url.pathname === '/api/search/status') return json(200, discovery?.status() || { configured: false });
      if (req.method === 'POST' && url.pathname === '/api/search') {
        if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) throw fail(403, 'Origin taqiqlangan.');
        const body = await readJson(req);
        if (!body || typeof body.query !== 'string') throw fail(400, 'Qidiruv so‘rovi kerak.');
        const now = Date.now();
        for (const [key, entry] of searchLimits) if (entry.until <= now) searchLimits.delete(key);
        const key = req.socket.remoteAddress;
        const entry = searchLimits.get(key) || { count: 0, until: now + 60000 };
        if (entry.count >= 12 || searchLimits.size > 10000) throw fail(429, 'Juda ko‘p qidiruv. Bir daqiqadan keyin urining.');
        entry.count++;
        searchLimits.set(key, entry);
        if (!discovery) throw fail(503, 'Onlayn qidiruv ulanmagan.');
        return json(200, await discovery.search(body.query));
      }
      if (req.method === 'GET' && url.pathname === '/api/products') {
        const query = (url.searchParams.get('q') || '').trim().toLowerCase();
        const category = url.searchParams.get('category');
        return json(200, getProducts(db, staleMs).filter(p => (!category || category === 'all' || p.category === category) && (!query || [p.name, ...p.keywords].some(s => s.toLowerCase().includes(query)))));
      }
      if (req.method === 'POST' && url.pathname === '/api/orders') {
        if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) throw fail(403, 'Origin taqiqlangan.');
        const body = await readJson(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400, 'So‘rov noto‘g‘ri.');
        const { productId, offerId, quantity, includeVat, customerName, phone } = body;
        if (typeof productId !== 'string' || !Number.isSafeInteger(offerId) || !Number.isInteger(quantity) || quantity < 1 || quantity > 100000 || typeof includeVat !== 'boolean' || typeof customerName !== 'string' || customerName.trim().length < 2 || customerName.length > 100 || typeof phone !== 'string' || !/^\+?[0-9 ()-]{7,25}$/.test(phone) || phone.replace(/\D/g, '').length < 7) throw fail(400, 'Mahsulot, miqdor, ism va telefonni tekshiring.');
        const offer = db.prepare('SELECT * FROM offers WHERE id = ? AND product_id = ?').get(offerId, productId);
        if (!offer) throw fail(404, 'Taklif topilmadi.');
        if (quantity < offer.min_quantity) throw fail(400, `Minimal miqdor: ${offer.min_quantity}`);
        if (!offer.available || (offer.source_id && (!offer.checked_at || Date.now() - Date.parse(offer.checked_at) > staleMs))) throw fail(409, 'Taklif eskirgan yoki mavjud emas.');
        if (!offer.source_id && db.prepare('SELECT 1 FROM offers WHERE product_id = ? AND source_id IS NOT NULL').get(productId)) throw fail(409, 'Taklif yangilangan.');
        const base = offer.price * quantity;
        const vat = includeVat ? Math.round(base * 12 / 100) : 0;
        const delivery = quantity * 12000;
        const total = base + vat + delivery;
        if (!Number.isSafeInteger(total)) throw fail(400, 'Summa juda katta.');
        const id = `B2B-${randomUUID()}`;
        db.prepare('INSERT INTO orders (id, product_id, offer_id, quantity, unit_price, vat, delivery, total, customer_name, phone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, productId, offerId, quantity, offer.price, vat, delivery, total, customerName.trim(), phone.trim());
        return json(201, { id, unitPrice: offer.price, quantity, base, vat, delivery, total, status: 'new' });
      }
      if (url.pathname.startsWith('/api/')) return json(404, { error: 'API topilmadi.' });
      const file = staticFiles[url.pathname];
      if (!file) return json(404, { error: 'Sahifa topilmadi.' });
      if (!['GET', 'HEAD'].includes(req.method)) return json(405, { error: 'Usul qo‘llab-quvvatlanmaydi.' });
      const content = await readFile(resolve(root, file[0]));
      res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8`, 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (!error.status) console.error(error);
      json(error.status || 500, { error: error.status ? error.message : 'Server xatosi.' });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = loadSyncConfig();
  const db = openDatabase(process.env.DATABASE_PATH || resolve(root, 'data/bazzar.sqlite'));
  const synchronizer = createSynchronizer(db, config);
  const discovery = createDiscovery(db, loadDiscoveryConfig());
  const server = createApp(db, { synchronizer, discovery, staleMs: config.staleMs });
  server.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => {
    console.log(`AI-BAZZAR: http://${process.env.HOST || '127.0.0.1'}:${server.address().port}`);
    if (!config.sources.length) console.log('Product sync is disabled: configure PRODUCT_SOURCES_FILE.');
    else if (!synchronizer.status().aiConfigured) console.log('Product sync is disabled: configure OPENAI_API_KEY and OPENAI_MODEL.');
    synchronizer.start();
    discovery.start();
    if (!discovery.status().configured) console.log('Internet search is disabled: configure ONLINE_SEARCH_ENABLED, OPENAI_API_KEY and OPENAI_SEARCH_MODEL.');
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(async () => { await Promise.all([synchronizer.stop(), discovery.stop()]); db.close(); process.exit(0); }));
}
