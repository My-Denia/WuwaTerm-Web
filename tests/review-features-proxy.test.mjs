import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseReviewRequest, parseSemanticReviewRequest, parseTranslationRequest, proxyReviewRequest,
} from '../lib/wuwaterm-proxy.js';
import { REASON_VALUES } from '../lib/manuscript.js';
import { createPool, fixtureEnvironment } from './helpers/pool-fixture.mjs';
import { dictionary, hash } from './fixtures/manuscript.mjs';

// X-WuwaTerm-Review-Features: dense-128 and reason-v1, asked for by the client, forwarded only when asked, and the 64 KiB request cap
// that belongs to /api/reviews alone.

const MATCHER = 'c'.repeat(64);
const camellya = { zh: '椿', en: 'Camellya', category: 'character', candidate_id: hash('candidate-camellya'), sources: [{ source_file: 'Fixture.json', source_id: 'camellya' }] };
// 40 lines "椿" / "Camellya" so a report can hold more than 32 findings.
const lines = Array.from({ length: 40 }, (_, i) => `第${i + 1}行：椿。`);
const source = lines.join('\n');
const target = Array.from({ length: 40 }, (_, i) => `Line ${i + 1}: Camellya.`).join('\n');
const scalarLength = text => Array.from(text).length;
const spanAt = (text, needle, from) => { const start = scalarLength(text.slice(0, text.indexOf(needle, from))); return { start, end: start + scalarLength(needle), text: needle }; };
function finding(n, extra = {}) {
  const line = lines[n];
  const offset = lines.slice(0, n).join('\n').length + (n ? 1 : 0);
  const span = spanAt(source, '椿', offset);
  return { id: `${span.start}:${span.end}:椿`, rule_id: 'review.term_pair', verdict: 'verified_constraint', source_span: span, target_span: null,
    candidates: [camellya], candidates_truncated: false, ...extra, _line: line };
}
const clean = f => { const { _line, ...rest } = f; void _line; return rest; };
function report(findings) {
  return {
    request_id: 'req-features', source_revision: '', target_revision: '', rule_version: 'review-v2', matcher_revision: MATCHER,
    dictionary: { ...dictionary }, coverage: { evaluated: findings.length, not_evaluated: 0, rules: ['review.term_pair', 'review.sentence_meaning'] },
    findings: findings.map(clean), truncated: false,
  };
}
async function withRevisions(body) {
  const { revisionOf } = await import('../lib/review-report.js');
  return { ...body, source_revision: await revisionOf(source), target_revision: await revisionOf(target) };
}
const input = { source, target, direction: 'en', review_version: 'review-v2' };
const upstream = (body, headers = {}) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', ...headers } });
const post = (value, headers = {}) => new Request('https://example.test/api/reviews', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(value) });

async function run({ features, inputValue = input, body, responseHeaders = {} }) {
  const DB = createPool(); let sent;
  try {
    const result = await proxyReviewRequest({
      environment: fixtureEnvironment(DB), input: inputValue, features,
      fetchImpl: async (url, options) => { sent = options; return upstream(await withRevisions(body), responseHeaders); },
    });
    return { result, sent };
  } finally { DB.close(); }
}

test('without the header the BFF forwards no feature header and keeps 32 findings, 32 resolutions and seven keys', async () => {
  const thirtyTwo = report(Array.from({ length: 32 }, (_, i) => finding(i)));
  const { result, sent } = await run({ body: thirtyTwo });
  assert.equal(result.status, 200);
  assert.equal(Object.keys(sent.headers).some(name => name.toLowerCase() === 'x-wuwaterm-review-features'), false);
  assert.equal(result.headers.get('x-wuwaterm-review-features'), null);
  const answer = await result.json();
  assert.equal(answer.findings.length, 32);
  assert.equal(Object.keys(answer.findings[0]).length, 7);
  // 33 findings from the upstream, or a reason, are a schema mismatch when nothing was asked.
  for (const body of [report(Array.from({ length: 33 }, (_, i) => finding(i))), report([finding(0, { verdict: 'not_evaluated', reason: 'ordinary_word' })])]) {
    const out = await run({ body });
    assert.equal(out.result.status, 502);
    assert.equal((await out.result.json()).reason, 'upstream_schema_mismatch');
  }
  // 33 resolutions are refused before any upstream call.
  const resolutions = Array.from({ length: 33 }, (_, i) => ({ mention_id: `${i}:${i + 1}:椿`, choice: 'not_a_term' }));
  let calls = 0;
  const DB = createPool();
  try {
    const refused = await proxyReviewRequest({ environment: fixtureEnvironment(DB), input: { ...input, resolutions, resolution_context: { source_revision: 'a'.repeat(64), rule_version: 'review-v2', dictionary_revision: 'b'.repeat(64), matcher_revision: MATCHER } }, fetchImpl: async () => { calls++; return upstream({}); } });
    assert.equal(refused.status, 400);
    assert.equal(calls, 0);
  } finally { DB.close(); }
});

