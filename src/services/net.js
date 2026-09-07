'use strict';
const config = require('../config');

const PRIVATE_V4 = [
  /^10\./, /^127\./, /^192\.168\./, /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
];

function normalize(ip) {
  if (!ip) return '';
  let v = String(ip).trim();
  if (v.startsWith('::ffff:')) v = v.slice(7); // IPv4-mapped IPv6
  if (v === '::1') v = '127.0.0.1';
  const bracket = v.match(/^\[(.+)\]$/);
  if (bracket) v = bracket[1];
  return v.toLowerCase();
}

function isPrivate(ip) {
  if (!ip) return true;
  if (ip === '127.0.0.1') return true;
  if (PRIVATE_V4.some((re) => re.test(ip))) return true;
  if (ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80')) return true;
  return false;
}

/**
 * 요청의 "공인 IP" 를 판정한다.
 * TRUST_PROXY_HOPS 만큼만 X-Forwarded-For 의 오른쪽에서 건너뛴 값을 취한다.
 * 프록시를 신뢰하지 않는 설정(기본값)에서는 헤더를 완전히 무시하므로,
 * 공격자가 X-Forwarded-For 를 위조해 IP 바인딩을 우회할 수 없다.
 */
function publicIp(req) {
  const socketIp = normalize(req.socket?.remoteAddress || req.ip);
  const hops = config.TRUST_PROXY_HOPS;
  if (hops <= 0) return socketIp;

  const raw = req.headers['x-forwarded-for'];
  if (!raw) return socketIp;
  const chain = String(raw).split(',').map(normalize).filter(Boolean);
  if (!chain.length) return socketIp;

  // 오른쪽 끝이 가장 가까운 프록시. hops 만큼 신뢰하고 그 왼쪽 값을 클라이언트로 본다.
  const idx = chain.length - hops;
  return chain[Math.max(0, Math.min(idx, chain.length - 1))] || socketIp;
}

module.exports = { publicIp, normalize, isPrivate };
