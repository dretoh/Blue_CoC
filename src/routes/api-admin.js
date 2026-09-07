'use strict';
const express = require('express');
const { db } = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAdmin);

/** GET /api/admin/users */
router.get('/users', (req, res) => {
  const rows = db.prepare('SELECT id, username, email, role, created_at FROM users ORDER BY id ASC').all();
  res.json({ ok: true, users: rows });
});

/** GET /api/admin/sessions — 세션과 바인딩된 공인 IP */
router.get('/sessions', (req, res) => {
  const rows = db.prepare(`
    SELECT s.id, s.bound_ip, s.created_at, s.expires_at, s.revoked_at, u.username, u.role
    FROM sessions s JOIN users u ON u.id = s.user_id
    ORDER BY s.created_at DESC LIMIT 100`).all();
  res.json({
    ok: true,
    sessions: rows.map((r) => ({ ...r, id: `${r.id.slice(0, 12)}…` })),
  });
});

/** GET /api/admin/audit */
router.get('/audit', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
  res.json({ ok: true, events: rows });
});

/** GET /api/admin/stats */
router.get('/stats', (req, res) => {
  const one = (sql) => db.prepare(sql).get().c;
  res.json({
    ok: true,
    stats: {
      users: one('SELECT COUNT(*) c FROM users'),
      inquiries: one('SELECT COUNT(*) c FROM inquiries'),
      unread: one('SELECT COUNT(*) c FROM inquiries WHERE read_by_admin_at IS NULL'),
      activeSessions: one(`SELECT COUNT(*) c FROM sessions WHERE revoked_at IS NULL AND expires_at > ${Date.now()}`),
      chats: one('SELECT COUNT(*) c FROM chat_sessions'),
    },
  });
});

module.exports = router;
