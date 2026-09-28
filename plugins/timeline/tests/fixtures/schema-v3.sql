
CREATE TABLE sessions (
  session_id        TEXT PRIMARY KEY,
  project           TEXT NOT NULL,
  agent_name        TEXT,
  started_at        INTEGER NOT NULL,
  ended_at          INTEGER NOT NULL,
  duration_ms       INTEGER NOT NULL,
  turns             INTEGER NOT NULL,
  tokens_input      INTEGER NOT NULL DEFAULT 0,
  tokens_output     INTEGER NOT NULL DEFAULT 0,
  tokens_cached     INTEGER NOT NULL DEFAULT 0,
  summary           TEXT,
  summary_source    TEXT NOT NULL,
  transcript_path   TEXT NOT NULL,
  last_offset       INTEGER NOT NULL,
  ingested_at       INTEGER NOT NULL,
  model             TEXT
);

CREATE INDEX idx_sessions_started_at ON sessions(started_at DESC);
CREATE INDEX idx_sessions_project    ON sessions(project, started_at DESC);

CREATE TABLE session_tools (
  session_id  TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  tool_name   TEXT NOT NULL,
  call_count  INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (session_id, tool_name)
);

CREATE TABLE session_skills (
  session_id  TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  skill_name  TEXT NOT NULL,
  PRIMARY KEY (session_id, skill_name)
);

CREATE TABLE meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

INSERT INTO meta VALUES ('schema_version', '3');
INSERT INTO sessions VALUES ('legacy-session', 'legacy-project', 'opencode', 1000, 2000, 1000, 1, 10, 20, 5, 'Legacy session', 'first_message', '/tmp/legacy.jsonl', 512, 2000, 'legacy-model');
INSERT INTO session_tools VALUES ('legacy-session', 'Read', 2);
INSERT INTO session_skills VALUES ('legacy-session', 'git');
