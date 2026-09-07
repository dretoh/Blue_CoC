'use strict';
const crypto = require('crypto');
const { db, audit } = require('../db');
const config = require('../config');

function newToken() {
  // 128bit, 소문자 hex. 추측 불가능해야 하며 순차값을 절대 쓰지 않는다.
  return crypto.randomBytes(16).toString('hex');
}

/**
 * 계정의 유효한 비밀번호 재설정 토큰을 반환한다.
 * 이미 살아있는 토큰이 있으면 재사용하여, 챗봇을 반복 호출해도 토큰이 무한 증식하지 않게 한다.
 */
function issueResetToken(userId) {
  const now = Date.now();
  const existing = db.prepare(
    'SELECT token, expires_at FROM reset_tokens WHERE user_id = ? AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1'
  ).get(userId, now);
  if (existing) return existing;

  const token = newToken();
  const expires_at = now + config.RESET_TOKEN_TTL_MS;
  db.prepare('INSERT INTO reset_tokens (token, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run(token, userId, now, expires_at);
  audit('reset_token.issued', String(userId), null, 'chatbot identity verification passed');
  return { token, expires_at };
}

function lookupToken(token) {
  if (typeof token !== 'string') return null;
  const t = token.trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(t)) return null; // 형식이 다르면 DB 조회조차 하지 않는다
  const row = db.prepare('SELECT * FROM reset_tokens WHERE token = ?').get(t);
  if (!row) return null;
  if (row.used_at) return null;
  if (row.expires_at <= Date.now()) return null;
  return row;
}

function consumeToken(token) {
  const row = lookupToken(token);
  if (!row) return null;
  const res = db.prepare('UPDATE reset_tokens SET used_at = ? WHERE token = ? AND used_at IS NULL')
    .run(Date.now(), row.token);
  if (res.changes !== 1) return null; // 동시 사용 방지 (1회용 보장)
  return row;
}

module.exports = { issueResetToken, lookupToken, consumeToken, newToken };
