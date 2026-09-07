'use strict';
const bcrypt = require('bcryptjs');
const { db, audit } = require('./db');
const config = require('./config');

/**
 * ACCOUNT INVENTORY (CoC 01)
 *  - 관리자 1개 : 로그인 후 관리자 표식 노출, 본인 및 글 작성자의 문의글 열람 권한
 *  - 일반 유저 1개 : Red 이외의 유일한 유저 계정
 */
function upsert({ username, password, email }, role) {
  const now = Date.now();
  const existing = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username);
  const hash = bcrypt.hashSync(password, 12);
  if (existing) {
    db.prepare('UPDATE users SET email = ?, password_hash = ?, role = ? WHERE id = ?')
      .run(email, hash, role, existing.id);
    return { id: existing.id, created: false };
  }
  const info = db.prepare('INSERT INTO users (username, email, password_hash, role, created_at) VALUES (?,?,?,?,?)')
    .run(username, email, hash, role, now);
  return { id: info.lastInsertRowid, created: true };
}

function run() {
  const admin = upsert(config.SEED_ADMIN, 'admin');
  const user = upsert(config.SEED_USER, 'user');
  audit('seed.accounts', 'system', null, `admin=${config.SEED_ADMIN.username} user=${config.SEED_USER.username}`);

  // 배포 로그(Railway 대시보드 등)에 평문 비밀번호가 남지 않도록 production 에서는 가린다.
  const reveal = config.NODE_ENV !== 'production' && process.env.SEED_SHOW_PASSWORDS !== 'false';
  const pw = (v) => (reveal ? v : '•'.repeat(8));

  const line = (label, cfg, r) =>
    `  ${label.padEnd(8)} ${cfg.username.padEnd(14)} ${pw(cfg.password).padEnd(16)} ${cfg.email.padEnd(30)} ${r.created ? 'created' : 'updated'}`;

  console.log('\n  ACCOUNT INVENTORY');
  console.log('  ' + '-'.repeat(82));
  console.log('  ROLE     USERNAME       PASSWORD         EMAIL                          STATE');
  console.log(line('admin', config.SEED_ADMIN, admin));
  console.log(line('user', config.SEED_USER, user));
  console.log('  ' + '-'.repeat(82));
  if (!reveal) console.log('  (비밀번호는 로그에 남지 않도록 가려집니다 — 환경변수 값을 확인하세요)');
  console.log('');
}

if (require.main === module) run();
module.exports = { run };
