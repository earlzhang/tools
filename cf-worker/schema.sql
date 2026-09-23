CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  captured_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entries (
  snapshot_id INTEGER NOT NULL,
  rank INTEGER NOT NULL,
  brand TEXT NOT NULL,
  model TEXT NOT NULL,
  score INTEGER NOT NULL,
  score_low INTEGER NOT NULL,
  score_high INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entries_snapshot ON entries (snapshot_id);
CREATE INDEX idx_entries_model ON entries (brand, model);
