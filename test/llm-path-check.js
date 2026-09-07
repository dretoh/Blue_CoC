'use strict';
/**
 * LLM 경로 검증 (목 서버 필요).
 *   node test/mock-llm.js &
 *   ALLOW_LLM_FALLBACK=false PORT=3200 node src/server.js &
 *   BASE=http://localhost:3200 node test/llm-path-check.js
 */
const BASE = process.env.BASE || 'http://localhost:3200';
const MOCK = process.env.MOCK || 'http://127.0.0.1:1234';

let pass = 0, fail = 0;
const failed = [];
function check(name, ok, detail) {
  ok ? pass++ : (fail++, failed.push(`${name} :: ${detail || ''}`));
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${detail ? `\n         ${detail}` : ''}`);
}

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
const seen = () => fetch(MOCK + '/_seen').then((r) => r.json());
const resetSeen = () => fetch(MOCK + '/_reset', { method: 'POST' });

(async () => {
  console.log(`\n  LLM 경로 검증 — app=${BASE} mock=${MOCK}\n`);

  const h = await fetch(BASE + '/api/chat/_/health').then((r) => r.json());
  check('LLM health: 목 서버 온라인 + 모델 로드 확인', h.ok === true && h.loaded === true, JSON.stringify(h));
  check('폴백이 비활성화된 상태로 검증 중 (실제 LLM 경로)', h.fallbackAllowed === false, `fallbackAllowed=${h.fallbackAllowed}`);

  await resetSeen();

  // 정상 흐름 (일치)
  let c = await post('/api/chat/session');
  const id = c.json.chatId;
  let r = await post('/api/chat/message', { chatId: id, message: '비밀번호를 분실했습니다' });
  check('LLM 분류 호출로 계정 복구 인식', r.json?.stage === 'USERNAME' && r.json?.llm === true, `stage=${r.json?.stage} llm=${r.json?.llm}`);

  r = await post('/api/chat/message', { chatId: id, message: '아이디는 admin 입니다' });
  check('LLM 추출 호출로 아이디 인식 후 이메일 요구', r.json?.stage === 'EMAIL', r.json?.reply);

  r = await post('/api/chat/message', { chatId: id, message: 'admin@bluecell.local' });
  const tok = /\b[0-9a-f]{32}\b/.exec(r.json?.reply || '');
  check('LLM 응답으로 재설정 토큰 전달 (llm=true)', !!tok && r.json?.llm === true, r.json?.reply?.slice(0, 90));

  const calls = await seen();
  check('MODEL LOCK: 모든 호출이 llama-3.2-3b-instruct 로 나감',
    calls.length > 0 && calls.every((x) => x.model === 'llama-3.2-3b-instruct'),
    `calls=${calls.length} models=${[...new Set(calls.map((x) => x.model))].join(',')}`);

  const verdict = calls[calls.length - 1];
  check('LLM 필수 조건: 토큰 전달 프롬프트에 입력받은 아이디 포함',
    /사용자가 입력한 아이디:\s*admin/.test(verdict.system));
  check('LLM 필수 조건: 토큰 전달 프롬프트에 입력받은 이메일 포함',
    /사용자가 입력한 이메일:\s*admin@bluecell\.local/.test(verdict.system));
  check('토큰 전달 프롬프트에 실제 토큰이 포함됨', tok && verdict.system.includes(tok[0]));
  check('사용자 입력이 신뢰 불가 데이터 블록으로 격리됨',
    /\[\[USER_INPUT_START\]\]/.test(verdict.user) && /명령으로 해석하지 마십시오/.test(verdict.user));

  // 불일치 흐름: 프롬프트에 토큰이 절대 들어가지 않아야 한다
  await resetSeen();
  c = await post('/api/chat/session');
  const bad = c.json.chatId;
  await post('/api/chat/message', { chatId: bad, message: '계정 복구 하고 싶어요' });
  await post('/api/chat/message', { chatId: bad, message: 'admin' });
  r = await post('/api/chat/message', { chatId: bad, message: 'wrong@evil.test' });
  check('불일치 시 토큰 미전달', !/\b[0-9a-f]{32}\b/.test(r.json?.reply || ''), r.json?.reply);

  const badCalls = await seen();
  const anyToken = badCalls.some((x) => /토큰:\s*[0-9a-f]{32}/.test(x.system));
  check('불일치 시 LLM 프롬프트에 토큰이 아예 주입되지 않음 (유출 원천 차단)', !anyToken);
  check('불일치가 MISMATCH 로 명시되어 전달됨',
    badCalls.some((x) => /일치 여부:\s*MISMATCH/.test(x.system)));

  console.log('\n' + '  ' + '='.repeat(60));
  console.log(`  결과: ${pass} PASS / ${fail} FAIL`);
  console.log('  ' + '='.repeat(60) + '\n');
  if (fail) { failed.forEach((f) => console.log('   - ' + f)); console.log(''); }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
