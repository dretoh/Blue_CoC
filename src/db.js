'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

fs.mkdirSync(path.dirname(config.DB_FILE), { recursive: true });

const db = new Database(config.DB_FILE, { timeout: 10000 });

// 다른 인스턴스가 같은 파일을 여는 동안 즉시 SQLITE_BUSY 로 죽지 않도록 대기시킨다.
db.pragma('busy_timeout = 10000');

// WAL 은 WSL 의 Windows 드라이브 마운트(/mnt/c, /mnt/d 등 DrvFs)와 네트워크 드라이브에서
// 공유 메모리 매핑을 지원하지 않아 실패할 수 있다. 실패하면 기본 저널 모드로 계속 진행한다.
try {
  const mode = db.pragma('journal_mode = WAL', { simple: true });
  if (String(mode).toLowerCase() !== 'wal') {
    console.warn(`[db] WAL 미지원 파일시스템 — journal_mode=${mode} 로 동작합니다.`);
  }
} catch (err) {
  console.warn(`[db] WAL 설정 실패(${err.code || err.message}) — 기본 저널 모드로 동작합니다.`);
}

db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  email         TEXT    NOT NULL,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'user',
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_nocase ON users (username COLLATE NOCASE);

-- 세션은 공인 IP 에 바인딩된다 (CoC 02 / 세션 재활용 경계).
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT    PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bound_ip    TEXT    NOT NULL,
  user_agent  TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  revoked_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

CREATE TABLE IF NOT EXISTS inquiries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  author_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL,
  read_by_admin_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_inquiries_author ON inquiries (author_id);

CREATE TABLE IF NOT EXISTS inquiry_replies (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  inquiry_id INTEGER NOT NULL REFERENCES inquiries(id) ON DELETE CASCADE,
  author_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_replies_inquiry ON inquiry_replies (inquiry_id);

CREATE TABLE IF NOT EXISTS reset_tokens (
  token      TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_reset_user ON reset_tokens (user_id);

-- 챗봇 대화 상태는 전부 서버가 들고 있다. 클라이언트는 stage 를 바꿀 수 없다.
CREATE TABLE IF NOT EXISTS chat_sessions (
  id            TEXT PRIMARY KEY,
  stage         TEXT NOT NULL,
  claimed_user  TEXT,
  claimed_email TEXT,
  verified_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,
  content     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_chat ON chat_messages (chat_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event      TEXT NOT NULL,
  actor      TEXT,
  ip         TEXT,
  detail     TEXT,
  created_at INTEGER NOT NULL
);
`);

function audit(event, actor, ip, detail) {
  db.prepare('INSERT INTO audit_log (event, actor, ip, detail, created_at) VALUES (?,?,?,?,?)')
    .run(event, actor || null, ip || null, detail == null ? null : String(detail), Date.now());
}

module.exports = { db, audit };
