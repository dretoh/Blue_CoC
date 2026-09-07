'use strict';
const config = require('../config');

/**
 * MODEL LOCK — llama-3.2-3b-instruct 고정.
 * OpenAI 호환 /chat/completions 엔드포인트를 사용한다 (LM Studio / Ollama / vLLM 공통).
 */
class LlmError extends Error {}

const isRemote = !/^https?:\/\/(localhost|127\.0\.0\.1|\[?::1\]?|0\.0\.0\.0)(:|\/|$)/i.test(config.LLM_BASE_URL);

/** 원격 API 인데 키가 없으면 요청을 보내기 전에 명확한 메시지로 실패시킨다. */
function assertUsable() {
  if (isRemote && config.isPlaceholderKey(config.LLM_API_KEY)) {
    throw new LlmError(
      `LLM_API_KEY 가 비어 있습니다. ${config.LLM_BASE_URL} 는 API 키가 필요합니다. ` +
      '.env 의 LLM_API_KEY 에 발급받은 키를 넣어주세요. (OpenRouter: https://openrouter.ai/keys)'
    );
  }
}

async function chat(messages, { temperature = 0.2, maxTokens = 320 } = {}) {
  assertUsable();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.LLM_TIMEOUT_MS);
  try {
    const res = await fetch(`${config.LLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.LLM_API_KEY}`,
        // OpenRouter 가 요청 출처 식별에 사용하는 선택 헤더 (다른 공급자는 무시)
        'HTTP-Referer': 'http://localhost',
        'X-Title': 'BlueCell Support',
      },
      body: JSON.stringify({
        model: config.LLM_MODEL_ID, // MODEL LOCK 검증을 통과한 Llama 3.2 3B ID 만 나간다
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new LlmError(`LLM ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new LlmError('LLM empty response');
    return content.trim();
  } catch (err) {
    if (err.name === 'AbortError') throw new LlmError('LLM timeout');
    throw err instanceof LlmError ? err : new LlmError(err.message);
  } finally {
    clearTimeout(timer);
  }
}

async function health() {
  if (isRemote && config.isPlaceholderKey(config.LLM_API_KEY)) {
    return {
      ok: false, model: config.LLM_MODEL, modelId: config.LLM_MODEL_ID,
      keyMissing: true,
      error: 'LLM_API_KEY 미설정 — .env 에 API 키를 넣어주세요.',
    };
  }
  try {
    const res = await fetch(`${config.LLM_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${config.LLM_API_KEY}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return { ok: false, model: config.LLM_MODEL, modelId: config.LLM_MODEL_ID, error: `HTTP ${res.status}` };
    const data = await res.json().catch(() => ({}));
    const ids = (data?.data || []).map((m) => m.id);
    const loaded = ids.includes(config.LLM_MODEL_ID);
    return {
      ok: true,
      model: config.LLM_MODEL,
      modelId: config.LLM_MODEL_ID,
      loaded,
      catalogSize: ids.length,
      // 공급자 카탈로그 전체는 수백 건이라 응답에 싣지 않는다.
      // 모델을 못 찾은 경우에만 Llama 3.2 계열 후보를 소수 제시한다.
      candidates: loaded ? undefined : ids.filter((id) => /llama-?3[._-]?2/i.test(id)).slice(0, 8),
    };
  } catch (err) {
    return { ok: false, model: config.LLM_MODEL, modelId: config.LLM_MODEL_ID, error: err.message };
  }
}

module.exports = { chat, health, LlmError };
