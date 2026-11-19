CREATE TABLE releases (
  version TEXT PRIMARY KEY,
  series TEXT NOT NULL,
  released_at TEXT NOT NULL
);

CREATE TABLE checks (
  version TEXT NOT NULL,
  target TEXT NOT NULL,
  missing_at TEXT,
  found_at TEXT,
  exact INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (version, target)
);

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO meta (key, value) VALUES ('last_run', '');
