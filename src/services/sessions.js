'use strict';
const crypto = require('crypto');
const { db, audit } = require('../db');
const config = require('../config');

function createSession(userId, ip, userAgent) {
  const id = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare(
    'INSERT INTO sessions (id, user_id, bound_ip, user_agent, created_at, expires_at) VALUES (?,?,?,?,?,?)'
  ).run(id, userId, ip, userAgent || null, now, now + config.SESSION_TTL_MS);
  return id;
}

/**
 * CoC 02 / 세션 재활용 경계
 * 세션(토큰)은 발급 당시의 공인 IP 에서만 유효하다.
 * 다른 공인 IP 에서 같은 토큰을 제시하면 무효로 판정한다.
 */
function resolveSession(sessionId, ip) {
  if (typeof sessionId !== 'string' || !/^[0-9a-f]{64}$/.test(sessionId)) {
    return { ok: false, reason: 'malformed' };
  }
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!row) return { ok: false, reason: 'unknown' };
  if (row.revoked_at) return { ok: false, reason: 'revoked' };
  if (row.expires_at <= Date.now()) return { ok: false, reason: 'expired' };

  if (row.bound_ip !== ip) {
    audit('session.ip_mismatch', String(row.user_id), ip, `bound=${row.bound_ip} seen=${ip}`);
    return { ok: false, reason: 'ip_mismatch', boundIp: row.bound_ip };
  }

  const user = db.prepare('SELECT id, username, email, role FROM users WHERE id = ?').get(row.user_id);
  if (!user) return { ok: false, reason: 'unknown' };
  return { ok: true, session: row, user };
}

function revokeSession(sessionId) {
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .run(Date.now(), sessionId);
}

function revokeAllForUser(userId) {
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
    .run(Date.now(), userId);
}

module.exports = { createSession, resolveSession, revokeSession, revokeAllForUser };
