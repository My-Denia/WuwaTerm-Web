// Unit tests for Part 1: GET /api/dictionary proxy, capability gating, schema validation,
// quota charging (kind = 'meta'), sensitive value redaction, and bounded server-side TTL cache.
import assert from 'node:assert/strict';
import test from 'node:test';
import { GET as getDictionaryRoute } from '../app/api/dictionary/route.ts';
import { NODE_ENVIRONMENT } from '../lib/runtime/node.js';
import { RuntimeStore } from '../lib/runtime-store.ts';
import { POOL_LIMITS } from '../lib/shared-pool.js';
import { CAPABILITY_DICTIONARY_IDENTITY, projectCapabilities } from '../lib/semantic-review.js';
import { resolveTmAutoReuseBasisFromRuntime } from '../lib/tm-live-provenance.ts';
import { proxyCapabilitiesRequest, proxyDictionaryRequest } from '../lib/wuwaterm-proxy.js';
import { createPool, fixtureEnvironment } from './helpers/pool-fixture.mjs';

const REV = 'd9f5e4ae' + '0'.repeat(56);
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});
const validCoreDict = (over = {}) => ({
  revision: REV,
  schema_version: '2',
  source_commit: '9ddee819abcd',
  source_game_version: '3.7.0',
  term_count: 12097,
  request_id: 'req-dict-1',
  ...over,
});

function makeUpstream({ capabilities = [CAPABILITY_DICTIONARY_IDENTITY], capStatus = 200, dict = validCoreDict, dictStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    const path = url.pathname.replace('/wuwaterm-api/', '');
    calls.push(path);
    if (path === 'v1/capabilities') {
      return capStatus === 404
        ? new Response('not found', { status: 404 })
        : json({ api_version: 'v1', capabilities, request_id: 'req-caps' }, capStatus);
    }
    if (path === 'v1/dictionary') {
      const payload = typeof dict === 'function' ? dict() : dict;
      return json(payload, dictStatus);
    }
    throw new Error(`unexpected path: ${path}`);
  };
  return { fetchImpl, calls, count: (p) => calls.filter(x => x === p).length };
}

test('dictionary-identity-v1 passes through projectCapabilities and proxyCapabilitiesRequest', async () => {
  assert.deepEqual(
    projectCapabilities({ capabilities: [CAPABILITY_DICTIONARY_IDENTITY, 'unknown-cap'], request_id: 'r1' }),
    { capabilities: [CAPABILITY_DICTIONARY_IDENTITY], request_id: 'r1' },
  );
  const up = makeUpstream({ capabilities: [CAPABILITY_DICTIONARY_IDENTITY, 'future-v9'] });
  const response = await proxyCapabilitiesRequest({ environment: fixtureEnvironment(null), fetchImpl: up.fetchImpl });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { capabilities: [CAPABILITY_DICTIONARY_IDENTITY], request_id: 'req-caps' });
});

test('proxyDictionaryRequest returns 503 dictionary_identity_unavailable without calling Core /v1/dictionary or charging quota when capability absent', async () => {
  for (const opts of [{ capabilities: [] }, { capStatus: 404 }]) {
    const DB = createPool();
    try {
      const env = fixtureEnvironment(DB);
      const up = makeUpstream(opts);
      const res = await proxyDictionaryRequest({ environment: env, fetchImpl: up.fetchImpl });
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { status: 'unavailable', reason: 'dictionary_identity_unavailable' });
      assert.equal(up.count('v1/dictionary'), 0);
      assert.equal(DB.count(), 0);
    } finally {
      DB.close();
    }
  }
});