test('dense-128 raises the resolutions and findings to 128 and is forwarded; reason-v1 allows a reason only on not_evaluated', async () => {
  const body = report(Array.from({ length: 40 }, (_, i) => finding(i, i === 39 ? { verdict: 'not_evaluated', reason: 'ambiguous_repeat' } : {})));
  const { result, sent } = await run({ features: { dense: true, reason: true }, body, responseHeaders: { 'x-wuwaterm-review-features': 'reason-v1,dense-128,unknown' } });
  assert.equal(result.status, 200);
  assert.equal(sent.headers['X-WuwaTerm-Review-Features'], 'dense-128,reason-v1');
  assert.equal(sent.headers['X-WuwaTerm-Matcher-Basis'], '1');
  // The upstream's echo is forwarded, limited to what was asked, in the fixed order; an unknown token is dropped.
  assert.equal(result.headers.get('x-wuwaterm-review-features'), 'dense-128,reason-v1');
  const answer = await result.json();
  assert.equal(answer.findings.length, 40);
  assert.equal(answer.findings.at(-1).reason, 'ambiguous_repeat');
  assert.deepEqual(Object.keys(answer.findings.at(-1)).at(-1), 'reason');
  assert.equal(Object.hasOwn(answer.findings[0], 'reason'), false);
  // A reason on a verdict that is not not_evaluated, null, or an unknown value: the response is invalid.
  for (const bad of [{ reason: 'ordinary_word' }, { verdict: 'not_evaluated', reason: null }, { verdict: 'not_evaluated', reason: 'other' }]) {
    const out = await run({ features: { dense: true, reason: true }, body: report([finding(0, bad)]) });
    assert.equal(out.result.status, 502, JSON.stringify(bad));
  }
  for (const reason of REASON_VALUES) {
    const out = await run({ features: { reason: true }, body: report([finding(0, { verdict: 'not_evaluated', reason })]) });
    assert.equal(out.result.status, 200, reason);
  }
  // Only dense-128 asked: a reason is not allowed, and 33+ findings are. Only reason-v1 asked: 33 findings are not allowed.
  assert.equal((await run({ features: { dense: true }, body: report(Array.from({ length: 33 }, (_, i) => finding(i))) })).result.status, 200);
  assert.equal((await run({ features: { dense: true }, body: report([finding(0, { verdict: 'not_evaluated', reason: 'not_a_term' })]) })).result.status, 502);
  assert.equal((await run({ features: { reason: true }, body: report(Array.from({ length: 33 }, (_, i) => finding(i))) })).result.status, 502);
  // An upstream that honours neither still answers in the old shape, which stays valid under both features.
  const old = await run({ features: { dense: true, reason: true }, body: report([finding(0)]) });
  assert.equal(old.result.status, 200);
  assert.equal(old.result.headers.get('x-wuwaterm-review-features'), null);
  // 129 findings are never valid.
  assert.equal((await run({ features: { dense: true, reason: true }, body: report(Array.from({ length: 129 }, (_, i) => finding(i % 40))) })).result.status, 502);
});

