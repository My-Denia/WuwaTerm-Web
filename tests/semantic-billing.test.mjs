import assert from 'node:assert/strict';
import test from 'node:test';
import { proxySemanticReviewRequest, proxyTranslationRequest } from '../lib/wuwaterm-proxy.js';
import { classifyFailure, initialRun, nextQueued, runReducer } from '../lib/semantic-run.js';
import { createPool, fixtureEnvironment } from './helpers/pool-fixture.mjs';

// The real BFF and shared pool, with an upstream that always answers 429, driven
// the way the workbench drives a run: the same failure classification and run
// state machine, and a waiting run resumes itself when its wait is over.
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function rateLimitedUpstream() {
  let charged = 0;
  const fetchImpl = async url => {
    const path = url.pathname.replace('/wuwaterm-api/', '');
    if (path === 'v1/capabilities') return json({ api_version: 'v1', capabilities: ['semantic-review-v1', 'translation-context-v1'], request_id: 'req-caps' });
    charged++;
    return json({ error: { code: 'rate_limited', message: 'synthetic' }, request_id: 'req-429' }, 429);
  };
  return { fetchImpl, upstreamCalls: () => charged };
}

async function drive(send, DB, rounds = 6) {
  let run = runReducer(initialRun(), { type: 'start', kind: 'semantic', items: [{ key: 'a', index: 0 }, { key: 'b', index: 1 }] });
  for (let i = 0; i < rounds; i++) {
    const item = nextQueued(run);
    if (!item) {
      if (run.phase !== 'waiting') break;
      DB.advance(Math.ceil((run.waitUntil - 0) / 1000));
      run = runReducer(run, { type: 'resume' });
      continue;
    }
    run = runReducer(run, { type: 'sent', key: item.key });
    const response = await send();
    const body = await response.json();
    run = runReducer(run, { type: 'failed', key: item.key, code: body.reason, classification: classifyFailure({ reason: body.reason, retryAfterSeconds: body.retry_after_seconds }), now: 0 });
  }
  return run;
}

for (const [name, send] of [
  ['semantic review', (environment, fetchImpl) => proxySemanticReviewRequest({ environment, fetchImpl, input: { source: '今汐来了。', target: 'Jinhsi came.', direction: 'en', review_version: 'semantic-review-v1', explain_language: 'zh' } })],
  ['segment translation', (environment, fetchImpl) => proxyTranslationRequest({ environment, fetchImpl, input: { text: '今汐来了。', to: 'en' } })],
]) {
  test(`${name}: a charged upstream rate limit stops the run and is never resent on its own`, async () => {
    const DB = createPool();
    try {
      const environment = fixtureEnvironment(DB);
      const upstream = rateLimitedUpstream();
      const run = await drive(() => send(environment, upstream.fetchImpl), DB);
      assert.equal(run.phase, 'stopped');
      assert.equal(run.stopCode, 'upstream_rate_limited');
      assert.equal(nextQueued(run), null);
      assert.equal(upstream.upstreamCalls(), 1);
      assert.equal(DB.row().translation_used, 1, 'one admission charged, no automatic resend');
    } finally { DB.close(); }
  });
}

test('the per-minute refusal is made before admission: waiting on it charges nothing', async () => {
  const DB = createPool();
  try {
    const environment = fixtureEnvironment(DB);
    const upstream = rateLimitedUpstream();
    const send = () => proxyTranslationRequest({ environment, fetchImpl: upstream.fetchImpl, input: { text: '今汐来了。', to: 'en' } });
    await send();
    const before = DB.row().translation_used;
    const refused = await send();
    const body = await refused.json();
    assert.equal(body.reason, 'shared_pool_busy');
    assert.equal(classifyFailure({ reason: body.reason, retryAfterSeconds: body.retry_after_seconds }).action, 'wait');
    assert.equal(DB.row().translation_used, before);
    assert.equal(upstream.upstreamCalls(), 1);
  } finally { DB.close(); }
});