test('proxyDictionaryRequest projects Core schema, charges meta quota, caches 60s success / 10s error, and rejects malformed or sensitive payloads', async () => {
  const DB = createPool();
  try {
    const env = fixtureEnvironment(DB);
    let clock = 1_700_000_000_000;
    const up = makeUpstream();

    const first = await proxyDictionaryRequest({ environment: env, fetchImpl: up.fetchImpl, now: () => clock });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), {
      revision: REV,
      schema_version: '2',
      source_commit: '9ddee819abcd',
      game_version: '3.7.0',
      term_count: 12097,
      request_id: 'req-dict-1',
    });
    assert.equal(up.count('v1/dictionary'), 1);
    assert.equal(DB.row().meta_used, 1);
    assert.equal(DB.row().review_used, 0);
    assert.equal(DB.row().translation_used, 0);

    // Within 60s TTL: served from server cache with 0 upstream calls and 0 additional quota debit.
    clock += 59_000;
    const cached = await proxyDictionaryRequest({ environment: env, fetchImpl: up.fetchImpl, now: () => clock });
    assert.equal(cached.status, 200);
    assert.equal((await cached.json()).revision, REV);
    assert.equal(up.count('v1/dictionary'), 1);
    assert.equal(DB.row().meta_used, 1);

    // After 60s TTL: refreshes upstream (advance pool second so 1/s gate allows admission).
    clock += 2_000;
    DB.prepare('UPDATE shared_pool SET second_key = second_key - 5 WHERE id = 1').first();
    const refreshed = await proxyDictionaryRequest({ environment: env, fetchImpl: up.fetchImpl, now: () => clock });
    assert.equal(refreshed.status, 200);
    assert.equal(up.count('v1/dictionary'), 2);
    assert.equal(DB.row().meta_used, 2);
  } finally {
    DB.close();
  }

  // Upstream error cached for 10s.
  {
    const DB = createPool();
    try {
      const env = fixtureEnvironment(DB);
      let clock = 1_700_000_000_000;
      const up = makeUpstream({
        dict: () => ({ error: { code: 'internal', message: 'boom' }, request_id: 'req-err' }),
        dictStatus: 503,
      });
      const r1 = await proxyDictionaryRequest({ environment: env, fetchImpl: up.fetchImpl, now: () => clock });
      assert.equal(r1.status, 503);
      assert.equal((await r1.json()).reason, 'upstream_unavailable');
      assert.equal(up.count('v1/dictionary'), 1);

      clock += 9_000;
      const r2 = await proxyDictionaryRequest({ environment: env, fetchImpl: up.fetchImpl, now: () => clock });
      assert.equal(r2.status, 503);
      assert.equal(up.count('v1/dictionary'), 1);

      clock += 2_000;
      DB.prepare('UPDATE shared_pool SET second_key = second_key - 5 WHERE id = 1').first();
      const r3 = await proxyDictionaryRequest({ environment: env, fetchImpl: up.fetchImpl, now: () => clock });
      assert.equal(r3.status, 503);
      assert.equal(up.count('v1/dictionary'), 2);
    } finally {
      DB.close();
    }
  }

  // Malformed or secret-leaking responses fail closed with 502 upstream_schema_mismatch.
  const badBodies = [
    validCoreDict({ revision: 'not-hex' }),
    validCoreDict({ revision: 'A'.repeat(64) }),
    validCoreDict({ term_count: -1 }),
    validCoreDict({ extra: 1 }),
    validCoreDict({ source_commit: fixtureEnvironment(null).WUWATERM_SITE_DEVICE_TOKEN }),
  ];
  for (const bad of badBodies) {
    const DB = createPool();
    try {
      const env = fixtureEnvironment(DB);
      const up = makeUpstream({ dict: bad });
      const res = await proxyDictionaryRequest({ environment: env, fetchImpl: up.fetchImpl });
      assert.equal(res.status, 502);
      assert.equal((await res.json()).reason, 'upstream_schema_mismatch');
    } finally {
      DB.close();
    }
  }
});

