import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyFailure, contextBefore, diffSplice, fitRequestBody, historySnapshot, initialRun, liveIssue, mapRegion, mapSpan,
  nextQueued, placeSegmentIssues, runProgress, runReducer, segmentKey, selectPrecedents, semanticExportItems,
  semanticIssuesResolved, semanticTextsWithinBudget,
} from '../lib/semantic-run.js';
import { parseWorkfile, serializeWorkfile } from '../lib/manuscript.js';
import { revisionOf } from '../lib/review-report.js';
import { makeSemanticDecision } from '../lib/semantic-decisions.js';
import { pairSegments } from '../lib/segmentation.js';
import { excerptOf, validPrecedent } from '../lib/semantic-review.js';

const sp = (text, needle, from = 0) => {
  const at = text.indexOf(needle, from);
  const start = Array.from(text.slice(0, at)).length;
  return { start, end: start + Array.from(needle).length, text: needle };
};

test('diffSplice finds the single replaced scalar range', () => {
  assert.equal(diffSplice('abc', 'abc'), null);
  assert.deepEqual(diffSplice('abcd', 'abXYd'), { start: 2, oldEnd: 3, newEnd: 4 });
  assert.deepEqual(diffSplice('abc', 'abXc'), { start: 2, oldEnd: 2, newEnd: 3 });
  assert.deepEqual(diffSplice('abXc', 'abc'), { start: 2, oldEnd: 3, newEnd: 2 });
  // prefix and suffix never overlap
  assert.deepEqual(diffSplice('aaa', 'aa'), { start: 2, oldEnd: 3, newEnd: 2 });
  assert.deepEqual(diffSplice('😀a', '😀b'), { start: 1, oldEnd: 2, newEnd: 2 });
});

test('mapSpan follows edits before and after, and rejects overlaps and inner edits', () => {
  const oldText = 'alpha beta gamma';
  const beta = sp(oldText, 'beta');
  const edit = (next) => [diffSplice(oldText, next), next];
  let [splice, next] = edit('alpha beta gamma!');
  assert.deepEqual(mapSpan(beta, splice, next), beta);
  [splice, next] = edit('ALPHA beta gamma');
  assert.deepEqual(mapSpan(beta, splice, next), beta);
  [splice, next] = edit('alpha  beta gamma');
  assert.deepEqual(mapSpan(beta, splice, next), { start: 7, end: 11, text: 'beta' });
  [splice, next] = edit('alpha bXeta gamma');
  assert.equal(mapSpan(beta, splice, next), null);
  [splice, next] = edit('alpha betaX gamma');
  assert.deepEqual(splice, { start: 10, oldEnd: 10, newEnd: 11 });
  assert.deepEqual(mapSpan(beta, splice, next), beta);
  // pure insertion exactly at the start shifts the span
  [splice, next] = edit('alpha Xbeta gamma');
  assert.deepEqual(mapSpan(beta, splice, next), { start: 7, end: 11, text: 'beta' });
  // text check against the new text
  assert.equal(mapSpan(beta, { start: 0, oldEnd: 0, newEnd: 1 }, 'alpha beta gamma'), null);
  assert.equal(mapSpan(beta, null, oldText), beta);
  assert.equal(mapSpan(null, splice, next), null);
});

test('mapRegion always yields a region and clamps boundaries inside an edit', () => {
  const splice = { start: 10, oldEnd: 20, newEnd: 25 };
  assert.deepEqual(mapRegion({ start: 0, end: 5 }, splice), { start: 0, end: 5 });
  assert.deepEqual(mapRegion({ start: 25, end: 40 }, splice), { start: 30, end: 45 });
  assert.deepEqual(mapRegion({ start: 5, end: 15 }, splice), { start: 5, end: 25 });
  assert.deepEqual(mapRegion({ start: 15, end: 30 }, splice), { start: 10, end: 35 });
  assert.deepEqual(mapRegion({ start: 1, end: 2 }, null), { start: 1, end: 2 });
});

test('segmentKey is a JSON array', () => {
  assert.equal(segmentKey('en', 'a', 'b'), '["en","a","b"]');
});

