CREATE TABLE IF NOT EXISTS app_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cycle INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO app_state (id, cycle, updated_at)
VALUES (1, 1, unixepoch());

CREATE TABLE IF NOT EXISTS watchers (
  slot TEXT PRIMARY KEY CHECK (slot IN ('primary', 'backup')),
  user_id INTEGER NOT NULL,
  user_name TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_watchers_user
ON watchers(user_id);

CREATE TABLE IF NOT EXISTS queue_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  user_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('waiting', 'called', 'done', 'skipped', 'cancelled')),
  requested_at INTEGER NOT NULL,
  called_at INTEGER,
  resolved_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_queue_cycle_status
ON queue_entries(cycle, status, id);

CREATE INDEX IF NOT EXISTS idx_queue_cycle_user
ON queue_entries(cycle, user_id, status);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  user_name TEXT NOT NULL,
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_audit_created
ON audit_log(created_at DESC);
