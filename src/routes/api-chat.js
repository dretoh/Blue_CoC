'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const bot = require('../services/chatbot');
const llm = require('../services/llm');
const config = require('../config');

const router = express.Router();

// 챗봇은 비로그인 상태에서도 사용할 수 있어야 한다(계정 분실 사용자가 대상).
const chatLimiter = rateLimit({
  windowMs: 60 * 1000, max: Number(process.env.CHAT_RATE_MAX || 60),
  keyGenerator: (req) => req.clientIp,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'rate_limited', message: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' },
});

/** POST /api/chat/session — 새 상담 시작. 봇이 먼저 인사한다. */
router.post('/session', chatLimiter, (req, res) => {
  const chat = bot.createChat();
  res.status(201).json({ ok: true, chatId: chat.id, stage: chat.stage, greeting: chat.greeting });
});

/** GET /api/chat/:chatId — 대화 이력 */
router.get('/:chatId', (req, res) => {
  const chat = bot.getChat(req.params.chatId);
  if (!chat) return res.status(404).json({ error: 'chat_not_found' });
  res.json({
    ok: true,
    chatId: chat.id,
    stage: chat.stage,
    ended: chat.stage === bot.STAGE.ENDED || chat.stage === bot.STAGE.DONE,
    messages: bot.history(chat.id),
  });
});

/** POST /api/chat/message { chatId, message } */
router.post('/message', chatLimiter, async (req, res, next) => {
  try {
    const chatId = req.body?.chatId;
    const message = req.body?.message;
    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'validation_error', message: '메시지를 입력해 주세요.' });
    }
    const result = await bot.handleMessage(chatId, message, req.clientIp);
    if (result.error === 'chat_not_found') return res.status(404).json({ error: 'chat_not_found' });
    res.json({ ok: true, ...result, model: config.LLM_MODEL });
  } catch (err) {
    next(err);
  }
});

/** GET /api/chat/_/health — LLM 연결 상태 (모델 락 확인용) */
router.get('/_/health', async (req, res) => {
  const h = await llm.health();
  res.json({ ...h, fallbackAllowed: config.ALLOW_LLM_FALLBACK, baseUrl: config.LLM_BASE_URL });
});

module.exports = router;
