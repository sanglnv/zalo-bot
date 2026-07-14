ALTER TABLE products ADD COLUMN category_id TEXT NOT NULL DEFAULT 'CAT_OTHER';
ALTER TABLE products ADD COLUMN category_name TEXT NOT NULL DEFAULT 'Khác';

CREATE INDEX IF NOT EXISTS products_category_sort
  ON products(category_id, is_available, sort_order, product_id);
