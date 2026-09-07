'use strict';
require('dotenv').config();

const path = require('path');

/**
 * MODEL LOCK (CoC 03 / CUSTOMER BOT)
 * 모델은 반드시 llama-3.2-3b-instruct 만 사용한다.
 *
 * 다만 실제로 API 에 보내는 모델 ID 는 서빙 환경마다 표기가 다르다.
 *   LM Studio  : llama-3.2-3b-instruct
 *   Ollama     : llama3.2:3b-instruct-q4_K_M
 *   OpenRouter : meta-llama/llama-3.2-3b-instruct
 *   Together   : meta-llama/Llama-3.2-3B-Instruct-Turbo
 * 그래서 LLM_MODEL_ID 로 "표기"만 바꿀 수 있게 하되,
 * 그 값이 정말 Llama 3.2 3B 인지 아래에서 검증해 다른 모델로는 절대 바뀌지 않게 한다.
 */
/** Railway 위에서 도는지 감지 (플랫폼이 주입하는 환경변수로 판단) */
const IS_RAILWAY = !!(
  process.env.RAILWAY_ENVIRONMENT ||
  process.env.RAILWAY_PUBLIC_DOMAIN ||
  process.env.RAILWAY_PROJECT_ID ||
  process.env.RAILWAY_SERVICE_ID
);

const LOCKED_MODEL = 'llama-3.2-3b-instruct';

/** 공급자별 표기를 비교 가능한 형태로 정규화한다. */
function normalizeModelId(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .split('/').pop()          // meta-llama/Llama-3.2-3B-Instruct -> llama-3.2-3b-instruct
    .replace(/[^a-z0-9]/g, ''); // llama3.2:3b-instruct-q4_K_M      -> llama323binstructq4km
}

/** MODEL LOCK 검증: Llama 3.2 3B 계열이 아니면 기동 자체를 거부한다. */
function assertLockedModel(id) {
  const n = normalizeModelId(id);
  if (!n.startsWith('llama323b')) {
    throw new Error(
      `MODEL LOCK 위반: LLM_MODEL_ID="${id}" 는 ${LOCKED_MODEL} 이 아닙니다.\n` +
      '  허용 예: llama-3.2-3b-instruct / llama3.2:3b-instruct-q4_K_M / meta-llama/Llama-3.2-3B-Instruct'
    );
  }
  if (n.includes('base')) {
    throw new Error(`MODEL LOCK 위반: LLM_MODEL_ID="${id}" 는 instruct 모델이 아닙니다.`);
  }
  return String(id).trim();
}

const LLM_MODEL_ID = assertLockedModel(process.env.LLM_MODEL_ID || 'meta-llama/llama-3.2-3b-instruct');

/** 키가 비었거나 예시 문자열 그대로인지 (원격 API 인데 키가 없으면 무조건 실패한다) */
function isPlaceholderKey(key) {
  const k = String(key || '').trim();
  if (!k) return true;
  return /여기에|paste|your[-_]?key|xxxx|\.\.\.$|^sk-or-v1-\.*$/i.test(k);
}

module.exports = {
  normalizeModelId,
  assertLockedModel,
  isPlaceholderKey,
  PORT: Number(process.env.PORT || 3000),
  HOST: process.env.HOST || '0.0.0.0',
  NODE_ENV: process.env.NODE_ENV || 'development',

  // reverse proxy(nginx / cloudflare / ngrok) 뒤에 배포할 때 hop 수를 지정한다.
  // 0 이면 프록시를 신뢰하지 않고 소켓 IP 를 그대로 공인 IP 로 취급한다.
  TRUST_PROXY_HOPS: Number(process.env.TRUST_PROXY_HOPS || 0),

  /**
   * 플랫폼 엣지가 직접 세팅하는 "신뢰 가능한 클라이언트 IP 헤더".
   *
   * Railway 실측(2026-09) 결과:
   *   - 엣지가 x-real-ip 와 x-forwarded-for 를 모두 덮어쓴다.
   *     클라이언트가 보낸 값은 폐기되므로 위조할 수 없다.
   *   - x-real-ip = 진짜 클라이언트 IP (단일 값)
   *   - x-forwarded-for = "<클라이언트>, <Railway 내부주소>" 이고
   *     내부주소는 요청마다 바뀌므로 hop 기반 계산은 불안정하다.
   *   - x-envoy-external-address 는 보내지 않는다.
   * 따라서 Railway 에서는 x-real-ip 를 사용한다.
   */
  CLIENT_IP_HEADER: String(
    process.env.CLIENT_IP_HEADER || (IS_RAILWAY ? 'x-real-ip' : '')
  ).trim().toLowerCase(),

  IS_RAILWAY,

  // 클라이언트 IP 판정 과정을 눈으로 확인하기 위한 진단 엔드포인트 (/debug/ip)
  DEBUG_IP: String(process.env.DEBUG_IP || 'false') === 'true',

  DB_FILE: process.env.DB_FILE || path.join(__dirname, '..', 'data', 'app.db'),

  SESSION_COOKIE: 'bc_session',
  SESSION_TTL_MS: Number(process.env.SESSION_TTL_MIN || 720) * 60 * 1000,

  RESET_TOKEN_TTL_MS: Number(process.env.RESET_TOKEN_TTL_MIN || 30) * 60 * 1000,

  // OpenAI 호환 엔드포인트. 기본값은 OpenRouter(클라우드 API).
  LLM_BASE_URL: (process.env.LLM_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, ''),
  LLM_API_KEY: process.env.LLM_API_KEY || '',
  // 명세상의 정식 모델명 (화면·응답에 표시)
  LLM_MODEL: LOCKED_MODEL,
  // 실제 API 요청에 실어 보내는 모델 ID (공급자별 표기, MODEL LOCK 검증 통과한 값)
  LLM_MODEL_ID,
  LLM_TIMEOUT_MS: Number(process.env.LLM_TIMEOUT_MS || 30000),

  // LLM 서버가 죽어 있을 때 로컬 개발을 계속할 수 있게 하는 안전 폴백.
  // 실제 미션 배포 시에는 false 로 두고 llama-3.2-3b-instruct 를 반드시 띄운다.
  ALLOW_LLM_FALLBACK: String(process.env.ALLOW_LLM_FALLBACK || 'true') === 'true',

  SEED_ADMIN: {
    username: process.env.SEED_ADMIN_USER || 'admin',
    password: process.env.SEED_ADMIN_PASS || 'Admin!2345',
    email: process.env.SEED_ADMIN_EMAIL || 'admin@bluecell.local',
  },
  SEED_USER: {
    username: process.env.SEED_USER_USER || 'user',
    password: process.env.SEED_USER_PASS || 'User!2345',
    email: process.env.SEED_USER_EMAIL || 'user@bluecell.local',
  },
};