// A synthetic document: three paragraphs, the last one is the current segment.
const SRC = ['Alpha Gate opened at dawn. The guard nodded.', 'The Gate Keeper spoke to Alpha Gate again.', 'Now Alpha Gate closes.'].join('\n\n');
const TGT = ['阿尔法之门在黎明开启。守卫点了点头。', '门卫又对阿尔法之门说话。', '现在阿尔法之门关闭。'].join('\n\n');
const PAIRS = pairSegments(SRC, TGT, 50);

test('fixture pairs are three ready segments', () => {
  assert.deepEqual(PAIRS.map(p => p.status), ['ready', 'ready', 'ready']);
});

const item = (needle, from, choice = 'user_rendering', rendering = 'X') => ({ span: sp(SRC, needle, from), choice, rendering: choice === 'not_a_term' ? null : rendering });

test('selectPrecedents keeps earlier valid items, prefers surfaces in the current segment, nearest first, deduplicated', () => {
  const second = SRC.indexOf('Alpha Gate again');
  const items = [
    item('Alpha Gate', 0, 'official_pair', '阿尔法之门'),
    item('guard', 0, 'user_rendering', '守卫'),
    item('Alpha Gate', second, 'official_pair', '阿尔法之门'),
    item('Gate Keeper', 0, 'not_a_term'),
    item('Alpha Gate', SRC.lastIndexOf('Alpha Gate'), 'official_pair', '阿尔法之门'), // inside the current segment: skipped
    { span: sp(SRC, 'Gate', 0), choice: 'not_a_term', rendering: 'oops' }, // not_a_term with a rendering
    { span: sp(SRC, 'Gate', 0), choice: 'user_rendering', rendering: '' },
    { span: sp(SRC, 'Gate', 0), choice: 'user_rendering', rendering: 'x'.repeat(49) },
    { span: { start: 0, end: 5, text: 'wrong' }, choice: 'user_rendering', rendering: 'x' },
  ];
  const out = selectPrecedents({ items, source: SRC, pairs: PAIRS, segmentIndex: 2 });
  assert.deepEqual(out.map(p => [p.surface, p.choice, p.rendering]), [
    ['Alpha Gate', 'official_pair', '阿尔法之门'], // in the current core, nearest occurrence kept
    ['Gate Keeper', 'not_a_term', null],
    ['guard', 'user_rendering', '守卫'],
  ]);
  assert.equal(out[0].anchor.segment_index, 1);
  assert.equal(out[0].anchor.source_start, 'The Gate Keeper spoke to '.length);
  assert.equal(out[2].anchor.segment_index, 0);
  for (const p of out) { assert.equal(validPrecedent(p), true); assert.equal(Array.from(p.snippet).length <= 80, true); assert.equal(p.snippet.includes(p.surface), true); }
  assert.equal(out[2].snippet, 'The guard nodded.');
  assert.equal(selectPrecedents({ items, source: SRC, pairs: PAIRS, segmentIndex: 2, limit: 1 }).length, 1);
  assert.deepEqual(selectPrecedents({ items, source: SRC, pairs: PAIRS, segmentIndex: 0 }), []);
});

test('selectPrecedents centers long sentences on the span and skips oversized spans', () => {
  const long = `${'x '.repeat(60)}TARGET${' y'.repeat(60)}.`;
  const doc = `${long}\n\nNext paragraph here.`;
  const pairs = pairSegments(doc, doc, 400);
  const at = Array.from(doc.slice(0, doc.indexOf('TARGET'))).length;
  const items = [{ span: { start: at, end: at + 6, text: 'TARGET' }, choice: 'user_rendering', rendering: '目标' }];
  const pairsSplit = pairSegments(doc, doc, 200);
  assert.equal(pairs.length >= 1, true);
  const idx = pairsSplit.length - 1;
  const [p] = selectPrecedents({ items, source: doc, pairs: pairsSplit, segmentIndex: idx });
  assert.equal(Array.from(p.snippet).length, 80);
  assert.equal(p.snippet.includes('TARGET'), true);
  const huge = 'z'.repeat(81);
  const doc2 = `${huge}\n\nTail text.`;
  const pairs2 = pairSegments(doc2, doc2, 100);
  const big = [{ span: { start: 0, end: 81, text: huge }, choice: 'user_rendering', rendering: 'r' }];
  assert.deepEqual(selectPrecedents({ items: big, source: doc2, pairs: pairs2, segmentIndex: pairs2.length - 1 }), []);
});

