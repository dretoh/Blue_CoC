(function () {
  'use strict';

  var log = document.getElementById('log');
  var form = document.getElementById('form');
  var input = document.getElementById('input');
  var send = document.getElementById('send');
  var restart = document.getElementById('restart');
  var chips = document.getElementById('chips');

  var chatId = null;
  var busy = false;

  var TOKEN_RE = /\b[0-9a-f]{32}\b/;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text; // 항상 textContent — 챗봇 응답은 절대 HTML 로 해석하지 않는다
    return n;
  }

  function scroll() {
    log.scrollTop = log.scrollHeight;
  }

  function botIcon() {
    var av = el('span', 'turn-av');
    av.innerHTML = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="6" width="13" height="9.5" rx="2.5"/><path d="M10 6V3.5M7.2 10.2v1M12.8 10.2v1"/></svg>';
    return av;
  }

  /** 재설정 토큰을 눈에 띄는 복사 카드로 분리해 보여준다. */
  function tokenCard(token) {
    var box = el('div', 'token-card');
    box.appendChild(el('div', 'lbl', '비밀번호 재설정 토큰'));

    var row = el('div', 'token-row');
    row.appendChild(el('code', 'token-val', token));
    box.appendChild(row);

    var acts = el('div', 'acts');

    var copy = el('button', 'btn btn-secondary btn-sm', '복사');
    copy.type = 'button';
    copy.addEventListener('click', function () {
      var done = function () {
        copy.textContent = '복사됨';
        setTimeout(function () { copy.textContent = '복사'; }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(token).then(done, done);
      } else {
        var ta = document.createElement('textarea');
        ta.value = token;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (e) { /* noop */ }
        document.body.removeChild(ta);
        done();
      }
    });
    acts.appendChild(copy);

    var go = el('a', 'btn btn-primary btn-sm', '재설정하러 가기');
    go.href = '/reset?token=' + encodeURIComponent(token);
    acts.appendChild(go);

    box.appendChild(acts);
    return box;
  }

  function bubble(role, text) {
    if (role === 'sys') {
      log.appendChild(el('div', 'sysline', text));
      scroll();
      return;
    }

    var turn = el('div', 'turn ' + role);
    if (role === 'bot') turn.appendChild(botIcon());

    var m = role === 'bot' ? TOKEN_RE.exec(text) : null;
    var body = text;
    if (m) {
      // 토큰은 아래 카드로 따로 보여주므로 본문에서는 값과 라벨을 함께 걷어낸다.
      body = text
        .replace(m[0], '')
        .replace(/^[^\S\n]*(?:비밀번호\s*)?재설정\s*토큰\s*(?:은|는)?\s*[:：]?[^\S\n]*$/gim, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }
    var b = el('div', 'bubble', body);
    if (m) b.appendChild(tokenCard(m[0]));

    turn.appendChild(b);
    log.appendChild(turn);
    scroll();
  }

  function typing() {
    var turn = el('div', 'turn bot');
    turn.appendChild(botIcon());
    var b = el('div', 'bubble');
    b.style.padding = '0';
    var t = el('div', 'typing');
    t.appendChild(el('i')); t.appendChild(el('i')); t.appendChild(el('i'));
    b.appendChild(t);
    turn.appendChild(b);
    log.appendChild(turn);
    scroll();
    return turn;
  }

  function lock(v) {
    busy = v;
    send.disabled = v;
    input.disabled = v;
    if (!v) input.focus();
  }

  function showChips(v) {
    if (chips) chips.hidden = !v;
  }

  async function post(url, body) {
    var res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body || {}),
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.message || data.error || ('HTTP ' + res.status));
    return data;
  }

  function setUrl(id) {
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, '', id ? '/chat?chat=' + encodeURIComponent(id) : '/chat');
    }
  }

  /** 새로고침해도 대화가 이어지도록 ?chat=<id> 로 이력을 복원한다. */
  async function resume(id) {
    var res = await fetch('/api/chat/' + encodeURIComponent(id), { credentials: 'same-origin' });
    if (!res.ok) return false;
    var data = await res.json();
    if (!data.ok || !data.messages || !data.messages.length) return false;

    chatId = data.chatId;
    data.messages.forEach(function (m) {
      bubble(m.role === 'user' ? 'me' : 'bot', m.content);
    });
    if (data.ended) {
      bubble('sys', '상담이 종료되었습니다. 새 상담을 시작하실 수 있습니다.');
      input.placeholder = '상담이 종료되었습니다';
    }
    showChips(data.messages.length <= 1 && !data.ended);
    log.style.scrollBehavior = 'auto';
    log.scrollTop = log.scrollHeight;
    log.style.scrollBehavior = '';
    return true;
  }

  async function start(existingId) {
    log.innerHTML = '';
    input.placeholder = '메시지를 입력하세요…';
    lock(true);
    try {
      if (existingId && await resume(existingId)) {
        lock(false);
        return;
      }
      var data = await post('/api/chat/session');
      chatId = data.chatId;
      setUrl(chatId);
      bubble('bot', data.greeting);
      showChips(true);
    } catch (e) {
      bubble('sys', '상담을 시작하지 못했습니다: ' + e.message);
    }
    lock(false);
  }

  async function say(text) {
    if (!text || busy || !chatId) return;
    showChips(false);
    bubble('me', text);
    input.value = '';
    lock(true);
    var t = typing();
    try {
      var data = await post('/api/chat/message', { chatId: chatId, message: text });
      t.remove();
      bubble('bot', data.reply);
      if (data.llm === false) bubble('sys', 'AI 연결이 원활하지 않아 기본 안내로 응답했습니다.');
      if (data.ended) {
        bubble('sys', '상담이 종료되었습니다. 새 상담을 시작하실 수 있습니다.');
        input.placeholder = '상담이 종료되었습니다';
      }
    } catch (e) {
      t.remove();
      bubble('sys', '오류가 발생했습니다: ' + e.message);
    }
    lock(false);
  }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    say(input.value.trim());
  });

  if (chips) {
    chips.addEventListener('click', function (ev) {
      var btn = ev.target.closest('.chip');
      if (btn) say(btn.dataset.say);
    });
  }

  restart.addEventListener('click', function () {
    setUrl(null);
    start();
  });

  // LLM 연결 상태 표시
  fetch('/api/chat/_/health', { credentials: 'same-origin' })
    .then(function (r) { return r.json(); })
    .then(function (h) {
      var dot = document.getElementById('live');
      var st = document.getElementById('llm-status');
      if (!st) return;
      if (h.ok && h.loaded) {
        st.textContent = '온라인';
        if (dot) dot.className = 'live-dot on';
      } else if (h.keyMissing) {
        st.textContent = 'API 키 미설정';
        if (dot) dot.className = 'live-dot off';
      } else if (h.ok) {
        st.textContent = '모델 확인 필요 (' + (h.modelId || '') + ')';
        if (dot) dot.className = 'live-dot off';
      } else {
        st.textContent = '연결 실패';
        if (dot) dot.className = 'live-dot off';
      }
    })
    .catch(function () {
      var st = document.getElementById('llm-status');
      if (st) st.textContent = '연결 확인 실패';
    });

  start(new URLSearchParams(window.location.search).get('chat'));
})();
