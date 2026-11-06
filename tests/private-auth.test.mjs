import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateGate, validatePrivateConfiguration } from '../lib/runtime/private-auth.js';
import { probeUpstreamAuthentication } from '../lib/wuwaterm-proxy.js';

const EDGE = 'synthetic_edge_marker_0123456789abcdef';
const BASE = {
  WUWATERM_RUNTIME_MODE: 'selfhost',
  WUWATERM_WEB_ORIGIN: 'https://web.test',
  WUWATERM_WEB_EDGE_SECRET: EDGE,
  WUWATERM_API_BASE_URL: 'http://127.0.0.1:8451/',
  WUWATERM_SITE_DEVICE_TOKEN: 'synthetic-device-token',
};
function request(path, { method = 'GET', edge = EDGE, cookie, origin, site, dest } = {}) {
  const headers = {};
  if (edge) headers['x-wuwaterm-edge'] = edge;
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  if (site) headers['sec-fetch-site'] = site;
  if (dest) headers['sec-fetch-dest'] = dest;
  return new Request(`https://web.test${path}`, { method, headers });
}

test('private startup rejects missing protection, unsafe origin, mismatched prefix and invalid TTL', () => {
  assert.throws(() => validatePrivateConfiguration({ ...BASE, WUWATERM_WEB_EDGE_SECRET: '' }, ''));
  assert.throws(() => validatePrivateConfiguration({ ...BASE, WUWATERM_WEB_ORIGIN: 'http://web.test' }, ''));
  assert.throws(() => validatePrivateConfiguration({ ...BASE, WUWATERM_WEB_ORIGIN: 'https://web.test/path' }, ''));
  assert.throws(() => validatePrivateConfiguration({ ...BASE, WUWATERM_WEB_BASE_PATH: '/other' }, '/private'));
  assert.throws(() => validatePrivateConfiguration({ ...BASE, WUWATERM_WEB_SESSION_TTL_SECONDS: '0' }, ''));
  assert.equal(validatePrivateConfiguration(BASE, '/private').path, '/private');
});

test('edge checked first, navigation mints a scoped session, unsafe methods require session and origin', async () => {
  let probes = 0;
  const admit = createPrivateGate(BASE, '/private', { probe: async () => { probes += 1; return 'valid'; } });
  assert.equal((await admit(request('/private/', { edge: '' }))).status, 403);
  assert.equal((await admit(request('/private/', { edge: 'wrong' }))).status, 403);
  assert.equal((await admit(request('/private/_next/static/app.js'))).status, 401);
  assert.equal((await admit(request('/private/api/reviews', { method: 'POST', origin: BASE.WUWATERM_WEB_ORIGIN }))).status, 401);
  assert.equal(probes, 0);
  const minted = await admit(request('/private/', { dest: 'document', site: 'none' }));
  assert.equal(minted.status, 200);
  assert.match(minted.cookie, /; Path=\/private; HttpOnly; Secure; SameSite=Strict$/u);
  const cookie = minted.cookie.split(';')[0];
  assert.equal((await admit(request('/private/_next/static/app.js', { cookie, dest: 'script', site: 'same-origin' }))).status, 200);
  assert.equal((await admit(request('/private/api/reviews', { method: 'POST', cookie }))).status, 403);
  assert.equal((await admit(request('/private/api/reviews', { method: 'POST', cookie, origin: 'https://elsewhere.test' }))).status, 403);
  assert.equal((await admit(request('/private/api/reviews', { method: 'POST', cookie, origin: BASE.WUWATERM_WEB_ORIGIN, site: 'cross-site' }))).status, 403);
  assert.equal((await admit(request('/private/api/reviews', { method: 'POST', cookie, origin: BASE.WUWATERM_WEB_ORIGIN, site: 'same-origin' }))).status, 200);
});