test('contextBefore takes the tail of the previous pair, or null', () => {
  assert.equal(contextBefore({ pairs: PAIRS, segmentIndex: 0, source: SRC, target: TGT }), null);
  const before = contextBefore({ pairs: PAIRS, segmentIndex: 1, source: SRC, target: TGT });
  assert.deepEqual(before, { source: 'Alpha Gate opened at dawn. The guard nodded.', target: '阿尔法之门在黎明开启。守卫点了点头。' });
  const long = '字'.repeat(500);
  const doc = `${long}\n\nB.`;
  const pairs = pairSegments(doc, doc, 600);
  const tail = contextBefore({ pairs: [{ ...pairs[0], index: 0 }, { index: 1 }], segmentIndex: 1, source: doc, target: doc });
  assert.equal(Array.from(tail.source).length, 400);
  const emptyPair = { source: { core_start: 0, core_end: 0 }, target: { core_start: 0, core_end: 0 } };
  assert.equal(contextBefore({ pairs: [emptyPair, {}], segmentIndex: 1, source: '', target: '' }), null);
});

const bytes = body => new TextEncoder().encode(JSON.stringify(body)).length;
const prec = n => ({ surface: `s${n}`, choice: 'user_rendering', rendering: 'r', snippet: 'x'.repeat(80), anchor: { segment_index: 0, source_start: 0, source_end: 2 }, scope: 'occurrence' });

test('fitRequestBody drops the furthest precedents, then halves the context, without mutating the input', () => {
  const semantic = { source: 'a', target: 'b', direction: 'en', review_version: 'semantic-review-v1', explain_language: 'zh',
    context: { before: { source: 'x'.repeat(400), target: 'y'.repeat(400) } }, precedents: [1, 2, 3, 4].map(prec) };
  const frozen = JSON.stringify(semantic);
  const keep = fitRequestBody(semantic, 1_000_000);
  assert.deepEqual([keep.droppedPrecedents, keep.contextTrimmed, keep.fits, keep.bytes], [0, false, true, bytes(semantic)]);
  const some = fitRequestBody(semantic, bytes(semantic) - 100);
  assert.equal(some.droppedPrecedents, 1);
  assert.deepEqual(some.body.precedents.map(p => p.surface), ['s1', 's2', 's3']);
  assert.equal(some.contextTrimmed, false);
  const ctx = fitRequestBody(semantic, 300);
  assert.equal(ctx.body.precedents.length, 0);
  assert.equal(ctx.contextTrimmed, true);
  assert.equal(ctx.fits, true);
  assert.equal(ctx.body.context === undefined || Array.from(ctx.body.context.before.source).length < 400, true);
  const tiny = fitRequestBody(semantic, 140);
  assert.equal(Object.hasOwn(tiny.body, 'context'), false);
  assert.equal(tiny.fits, true);
  assert.equal(fitRequestBody(semantic, 10).fits, false);
  assert.equal(JSON.stringify(semantic), frozen);

  const translate = { text: 'hello', context: { before: { source: 'x'.repeat(300), target: 'y'.repeat(300) }, precedents: [1, 2].map(prec) } };
  const out = fitRequestBody(translate, bytes({ text: 'hello', context: { precedents: [1].map(prec) } }) + 5);
  assert.equal(out.droppedPrecedents, 2);
  assert.equal(out.contextTrimmed, true);
  assert.equal(out.fits, true);
  const bare = fitRequestBody({ text: 'hello', context: { before: { source: 'x'.repeat(50), target: 'y' } } }, 20);
  assert.deepEqual(bare.body, { text: 'hello' });
  assert.equal(bare.contextTrimmed, true);
});

