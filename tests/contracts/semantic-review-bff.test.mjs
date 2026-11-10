import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { parseSemanticReviewRequest, proxySemanticReviewRequest } from '../../lib/wuwaterm-proxy.js';
import { SEMANTIC_WIRE_KEYS } from '../../lib/semantic-review.js';
import { createPool, fixtureEnvironment } from '../helpers/pool-fixture.mjs';

const root = process.env.WUWATERM_BACKEND_ROOT;
assert.ok(root, 'Set WUWATERM_BACKEND_ROOT to the pinned backend checkout');
const dir = join(root, 'contracts', 'semantic-review-v1');
const cases = JSON.parse(readFileSync(join(dir, 'cases.json'), 'utf8')).cases;
const bytes = name => readFileSync(join(dir, name));
const jsonHeaders = length => ({ 'content-type': 'application/json', ...(length === undefined ? {} : { 'content-length': String(length) }) });

function fakeUpstream({ response, status = 200 } = {}) {
  const sent = [];
  const fetchImpl = async (url, init) => {
    const path = url.pathname.replace('/wuwaterm-api/', '');
    if (path === 'v1/capabilities') {
      return new Response(JSON.stringify({ api_version: 'v1', capabilities: ['semantic-review-v1'], request_id: 'req-caps' }), { headers: jsonHeaders() });
    }
    assert.equal(path, 'v1/semantic-reviews');
    sent.push(init.body);
    return new Response(response ?? JSON.stringify({ error: { code: 'llm_unavailable', message: 'x' }, request_id: 'req-x' }), { status, headers: jsonHeaders(response?.length) });
  };
  return { fetchImpl, sent };
}

async function run(input, upstream) {
  const DB = createPool();
  try { return await proxySemanticReviewRequest({ environment: fixtureEnvironment(DB), input, fetchImpl: upstream.fetchImpl }); } finally { DB.close(); }
}

for (const fixtureCase of cases) {
  test(`Core semantic-review-v1 case ${fixtureCase.name} passes the Web parser and BFF`, async () => {
    const requestBytes = bytes(fixtureCase.request);
    assert.ok(requestBytes.length <= 32_768);
    const parsed = await parseSemanticReviewRequest(new Request('https://site.test/api/semantic-reviews', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: requestBytes,
    }));
    assert.equal(parsed.ok, true, parsed.ok ? '' : await parsed.response.clone().text());
    if (fixtureCase.response === undefined || fixtureCase.response === null) {
      const upstream = fakeUpstream();
      await run(parsed.input, upstream);
      assert.equal(upstream.sent.length, 1);
      assert.equal(upstream.sent[0], requestBytes.toString('utf8'), 'forwarded body is byte-identical to the fixture');
      assert.ok(Buffer.byteLength(upstream.sent[0]) <= 32_768);
      return;
    }
    // The server's exact bytes, never re-serialized.
    const raw = bytes(fixtureCase.response);
    const upstream = fakeUpstream({ response: raw });
    const response = await run(parsed.input, upstream);
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), JSON.parse(raw.toString('utf8')));
  });
}

test('the fixtures include the 56,651-byte max response and the byte-limit response', () => {
  assert.ok(cases.some(item => item.name === 'max') && cases.some(item => item.name === 'byte-limit'));
  assert.ok(bytes('max-response.json').length > 56_000);
});

test('Web wire key sets equal Core OpenAPI schemas', { skip: !existsSync(join(root, 'docs/api/openapi.json')) && 'no OpenAPI snapshot in the pinned backend' }, () => {
  const schemas = JSON.parse(readFileSync(join(root, 'docs/api/openapi.json'), 'utf8')).components.schemas;
  for (const [name, keys] of Object.entries(SEMANTIC_WIRE_KEYS)) {
    assert.ok(schemas[name], `${name} missing from Core OpenAPI`);
    assert.deepEqual([...keys].sort(), Object.keys(schemas[name].properties).sort(), name);
  }
});