test('dense-128 allows 128 resolutions in a request, and no more; the parser reads the header', async () => {
  const context = { source_revision: 'a'.repeat(64), rule_version: 'review-v2', dictionary_revision: 'b'.repeat(64), matcher_revision: MATCHER };
  const resolutions = n => Array.from({ length: n }, (_, i) => ({ mention_id: `${i}:${i + 1}:椿`, choice: 'not_a_term' }));
  const dense = n => ({ ...input, resolutions: resolutions(n), resolution_context: context });
  const ok = await parseReviewRequest(post(dense(128), { 'X-WuwaTerm-Review-Features': 'dense-128,reason-v1' }));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.features, { dense: true, reason: true, ambiguous: false });
  assert.deepEqual(ok.input, dense(128), 'the features never enter the forwarded body');
  assert.equal((await parseReviewRequest(post(dense(129), { 'X-WuwaTerm-Review-Features': 'dense-128' }))).ok, false);
  assert.equal((await parseReviewRequest(post(dense(33)))).ok, false, 'no header: 32 at most');
  assert.equal((await parseReviewRequest(post(dense(33), { 'X-WuwaTerm-Review-Features': 'reason-v1' }))).ok, false, 'reason-v1 alone does not raise the resolutions');
  assert.equal((await parseReviewRequest(post(dense(32)))).ok, true);
  const none = await parseReviewRequest(post(input));
  assert.deepEqual(none.features, { dense: false, reason: false, ambiguous: false });
  const blank = await parseReviewRequest(post(input, { 'X-WuwaTerm-Review-Features': '  ' }));
  assert.equal(blank.ok, true);
  assert.deepEqual(blank.features, { dense: false, reason: false, ambiguous: false });
  assert.deepEqual((await parseReviewRequest(post(input, { 'X-WuwaTerm-Review-Features': ' reason-v1 ' }))).features, { dense: false, reason: true, ambiguous: false });
  assert.deepEqual((await parseReviewRequest(post(input, { 'X-WuwaTerm-Review-Features': 'dense-128,reason-v1,ambiguous-mention-v1' }))).features,
    { dense: true, reason: true, ambiguous: true });
  // An unknown, repeated or empty token, and any token on review-v1, is site_invalid_request.
  // ambiguous-mention-v1 needs reason-v1 on the same request, as Core refuses it alone.
  for (const header of ['dense-256', 'dense-128,dense-128', 'dense-128,', ',', 'DENSE-128', 'dense-128 reason-v1', 'ambiguous-mention-v1', 'dense-128,ambiguous-mention-v1']) {
    const refused = await parseReviewRequest(post(input, { 'X-WuwaTerm-Review-Features': header }));
    assert.equal(refused.ok, false, header);
    assert.equal(refused.response.status, 400);
    assert.equal((await refused.response.json()).reason, 'site_invalid_request');
  }
  for (const v1 of [{ source, target, direction: 'en' }, { source, target, direction: 'en', review_version: 'review-v1' }]) {
    const refused = await parseReviewRequest(post(v1, { 'X-WuwaTerm-Review-Features': 'dense-128' }));
    assert.equal(refused.ok, false);
    assert.equal((await refused.response.json()).reason, 'site_invalid_request');
    assert.equal((await parseReviewRequest(post(v1))).ok, true);
  }
  // proxyReviewRequest holds the same rule for a caller that passes features directly.
  const DB = createPool();
  try {
    const refused = await proxyReviewRequest({ environment: fixtureEnvironment(DB), input: { source, target, direction: 'en' }, features: { dense: true }, fetchImpl: async () => { throw new Error('no call'); } });
    assert.equal(refused.status, 400);
  } finally { DB.close(); }
});

test('/api/reviews takes up to 64 KiB; every other endpoint keeps 32 KiB', async () => {
  const json = value => JSON.stringify(value);
  const padded = bytes => { const body = json({ ...input }); return `${body}${' '.repeat(bytes - Buffer.byteLength(body, 'utf8'))}`; };
  const request = (path, body, headers = {}) => new Request(`https://example.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  // Reviews: 40,000 bytes and exactly 65,536 pass the size check (and parse), 65,537 is too large, by content-length and by stream.
  for (const bytes of [40_000, 65_536]) {
    const parsed = await parseReviewRequest(request('/api/reviews', padded(bytes)));
    assert.equal(parsed.ok, true, `${bytes}`);
  }
  const tooLarge = await parseReviewRequest(request('/api/reviews', padded(65_537)));
  assert.equal(tooLarge.ok, false);
  assert.equal(tooLarge.response.status, 413);
  assert.equal((await tooLarge.response.json()).reason, 'site_request_too_large');
  const declared = await parseReviewRequest(request('/api/reviews', padded(2_000), { 'content-length': '65537' }));
  assert.equal(declared.response.status, 413);
  let cancelled = false;
  const streamed = await parseReviewRequest(new Request('https://example.test/api/reviews', {
    method: 'POST', headers: { 'content-type': 'application/json' }, duplex: 'half',
    body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(40_000)); controller.enqueue(new Uint8Array(30_000)); }, cancel() { cancelled = true; } }),
  }));
  assert.equal(streamed.response.status, 413);
  assert.equal(cancelled, true);
  // The other endpoints: 32,768 passes the size check (it is not valid JSON input here, so 400), 32,769 is 413.
  const translation = await parseTranslationRequest(request('/api/translations', `${json({ text: '今汐' })}${' '.repeat(32_768 - Buffer.byteLength(json({ text: '今汐' }), 'utf8'))}`));
  assert.equal(translation.ok, true);
  const translationBig = await parseTranslationRequest(request('/api/translations', `${json({ text: '今汐' })}${' '.repeat(32_769 - Buffer.byteLength(json({ text: '今汐' }), 'utf8'))}`));
  assert.equal(translationBig.response.status, 413);
  const semantic = await parseSemanticReviewRequest(request('/api/semantic-reviews', ' '.repeat(32_769)));
  assert.equal(semantic.response.status, 413);
  const semanticOver = await parseSemanticReviewRequest(request('/api/semantic-reviews', ' '.repeat(40_000)));
  assert.equal(semanticOver.response.status, 413);
});
