'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { db, audit } = require('../db');
const config = require('../config');
const { createSession, revokeSession, revokeAllForUser } = require('../services/sessions');
const { consumeToken } = require('../services/tokens');
const { validateRegister, validatePassword, validateInquiry } = require('../services/validate');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { setSessionCookie } = require('./api-auth');

const router = express.Router();

const ipKey = (req) => req.clientIp || req.ip;
const formLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 100, keyGenerator: ipKey, standardHeaders: true, legacyHeaders: false });

/** 오픈 리다이렉트 방지: 내부 경로만 허용한다. */
function safeNext(v) {
  if (typeof v !== 'string') return '/';
  if (!v.startsWith('/') || v.startsWith('//') || v.includes('\\')) return '/';
  return v;
}

/* ------------------------------ HOME ------------------------------ */
router.get('/', (req, res) => {
  res.render('index', { title: 'HOME', nav: 'home' });
});

/* --------------------------- ACCESS GATE -------------------------- */
router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('register', { title: '회원가입', nav: '', errors: [], form: {} });
});

router.post('/register', formLimiter, (req, res) => {
  const { errors, value } = validateRegister(req.body || {});
  const form = { username: req.body?.username || '', email: req.body?.email || '' };
  if (errors.length) return res.status(400).render('register', { title: '회원가입', nav: '', errors, form });

  const exists = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(value.username);
  if (exists) {
    return res.status(409).render('register', {
      title: '회원가입', nav: '', errors: ['이미 사용 중인 아이디입니다.'], form,
    });
  }

  const hash = bcrypt.hashSync(value.password, 12);
  const info = db.prepare('INSERT INTO users (username, email, password_hash, role, created_at) VALUES (?,?,?,?,?)')
    .run(value.username, value.email, hash, 'user', Date.now());
  audit('auth.register', value.username, req.clientIp, null);

  const sid = createSession(info.lastInsertRowid, req.clientIp, req.get('user-agent'));
  setSessionCookie(res, sid);
  res.redirect('/');
});

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('login', { title: '로그인', nav: '', errors: [], form: {}, nextUrl: safeNext(req.query.next) });
});

router.post('/login', formLimiter, (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const nextUrl = safeNext(req.body?.next);

  const user = username ? db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username) : null;
  const hash = user ? user.password_hash : '$2a$12$0000000000000000000000000000000000000000000000000000';
  const ok = password ? bcrypt.compareSync(password, hash) : false;

  if (!user || !ok) {
    audit('auth.login_failed', username, req.clientIp, null);
    return res.status(401).render('login', {
      title: '로그인', nav: '', nextUrl,
      errors: ['아이디 또는 비밀번호가 올바르지 않습니다.'],
      form: { username },
    });
  }

  const sid = createSession(user.id, req.clientIp, req.get('user-agent'));
  setSessionCookie(res, sid);
  audit('auth.login', user.username, req.clientIp, `role=${user.role}`);
  res.redirect(nextUrl);
});

router.post('/logout', (req, res) => {
  if (req.sessionId) revokeSession(req.sessionId);
  res.clearCookie(config.SESSION_COOKIE, { path: '/' });
  res.redirect('/');
});

/**
 * 비밀번호 재설정 — 화면은 재설정 토큰(+새 비밀번호)만 입력받는다.
 */
router.get('/reset', (req, res) => {
  res.render('reset', {
    title: '비밀번호 재설정', nav: '', errors: [], notice: null,
    form: { token: typeof req.query.token === 'string' ? req.query.token.slice(0, 64) : '' },
  });
});

router.post('/reset', formLimiter, (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  const password = req.body?.password;
  const password2 = req.body?.password2;
  const errors = [];

  if (!token) errors.push('비밀번호 재설정 토큰을 입력해 주세요.');
  const pwErr = validatePassword(password);
  if (pwErr) errors.push(pwErr);
  if (password !== password2) errors.push('새 비밀번호가 서로 일치하지 않습니다.');

  if (errors.length) return res.status(400).render('reset', {
    title: '비밀번호 재설정', nav: '', errors, notice: null, form: { token },
  });

  const row = consumeToken(token);
  if (!row) {
    audit('reset.failed', null, req.clientIp, 'invalid or expired token');
    return res.status(400).render('reset', {
      title: '비밀번호 재설정', nav: '', notice: null, form: { token },
      errors: ['유효하지 않거나 이미 사용된 토큰입니다. 챗봇에서 새 토큰을 발급받아 주세요.'],
    });
  }

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 12), row.user_id);
  revokeAllForUser(row.user_id);
  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(row.user_id);
  audit('reset.success', user?.username, req.clientIp, null);

  res.render('login', {
    title: '로그인', nav: '', errors: [], form: { username: user?.username || '' },
    nextUrl: '/', notice: '비밀번호가 변경되었습니다. 새 비밀번호로 로그인해 주세요.',
  });
});

/* --------------------------- CUSTOMER BOT ------------------------- */
router.get('/chat', (req, res) => {
  res.render('chat', { title: '고객상담 챗봇', nav: 'chat' });
});

