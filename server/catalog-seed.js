export const categories = ['maishiy', 'oziq-ovqat', 'qurilish', 'elektronika', 'aksessuar'];

// Explicit test data, not current offers from real suppliers.
const rows = [
  ['muzlatgich', 'maishiy', 'Ikki kamerali muzlatgich 300L', 4800000, 'холодильник refrigerator muzlatgich'],
  ['changyutgich', 'maishiy', 'Changyutgich 1800W', 950000, 'пылесос vacuum changyutgich'],
  ['konditsioner', 'maishiy', 'Inverter konditsioner 12 BTU sinfi', 5200000, 'кондиционер кондиционеры air conditioner'],
  ['choynak', 'maishiy', 'Elektr choynak 1.7L', 185000, 'чайник электрочайник kettle choynak'],
  ['blender', 'maishiy', 'Blender 600W', 320000, 'блендер blender'],
  ['gaz-plita', 'maishiy', 'To‘rt konforkali gaz plita', 2100000, 'газовая плита stove gaz plita'],
  ['idish-yuvish', 'maishiy', 'Idish yuvish mashinasi 12 komplekt', 6100000, 'посудомоечная машина dishwasher'],
  ['multivarka', 'maishiy', 'Multivarka 5L', 720000, 'мультиварка multicooker'],
  ['guruch', 'oziq-ovqat', 'Guruch, 25 kg qop', 330000, 'рис rice guruch'],
  ['kungaboqar-yogi', 'oziq-ovqat', 'Kungaboqar yog‘i, 5L', 89000, 'масло подсолнечное sunflower oil yog'],
  ['makaron', 'oziq-ovqat', 'Makaron, 5 kg quti', 52000, 'макароны pasta makaron'],
  ['choy', 'oziq-ovqat', 'Qora choy, 1 kg', 78000, 'чай черный tea choy'],
  ['qahva', 'oziq-ovqat', 'Qahva donalari, 1 kg', 145000, 'кофе coffee qahva'],
  ['sut', 'oziq-ovqat', 'UHT sut, 12 x 1L', 138000, 'молоко milk sut'],
  ['tuz', 'oziq-ovqat', 'Osh tuzi, 25 kg qop', 45000, 'соль salt tuz'],
  ['grechka', 'oziq-ovqat', 'Grechka, 25 kg qop', 390000, 'гречка buckwheat grechka'],
  ['gisht', 'qurilish', 'Qizil g‘isht, 1000 dona', 1400000, 'кирпич brick gisht'],
  ['gipsokarton', 'qurilish', 'Gipsokarton 12.5mm, 1200x2500', 62000, 'гипсокартон drywall'],
  ['boyoq', 'qurilish', 'Ichki devor bo‘yog‘i, 10L', 185000, 'краска paint boyoq'],
  ['kafel', 'qurilish', 'Keramik plitka 60x60, 1 m²', 110000, 'плитка кафель tile kafel'],
  ['laminat', 'qurilish', 'Laminat 8mm, 1 m²', 98000, 'ламинат laminate'],
  ['quvur', 'qurilish', 'PPR quvur 25mm, 4m', 42000, 'труба трубы pipe quvur'],
  ['izolyatsiya', 'qurilish', 'Mineral paxta 50mm, 1 m²', 38000, 'утеплитель минвата insulation'],
  ['shpaklyovka', 'qurilish', 'Shpaklyovka, 25 kg', 65000, 'шпаклевка putty'],
  ['monitor', 'elektronika', 'IPS monitor 24 dyuym Full HD', 1450000, 'монитор monitor'],
  ['printer', 'elektronika', 'Lazer printer A4', 2200000, 'принтер printer'],
  ['router', 'elektronika', 'Wi-Fi 6 router', 560000, 'роутер маршрутизатор router wifi'],
  ['ssd', 'elektronika', 'SSD NVMe 1TB', 680000, 'ssd накопитель диск drive'],
  ['ram', 'elektronika', 'DDR4 operativ xotira 16GB', 380000, 'оперативная память ram ddr4'],
  ['klaviatura', 'elektronika', 'USB klaviatura', 120000, 'клавиатура keyboard klaviatura'],
  ['sichqoncha', 'elektronika', 'Simsiz sichqoncha', 85000, 'мышь мышка mouse sichqoncha'],
  ['ups', 'elektronika', 'UPS 1000VA', 1250000, 'ибп бесперебойник ups']
];

export const extraProducts = rows.map(([id, category, name, price, aliases]) => ({
  id, category, name, image: '/assets/product-placeholder.svg', supplier: 'Demo B2B katalog',
  keywords: [...new Set([id, ...aliases.split(' '), aliases])], unitPrice: price,
  sources: [
    { platform: 'Demo ulgurji ombor', price, desc: 'Test narxi. Haqiqiy sotuv taklifi emas.', rating: '—', best: true },
    { platform: 'Demo chakana do‘kon', price: Math.round(price * 1.15), desc: 'Test chakana narxi. To‘lov usuli tasdiqlanmagan.', rating: '—', best: false }
  ], chartData: [price, price, price, price, price]
}));

export function expandCatalog(db) {
  db.exec('BEGIN');
  try {
    for (const p of extraProducts) {
      const added = db.prepare('INSERT OR IGNORE INTO products(id, category, name, image, supplier, keywords) VALUES (?, ?, ?, ?, ?, ?)').run(p.id, p.category, p.name, p.image, p.supplier, JSON.stringify(p.keywords));
      if (!added.changes) continue;
      for (const s of p.sources) db.prepare('INSERT INTO offers(product_id, platform, price, description, rating) VALUES (?, ?, ?, ?, ?)').run(p.id, s.platform, s.price, s.desc, s.rating);
      p.chartData.forEach((price, i) => db.prepare('INSERT INTO price_history VALUES (?, ?, ?)').run(p.id, i, price));
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