test('forceRefresh bypasses the 60s proxyDictionaryRequest cache within 15s and refreshes cached identity', async () => {
  const DB = createPool();
  const REV_2 = 'e'.repeat(64);
  let clock = 1_700_000_000_000;
  let activeDict = validCoreDict();
  try {
    const env = fixtureEnvironment(DB);
    const up = makeUpstream({ dict: () => activeDict });

    // Initial read populates 60s server proxy cache with REV.
    const first = await proxyDictionaryRequest({ environment: env, fetchImpl: up.fetchImpl, now: () => clock });
    assert.equal(first.status, 200);
    assert.equal((await first.json()).revision, REV);
    assert.equal(up.count('v1/dictionary'), 1);

    // 15s later (inside 60s proxy TTL), upstream rotates to REV_2.
    clock += 15_000;
    DB.prepare('UPDATE shared_pool SET second_key = second_key - 5 WHERE id = 1').first();
    activeDict = validCoreDict({ revision: REV_2, source_game_version: '3.8.0', request_id: 'req-dict-2' });

    // Non-forced display read still hits 60s proxy cache and returns REV.
    const cached = await proxyDictionaryRequest({ environment: env, fetchImpl: up.fetchImpl, now: () => clock });
    assert.equal(cached.status, 200);
    assert.equal((await cached.json()).revision, REV);
    assert.equal(up.count('v1/dictionary'), 1);

    // RuntimeStore + resolveTmAutoReuseBasisFromRuntime sends ?refresh=1 -> penetrates 60s proxy cache!
    const seenPaths = [];
    const runtime = new RuntimeStore({
      pool: false,
      now: () => clock,
      fetch: async (path) => {
        const parsed = new URL(path, 'http://127.0.0.1');
        seenPaths.push(path);
        if (parsed.pathname === '/api/capabilities') {
          return proxyCapabilitiesRequest({ environment: env, fetchImpl: up.fetchImpl });
        }
        if (parsed.pathname === '/api/dictionary') {
          return proxyDictionaryRequest({
            environment: env,
            fetchImpl: up.fetchImpl,
            now: () => clock,
            forceRefresh: parsed.searchParams.get('refresh') === '1',
          });
        }
        throw new Error(`Unexpected path: ${path}`);
      },
    });
    // Pre-warm RuntimeStore with normal load (hits 60s cache -> REV), then rotate check via resolveTmAutoReuseBasisFromRuntime.
    await runtime.loadDictionary();
    assert.equal(runtime.getSnapshot().dictionary.data.revision, REV);
    assert.equal(up.count('v1/dictionary'), 1);

    const basis = await resolveTmAutoReuseBasisFromRuntime(runtime, null, { now: clock });
    assert.deepEqual(seenPaths, ['/api/capabilities', '/api/dictionary', '/api/dictionary?refresh=1']);
    assert.equal(up.count('v1/dictionary'), 2);
    assert.deepEqual(basis, { currentTermsDbRevision: REV_2, currentGameVersion: '3.8.0' });

    // Proxy cache is now updated to REV_2, so subsequent normal display read sees REV_2 without extra upstream fetch.
    const afterCached = await proxyDictionaryRequest({ environment: env, fetchImpl: up.fetchImpl, now: () => clock });
    assert.equal(afterCached.status, 200);
    assert.equal((await afterCached.json()).revision, REV_2);
    assert.equal(up.count('v1/dictionary'), 2);
  } finally {
    DB.close();
  }

  // Verify /api/dictionary ignores Cache-Control: no-cache (attached automatically by fetch cache: 'no-store')
  // and only bypasses the 60s cache on explicit ?refresh=1.
  const prevMode = process.env.WUWATERM_RUNTIME_MODE;
  const prevEnv = globalThis[NODE_ENVIRONMENT];
  const DB2 = createPool();
  const prevFetch = globalThis.fetch;
  try {
    let routeDict = validCoreDict({ revision: REV });
    let upstreamCount = 0;
    const env2 = {
      ...fixtureEnvironment(DB2),
      WUWATERM_RUNTIME_MODE: 'selfhost',
      WUWATERM_LOCAL_LIMITS: POOL_LIMITS,
    };
    process.env.WUWATERM_RUNTIME_MODE = 'selfhost';
    globalThis[NODE_ENVIRONMENT] = env2;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.endsWith('/v1/capabilities')) {
        return json({ api_version: 'v1', capabilities: [CAPABILITY_DICTIONARY_IDENTITY], request_id: 'cap-route' });
      }
      if (u.endsWith('/v1/dictionary')) {
        upstreamCount += 1;
        return json(routeDict);
      }
      throw new Error(`Unexpected fetch: ${u}`);
    };

    const r1 = await getDictionaryRoute(new Request('http://127.0.0.1/api/dictionary', {
      headers: { 'cache-control': 'no-cache' },
    }));
    assert.equal(r1.status, 200);
    assert.equal((await r1.json()).revision, REV);
    assert.equal(upstreamCount, 1);

    routeDict = validCoreDict({ revision: REV_2, request_id: 'req-route-2' });

    // Concurrent same-second normal display read carrying Cache-Control: no-cache MUST hit 60s BFF cache (200, NOT 429)!
    const rNoCacheSameSec = await getDictionaryRoute(new Request('http://127.0.0.1/api/dictionary', {
      headers: { 'cache-control': 'no-cache' },
    }));
    assert.equal(rNoCacheSameSec.status, 200);
    assert.equal((await rNoCacheSameSec.json()).revision, REV);
    assert.equal(upstreamCount, 1);

    DB2.prepare('UPDATE shared_pool SET second_key = second_key - 5 WHERE id = 1').first();

    const rNoCacheNextSec = await getDictionaryRoute(new Request('http://127.0.0.1/api/dictionary', {
      headers: { 'cache-control': 'no-cache' },
    }));
    assert.equal(rNoCacheNextSec.status, 200);
    assert.equal((await rNoCacheNextSec.json()).revision, REV);
    assert.equal(upstreamCount, 1);

    const rQueryRefresh = await getDictionaryRoute(new Request('http://127.0.0.1/api/dictionary?refresh=1'));
    assert.equal(rQueryRefresh.status, 200);
    assert.equal((await rQueryRefresh.json()).revision, REV_2);
    assert.equal(upstreamCount, 2);
  } finally {
    globalThis.fetch = prevFetch;
    DB2.close();
    if (prevEnv === undefined) delete globalThis[NODE_ENVIRONMENT];
    else globalThis[NODE_ENVIRONMENT] = prevEnv;
    if (prevMode === undefined) delete process.env.WUWATERM_RUNTIME_MODE;
    else process.env.WUWATERM_RUNTIME_MODE = prevMode;
  }
});

