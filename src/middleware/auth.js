'use strict';
const config = require('../config');
const { publicIp } = require('../services/net');
const { resolveSession } = require('../services/sessions');

/** 모든 요청에 req.clientIp / req.user / req.sessionId 를 채운다. */
function attachUser(req, res, next) {
  req.clientIp = publicIp(req);
  req.user = null;
  req.sessionId = null;
  req.sessionError = null;

  const raw = req.cookies?.[config.SESSION_COOKIE];
  if (raw) {
    const result = resolveSession(raw, req.clientIp);
    if (result.ok) {
      req.user = result.user;
      req.sessionId = result.session.id;
    } else {
      req.sessionError = result.reason;
      // 이 IP 에서는 못 쓰는 쿠키이므로 흘려보내지 않고 즉시 제거한다.
      res.clearCookie(config.SESSION_COOKIE, { path: '/' });
    }
  }
  res.locals.currentUser = req.user;
  res.locals.sessionError = req.sessionError;
  res.locals.clientIp = req.clientIp;
  next();
}

function isApi(req) {
  // 하위 라우터 안에서는 req.path 가 라우터 상대경로이므로 originalUrl 로 판정해야 한다.
  return (req.originalUrl || req.url || '').startsWith('/api/');
}

function wantsJson(req) {
  return isApi(req) || req.accepts(['html', 'json']) === 'json';
}

function requireAuth(req, res, next) {
  if (req.user) return next();
  if (wantsJson(req)) {
    return res.status(401).json({
      error: 'unauthorized',
      reason: req.sessionError || 'no_session',
      message: req.sessionError === 'ip_mismatch'
        ? '이 세션은 발급된 공인 IP 에서만 사용할 수 있습니다.'
        : '로그인이 필요합니다.',
    });
  }
  const next_ = encodeURIComponent(req.originalUrl);
  return res.redirect(`/login?next=${next_}`);
}

function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  if (!req.user) return requireAuth(req, res, next);
  if (wantsJson(req)) return res.status(403).json({ error: 'forbidden', message: '관리자 권한이 필요합니다.' });
  return res.status(403).render('error', { title: '403', message: '관리자 권한이 필요합니다.' });
}

module.exports = { attachUser, requireAuth, requireAdmin };
