CREATE TABLE IF NOT EXISTS categories (
  category_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  updated_at TEXT NOT NULL
);

INSERT INTO categories(category_id, name, sort_order, active, updated_at) VALUES
  ('CAT_CAFE', 'CAFE', 1, 1, '2026-06-29 7:56:00'),
  ('CAT_SOFT', 'NƯỚC NGỌT', 2, 1, '2026-06-29 7:56:28'),
  ('CAT_TEA', 'TRÀ', 3, 1, '2026-06-29 7:56:42'),
  ('CAT_MILKTEA', 'TRÀ SỮA', 4, 1, '2026-06-29 7:57:07'),
  ('CAT_ICE', 'ĐÁ XAY', 5, 1, '2026-06-29 7:59:12'),
  ('CAT_SPECIAL', 'ĐẶC BIỆT', 6, 1, '2026-06-30 6:49:23'),
  ('CAT_RICE', 'CƠM', 7, 1, '2026-06-29 8:01:33'),
  ('CAT_OTHER', 'KHÁC', 8, 1, '2026-06-29 8:01:45'),
  ('CAT_YAOURT', 'Yaourt', 9, 0, '2026-06-29 7:55:31'),
  ('CAT_SODA', 'Soda', 10, 0, '2026-06-29 7:55:31')
ON CONFLICT(category_id) DO UPDATE SET
  name = excluded.name,
  sort_order = excluded.sort_order,
  active = excluded.active,
  updated_at = excluded.updated_at;

CREATE INDEX IF NOT EXISTS categories_active_sort
  ON categories(active, sort_order, category_id);