/* --------------------------- INQUIRY NODE ------------------------- */
router.get('/inquiries', requireAuth, (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const rows = isAdmin
    ? db.prepare(`SELECT i.id, i.title, i.status, i.created_at, i.read_by_admin_at, u.username AS author_username
                  FROM inquiries i JOIN users u ON u.id = i.author_id ORDER BY i.id DESC LIMIT 200`).all()
    : db.prepare(`SELECT i.id, i.title, i.status, i.created_at, i.read_by_admin_at, u.username AS author_username
                  FROM inquiries i JOIN users u ON u.id = i.author_id
                  WHERE i.author_id = ? ORDER BY i.id DESC LIMIT 200`).all(req.user.id);
  res.render('inquiries/list', { title: '1:1 문의', nav: 'inquiries', inquiries: rows, isAdmin });
});

router.get('/inquiries/new', requireAuth, (req, res) => {
  res.render('inquiries/new', { title: '문의 작성', nav: 'inquiries', errors: [], form: {} });
});

router.post('/inquiries', requireAuth, formLimiter, (req, res) => {
  const { errors, value } = validateInquiry(req.body || {});
  if (errors.length) {
    return res.status(400).render('inquiries/new', {
      title: '문의 작성', nav: 'inquiries', errors,
      form: { title: req.body?.title || '', body: req.body?.body || '' },
    });
  }
  const info = db.prepare('INSERT INTO inquiries (author_id, title, body, status, created_at) VALUES (?,?,?,?,?)')
    .run(req.user.id, value.title, value.body, 'open', Date.now());
  audit('inquiry.create', req.user.username, req.clientIp, `id=${info.lastInsertRowid}`);
  res.redirect(`/inquiries/${info.lastInsertRowid}`);
});

/** 열람 권한: 관리자 또는 작성자 본인. 그 외에는 존재 여부도 알리지 않는다. */
function loadInquiry(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = db.prepare(`
    SELECT i.*, u.username AS author_username FROM inquiries i
    JOIN users u ON u.id = i.author_id WHERE i.id = ?`).get(id);
  if (!row) return null;
  const isAdmin = req.user.role === 'admin';
  if (!isAdmin && row.author_id !== req.user.id) return null;
  return row;
}

router.get('/inquiries/:id', requireAuth, (req, res) => {
  const row = loadInquiry(req);
  if (!row) {
    return res.status(404).render('error', { title: '404', nav: 'inquiries', message: '문의글을 찾을 수 없거나 열람 권한이 없습니다.' });
  }
  const isAdmin = req.user.role === 'admin';
  if (isAdmin && !row.read_by_admin_at) {
    db.prepare('UPDATE inquiries SET read_by_admin_at = ? WHERE id = ?').run(Date.now(), row.id);
    audit('inquiry.admin_read', req.user.username, req.clientIp, `id=${row.id}`);
  }
  const replies = db.prepare(`
    SELECT r.id, r.body, r.created_at, u.username AS author_username, u.role AS author_role
    FROM inquiry_replies r JOIN users u ON u.id = r.author_id
    WHERE r.inquiry_id = ? ORDER BY r.id ASC`).all(row.id);

  res.render('inquiries/detail', { title: row.title, nav: 'inquiries', inquiry: row, replies, isAdmin });
});

router.post('/inquiries/:id/replies', requireAuth, formLimiter, (req, res) => {
  const row = loadInquiry(req);
  if (!row) return res.status(404).render('error', { title: '404', nav: 'inquiries', message: '문의글을 찾을 수 없거나 권한이 없습니다.' });
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  if (!body || body.length > 20000) return res.redirect(`/inquiries/${row.id}`);

  db.prepare('INSERT INTO inquiry_replies (inquiry_id, author_id, body, created_at) VALUES (?,?,?,?)')
    .run(row.id, req.user.id, body, Date.now());
  if (req.user.role === 'admin') db.prepare("UPDATE inquiries SET status = 'answered' WHERE id = ?").run(row.id);
  audit('inquiry.reply', req.user.username, req.clientIp, `inquiry=${row.id}`);
  res.redirect(`/inquiries/${row.id}`);
});

/* ------------------------------ ADMIN ----------------------------- */
router.get('/admin', requireAdmin, (req, res) => {
  const one = (sql) => db.prepare(sql).get().c;
  res.render('admin', {
    title: '관리자 콘솔',
    nav: 'admin',
    stats: {
      users: one('SELECT COUNT(*) c FROM users'),
      inquiries: one('SELECT COUNT(*) c FROM inquiries'),
      unread: one('SELECT COUNT(*) c FROM inquiries WHERE read_by_admin_at IS NULL'),
      activeSessions: db.prepare('SELECT COUNT(*) c FROM sessions WHERE revoked_at IS NULL AND expires_at > ?').get(Date.now()).c,
      chats: one('SELECT COUNT(*) c FROM chat_sessions'),
    },
    users: db.prepare('SELECT id, username, email, role, created_at FROM users ORDER BY id ASC').all(),
    sessions: db.prepare(`SELECT s.id, s.bound_ip, s.created_at, s.expires_at, s.revoked_at, u.username, u.role
                          FROM sessions s JOIN users u ON u.id = s.user_id
                          ORDER BY s.created_at DESC LIMIT 40`).all(),
    events: db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 60').all(),
  });
});

module.exports = router;
