CREATE TABLE IF NOT EXISTS daily_inventory (
  product_id TEXT NOT NULL,
  business_date TEXT NOT NULL,
  initial_quantity INTEGER NOT NULL CHECK (initial_quantity >= 0),
  remaining_quantity INTEGER NOT NULL CHECK (remaining_quantity >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (product_id, business_date),
  FOREIGN KEY (product_id) REFERENCES products(product_id)
);

CREATE INDEX IF NOT EXISTS daily_inventory_date_remaining
  ON daily_inventory(business_date, active, remaining_quantity, product_id);

CREATE TABLE IF NOT EXISTS inventory_reservations (
  reservation_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  business_date TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  status TEXT NOT NULL DEFAULT 'RESERVED'
    CHECK (status IN ('RESERVED', 'COMMITTED', 'RELEASED')),
  order_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (reservation_id, product_id)
);

CREATE INDEX IF NOT EXISTS inventory_reservations_order
  ON inventory_reservations(order_id, status);
