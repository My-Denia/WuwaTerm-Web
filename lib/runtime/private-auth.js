import { randomBytes, timingSafeEqual } from 'node:crypto';
import { probeUpstreamAuthentication } from '../wuwaterm-proxy.js';

const COOKIE = 'wuwaterm_web_session';
const EDGE_HEADER = 'x-wuwaterm-edge';
const MAX_SESSIONS = 128;

function invalidConfiguration() {
  return new Error('Invalid self-host private access configuration');
}

export function validatePrivateConfiguration(source, basePath) {
  if (source.WUWATERM_RUNTIME_MODE !== 'selfhost'
    || typeof basePath !== 'string'
    || (basePath !== '' && !/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/u.test(basePath))
    || (source.WUWATERM_WEB_BASE_PATH !== undefined && source.WUWATERM_WEB_BASE_PATH !== basePath)) throw invalidConfiguration();
  const edgeSecret = source.WUWATERM_WEB_EDGE_SECRET;
  if (typeof edgeSecret !== 'string' || !/^[a-zA-Z0-9_-]{32,128}$/u.test(edgeSecret)) throw invalidConfiguration();
  let origin;
  try { origin = new URL(source.WUWATERM_WEB_ORIGIN); } catch { throw invalidConfiguration(); }
  if (origin.protocol !== 'https:' || origin.username || origin.password
    || origin.origin !== source.WUWATERM_WEB_ORIGIN || origin.pathname !== '/'
    || origin.search || origin.hash) throw invalidConfiguration();
  const ttlValue = source.WUWATERM_WEB_SESSION_TTL_SECONDS ?? '900';
  if (!/^[1-9][0-9]*$/u.test(ttlValue)) throw invalidConfiguration();
  const ttl = Number(ttlValue);
  if (!Number.isSafeInteger(ttl) || ttl > 86_400) throw invalidConfiguration();
  return { edgeSecret, origin: origin.origin, path: basePath || '/', basePath, ttl };
}

function edgeMatches(presented, expected) {
  if (typeof presented !== 'string') return false;
  const actual = Buffer.from(presented, 'utf8');
  const required = Buffer.from(expected, 'utf8');
  return actual.length === required.length && timingSafeEqual(actual, required);
}

function sessionCookie(request) {
  const pairs = (request.headers.get('cookie') || '').split(';');
  const values = pairs.map(pair => pair.trim()).filter(pair => pair.startsWith(`${COOKIE}=`));
  if (values.length !== 1) return null;
  const value = values[0].slice(COOKIE.length + 1);
  return /^[a-zA-Z0-9_-]{43}$/u.test(value) ? value : null;
}

function canMint(request, basePath) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const destination = request.headers.get('sec-fetch-dest');
  if (destination && destination !== 'document') return false;
  let path = new URL(request.url).pathname;
  if (basePath && (path === basePath || path.startsWith(`${basePath}/`))) path = path.slice(basePath.length) || '/';
  return ['/', '/privacy', '/limits'].includes(path);
}

// A session lives only in this server process. Parallel asset requests share an
// in-flight liveness check, but no result is cached once that check completes.
export function createPrivateGate(source, basePath, options = {}) {
  const config = validatePrivateConfiguration(source, basePath);
  const sessions = new Map();
  const clock = options.clock ?? Date.now;
  const probe = options.probe ?? (() => probeUpstreamAuthentication(source));
  let pendingProbe;
  async function live() {
    if (!pendingProbe) {
      pendingProbe = Promise.resolve().then(probe).catch(() => 'unavailable')
        .finally(() => { pendingProbe = undefined; });
    }
    return pendingProbe;
  }
  return async function admit(request) {
    if (!edgeMatches(request.headers.get(EDGE_HEADER), config.edgeSecret)) return { status: 403 };
    const fetchSite = request.headers.get('sec-fetch-site');
    if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return { status: 403 };
    const now = clock();
    for (const [id, expires] of sessions) if (expires <= now) sessions.delete(id);
    const id = sessionCookie(request);
    const known = id !== null && sessions.has(id);
    const safe = request.method === 'GET' || request.method === 'HEAD';
    if (!safe && request.headers.get('origin') !== config.origin) return { status: 403 };
    if (!known && !canMint(request, config.basePath)) return { status: 401 };
    const result = await live();
    if (result !== 'valid') {
      if (result === 'rejected' && known) sessions.delete(id);
      return { status: result === 'rejected' ? 401 : 503 };
    }
    if (known) return { status: 200 };
    while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    const session = randomBytes(32).toString('base64url');
    sessions.set(session, now + config.ttl * 1000);
    return {
      status: 200,
      cookie: `${COOKIE}=${session}; Max-Age=${config.ttl}; Path=${config.path}; HttpOnly; Secure; SameSite=Strict`,
    };
  };
}