test('429-denied forceRefresh does not advance slot.generation or prevent admitted forceRefresh from populating cache', async () => {
  const DB = createPool();
  const REV_2 = 'e'.repeat(64);
  let clock = 1_700_000_000_000;
  try {
    const env = fixtureEnvironment(DB);
    let releaseDict;
    let dictStarted;
    const dictEntered = new Promise((resolve) => { dictStarted = resolve; });
    const dictGate = new Promise((resolve) => { releaseDict = resolve; });
    let upstreamDictCalls = 0;

    const fetchImpl = async (url) => {
      const path = url.pathname.replace('/wuwaterm-api/', '');
      if (path === 'v1/capabilities') {
        return json({ api_version: 'v1', capabilities: [CAPABILITY_DICTIONARY_IDENTITY], request_id: 'cap-1' });
      }
      if (path === 'v1/dictionary') {
        upstreamDictCalls += 1;
        dictStarted();
        await dictGate;
        return json(validCoreDict({ revision: REV_2, source_game_version: '3.8.0', request_id: 'req-admitted' }));
      }
      throw new Error(`unexpected path: ${path}`);
    };

    // Admitted forceRefresh #1 starts with empty cache (slot.entry === null) and suspends on upstream /v1/dictionary.
    const p1 = proxyDictionaryRequest({
      environment: env,
      fetchImpl,
      now: () => clock,
      forceRefresh: true,
    });
    await dictEntered;
    assert.equal(upstreamDictCalls, 1);

    // Same-second forceRefresh #2 is denied locally by 1/s meta gate with 429 shared_pool_busy.
    const p2 = await proxyDictionaryRequest({
      environment: env,
      fetchImpl,
      now: () => clock,
      forceRefresh: true,
    });
    assert.equal(p2.status, 429);
    assert.equal((await p2.json()).reason, 'shared_pool_busy');
    assert.equal(upstreamDictCalls, 1);

    // Let admitted request #1 finish: it MUST return 200 AND populate slot.entry cache despite #2's 429.
    releaseDict();
    const res1 = await p1;
    assert.equal(res1.status, 200);
    assert.equal((await res1.json()).revision, REV_2);

    // Subsequent same-second non-forced read MUST hit populated cache (200, 0 upstream calls, NOT 429).
    const resCached = await proxyDictionaryRequest({
      environment: env,
      fetchImpl,
      now: () => clock,
    });
    assert.equal(resCached.status, 200);
    assert.equal((await resCached.json()).revision, REV_2);
    assert.equal(upstreamDictCalls, 1);
  } finally {
    DB.close();
  }
});

