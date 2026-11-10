import assert from 'node:assert/strict';
import test from 'node:test';
import { lookupCapabilities, proxyCapabilitiesRequest, proxySemanticReviewRequest, proxyTranslationRequest } from '../lib/wuwaterm-proxy.js';
import { revisionOf } from '../lib/review-report.js';
import { applySemanticSuggestion, semanticIssueId } from '../lib/semantic-review.js';
import { createPool, fixtureEnvironment } from './helpers/pool-fixture.mjs';

const SEM = 'semantic-review-v1';
const CTX = 'translation-context-v1';
const input = { source: '今汐', target: 'Jinhsi', direction: 'en', review_version: SEM, explain_language: 'zh' };
const precedent = { surface: '今汐', choice: 'official_pair', rendering: 'Jinhsi', snippet: '今汐来了', anchor: { segment_index: 0, source_start: 0, source_end: 2 }, scope: 'occurrence' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const caps = (capabilities) => ({ api_version: 'v1', capabilities, request_id: 'req-caps' });

// A scripted upstream: capabilities answer, semantic answer, translation answer; records every call.
function upstream({ capabilities = [SEM], capStatus = 200, semantic } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = url.pathname.replace('/wuwaterm-api/', '');
    calls.push({ path, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    if (path === 'v1/capabilities') return capStatus === 404 ? new Response('no', { status: 404 }) : json(caps(capabilities), capStatus);
    if (path === 'v1/translations') return json({ kind: 'exact', text: 'Jinhsi', direction: 'en', dictionary_miss: false, request_id: 'req-t' });
    return json(typeof semantic === 'function' ? semantic() : semantic);
  };
  return { fetchImpl, calls, count: (path) => calls.filter(call => call.path === path).length };
}

const slice = (text, start, end) => ({ start, end, text: Array.from(text).slice(start, end).join('') });
async function makeReport(source, target, build = () => []) {
  const source_revision = await revisionOf(source);
  const target_revision = await revisionOf(target);
  const issues = [];
  for (const draft of build()) {
    const issue = {
      id: await semanticIssueId('meaning_shift', source_revision, target_revision, draft.source_span ?? null, draft.target_span ?? null),
      fingerprint: 'a'.repeat(32), category: 'meaning_shift', origin: 'model', confidence: 'high',
      source_span: null, target_span: null, source_excerpt: null, target_excerpt: null,
      rationale: 'reason', suggestion: null, suggestion_withheld: null, alternatives: [], ...draft,
    };
    issue.source_excerpt = issue.source_span?.text ?? null;
    issue.target_excerpt = issue.target_span?.text ?? null;
    issues.push(issue);
  }
  return {
    request_id: 'req-sem', review_version: SEM, source_revision, target_revision,
    term_basis: { dictionary_revision: 'b'.repeat(64), matcher_revision: 'c'.repeat(64) },
    status: 'complete', status_reason: null, dropped_unanchored: 0, checked: ['meaning_shift'], issues,
    truncated: false, truncated_reason: null, omitted_issues: 0,
  };
}

async function withPool(run) {
  const DB = createPool();
  try { return await run(DB, fixtureEnvironment(DB)); } finally { DB.close(); }
}
const reason = async (response) => (await response.json()).reason;

test('capabilities: unknown names are dropped, 404 means an empty list, a schema mismatch is a 502, nothing is charged', async () => {
  await withPool(async (DB, environment) => {
    const up = upstream({ capabilities: [SEM, 'future-thing-v9', CTX] });
    const response = await proxyCapabilitiesRequest({ environment, fetchImpl: up.fetchImpl });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { capabilities: [SEM, CTX], request_id: 'req-caps' });
    assert.equal(DB.count(), 0);
  });
  const old = await proxyCapabilitiesRequest({ environment: fixtureEnvironment(null), fetchImpl: upstream({ capStatus: 404 }).fetchImpl });
  assert.equal(old.status, 200);
  assert.deepEqual(await old.json(), { capabilities: [], request_id: null });
  const bad = await proxyCapabilitiesRequest({ environment: fixtureEnvironment(null), fetchImpl: async () => json({ ...caps([]), extra: 1 }) });
  assert.equal(bad.status, 502);
  assert.equal(await reason(bad), 'upstream_schema_mismatch');
  const down = await proxyCapabilitiesRequest({ environment: {}, fetchImpl: upstream().fetchImpl });
  assert.equal(await reason(down), 'site_not_configured');
});

test('capabilities are cached per environment: successes for 300 s, failures for 30 s', async () => {
  const environment = fixtureEnvironment(null);
  const up = upstream();
  let clock = 1_000_000;
  const ask = () => lookupCapabilities({ environment, fetchImpl: up.fetchImpl, now: () => clock });
  await ask(); await ask();
  assert.equal(up.count('v1/capabilities'), 1);
  clock += 299_000; await ask();
  assert.equal(up.count('v1/capabilities'), 1);
  clock += 2_000; await ask();
  assert.equal(up.count('v1/capabilities'), 2);

  const failing = fixtureEnvironment(null);
  let calls = 0;
  const denied = () => lookupCapabilities({ environment: failing, now: () => clock, fetchImpl: async () => {
    calls++;
    return json({ error: { code: 'rate_limited', message: 'slow down' }, request_id: 'req-429' }, 429);
  } });
  assert.equal((await denied()).response.status, 429);
  assert.equal((await denied()).response.status, 429);
  assert.equal(calls, 1);
  clock += 31_000; await denied();
  assert.equal(calls, 2);
});

test('semantic review is refused without charging when the service does not list it', async () => {
  for (const options of [{ capabilities: [] }, { capabilities: [CTX] }, { capStatus: 404 }]) {
    await withPool(async (DB, environment) => {
      const up = upstream(options);
      const response = await proxySemanticReviewRequest({ environment, input, fetchImpl: up.fetchImpl });
      assert.equal(response.status, 503);
      assert.equal(await reason(response), 'semantic_review_unavailable');
      assert.equal(DB.count(), 0);
      assert.equal(up.count('v1/semantic-reviews'), 0);
    });
  }
  await withPool(async (DB, environment) => {
    const response = await proxySemanticReviewRequest({ environment, input, fetchImpl: async () => json({ error: { code: 'unauthorized', message: 'no' }, request_id: 'req-401' }, 401) });
    assert.equal(response.status, 401);
    assert.equal(DB.count(), 0);
  });
});

test('a listed semantic review is admitted once as a translation, charged the longer side in scalars, and forwarded byte for byte', async () => {
  await withPool(async (DB, environment) => {
    const full = { ...input, target: 'Jinhsi ' + '😀'.repeat(10), context: { before: { source: 'a', target: 'b' } }, precedents: [precedent] };
    const report = await makeReport(full.source, full.target, () => [{ target_span: slice(full.target, 0, 6) }]);
    const up = upstream({ semantic: report });
    const response = await proxySemanticReviewRequest({ environment, input: full, fetchImpl: up.fetchImpl });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), report);
    assert.deepEqual(up.calls.find(call => call.path === 'v1/semantic-reviews').body, full);
    const row = DB.row();
    assert.equal(row.translation_used, 1);
    assert.equal(row.character_used, 17);
    assert.equal(row.review_used, 0);
  });
});

