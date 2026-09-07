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

  if (config.CLIENT_IP_HEADER) {
    const raw = req.headers[config.CLIENT_IP_HEADER];
    if (raw) {
      const ip = normalize(String(raw).split(',')[0]);
      if (ip) return { ip, source: `header:${config.CLIENT_IP_HEADER}`, socketIp };
    }
  }

  // 자동 복구: 소켓 IP 가 사설/CGNAT 이면 우리는 확실히 프록시 뒤에 있다.
  // 이때 Envoy 가 직접 세팅하는 x-envoy-external-address 가 있으면 그것을 쓴다.
  // (Envoy 는 외부 요청에서 x-envoy-* 헤더를 정리하므로 클라이언트가 위조할 수 없다.)
  // Railway 가 RAILWAY_* 환경변수를 주입하지 않는 경우에도 동작하도록 하기 위한 안전망.
  if (!config.CLIENT_IP_HEADER && isPrivate(socketIp)) {
    const envoy = req.headers['x-envoy-external-address'];
    if (envoy) {
      const ip = normalize(String(envoy).split(',')[0]);
      if (ip && !isPrivate(ip)) {
        return { ip, source: 'header:x-envoy-external-address (auto)', socketIp };
      }
    }
  }

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