test('concurrent force-refresh RuntimeStore calls coalesce before hitting 1/s shared_pool', async () => {
  const DB = createPool();
  const REV_2 = 'a'.repeat(64);
  let clock = 1_700_000_000_000;
  try {
    const env = fixtureEnvironment(DB);
    let releaseDict;
    const dictGate = new Promise((resolve) => { releaseDict = resolve; });
    let proxyRequests = 0;
    let upstreamDictCalls = 0;

    const fetchImpl = async (url) => {
      const path = url.pathname.replace('/wuwaterm-api/', '');
      if (path === 'v1/capabilities') {
        return json({ api_version: 'v1', capabilities: [CAPABILITY_DICTIONARY_IDENTITY], request_id: 'cap-pool' });
      }
      if (path === 'v1/dictionary') {
        upstreamDictCalls += 1;
        await dictGate;
        return json(validCoreDict({ revision: REV_2, source_game_version: '3.8.0', request_id: 'req-pool' }));
      }
      throw new Error(`unexpected path: ${path}`);
    };

    const runtime = new RuntimeStore({
      pool: false,
      now: () => clock,
      fetch: async (path) => {
        const parsed = new URL(path, 'http://127.0.0.1');
        if (parsed.pathname === '/api/capabilities') {
          return proxyCapabilitiesRequest({ environment: env, fetchImpl });
        }
        if (parsed.pathname === '/api/dictionary') {
          proxyRequests += 1;
          return proxyDictionaryRequest({
            environment: env,
            fetchImpl,
            now: () => clock,
            forceRefresh: parsed.searchParams.get('refresh') === '1',
          });
        }
        throw new Error(`Unexpected path: ${path}`);
      },
    });

    await runtime.capabilities(true);

    // Trigger two concurrent forced refreshes (e.g. batch auto-reuse + manual forced refresh) in the same second.
    const pBasis = resolveTmAutoReuseBasisFromRuntime(runtime, null, { now: clock });
    const pManual = runtime.loadDictionary(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(proxyRequests, 1);
    assert.equal(upstreamDictCalls, 1);

    releaseDict();
    const [basis] = await Promise.all([pBasis, pManual]);
    assert.deepEqual(basis, { currentTermsDbRevision: REV_2, currentGameVersion: '3.8.0' });
    assert.deepEqual(runtime.getSnapshot().dictionary, {
      kind: 'success',
      data: {
        revision: REV_2,
        schema_version: '2',
        source_commit: '9ddee819abcd',
        game_version: '3.8.0',
        term_count: 12097,
        request_id: 'req-pool',
      },
      fetchedAt: clock,
    });
  } finally {
    DB.close();
  }
});
