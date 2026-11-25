import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as L from '../lib/long-review.ts';
import { parseWorkfile, serializeWorkfile } from '../lib/manuscript.js';
import { GAP_SEGMENTATION_VERSION, SEGMENTATION_VERSION, pairSegments, pairSegmentsWithGaps } from '../lib/segmentation.ts';
import { reviewFeatureHeader } from '../lib/workbench-transport.ts';

// manuscript-v5 SPEC "Review features" and "Gap-tolerant segment records" at runtime: a stored result is reused only under the
// features it was made with, a check stores the features it asked for, and a gapped alignment list keeps every aligned segment.

const read = name => readFileSync(new URL(`../contracts/manuscript-v5/${name}`, import.meta.url), 'utf8');
const AMB = ['ambiguous-mention-v1'];
const draftOf = x => ({ source: x.source, target: x.target, direction: x.direction, alignments: x.alignments });
const states = (long, ctx) => long.records.map((_, i) => L.recordView(long, i, ctx)?.state);

test('session features come from the capabilities: null while unknown, ambiguous-mention-v1 only when listed', () => {
  assert.equal(L.sessionReviewFeatures(null), null);
  assert.deepEqual(L.sessionReviewFeatures([]), []);
  assert.deepEqual(L.sessionReviewFeatures(['structure-check-v1', 'ambiguous-mention-v1', 'semantic-review-v1']), AMB);
  assert.equal(reviewFeatureHeader(true), 'dense-128,reason-v1');
  assert.equal(reviewFeatureHeader([]), 'dense-128,reason-v1');
  assert.equal(reviewFeatureHeader(AMB), 'dense-128,reason-v1,ambiguous-mention-v1');
});

test('a stored result is current only under the features it was made with; saved while they are unknown; stale under others', () => {
  const parsed = parseWorkfile(read('valid-v5-features-without-ambiguous.json'));
  const long = L.longFromWorkfile(parsed);
  assert.deepEqual(long.records.map(r => r.features), [AMB, AMB, []]);
  const draft = draftOf(parsed);
  const basis = parsed.segments[0].basis;
  assert.deepEqual(states(long, { draft, basis, features: AMB }), ['current', 'stale', 'pending']);
  assert.deepEqual(states(long, { draft, basis, features: null }), ['saved', 'stale', 'pending']);
  assert.deepEqual(states(long, { draft, basis, features: [] }), ['stale', 'stale', 'pending']);
  // A v4 file has no list: under a session that asks for the feature its results are checked again, once.
  const v4 = parseWorkfile(read('valid-v4-from-v5.json'));
  const v4long = L.longFromWorkfile(v4);
  assert.ok(v4long.records.every(r => r.features.length === 0));
  const v4ctx = { draft: draftOf(v4), basis: v4.segments.find(r => r.basis)?.basis ?? null };
  const done = v4long.records.findIndex(r => r.status === 'done');
  assert.ok(done >= 0);
  assert.equal(L.recordView(v4long, done, { ...v4ctx, features: AMB }).state, 'stale');
  assert.notEqual(L.recordView(v4long, done, { ...v4ctx, features: [] }).state, 'stale');
});

test('a check asks for the session features, stores them with an ambiguous_mention result, and the reopened file reuses it', () => {
  const parsed = parseWorkfile(read('valid-v5-segments-ambiguous.json'));
  const draft = draftOf(parsed);
  const basis = parsed.segments[0].basis;
  const long = L.longFromWorkfile(parsed);
  const ctx = { draft, basis, features: AMB };
  // Record 2 is pending: its check carries the features, and the result keeps its ambiguous finding.
  const request = L.segmentRequest(long, 2, ctx);
  assert.deepEqual(request.features, AMB);
  const record0 = L.expandResult(long.records[0], L.segmentInputs(draft).items[0].sourceCore, L.segmentInputs(draft).items[0].targetCore);
  assert.equal(record0.findings.at(-1).reason, 'ambiguous_mention');
  assert.notEqual(L.compactResult(record0), null, 'a result with an ambiguous_mention finding is storable');
  const item = L.segmentInputs(draft).items[2];
  const report = {
    request_id: 'req-2', source_revision: item.sourceHash, target_revision: item.targetHash, rule_version: 'review-v2',
    matcher_revision: basis.matcher_revision, dictionary: { ...basis.dictionary },
    coverage: { evaluated: 0, not_evaluated: 0, rules: ['review.term_pair', 'review.sentence_meaning'] }, findings: [], truncated: false,
  };
  const out = L.applyResult(long, ctx, request, report);
  assert.equal(out.error, null);
  assert.deepEqual(out.long.records[2].features, AMB);
  assert.deepEqual(states(out.long, ctx), ['current', 'stale', 'current']);
  const written = parseWorkfile(serializeWorkfile({ ...parsed, ...draft, ...L.workfileParts(out.long, draft, { basis }) }));
  assert.equal(written.format, 'wuwaterm-manuscript-v5');
  assert.deepEqual(written.review_features, AMB);
  assert.deepEqual(states(L.longFromWorkfile(written), ctx), ['current', 'stale', 'current']);
  // The same check made without the feature is not reused by a session that asks for it.
  const plain = L.applyResult(long, { ...ctx, features: [] }, { ...request, features: [] }, report);
  assert.deepEqual(plain.long.records[2].features, []);
  assert.equal(L.recordView(plain.long, 2, ctx).state, 'stale');
});

