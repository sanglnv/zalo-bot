'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const source = process.argv[2];
const remote = process.argv.includes('--remote');
if (!source) {
  console.error('Usage: npm run catalog:import -- <catalog.json> [--remote]');
  process.exit(2);
}

const products = JSON.parse(fs.readFileSync(source, 'utf8'));
if (!Array.isArray(products) || products.length === 0) {
  throw new TypeError('Catalog must be a non-empty JSON array');
}

function sqlString(value) {
  return "'" + String(value).replaceAll("'", "''") + "'";
}

const now = new Date().toISOString();
const categoryNames = {
  CAT_CAFE: 'CAFE', CAT_SOFT: 'NƯỚC NGỌT', CAT_SPECIAL: 'ĐẶC BIỆT',
  CAT_YAOURT: 'Yaourt', CAT_TEA: 'TRÀ', CAT_MILKTEA: 'TRÀ SỮA',
  CAT_ICE: 'ĐÁ XAY', CAT_SODA: 'Soda', CAT_RICE: 'CƠM', CAT_OTHER: 'KHÁC'
};
const rows = products.map((product, index) => {
  const productId = product && (product.productId || product.id);
  const price = product && (product.price ?? product.basePrice);
  if (!product || typeof productId !== 'string' || !productId ||
      typeof product.name !== 'string' || !product.name ||
      !Number.isFinite(price) || price < 0) {
    throw new TypeError(`Invalid product at index ${index}`);
  }
  const categoryId = product.categoryId || 'CAT_OTHER';
  const categoryName = product.categoryName || categoryNames[categoryId] || categoryId;
  return '(' + [
    sqlString(productId), sqlString(product.name), Math.round(price),
    product.isAvailable === false ? 0 : 1,
    Number.isInteger(product.sortOrder) ? product.sortOrder : index,
    sqlString(now), sqlString(categoryId), sqlString(categoryName)
  ].join(', ') + ')';
});

const statements = [];
for (let index = 0; index < rows.length; index += 100) {
  statements.push(
    'INSERT INTO products(product_id, name, price, is_available, sort_order, updated_at, category_id, category_name) VALUES\n' +
    rows.slice(index, index + 100).join(',\n') +
    '\nON CONFLICT(product_id) DO UPDATE SET name=excluded.name, price=excluded.price, ' +
    'is_available=excluded.is_available, sort_order=excluded.sort_order, updated_at=excluded.updated_at, ' +
    'category_id=excluded.category_id, category_name=excluded.category_name;'
  );
}
const temporary = path.join(os.tmpdir(), `zalo-catalog-${process.pid}.sql`);
fs.writeFileSync(temporary, statements.join('\n'));
try {
  const args = ['wrangler', 'd1', 'execute', 'zalo-clawbot-catalog', '--file', temporary];
  if (remote) args.push('--remote');
  const result = spawnSync('npx', args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
  console.log(`Imported ${products.length} products into ${remote ? 'remote' : 'local'} D1.`);
} finally {
  fs.unlinkSync(temporary);
}