test('classifyFailure maps reasons to run actions', () => {
  assert.deepEqual(classifyFailure({ reason: 'shared_pool_busy' }), { action: 'wait', seconds: 30 });
  assert.deepEqual(classifyFailure({ reason: 'shared_pool_busy', retryAfterSeconds: 1 }), { action: 'wait', seconds: 5 });
  assert.deepEqual(classifyFailure({ reason: 'shared_pool_busy', retryAfterSeconds: 9999 }), { action: 'wait', seconds: 600 });
  assert.deepEqual(classifyFailure({ reason: 'shared_pool_busy', retryAfterSeconds: 42 }), { action: 'wait', seconds: 42 });
  // An upstream rate limit came after admission: charged, so never resent automatically.
  assert.deepEqual(classifyFailure({ reason: 'upstream_rate_limited', retryAfterSeconds: 42 }), { action: 'stop' });
  assert.deepEqual(classifyFailure({ reason: 'rate_limited' }), { action: 'stop' });
  for (const reason of ['translation_pool_exhausted', 'reviews_pool_exhausted', 'llm_budget_exhausted', 'translation_disabled']) {
    assert.deepEqual(classifyFailure({ reason }), { action: 'pause_quota' }, reason);
  }
  for (const reason of ['llm_unavailable', 'semantic_review_unavailable', 'site_not_configured', 'upstream_unauthorized', 'upstream_forbidden', 'unauthorized', 'forbidden']) {
    assert.deepEqual(classifyFailure({ reason }), { action: 'stop' }, reason);
  }
  assert.deepEqual(classifyFailure({ reason: 'upstream_timeout' }), { action: 'manual_retry' });
  assert.deepEqual(classifyFailure({ status: 500, reason: 'mystery' }), { action: 'segment_failed' });
  assert.deepEqual(classifyFailure({ status: 500 }), { action: 'segment_failed' });
});

const start = (keys = ['a', 'b', 'c']) => runReducer(initialRun(), { type: 'start', kind: 'semantic', items: keys.map((key, index) => ({ key, index })) });
const statusesOf = s => s.items.map(i => i.status).join(',');

test('runReducer runs serially to done', () => {
  let s = start();
  assert.equal(s.phase, 'running');
  assert.equal(nextQueued(s).key, 'a');
  s = runReducer(s, { type: 'sent', key: 'a' });
  assert.equal(nextQueued(s), null);
  s = runReducer(s, { type: 'done', key: 'a' });
  for (const key of ['b', 'c']) {
    assert.equal(nextQueued(s).key, key);
    s = runReducer(s, { type: 'sent', key });
    s = runReducer(s, { type: 'done', key });
  }
  assert.equal(s.phase, 'done');
  assert.deepEqual(runProgress(s), { done: 3, failed: 0, skipped: 0, total: 3 });
  assert.equal(runReducer(initialRun(), { type: 'start', kind: 'term', items: [] }).phase, 'done');
});

test('runReducer waits, pauses for quota and stops according to the classification', () => {
  let s = runReducer(start(), { type: 'sent', key: 'a' });
  s = runReducer(s, { type: 'failed', key: 'a', code: 'shared_pool_busy', classification: { action: 'wait', seconds: 30 }, now: 1000 });
  assert.deepEqual([s.phase, s.waitUntil, statusesOf(s), nextQueued(s)], ['waiting', 31000, 'queued,queued,queued', null]);
  s = runReducer(s, { type: 'resume' });
  assert.deepEqual([s.phase, s.waitUntil], ['running', null]);
  s = runReducer(runReducer(s, { type: 'sent', key: 'a' }), { type: 'failed', key: 'a', code: 'llm_budget_exhausted', classification: { action: 'pause_quota' }, now: 0 });
  assert.deepEqual([s.phase, s.stopCode, statusesOf(s)], ['paused', 'llm_budget_exhausted', 'queued,queued,queued']);
  s = runReducer(s, { type: 'resume' });
  assert.deepEqual([s.phase, s.stopCode], ['running', null]);
  s = runReducer(runReducer(s, { type: 'sent', key: 'a' }), { type: 'failed', key: 'a', code: 'unauthorized', classification: { action: 'stop' }, now: 0 });
  assert.deepEqual([s.phase, s.stopCode, nextQueued(s)], ['stopped', 'unauthorized', null]);
});

