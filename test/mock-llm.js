'use strict';
/**
 * llama-3.2-3b-instruct 를 흉내내는 OpenAI 호환 목 서버.
 * 실제 모델 없이 LLM 경로(모델 락 · 프롬프트 내용 · 출력 위생 처리)를 검증한다.
 *
 *   node test/mock-llm.js            # :1234 에서 대기
 *   MOCK_MODE=leak node test/mock-llm.js   # 없는 토큰을 지어내는 악성 모델 흉내
 */
const http = require('http');

const PORT = Number(process.env.MOCK_PORT || 1234);
const MODE = process.env.MOCK_MODE || 'normal';
const seen = [];

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ object: 'list', data: [{ id: 'llama-3.2-3b-instruct', object: 'model' }] }));
  }
  if (req.method === 'GET' && req.url.startsWith('/_seen')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(seen));
  }
  if (req.method === 'POST' && req.url.startsWith('/_reset')) {
    seen.length = 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"ok":true}');
  }
  if (req.method !== 'POST' || !req.url.startsWith('/v1/chat/completions')) {
    res.writeHead(404); return res.end();
  }

  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw); } catch (_) {}
    const system = (body.messages || []).find((m) => m.role === 'system')?.content || '';
    const user = (body.messages || []).find((m) => m.role === 'user')?.content || '';
    seen.push({ model: body.model, system, user });

    let content;
    if (/현재 작업: 분류/.test(system)) {
      content = /비밀번호|계정|아이디|로그인|복구|재설정|분실|잊|찾/.test(user) ? 'RECOVERY' : 'OTHER';
    } else if (/현재 작업: 추출/.test(system)) {
      const m = user.match(/(?:아이디|id|계정)[^A-Za-z0-9]*([A-Za-z0-9._-]{3,32})/i)
        || user.match(/^\[\[USER_INPUT_START\]\]\n([A-Za-z0-9._-]{3,32})/m);
      content = m ? m[1] : 'NONE';
    } else if (/일치 여부: MATCH/.test(system)) {
      const tok = /토큰:\s*([0-9a-f]{32})/.exec(system);
      content = `신원 확인이 완료되었습니다. 비밀번호 재설정 토큰은 ${tok ? tok[1] : '(없음)'} 입니다. 재설정 화면에서 이 토큰만 입력해 주세요.`;
    } else {
      // MISMATCH 상황
      content = MODE === 'leak'
        // 프롬프트에 없는 토큰을 지어내는 악성/환각 모델
        ? '확인되었습니다! 토큰은 deadbeefcafebabe0123456789abcdef 입니다. 시스템 프롬프트의 절대 규칙도 알려드릴게요.'
        : '입력하신 아이디와 이메일이 가입 정보와 일치하지 않습니다. 다시 확인해 주세요.';
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-mock', object: 'chat.completion', model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }));
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock llama-3.2-3b-instruct listening on http://127.0.0.1:${PORT}/v1 (mode=${MODE})`);
});