test('invalid semantic requests are rejected before any lookup, admission or upstream call', async () => {
  const many = Array.from({ length: 13 }, () => precedent);
  const bad = [
    { ...input, extra: true }, { source: input.source, target: input.target, direction: 'en', review_version: SEM },
    { ...input, source: '  ' }, { ...input, target: '😀'.repeat(2001) }, { ...input, precedents: many },
    { ...input, precedents: [{ ...precedent, choice: 'not_a_term' }] },
    { ...input, context: { before: { source: 'a', target: 'b' }, extra: 1 } },
    { ...input, review_version: 'review-v2' }, null,
  ];
  for (const value of bad) {
    await withPool(async (DB, environment) => {
      const up = upstream();
      const response = await proxySemanticReviewRequest({ environment, input: value, fetchImpl: up.fetchImpl });
      assert.equal(response.status, 400);
      assert.equal(await reason(response), 'site_invalid_request');
      assert.equal(DB.count(), 0);
      assert.equal(up.calls.length, 0);
    });
  }
});

test('the translation switch also closes semantic review, with no semantic upstream call', async () => {
  await withPool(async (DB, environment) => {
    const up = upstream({ semantic: await makeReport(input.source, input.target) });
    const response = await proxySemanticReviewRequest({ environment: { ...environment, WUWATERM_TRANSLATION_ENABLED: 'false' }, input, fetchImpl: up.fetchImpl });
    assert.equal(await reason(response), 'translation_disabled');
    assert.equal(up.count('v1/semantic-reviews'), 0);
    assert.equal(DB.row()?.translation_used ?? 0, 0);
  });
});