test('two equal segment failures in a row stop the run; a success clears the streak; retry requeues', () => {
  const fail = (s, key, code = 'bad_gateway', action = 'segment_failed') => runReducer(runReducer(s, { type: 'sent', key }),
    { type: 'failed', key, code, classification: { action }, now: 0 });
  let s = start(['a', 'b', 'c', 'd', 'e']);
  s = fail(s, 'a');
  assert.deepEqual([s.phase, s.streak], ['running', { code: 'bad_gateway', count: 1 }]);
  s = runReducer(runReducer(s, { type: 'sent', key: 'b' }), { type: 'done', key: 'b' });
  assert.equal(s.streak.count, 0);
  s = fail(s, 'c');
  s = fail(s, 'd', 'upstream_timeout', 'manual_retry');
  assert.deepEqual([s.phase, s.streak.count], ['running', 1]);
  s = runReducer(s, { type: 'retry', key: 'd' });
  s = fail(s, 'd', 'upstream_timeout', 'manual_retry');
  assert.deepEqual([s.phase, s.stopCode, statusesOf(s)], ['stopped', 'upstream_timeout', 'failed,done,failed,failed,queued']);
  s = runReducer(s, { type: 'resume' });
  assert.deepEqual([s.phase, s.streak.count, nextQueued(s).key], ['running', 0, 'e']);
  s = runReducer(runReducer(s, { type: 'sent', key: 'e' }), { type: 'done', key: 'e' });
  assert.equal(s.phase, 'done');
  s = runReducer(s, { type: 'retry', key: 'a' });
  assert.deepEqual([s.phase, nextQueued(s).key], ['running', 'a']);
  assert.deepEqual(runProgress(s), { done: 2, failed: 2, skipped: 0, total: 5 });
});

test('pause keeps the in-flight item; skip ends an item without touching streak or phase', () => {
  let s = runReducer(start(), { type: 'sent', key: 'a' });
  s = runReducer(s, { type: 'pause' });
  assert.equal(s.phase, 'paused');
  assert.equal(nextQueued(s), null);
  s = runReducer(s, { type: 'done', key: 'a' });
  assert.deepEqual([s.phase, statusesOf(s)], ['paused', 'done,queued,queued']);
  s = runReducer(s, { type: 'resume' });
  s = runReducer(runReducer(s, { type: 'sent', key: 'b' }), { type: 'failed', key: 'b', code: 'x', classification: { action: 'segment_failed' }, now: 0 });
  s = runReducer(s, { type: 'skip', key: 'c' });
  assert.deepEqual([s.items[2].status, s.items[2].code, s.streak, s.phase], ['skipped', 'segment_changed', { code: 'x', count: 1 }, 'done']);
  assert.deepEqual(runProgress(s), { done: 1, failed: 1, skipped: 1, total: 3 });
  s = runReducer(runReducer(start(['q']), { type: 'sent', key: 'q' }), { type: 'skip', key: 'q' });
  assert.deepEqual([s.items[0].status, s.phase], ['skipped', 'done']);
  assert.equal(runReducer(s, { type: 'reset' }).phase, 'idle');
  // a user pause survives a wait classification
  let p = runReducer(runReducer(start(), { type: 'sent', key: 'a' }), { type: 'pause' });
  p = runReducer(p, { type: 'failed', key: 'a', code: 'shared_pool_busy', classification: { action: 'wait', seconds: 5 }, now: 0 });
  assert.deepEqual([p.phase, p.waitUntil, p.items[0].status], ['paused', null, 'queued']);
});

// ---- issues ----