test('expiry and upstream revocation remove the session; failed liveness is never admission', async () => {
  let now = 1_000;
  let state = 'valid';
  const admit = createPrivateGate({ ...BASE, WUWATERM_WEB_SESSION_TTL_SECONDS: '2' }, '', { clock: () => now, probe: async () => state });
  let minted = await admit(request('/'));
  let cookie = minted.cookie.split(';')[0];
  now += 2_000;
  assert.equal((await admit(request('/api/pool', { cookie }))).status, 401);
  minted = await admit(request('/'));
  cookie = minted.cookie.split(';')[0];
  state = 'unavailable';
  assert.equal((await admit(request('/api/pool', { cookie }))).status, 503);
  state = 'valid';
  assert.equal((await admit(request('/api/pool', { cookie }))).status, 200);
  state = 'rejected';
  assert.equal((await admit(request('/api/pool', { cookie }))).status, 401);
  state = 'valid';
  assert.equal((await admit(request('/api/pool', { cookie }))).status, 401);
});

test('simultaneous requests share only the in-flight liveness probe', async () => {
  let probes = 0;
  const admit = createPrivateGate(BASE, '', { probe: async () => { probes += 1; await new Promise(resolve => setTimeout(resolve, 10)); return 'valid'; } });
  const { cookie: fullCookie } = await admit(request('/'));
  const cookie = fullCookie.split(';')[0];
  const results = await Promise.all(Array.from({ length: 8 }, () => admit(request('/api/pool', { cookie }))));
  assert.ok(results.every(item => item.status === 200));
  assert.equal(probes, 2);
  assert.equal((await admit(request('/api/pool', { cookie }))).status, 200);
  assert.equal(probes, 3);
});

test('liveness sends only the server-held bearer and requires a no-store empty Core status', async () => {
  const seen = [];
  const fetcher = async (url, options) => {
    seen.push({ url, options });
    return new Response(null, { status: 204, headers: { 'cache-control': 'private, no-store' } });
  };
  assert.equal(await probeUpstreamAuthentication(BASE, fetcher), 'valid');
  assert.equal(seen[0].url.pathname, '/v1/auth/status');
  assert.equal(seen[0].options.method, 'GET');
  assert.equal(seen[0].options.redirect, 'manual');
  assert.equal(seen[0].options.credentials, 'omit');
  assert.equal(seen[0].options.cache, 'no-store');
  assert.deepEqual(Object.keys(seen[0].options.headers).sort(), ['accept', 'authorization']);
  assert.ok(seen[0].options.headers.authorization === `Bearer ${BASE.WUWATERM_SITE_DEVICE_TOKEN}`);
  for (const status of [401, 403]) {
    assert.equal(await probeUpstreamAuthentication(BASE, async () => new Response('', { status })), 'rejected');
  }
  for (const status of [429, 503]) {
    assert.equal(await probeUpstreamAuthentication(BASE, async () => new Response('', { status })), 'unavailable');
  }
  assert.equal(await probeUpstreamAuthentication(BASE, async () => new Response('', { status: 302, headers: { location: 'https://elsewhere.test' } })), 'unavailable');
  assert.equal(await probeUpstreamAuthentication(BASE, async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })), 'unavailable');
  assert.equal(await probeUpstreamAuthentication(BASE, async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })), 'unavailable');
  assert.equal(await probeUpstreamAuthentication(BASE, async () => new Response(null, { status: 204 })), 'unavailable');
  assert.equal(await probeUpstreamAuthentication(BASE, async () => new Response(null, { status: 204, headers: { 'cache-control': 'no-store', 'content-length': '1' } })), 'unavailable');
  assert.equal(await probeUpstreamAuthentication(BASE, async () => new Response(null, { status: 204, headers: { 'cache-control': 'no-store', 'transfer-encoding': 'chunked' } })), 'unavailable');
  let cancelled = false;
  const unexpectedBody = {
    status: 204, headers: new Headers({ 'cache-control': 'no-store' }),
    body: { cancel() { cancelled = true; } },
  };
  assert.equal(await probeUpstreamAuthentication(BASE, async () => unexpectedBody), 'unavailable');
  assert.equal(cancelled, true);
  assert.equal(await probeUpstreamAuthentication(BASE, async () => { throw new Error('network unavailable'); }), 'unavailable');
});

test('liveness times out and fails closed when the Core status request stalls', async () => {
  let aborted = false;
  const result = await probeUpstreamAuthentication(BASE, async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
  }));
  assert.equal(result, 'unavailable');
  assert.equal(aborted, true);
});
