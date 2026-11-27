// Unit tests for Part 1: GET /api/dictionary proxy, capability gating, schema validation,
// quota charging (kind = 'meta'), sensitive value redaction, and bounded server-side TTL cache.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CAPABILITY_DICTIONARY_IDENTITY, projectCapabilities } from '../lib/semantic-review.js';
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