const issueOf = (source, target, needleS, needleT, extra = {}) => ({
  id: 'a'.repeat(32), fingerprint: 'f'.repeat(32), category: 'omission', origin: 'model', confidence: 'high',
  source_span: needleS ? sp(source, needleS) : null, target_span: needleT ? sp(target, needleT) : null,
  source_excerpt: needleS ?? null, target_excerpt: needleT ?? null, rationale: 'why', suggestion: null, suggestion_withheld: null, alternatives: [], ...extra,
});

test('placeSegmentIssues shifts segment issues into document coordinates', () => {
  const pair = PAIRS[1];
  const segSource = Array.from(SRC).slice(pair.source.core_start, pair.source.core_end).join('');
  const segTarget = Array.from(TGT).slice(pair.target.core_start, pair.target.core_end).join('');
  const issue = issueOf(segSource, segTarget, 'Gate Keeper', '门卫', {
    suggestion: { target_span: sp(segTarget, '门卫'), replacement: '看门人', term_effect: 'none' } });
  const [placed] = placeSegmentIssues({ report: { issues: [issue] }, pair });
  assert.equal(placed.segment_index, 1);
  assert.equal(Array.from(SRC).slice(placed.source_span.start, placed.source_span.end).join(''), 'Gate Keeper');
  assert.equal(Array.from(TGT).slice(placed.suggestion.target_span.start, placed.suggestion.target_span.end).join(''), '门卫');
});

test('liveIssue follows several edits in order and goes stale only when a span is hit', () => {
  const oldSource = 'One two three four.';
  const oldTarget = '一二三四五六。';
  const issue = issueOf(oldSource, oldTarget, 'three', '五六', { suggestion: { target_span: sp(oldTarget, '五六'), replacement: 'x', term_effect: 'none' } });
  const s1 = 'One two three four.!';
  const s2 = 'Zero. One two three four.!';
  const t1 = '零一二三四五六。';
  const t2 = '零零一二三四五六。';
  const live = liveIssue(issue, { sourceSplices: [diffSplice(oldSource, s1), diffSplice(s1, s2)], targetSplices: [diffSplice(oldTarget, t1), diffSplice(t1, t2)], source: s2, target: t2 });
  assert.equal(live.stale, false);
  assert.deepEqual(live.live.source_span, sp(s2, 'three'));
  assert.deepEqual(live.live.target_span, sp(t2, '五六'));
  assert.deepEqual(live.live.suggestion_span, sp(t2, '五六'));
  // an intermediate state that would not match the final text is fine: only the final text is checked
  const hit = '一二三四伍六。';
  const stale = liveIssue(issue, { sourceSplices: [], targetSplices: [diffSplice(oldTarget, hit)], source: oldSource, target: hit });
  assert.equal(stale.stale, true);
  assert.equal(stale.live.target_span, null);
  assert.deepEqual(stale.live.source_span, issue.source_span);
  const onlyTarget = issueOf(oldSource, oldTarget, null, '五六');
  assert.equal(liveIssue(onlyTarget, { sourceSplices: [], targetSplices: [], source: oldSource, target: oldTarget }).stale, false);
  // the final text disagreeing with the coordinates is stale
  assert.equal(liveIssue(issue, { sourceSplices: [], targetSplices: [], source: 'changed text', target: oldTarget }).stale, true);
});

// ---- workfile budget and history ----

const TB = { dictionary_revision: 'd1'.repeat(32), matcher_revision: 'a2'.repeat(32) };

async function ignored(source, target, n) {
  return makeSemanticDecision({ issue: { id: String(n).repeat(32), fingerprint: 'f'.repeat(32), category: 'omission', segment_index: 0,
    source_span: { start: 0, end: 1, text: 'x' }, target_span: null }, segmentIndex: 0, source, target, termBasis: TB, decision: 'ignored', appliedText: null });
}

