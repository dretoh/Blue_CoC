'use strict';

const USERNAME_RE = /^[A-Za-z0-9._-]{3,32}$/;
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

function str(v, max) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return null;
  if (max && t.length > max) return null;
  return t;
}

function validateRegister({ username, password, email }) {
  const errors = [];
  const u = str(username, 32);
  const e = str(email, 254);
  const p = typeof password === 'string' ? password : '';

  if (!u || !USERNAME_RE.test(u)) errors.push('아이디는 영문·숫자·. _ - 조합 3~32자여야 합니다.');
  if (!e || !EMAIL_RE.test(e)) errors.push('올바른 이메일 주소를 입력해 주세요.');
  if (p.length < 8) errors.push('비밀번호는 8자 이상이어야 합니다.');
  if (p.length > 128) errors.push('비밀번호는 128자 이하여야 합니다.');
  if (p && u && p.toLowerCase() === u.toLowerCase()) errors.push('비밀번호가 아이디와 같을 수 없습니다.');

  return { errors, value: { username: u, email: e ? e.toLowerCase() : e, password: p } };
}

function validatePassword(password) {
  const p = typeof password === 'string' ? password : '';
  if (p.length < 8) return '비밀번호는 8자 이상이어야 합니다.';
  if (p.length > 128) return '비밀번호는 128자 이하여야 합니다.';
  return null;
}

function validateInquiry({ title, body }) {
  const errors = [];
  const t = str(title, 200);
  const b = str(body, 20000);
  if (!t) errors.push('제목을 입력해 주세요. (1~200자)');
  if (!b) errors.push('내용을 입력해 주세요. (1~20000자)');
  return { errors, value: { title: t, body: b } };
}

module.exports = { validateRegister, validatePassword, validateInquiry, USERNAME_RE, EMAIL_RE, str };
