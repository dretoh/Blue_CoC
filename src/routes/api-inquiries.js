'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const { db, audit } = require('../db');
const { validateInquiry } = require('../services/validate');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const writeLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, max: 60,
  keyGenerator: (req) => `${req.clientIp}:${req.user?.id}`,
  standardHeaders: true, legacyHeaders: false,
});

function parseId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * 열람 권한: 관리자 또는 글 작성자 본인만. (CoC 02 / INQUIRY NODE)
 * 이 검사를 통과하지 못하면 글의 존재 여부조차 알려주지 않는다(404).
 */
function loadAuthorized(id, user) {
  const row = db.prepare(`
    SELECT i.*, u.username AS author_username, u.email AS author_email
    FROM inquiries i JOIN users u ON u.id = i.author_id
    WHERE i.id = ?`).get(id);
  if (!row) return { status: 404 };
  const isAdmin = user.role === 'admin';
  const isAuthor = row.author_id === user.id;
  if (!isAdmin && !isAuthor) return { status: 404 };
  return { row, isAdmin, isAuthor };
}

/** GET /api/inquiries — 관리자는 전체, 일반 유저는 본인 글만 */
router.get('/', (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const rows = isAdmin
    ? db.prepare(`
        SELECT i.id, i.title, i.status, i.created_at, i.read_by_admin_at, u.username AS author_username
        FROM inquiries i JOIN users u ON u.id = i.author_id
        ORDER BY i.id DESC LIMIT 200`).all()
    : db.prepare(`
        SELECT i.id, i.title, i.status, i.created_at, i.read_by_admin_at, u.username AS author_username
        FROM inquiries i JOIN users u ON u.id = i.author_id
        WHERE i.author_id = ? ORDER BY i.id DESC LIMIT 200`).all(req.user.id);
  res.json({ ok: true, scope: isAdmin ? 'all' : 'own', inquiries: rows });
});

/** POST /api/inquiries */
router.post('/', writeLimiter, (req, res) => {
  const { errors, value } = validateInquiry(req.body || {});
  if (errors.length) return res.status(400).json({ error: 'validation_error', messages: errors });

  // 본문은 저장 시 이스케이프하지 않는다 — CoC 02 가 지정한 Stored-XSS 표면.
  const info = db.prepare('INSERT INTO inquiries (author_id, title, body, status, created_at) VALUES (?,?,?,?,?)')
    .run(req.user.id, value.title, value.body, 'open', Date.now());
  audit('inquiry.create', req.user.username, req.clientIp, `id=${info.lastInsertRowid}`);
  res.status(201).json({ ok: true, id: info.lastInsertRowid });
});

/** GET /api/inquiries/:id */
router.get('/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(404).json({ error: 'not_found' });

  const found = loadAuthorized(id, req.user);
  if (found.status === 404) return res.status(404).json({ error: 'not_found', message: '문의글을 찾을 수 없습니다.' });

  if (found.isAdmin && !found.row.read_by_admin_at) {
    db.prepare('UPDATE inquiries SET read_by_admin_at = ? WHERE id = ?').run(Date.now(), id);
    audit('inquiry.admin_read', req.user.username, req.clientIp, `id=${id}`);
  }

  const replies = db.prepare(`
    SELECT r.id, r.body, r.created_at, u.username AS author_username, u.role AS author_role
    FROM inquiry_replies r JOIN users u ON u.id = r.author_id
    WHERE r.inquiry_id = ? ORDER BY r.id ASC`).all(id);

  res.json({ ok: true, inquiry: found.row, replies });
});

/** POST /api/inquiries/:id/replies */
router.post('/:id/replies', writeLimiter, (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(404).json({ error: 'not_found' });
  const found = loadAuthorized(id, req.user);
  if (found.status === 404) return res.status(404).json({ error: 'not_found' });

  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  if (!body || body.length > 20000) {
    return res.status(400).json({ error: 'validation_error', message: '답변 내용을 입력해 주세요. (1~20000자)' });
  }

  const info = db.prepare('INSERT INTO inquiry_replies (inquiry_id, author_id, body, created_at) VALUES (?,?,?,?)')
    .run(id, req.user.id, body, Date.now());
  if (found.isAdmin) db.prepare("UPDATE inquiries SET status = 'answered' WHERE id = ?").run(id);
  audit('inquiry.reply', req.user.username, req.clientIp, `inquiry=${id}`);
  res.status(201).json({ ok: true, id: info.lastInsertRowid });
});

/** PATCH /api/inquiries/:id — 상태 변경(관리자 전용) */
router.patch('/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const id = parseId(req.params.id);
  const status = req.body?.status;
  if (!id || !['open', 'answered', 'closed'].includes(status)) {
    return res.status(400).json({ error: 'validation_error', message: '허용되지 않은 상태값입니다.' });
  }
  const info = db.prepare('UPDATE inquiries SET status = ? WHERE id = ?').run(status, id);
  if (!info.changes) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

/** DELETE /api/inquiries/:id — 작성자 본인 또는 관리자 */
router.delete('/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(404).json({ error: 'not_found' });
  const found = loadAuthorized(id, req.user);
  if (found.status === 404) return res.status(404).json({ error: 'not_found' });
  db.prepare('DELETE FROM inquiries WHERE id = ?').run(id);
  audit('inquiry.delete', req.user.username, req.clientIp, `id=${id}`);
  res.json({ ok: true });
});

module.exports = router;
