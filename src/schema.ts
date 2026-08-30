/** Canonical SQLite schema version. Writable stores migrate forward only. */
export const STORE_SCHEMA_VERSION = 2

/** The v2 addition is deliberately small and migration-safe. */
export const MIGRATE_V1_TO_V2_SQL = `
ALTER TABLE memory_candidates
  ADD COLUMN similar_memory_ids_json TEXT NOT NULL DEFAULT '[]';
CREATE TABLE IF NOT EXISTS memory_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
INSERT OR IGNORE INTO memory_meta(key, value) VALUES ('schema_format', '2');
`

export const CREATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memory_records (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('working', 'episodic', 'semantic', 'procedural')),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'workspace', 'repository', 'session', 'agent', 'user')),
  scope_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'conflicted', 'stale', 'archived', 'deleted')),
  current_revision INTEGER NOT NULL CHECK (current_revision >= 1),
  subject TEXT NOT NULL,
  applicability TEXT NOT NULL,
  action_text TEXT NOT NULL,
  rationale TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('public', 'internal', 'confidential')),
  owner TEXT NOT NULL,
  expires_at INTEGER,
  content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  positive_feedback INTEGER NOT NULL DEFAULT 0 CHECK (positive_feedback >= 0),
  negative_feedback INTEGER NOT NULL DEFAULT 0 CHECK (negative_feedback >= 0),
  use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  last_used_at INTEGER
) STRICT;

CREATE INDEX IF NOT EXISTS memory_records_scope_status
  ON memory_records(scope_type, scope_key, status);
CREATE INDEX IF NOT EXISTS memory_records_hash
  ON memory_records(content_hash, status);
CREATE INDEX IF NOT EXISTS memory_records_expiry
  ON memory_records(expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS memory_revisions (
  memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  parent_revision INTEGER,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'contradict', 'invalidate', 'archive', 'revive', 'delete')),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'agent', 'policy', 'migration', 'system')),
  actor_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  status TEXT NOT NULL,
  subject TEXT NOT NULL,
  applicability TEXT NOT NULL,
  action_text TEXT NOT NULL,
  rationale TEXT NOT NULL,
  confidence REAL NOT NULL,
  sensitivity TEXT NOT NULL,
  owner TEXT NOT NULL,
  expires_at INTEGER,
  content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(memory_id, revision)
) STRICT;

CREATE TABLE IF NOT EXISTS memory_evidence (
  memory_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('session-event', 'file', 'commit', 'test', 'url', 'human')),
  locator TEXT NOT NULL,
  note TEXT,
  observed_at INTEGER,
  content_hash TEXT,
  PRIMARY KEY(memory_id, revision, ordinal),
  FOREIGN KEY(memory_id, revision) REFERENCES memory_revisions(memory_id, revision) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS memory_candidates (
  id TEXT PRIMARY KEY,
  request_id TEXT UNIQUE,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'contradict')),
  status TEXT NOT NULL CHECK (status IN ('candidate', 'published', 'rejected', 'skipped')),
  target_memory_id TEXT,
  expected_revision INTEGER,
  exact_duplicate_id TEXT,
  similar_memory_ids_json TEXT NOT NULL DEFAULT '[]',
  content_hash TEXT NOT NULL,
  content_json TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  reviewer_kind TEXT,
  reviewer_id TEXT,
  decision_reason TEXT,
  published_memory_id TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS memory_candidates_queue
  ON memory_candidates(status, created_at);
CREATE INDEX IF NOT EXISTS memory_candidates_hash
  ON memory_candidates(content_hash, status);

CREATE TABLE IF NOT EXISTS memory_conflicts (
  id TEXT PRIMARY KEY,
  left_memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
  left_revision INTEGER NOT NULL,
  right_memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
  right_revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolver_kind TEXT,
  resolver_id TEXT,
  resolution TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS memory_conflicts_open ON memory_conflicts(status, created_at);

CREATE TABLE IF NOT EXISTS memory_retrievals (
  id TEXT PRIMARY KEY,
  query_hash TEXT NOT NULL,
  query_text TEXT,
  context_json TEXT NOT NULL,
  candidate_count INTEGER NOT NULL,
  selected_json TEXT NOT NULL,
  token_budget INTEGER NOT NULL,
  estimated_tokens INTEGER NOT NULL,
  duration_ms REAL NOT NULL,
  session_id TEXT,
  turn_number INTEGER,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS memory_feedback (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  retrieval_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('helpful', 'harmful', 'irrelevant', 'stale')),
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS memory_audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  details_json TEXT NOT NULL
) STRICT;

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  memory_id UNINDEXED,
  subject,
  applicability,
  action_text,
  rationale,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS memory_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
INSERT OR IGNORE INTO memory_meta(key, value) VALUES ('schema_format', '2');
`
