'use strict';
const config = require('../config');

const PRIVATE_V4 = [
  /^10\./, /^127\./, /^192\.168\./, /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./, // CGNAT 100.64.0.0/10 — Railway 내부망
];

function normalize(ip) {
  if (!ip) return '';
  let v = String(ip).trim();
  const bracket = v.match(/^\[(.+)\](?::\d+)?$/); // [::1]:443
  if (bracket) v = bracket[1];
  if (v.startsWith('::ffff:')) v = v.slice(7);    // IPv4-mapped IPv6
  // IPv4 뒤에 붙은 포트만 떼어낸다 (IPv6 는 콜론이 많으므로 건드리지 않는다)
  const v4port = v.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (v4port) v = v4port[1];
  if (v === '::1') v = '127.0.0.1';
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
 * 요청의 "공인 IP" 를 판정한다. 우선순위:
 *
 *  1) CLIENT_IP_HEADER — 플랫폼 엣지가 직접 세팅하는 신뢰 헤더.
 *     Railway(Envoy) 는 x-envoy-external-address 를 엣지에서 덮어쓰므로
 *     클라이언트가 위조할 수 없다. Railway 감지 시 자동으로 켜진다.
 *
 *  2) X-Forwarded-For + TRUST_PROXY_HOPS — 일반 리버스 프록시(nginx 등).
 *     오른쪽 끝이 가장 가까운 프록시이므로 hops 만큼 신뢰하고 그 왼쪽 값을 클라이언트로 본다.
 *     XFF 는 클라이언트가 앞쪽에 값을 끼워넣을 수 있어 hops 를 실제 구성과 정확히 맞춰야 한다.
 *
 *  3) 소켓 IP — 프록시가 없는 경우.
 *
 * 반환값이 사설/CGNAT 주소면 프록시 설정이 틀렸다는 뜻이므로 detail.suspect 로 알린다.
 */
function resolve(req) {
  const socketIp = normalize(req.socket?.remoteAddress || req.ip);

  // Railway 에서는 엣지가 x-real-ip 를 항상 덮어쓰므로 클라이언트가 위조할 수 없다.
  // 이 판정은 세션 경계를 지키는 보안 통제이므로, CLIENT_IP_HEADER 를 잘못 지정하더라도
  // 우회되지 않도록 Railway 에서는 x-real-ip 를 가장 먼저 신뢰한다.
  if (config.IS_RAILWAY) {
    const realIp = req.headers['x-real-ip'];
    if (realIp) {
      const ip = normalize(String(realIp).split(',')[0]);
      if (ip) return { ip, source: 'header:x-real-ip (railway)', socketIp };
    }
  }

  if (config.CLIENT_IP_HEADER) {
    const raw = req.headers[config.CLIENT_IP_HEADER];
    if (raw) {
      const ip = normalize(String(raw).split(',')[0]);
      if (ip) return { ip, source: `header:${config.CLIENT_IP_HEADER}`, socketIp };
    }
  }

  // 주의: 설정되지 않은 헤더를 "있으면 믿는" 식의 자동 복구를 두지 않는다.
  // 플랫폼이 그 헤더를 덮어쓰지 않으면 누구나 값을 넣어 IP 바인딩을 우회할 수 있다.
  // 신뢰 헤더는 반드시 CLIENT_IP_HEADER 로 명시하거나 플랫폼 감지로만 결정한다.

  const hops = config.TRUST_PROXY_HOPS;
  if (hops > 0) {
    const raw = req.headers['x-forwarded-for'];
    if (raw) {
      const chain = String(raw).split(',').map(normalize).filter(Boolean);
      if (chain.length) {
        const idx = Math.max(0, Math.min(chain.length - hops, chain.length - 1));
        return { ip: chain[idx], source: `x-forwarded-for[${idx}] (hops=${hops})`, socketIp, chain };
      }
    }
  }

  return { ip: socketIp, source: 'socket', socketIp };
}

function publicIp(req) {
  return resolve(req).ip;
}

module.exports = { publicIp, resolve, normalize, isPrivate };