test('semanticTextsWithinBudget keeps only needed, non-current texts and drops the oldest until the file fits', async () => {
  const big = c => `${c}${'x'.repeat(430_000)}`;
  const [a, b, c, old] = [big('A'), big('B'), big('C'), 'old short text'];
  const d1 = await ignored(a, b, 1);
  const d2 = await ignored(c, old, 2);
  const accepted = await makeSemanticDecision({ issue: { id: '3'.repeat(32), fingerprint: 'f'.repeat(32), category: 'omission', segment_index: 0, source_span: { start: 0, end: 1, text: 'x' }, target_span: null },
    segmentIndex: 0, source: 'unrelated source', target: 'unrelated target', termBasis: TB, decision: 'accepted', appliedText: 'y' });
  const payload = { source: 'current source', target: 'current target', direction: 'en', alignments: null, choices: [], history: [],
    semantic_decisions: [d1, d2, accepted], semantic_texts: [], semantic_history: [] };
  const entry = async text => ({ revision: await revisionOf(text), text });
  const candidates = [await entry(a), await entry(b), await entry(c), await entry(old), await entry('unrelated source'), await entry('current source')];
  const { texts, dropped } = semanticTextsWithinBudget({ payload, candidates, currentTexts: { source: 'current source', target: 'current target' } });
  // oldest first out: old, then c, until A+B (860 KB) fit
  assert.deepEqual(texts.map(t => t.text === a ? 'a' : t.text === b ? 'b' : '?'), ['a', 'b']);
  assert.equal(dropped, 2);
  assert.equal(parseWorkfile(serializeWorkfile({ ...payload, semantic_texts: texts })).semantic_texts.length, 2);
  // current texts are never stored
  const current = semanticTextsWithinBudget({ payload: { ...payload, semantic_decisions: [await ignored('current source', 'current target', 4)] },
    candidates: [await entry('current source'), await entry('current target')], currentTexts: { source: 'current source', target: 'current target' } });
  assert.deepEqual(current, { texts: [], dropped: 0 });
});

function reportFor(source, target, needleS, needleT) {
  const sourceSpan = sp(source, needleS); const targetSpan = sp(target, needleT);
  return {
    request_id: 'r1', review_version: 'semantic-review-v1', source_revision: 'a'.repeat(64), target_revision: 'b'.repeat(64),
    term_basis: { dictionary_revision: 'c'.repeat(64), matcher_revision: 'd'.repeat(64) }, status: 'complete', status_reason: null,
    dropped_unanchored: 0, checked: ['omission'],
    issues: [{ id: '1'.repeat(32), fingerprint: '2'.repeat(32), category: 'omission', origin: 'model', confidence: 'low', source_span: sourceSpan, target_span: targetSpan,
      source_excerpt: excerptOf(needleS), target_excerpt: excerptOf(needleT), rationale: 'r', suggestion: null, suggestion_withheld: null, alternatives: [] }],
    truncated: false, truncated_reason: null, omitted_issues: 0,
  };
}

test('historySnapshot keeps unchanged segments and round-trips through a v2 workfile', () => {
  const regionOf = (p, side) => ({ start: p[side].core_start, end: p[side].core_end });
  const slice = (text, r) => Array.from(text).slice(r.start, r.end).join('');
  const segments = PAIRS.map((p, i) => {
    const sourceRegion = regionOf(p, 'source'); const targetRegion = regionOf(p, 'target');
    const sentSource = slice(SRC, sourceRegion); const sentTarget = slice(TGT, targetRegion);
    return { segment_index: i, sentSource, sentTarget, sourceRegion, targetRegion, report: reportFor(sentSource, sentTarget, i === 0 ? 'guard' : 'Gate', i === 0 ? '守卫' : '之门') };
  }).reverse();
  segments[0] = { ...segments[0], sentTarget: 'edited since' };
  const snapshot = historySnapshot({ source: SRC, target: TGT, direction: 'en', segments });
  assert.deepEqual(snapshot.segments.map(s => s.segment_index), [0, 1]);
  assert.equal(historySnapshot({ source: SRC, target: TGT, direction: 'en', segments: [segments[0]] }), null);
  const payload = { source: SRC, target: TGT, direction: 'en', alignments: null, choices: [], history: [],
    semantic_decisions: [], semantic_texts: [], semantic_history: [snapshot] };
  const parsed = parseWorkfile(serializeWorkfile(payload));
  assert.equal(parsed.format, 'wuwaterm-manuscript-v2');
  assert.deepEqual(parsed.semantic_history[0], snapshot);
  // at most 64 segments, ascending
  const many = Array.from({ length: 70 }, (_, i) => ({ ...segments[1], segment_index: 69 - i }));
  assert.deepEqual(historySnapshot({ source: SRC, target: TGT, direction: 'en', segments: many }).segments.map(s => s.segment_index), Array.from({ length: 64 }, (_, i) => i));
});

