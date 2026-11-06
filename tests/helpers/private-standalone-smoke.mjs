// Exercise the actual built Next server's access boundary. The loopback
// upstream is only an authentication fixture, not a translation/review test.
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const prefix = process.argv[2] || '';
const check = (condition, message) => { if (!condition) throw new Error(message); };
const edge = randomBytes(32).toString('base64url');
const token = randomBytes(32).toString('base64url');
const origin = 'https://web.test';
let revoked = false;
let temporarilyUnavailable = 0;
let authCalls = 0;
const api = createServer((request, response) => {
  if (request.url !== '/v1/auth/status') { response.writeHead(404).end(); return; }
  authCalls += 1;
  if (revoked || request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return; }
  if (temporarilyUnavailable) { response.writeHead(temporarilyUnavailable).end(); return; }
  response.writeHead(204, { 'cache-control': 'no-store' }).end();
});
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => server.close(resolve));
const stop = async child => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  process.kill(-child.pid, 'SIGTERM');
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(5_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    process.kill(-child.pid, 'SIGKILL');
    await new Promise(resolve => child.once('exit', resolve));
  }
};
let child;
try {
  await listen(api);
  const reservation = createServer();
  await listen(reservation);
  const port = reservation.address().port;
  await close(reservation);
  const state = mkdtempSync(join(process.env.TASK_STATE_ROOT, 'private-auth-'));
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
    HOSTNAME: '127.0.0.1', PORT: String(port), WUWATERM_RUNTIME_MODE: 'selfhost',
    WUWATERM_LOCAL_DB_PATH: join(state, 'admission.sqlite'), WUWATERM_TRANSLATION_ENABLED: 'true',
    WUWATERM_API_BASE_URL: `http://127.0.0.1:${api.address().port}/`, WUWATERM_SITE_DEVICE_TOKEN: token,
    WUWATERM_WEB_ORIGIN: origin, WUWATERM_WEB_EDGE_SECRET: edge, WUWATERM_WEB_BASE_PATH: prefix,
  };
  // Exercise the documented launcher, which imports the packaged server.
  const command = join(process.cwd(), 'scripts/start-selfhost.mjs');
  const invalid = spawn(process.execPath, [command], {
    cwd: process.cwd(), env: { PATH: env.PATH, HOME: env.HOME, PORT: String(port), HOSTNAME: '127.0.0.1', NODE_ENV: 'production' },
    detached: true, stdio: 'ignore',
  });
  const invalidExit = await Promise.race([new Promise(resolve => invalid.once('exit', resolve)), delay(10_000).then(() => null)]);
  await stop(invalid);
  check(invalidExit !== null && invalidExit !== 0, 'missing private configuration did not fail startup');
  child = spawn(process.execPath, [command], { cwd: process.cwd(), env, detached: true, stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error('standalone server exited before readiness');
    try { await fetch(url + prefix + '/', { redirect: 'manual' }); ready = true; break; }
    catch { await delay(100); }
  }
  check(ready, 'standalone server did not become ready');
  async function get(path, options = {}) {
    return fetch(url + prefix + path, { ...options, redirect: 'manual' });
  }
  const requestsBeforeEdge = authCalls;
  const protectedPaths = ['/', '/privacy', '/limits', '/api/meta', '/api/pool', '/api/terms?q=x', '/api/translations', '/api/reviews', '/_next/static/missing.js', '/robots.txt'];
  for (const [index, path] of protectedPaths.entries()) {
    const response = await get(path);
    check(response.status === 403, `edge denial case ${index} returned ${response.status}`);
  }
  check(authCalls === requestsBeforeEdge, 'missing edge marker reached backend');
  const headers = { 'x-wuwaterm-edge': edge };
  check((await get('/api/pool', { headers })).status === 401, 'API minted a session');
  check((await get('/_next/static/missing.js', { headers })).status === 401, 'static resource minted a session');
  check((await get('/api/reviews', { method: 'POST', headers: { ...headers, origin } })).status === 401, 'POST minted a session');
  const page = await get('/', { headers: { ...headers, 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none' } });
  check(page.status === 200, 'authenticated navigation failed');
  const cookie = page.headers.get('set-cookie');
  check(cookie && cookie.includes(`Path=${prefix || '/'}`) && cookie.includes('HttpOnly') && cookie.includes('Secure') && cookie.includes('SameSite=Strict'), 'session cookie attributes differ');
  const session = cookie.split(';')[0];
  const html = await page.text();
  check(html.includes('自托管') && !html.includes('匿名公测'), 'private page did not use self-host copy');
  check(html.includes(`href="${prefix}/limits"`) && html.includes(`href="${prefix}/privacy"`), 'private navigation omitted its base path');
  const asset = html.match(/(?:src|href)="([^"]*\/_next\/static\/[^"?]+\.(?:js|css))(?:\?[^"]*)?"/u)?.[1];
  check(asset && asset.startsWith(prefix + '/_next/static/'), 'prefix-aware built asset was absent');
  const authorized = { ...headers, cookie: session, 'sec-fetch-site': 'same-origin' };
  const staticResponse = await fetch(url + asset, { headers: authorized });
  check(staticResponse.status === 200, 'authenticated built asset did not load');
  check(staticResponse.headers.get('cache-control')?.includes('no-store'), 'private built asset was cacheable');
  if (prefix) {
    check((await fetch(url + asset.slice(prefix.length), { headers: authorized, redirect: 'manual' })).status !== 200, 'asset escaped its base path');
    check((await fetch(url + '/api/pool', { headers: authorized, redirect: 'manual' })).status !== 200, 'API escaped its base path');
  }
  const privacyPage = await get('/privacy', { headers: authorized });
  check(privacyPage.status === 200, 'authenticated private page failed');
  check((await privacyPage.text()).includes('安全会话 cookie'), 'private privacy notice omitted the session cookie');
  const limitsPage = await get('/limits', { headers: authorized });
  check(limitsPage.status === 200, 'authenticated limits page failed');
  check((await limitsPage.text()).includes('<td>—</td>'), 'private limits page displayed defaults before loading instance configuration');
  check((await get('/api/pool', { headers: authorized })).status === 200, 'authenticated pool API failed');
  for (const status of [429, 503]) {
    temporarilyUnavailable = status;
    check((await get('/api/pool', { headers: authorized })).status === 503, 'unavailable Core status did not fail closed');
    temporarilyUnavailable = 0;
    check((await get('/api/pool', { headers: authorized })).status === 200, 'temporary Core failure discarded the session');
  }
  check((await get('/api/translations', { method: 'POST', headers: authorized, body: '{}' })).status === 403, 'unsafe request without Origin passed');
  check((await get('/api/reviews', { method: 'POST', headers: { ...authorized, origin: 'https://other.test' }, body: '{}' })).status === 403, 'cross-origin POST passed');
  check((await get('/api/reviews', { method: 'POST', headers: { ...authorized, origin, 'content-type': 'application/json' }, body: '{}' })).status === 400, 'same-origin POST did not reach the API parser');
  revoked = true;
  check((await get('/privacy', { headers: authorized })).status === 401, 'revoked session reached private page');
  check((await fetch(url + asset, { headers: authorized })).status === 401, 'revoked session reached asset');
  check((await get('/api/pool', { headers: authorized })).status === 401, 'revoked session reached API');
  revoked = false;
  check((await get('/api/pool', { headers: authorized })).status === 401, 'revoked session was retained');
  await stop(child);
  child = spawn(process.execPath, [command], { cwd: process.cwd(), env, detached: true, stdio: 'ignore' });
  let restarted = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error('standalone server exited after restart');
    try { await get('/'); restarted = true; break; }
    catch { await delay(100); }
  }
  check(restarted, 'standalone server did not restart');
  check((await get('/api/pool', { headers: authorized })).status === 401, 'session survived a server restart');
  console.log('Standalone private auth: startup, edge, pages, assets, API, origin, session and revocation passed');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await stop(child);
  if (api.listening) await close(api);
}