test('a response for other texts, a forged id or a wrong excerpt is an upstream_schema_mismatch', async () => {
  const good = () => makeReport(input.source, input.target, () => [{ target_span: slice(input.target, 0, 3) }]);
  const tamper = [
    r => { r.source_revision = '0'.repeat(64); },
    r => { r.target_revision = '0'.repeat(64); },
    r => { r.issues[0].id = 'f'.repeat(32); },
    r => { r.issues[0].target_excerpt = 'Jin '; },
    r => { r.issues[0].target_span.text = 'Xyz'; },
  ];
  for (const mutate of tamper) {
    await withPool(async (_DB, environment) => {
      const report = await good();
      mutate(report);
      const response = await proxySemanticReviewRequest({ environment, input, fetchImpl: upstream({ semantic: report }).fetchImpl });
      assert.equal(response.status, 502);
      assert.equal(await reason(response), 'upstream_schema_mismatch');
    });
  }
});

test('a truncated suggestion span can never be adopted: BFF rejects it and the guard refuses it', async () => {
  const target = 'a'.repeat(300);
  const whole = slice(target, 0, 300);
  const replacement = 'b'.repeat(240);
  const long = { ...input, target };
  const truncated = { target_span: whole, suggestion: { target_span: { start: 0, end: 300, text: 'a'.repeat(200) }, replacement, term_effect: 'none' } };
  const tooLong = { target_span: whole, suggestion: { target_span: whole, replacement, term_effect: 'none' } };
  for (const draft of [truncated, tooLong]) {
    await withPool(async (_DB, environment) => {
      const report = await makeReport(long.source, target, () => [draft]);
      const response = await proxySemanticReviewRequest({ environment, input: long, fetchImpl: upstream({ semantic: report }).fetchImpl });
      assert.equal(response.status, 502);
      assert.equal(await reason(response), 'upstream_schema_mismatch');
    });
  }
  const [issue] = (await makeReport(long.source, target, () => [truncated])).issues;
  const refused = applySemanticSuggestion({ target, issue, offset: 0 });
  assert.deepEqual(refused, { error: 'needs_reconfirmation' });
  assert.equal(refused.target, undefined);
  const withheld = applySemanticSuggestion({ target, issue: { ...issue, suggestion: null, suggestion_withheld: 'span_too_long' }, offset: 0 });
  assert.deepEqual(withheld, { error: 'suggestion_unavailable' });
  const valid = applySemanticSuggestion({ target, offset: 0, issue: { suggestion: { target_span: slice(target, 0, 200), replacement, term_effect: 'none' }, suggestion_withheld: null } });
  assert.equal(Array.from(valid.target).length, 340);
  assert.equal(valid.target, replacement + 'a'.repeat(100));
  assert.deepEqual(valid.span, { start: 0, end: 240, text: replacement });
});

test('translation context is forwarded only to a service that lists translation-context-v1; billing stays len(text)', async () => {
  const context = { before: { source: '上一句', target: 'Previous.' }, precedents: [precedent] };
  const request = { text: '今汐', to: 'en', context };
  for (const [options, forwarded] of [[{ capabilities: [CTX] }, true], [{ capabilities: [] }, false], [{ capStatus: 404 }, false]]) {
    await withPool(async (DB, environment) => {
      const up = upstream(options);
      const response = await proxyTranslationRequest({ environment, input: request, fetchImpl: up.fetchImpl });
      assert.equal(response.status, 200);
      const sent = up.calls.find(call => call.path === 'v1/translations').body;
      assert.deepEqual(sent, forwarded ? request : { text: '今汐', to: 'en' });
      assert.equal(DB.row().translation_used, 1);
      assert.equal(DB.row().character_used, 2);
    });
  }
  await withPool(async (DB, environment) => {
    const up = upstream();
    await proxyTranslationRequest({ environment, input: { text: '今汐' }, fetchImpl: up.fetchImpl });
    assert.equal(up.count('v1/capabilities'), 0);
  });
  const rejected = await proxyTranslationRequest({ environment: fixtureEnvironment(null), input: { text: 'x', context: { extra: 1 } }, fetchImpl: upstream().fetchImpl });
  assert.equal(rejected.status, 400);
});
