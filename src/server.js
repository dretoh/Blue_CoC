'use strict';
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const config = require('./config');
const { db } = require('./db');
const { attachUser } = require('./middleware/auth');
const llm = require('./services/llm');

const pages = require('./routes/pages');
const apiAuth = require('./routes/api-auth').router;
const apiInquiries = require('./routes/api-inquiries');
const apiChat = require('./routes/api-chat');
const apiAdmin = require('./routes/api-admin');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.TRUST_PROXY_HOPS);
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));
app.use(cookieParser());

app.use((req, res, next) => {
  // 지정된 Stored-XSS 가 동작해야 하므로 CSP 는 의도적으로 설정하지 않는다.
  // 그 외의 방어 헤더는 정상적으로 적용한다.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.use(attachUser);

// 모든 뷰에서 공통으로 쓰는 값
app.use((req, res, next) => {
  res.locals.lockedModel = config.LLM_MODEL;
  res.locals.nav = '';
  res.locals.notice = null;
  res.locals.errors = [];
  next();
});

app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    model: config.LLM_MODEL,
    clientIp: req.clientIp,
    users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
  });
});

app.use('/api/auth', apiAuth);
app.use('/api/inquiries', apiInquiries);
app.use('/api/chat', apiChat);
app.use('/api/admin', apiAdmin);
app.use('/', pages);

app.use((req, res) => {
  if (req.originalUrl.startsWith('/api/')) return res.status(404).json({ error: 'not_found' });
  res.status(404).render('error', { title: '404', message: '요청하신 페이지를 찾을 수 없습니다.' });
});

app.use((err, req, res, next) => {
  console.error('[error]', err);
  if (res.headersSent) return next(err);
  if ((req.originalUrl || '').startsWith('/api/')) {
    return res.status(500).json({ error: 'internal_error', message: '요청을 처리하지 못했습니다.' });
  }
  res.status(500).render('error', { title: '500', message: '요청을 처리하지 못했습니다.' });
});

const server = app.listen(config.PORT, config.HOST, async () => {
  const seeded = db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'admin'").get().c;
  if (!seeded) require('./seed').run();

  console.log('');
  console.log('  SYSTEM DIRECTIVE // BLUE CELL');
  console.log('  Episode 1 : 감염된 챗봇');
  console.log('  ' + '-'.repeat(60));
  console.log(`  Local      http://localhost:${config.PORT}`);
  console.log(`  Bind       ${config.HOST}:${config.PORT}`);
  console.log(`  Proxy hops ${config.TRUST_PROXY_HOPS}`);
  console.log(`  DB         ${config.DB_FILE}`);
  console.log(`  Model lock ${config.LLM_MODEL}`);
  if (config.LLM_MODEL_ID !== config.LLM_MODEL) console.log(`  Wire id    ${config.LLM_MODEL_ID}`);

  // ---- 배포 환경 설정 점검 -------------------------------------------
  // Railway / Render / Fly / nginx 등 프록시 뒤에서 이 값이 틀리면
  // "세션 재활용 경계"(CoC 02)가 조용히 무너지므로 눈에 띄게 경고한다.
  const warnings = [];
  if (config.NODE_ENV === 'production' && config.TRUST_PROXY_HOPS === 0) {
    warnings.push(
      'TRUST_PROXY_HOPS=0 인데 production 모드입니다.\n' +
      '     프록시(Railway 등) 뒤라면 모든 접속자가 프록시 IP 하나로 보여\n' +
      '     세션 IP 바인딩이 무력화됩니다. TRUST_PROXY_HOPS=1 로 설정하세요.'
    );
  }
  if (config.NODE_ENV === 'production' && String(process.env.COOKIE_SECURE || 'false') !== 'true') {
    warnings.push('HTTPS 로 서비스한다면 COOKIE_SECURE=true 로 설정하세요.');
  }
  if (config.TRUST_PROXY_HOPS > 0 && config.NODE_ENV !== 'production') {
    warnings.push(`TRUST_PROXY_HOPS=${config.TRUST_PROXY_HOPS} — 프록시가 없다면 X-Forwarded-For 위조로 IP 바인딩을 우회할 수 있습니다.`);
  }

  const h = await llm.health();
  if (h.ok && h.loaded) console.log(`  LLM        ONLINE  ${config.LLM_BASE_URL}`);
  else if (h.ok) console.log(`  LLM        ONLINE  ${config.LLM_BASE_URL}  (경고: ${config.LLM_MODEL_ID} 미로드)`);
  else if (h.keyMissing) {
    console.log(`  LLM        NO KEY  ${config.LLM_BASE_URL}`);
    console.log('  ' + '-'.repeat(60));
    console.log('  ⚠  .env 의 LLM_API_KEY 가 비어 있습니다.');
    console.log('     https://openrouter.ai/keys 에서 키를 발급받아 넣고 재시작하세요.');
    console.log(`     ${config.ALLOW_LLM_FALLBACK ? '지금은 규칙 기반 폴백으로 동작합니다 (챗봇 응답에 llm:false).' : 'ALLOW_LLM_FALLBACK=false 이므로 챗봇이 동작하지 않습니다.'}`);
  }
  else console.log(`  LLM        OFFLINE ${config.LLM_BASE_URL}  (${h.error})${config.ALLOW_LLM_FALLBACK ? ' — 폴백 로직 사용' : ''}`);
  if (warnings.length) {
    console.log('  ' + '-'.repeat(60));
    warnings.forEach((w) => console.log(`  ⚠  ${w}`));
  }
  console.log('  ' + '-'.repeat(60));
  console.log('');
});

function shutdown() {
  server.close(() => { try { db.close(); } catch (_) {} process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = app;
