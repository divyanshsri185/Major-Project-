const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const dbPath = path.resolve(process.env.DB_PATH || './data/invigil.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('student','examiner')),
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS exams (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  duration_sec INTEGER NOT NULL CHECK (duration_sec BETWEEN 60 AND 28800),
  active       INTEGER NOT NULL DEFAULT 1,
  created_by   INTEGER NOT NULL REFERENCES users(id),
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS questions (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id  INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  text     TEXT NOT NULL,
  options  TEXT NOT NULL,          -- JSON array of strings
  answer   INTEGER NOT NULL        -- index of correct option (never sent to students)
);
CREATE INDEX IF NOT EXISTS idx_questions_exam ON questions(exam_id, position);

CREATE TABLE IF NOT EXISTS sessions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id         INTEGER NOT NULL REFERENCES exams(id),
  user_id         INTEGER NOT NULL REFERENCES users(id),
  started_at      INTEGER NOT NULL,
  deadline        INTEGER NOT NULL,
  submitted_at    INTEGER,
  status          TEXT NOT NULL DEFAULT 'in_progress'
                  CHECK (status IN ('in_progress','submitted','expired')),
  answers         TEXT NOT NULL DEFAULT '{}',   -- JSON {questionId: optionIndex}
  integrity       INTEGER NOT NULL DEFAULT 100,
  correct         INTEGER,
  total           INTEGER,
  has_devices     INTEGER NOT NULL DEFAULT 0,
  reviewed        INTEGER NOT NULL DEFAULT 0,
  reviewer_note   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_exam ON sessions(exam_id);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  message    TEXT NOT NULL,
  level      TEXT NOT NULL,         -- '', 'w' (warning), 'b' (severe)
  penalty    INTEGER NOT NULL DEFAULT 0,
  at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, at);
`);

module.exports = db;