test('the term view keeps ambiguous names out of the groups and lists them on their own', () => {
  const parsed = parseWorkfile(read('valid-v5-segments-ambiguous.json'));
  const draft = draftOf(parsed);
  const ctx = { draft, basis: parsed.segments[0].basis, features: AMB };
  const long = L.longFromWorkfile(parsed);
  const { judged, ambiguous } = L.splitAmbiguousSegments(L.termSegments(long, ctx));
  assert.ok(judged.every(s => s.report.findings.every(f => f.reason !== 'ambiguous_mention')));
  assert.deepEqual(ambiguous.map(s => s.report.findings.map(f => f.source_span.text)), [['椿'], ['椿']]);
  const groups = L.groupTermOccurrences(judged, draft.source, draft.target, draft.direction);
  assert.equal(groups.some(g => g.surface === '椿'), false);
  assert.equal(L.termGroupCounts(groups).not_evaluated, 0);
});

test('gap-tolerant pairing: covered or absent alignments are segmentation-v1; a gap keeps every aligned region and is never ready', () => {
  const source = '甲一。\n\n甲二。\n\n甲三。';
  const target = 'One.\n\nTwo.\n\nThree.';
  const at = (text, needle) => { const start = Array.from(text.slice(0, text.indexOf(needle))).length; return { start, end: start + Array.from(needle).length, text: needle }; };
  const pair = (s, t) => ({ source: at(source, s), target: t === null ? null : at(target, t) });
  const covering = [pair('甲一。', 'One.'), pair('甲二。', 'Two.'), pair('甲三。', 'Three.')];
  for (const alignments of [null, [], covering]) {
    const out = pairSegmentsWithGaps(source, target, 1800, alignments);
    assert.equal(out.version, SEGMENTATION_VERSION);
    assert.deepEqual(out.pairs, pairSegments(source, target, 1800, alignments));
  }
  // The middle alignment is gone: segmentation-v1 makes one manual pair, the gap-tolerant pairing a manual gap between two aligned ones.
  const gapped = [covering[0], covering[2]];
  assert.deepEqual(pairSegments(source, target, 1800, gapped).map(p => p.status), ['needs_manual_split']);
  const out = pairSegmentsWithGaps(source, target, 1800, gapped);
  assert.equal(out.version, GAP_SEGMENTATION_VERSION);
  assert.deepEqual(out.pairs.map(p => p.status), ['ready', 'needs_manual_split', 'ready']);
  const core = (text, r) => Array.from(text).slice(r.core_start, r.core_end).join('');
  assert.deepEqual(out.pairs.map(p => [core(source, p.source), core(target, p.target)]), [['甲一。', 'One.'], ['甲二。', 'Two.'], ['甲三。', 'Three.']]);
  // Source text only in the gap: untranslated. Target text only: unpaired target.
  assert.deepEqual(pairSegmentsWithGaps(source, 'One.\n\nThree.', 1800, [pair('甲一。', 'One.'), { source: at(source, '甲三。'), target: { ...at('One.\n\nThree.', 'Three.') } }]).pairs.map(p => p.status),
    ['ready', 'untranslated', 'ready']);
  const extraTarget = 'One.\n\nExtra.\n\nThree.';
  const tgt = needle => at(extraTarget, needle);
  const noGapSource = '甲一。\n\n甲三。';
  const src = needle => at(noGapSource, needle);
  assert.deepEqual(pairSegmentsWithGaps(noGapSource, extraTarget, 1800, [{ source: src('甲一。'), target: tgt('One.') }, { source: src('甲三。'), target: tgt('Three.') }]).pairs.map(p => p.status),
    ['ready', 'unpaired_target', 'ready']);
  // A target gap next to an alignment without a target: which part is whose is unknown, so the stretch is one manual gap.
  const withNull = [covering[0], { source: at(source, '甲二。'), target: null }, pair('甲三。', 'Three.')];
  assert.deepEqual(pairSegmentsWithGaps(source, target, 1800, withNull).pairs.map(p => p.status), ['ready', 'needs_manual_split', 'ready']);
  // The long-mode records carry the label.
  assert.equal(L.segmentInputs({ source, target, direction: 'en', alignments: gapped }).version, GAP_SEGMENTATION_VERSION);
});
