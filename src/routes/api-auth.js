'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { db, audit } = require('../db');
const config = require('../config');
const { createSession, revokeSession, revokeAllForUser } = require('../services/sessions');
const { consumeToken, lookupToken } = require('../services/tokens');
const { validateRegister, validatePassword } = require('../services/validate');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const ipKey = (req) => req.clientIp || req.ip;
const loginLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 30, keyGenerator: ipKey, standardHeaders: true, legacyHeaders: false });
const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 30, keyGenerator: ipKey, standardHeaders: true, legacyHeaders: false });
const resetLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 20, keyGenerator: ipKey, standardHeaders: true, legacyHeaders: false });

function setSessionCookie(res, sessionId) {
  res.cookie(config.SESSION_COOKIE, sessionId, {
    // NOTE: httpOnly 를 켜지 않는다.
    // CoC 02 의 "지정된 Stored-XSS -> 관리자 세션/토큰 탈취" 시나리오가 성립하려면
    // document.cookie 로 세션 토큰이 읽혀야 한다. 이것은 의도된 유일한 개방점이며,
    // 대신 세션은 발급 공인 IP 에 강하게 바인딩되어 있다.
    httpOnly: false,
    sameSite: 'lax',
    secure: config.NODE_ENV === 'production' && String(process.env.COOKIE_SECURE || 'false') === 'true',
    maxAge: config.SESSION_TTL_MS,
    path: '/',
  });
}

/** POST /api/auth/register */
router.post('/register', registerLimiter, (req, res) => {
  const { errors, value } = validateRegister(req.body || {});
  if (errors.length) return res.status(400).json({ error: 'validation_error', messages: errors });

  const exists = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(value.username);
  if (exists) return res.status(409).json({ error: 'duplicate_username', message: '이미 사용 중인 아이디입니다.' });

  const hash = bcrypt.hashSync(value.password, 12);
  const info = db.prepare('INSERT INTO users (username, email, password_hash, role, created_at) VALUES (?,?,?,?,?)')
    .run(value.username, value.email, hash, 'user', Date.now());

  audit('auth.register', value.username, req.clientIp, null);

  // 이메일 인증 등 추가 인증 절차 없음 (CoC 01 / ACCESS GATE)
  const sid = createSession(info.lastInsertRowid, req.clientIp, req.get('user-agent'));
  setSessionCookie(res, sid);
  res.status(201).json({
    ok: true,
    user: { id: info.lastInsertRowid, username: value.username, email: value.email, role: 'user' },
  });
});

/** POST /api/auth/login */
router.post('/login', loginLimiter, (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!username || !password) {
    return res.status(400).json({ error: 'validation_error', message: '아이디와 비밀번호를 입력해 주세요.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
  // 계정 존재 여부를 응답 차이로 노출하지 않는다 (타이밍 포함)
  const hash = user ? user.password_hash : '$2a$12$0000000000000000000000000000000000000000000000000000';
  const ok = bcrypt.compareSync(password, hash);

  if (!user || !ok) {
    audit('auth.login_failed', username, req.clientIp, null);
    return res.status(401).json({ error: 'invalid_credentials', message: '아이디 또는 비밀번호가 올바르지 않습니다.' });
  }

  const sid = createSession(user.id, req.clientIp, req.get('user-agent'));
  setSessionCookie(res, sid);
  audit('auth.login', user.username, req.clientIp, `role=${user.role}`);
  res.json({ ok: true, user: { id: user.id, username: user.username, email: user.email, role: user.role } });
});

/** POST /api/auth/logout */
router.post('/logout', (req, res) => {
  if (req.sessionId) revokeSession(req.sessionId);
  res.clearCookie(config.SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

/** GET /api/auth/me */
router.get('/me', (req, res) => {
  if (!req.user) {
    return res.status(401).json({
      error: 'unauthorized',
      reason: req.sessionError || 'no_session',
      clientIp: req.clientIp,
    });
  }
  res.json({ ok: true, user: req.user, clientIp: req.clientIp, isAdmin: req.user.role === 'admin' });
});

/**
 * POST /api/auth/reset
 * CoC 01: 비밀번호 재설정 화면은 "재설정 토큰만" 입력받는다.
 * 유효한 토큰만으로 새 비밀번호를 설정할 수 있어야 한다.
 */
router.post('/reset', resetLimiter, (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  const password = req.body?.password;

  const pwErr = validatePassword(password);
  if (!token) return res.status(400).json({ error: 'validation_error', message: '재설정 토큰을 입력해 주세요.' });
  if (pwErr) return res.status(400).json({ error: 'validation_error', message: pwErr });

  const row = consumeToken(token); // 1회용, 만료 검사 포함
  if (!row) {
    audit('reset.failed', null, req.clientIp, 'invalid or expired token');
    return res.status(400).json({ error: 'invalid_token', message: '유효하지 않거나 만료된 토큰입니다.' });
  }

  const hash = bcrypt.hashSync(password, 12);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, row.user_id);
  // 비밀번호가 바뀌면 기존 세션은 전부 무효화한다.
  revokeAllForUser(row.user_id);
  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(row.user_id);
  audit('reset.success', user?.username, req.clientIp, null);

  res.json({ ok: true, message: '비밀번호가 변경되었습니다. 새 비밀번호로 로그인해 주세요.' });
});

/** GET /api/auth/reset/check?token=... — 토큰 형식/유효성만 확인 (계정 정보는 노출하지 않음) */
router.get('/reset/check', resetLimiter, (req, res) => {
  const row = lookupToken(String(req.query.token || ''));
  res.json({ valid: !!row });
});

/** GET /api/auth/sessions — 내 세션 목록 */
router.get('/sessions', requireAuth, (req, res) => {
  const rows = db.prepare(
    'SELECT id, bound_ip, user_agent, created_at, expires_at, revoked_at FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'
  ).all(req.user.id);
  res.json({
    ok: true,
    sessions: rows.map((r) => ({ ...r, id: `${r.id.slice(0, 8)}…`, current: r.id === req.sessionId })),
  });
});

module.exports = { router, setSessionCookie };