test('semanticExportItems flattens issues with their status and semanticIssuesResolved counts decided ones', () => {
  const base = issueOf('abc def', '甲乙 丙', 'def', '丙', { segment_index: 2, suggestion: { target_span: sp('甲乙 丙', '丙'), replacement: 'R', term_effect: 'none' } });
  const second = { ...issueOf('abc def', '甲乙 丙', 'abc', null), id: 'b'.repeat(32), suggestion_withheld: 'span_too_long', stale: true };
  const third = { ...issueOf('abc def', '甲乙 丙', null, '甲乙'), id: 'c'.repeat(32) };
  const statuses = new Map([[base.id, 'adjusted'], ['zzz', 'ignored'], [third.id, 'bogus']]);
  const rows = semanticExportItems({ issues: [base, second, third], statuses });
  assert.deepEqual(rows[0], { issue_id: base.id, category: 'omission', confidence: 'high', segment_index: 2, source_excerpt: 'def', target_excerpt: '丙',
    rationale: 'why', suggestion: 'R', suggestion_withheld: null, status: 'adjusted' });
  assert.deepEqual([rows[1].status, rows[1].suggestion, rows[1].suggestion_withheld, rows[1].target_excerpt], ['stale', null, 'span_too_long', null]);
  assert.equal(rows[2].status, 'pending');
  assert.equal(semanticIssuesResolved(statuses), 2);
  assert.equal(semanticIssuesResolved({ a: 'accepted', b: 'pending', c: 'needs_reconfirmation', d: 'ignored' }), 2);
  assert.equal(semanticExportItems({ issues: [base], statuses: { [base.id]: 'needs_reconfirmation' } })[0].status, 'needs_reconfirmation');
});

test('nextToSend moves on as soon as the run state shows the last send finished, however late its promise settles', async () => {
  const { nextToSend } = await import('../lib/semantic-run.js');
  const items = ['a', 'b', 'c'].map((key, index) => ({ key, index }));
  let s = runReducer(initialRun(), { type: 'start', kind: 'semantic', items });
  // The caller starts b but the state does not show it yet: never start it twice.
  s = runReducer(runReducer(s, { type: 'sent', key: 'a' }), { type: 'done', key: 'a' });
  const pendingB = { key: 'b', attempt: 1 };
  assert.equal(nextToSend(s, pendingB), null);
  // b failed (charged, 502). Its runner may still be settling; the run continues with c.
  // (The old guard waited for that promise and stalled the run when it settled after the render.)
  s = runReducer(runReducer(s, { type: 'sent', key: 'b' }), { type: 'failed', key: 'b', code: 'upstream_network_error', classification: { action: 'segment_failed' }, now: 0 });
  assert.equal(nextToSend(s, pendingB)?.key, 'c');
  // A wait puts b back in the queue after its send: resuming sends b again.
  let w = runReducer(runReducer(initialRun(), { type: 'start', kind: 'semantic', items }), { type: 'sent', key: 'a' });
  w = runReducer(w, { type: 'failed', key: 'a', code: 'shared_pool_busy', classification: { action: 'wait', seconds: 5 }, now: 0 });
  assert.equal(nextToSend(w, { key: 'a', attempt: 1 }), null);
  w = runReducer(w, { type: 'resume' });
  assert.equal(nextToSend(w, { key: 'a', attempt: 1 })?.key, 'a');
  // A retried failed item is sent again.
  s = runReducer(runReducer(s, { type: 'sent', key: 'c' }), { type: 'done', key: 'c' });
  s = runReducer(s, { type: 'retry', key: 'b' });
  assert.equal(nextToSend(s, { key: 'c', attempt: 1 })?.key, 'b');
});
