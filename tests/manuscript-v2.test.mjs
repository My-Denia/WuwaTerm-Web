import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { MAX_WORKFILE_BYTES, WORKFILE_FORMAT, WORKFILE_FORMAT_V2, makeChoice, parseWorkfile, semanticPartsOf, serializeWorkfile } from '../lib/manuscript.js';
import { buildSemanticTexts, makeSemanticDecision, reconcileSemanticDecisions, toDocumentIssue } from '../lib/semantic-decisions.js';
import { revisionOf } from '../lib/review-report.js';
import { buildFixtures } from '../scripts/build-manuscript-v2-fixtures.mjs';
import { fixture } from './fixtures/manuscript.mjs';

const dir = new URL('../contracts/manuscript-v2/', import.meta.url);
const read = name => readFileSync(new URL(name, dir), 'utf8');
const cases = JSON.parse(read('cases.json'));
const valid = parseWorkfile(read(cases.valid[0].file));
const TB = { dictionary_revision: 'd1'.repeat(32), matcher_revision: 'a2'.repeat(32) };
const span = (text, needle, from = 0) => {
  const at = text.indexOf(needle, from); const start = Array.from(text.slice(0, at)).length;
  return { start, end: start + Array.from(needle).length, text: needle };
};
const issue = (id, spans, fingerprint = 'f'.repeat(32), category = 'omission') =>
  ({ id, fingerprint, category, source_span: spans[0], target_span: spans[1] });
const decide = (oldSource, oldTarget, spans, kind = 'ignored', fingerprint = 'f'.repeat(32), category = 'omission') =>
  makeSemanticDecision({ issue: issue('a'.repeat(32), spans, fingerprint, category), segmentIndex: 0, source: oldSource, target: oldTarget,
    termBasis: TB, decision: kind, appliedText: kind === 'ignored' ? null : 'x' });
const status = async (args) => (await reconcileSemanticDecisions(args)).results.map(r => [r.status, r.code]);

test('without semantic data the writer still emits the exact v1 bytes', () => {
  const s = fixture(); const { report, trusted, resolutions, ...rest } = s; void report; void trusted; void resolutions;
  const payload = { ...rest, choices: [makeChoice({ ...s, finding: s.report.findings[0], candidate: s.report.findings[0].candidates[0] })], history: [] };
  const v1 = serializeWorkfile(payload);
  assert.equal(JSON.parse(v1).format, WORKFILE_FORMAT);
  assert.equal(v1, JSON.stringify({ format: WORKFILE_FORMAT, ...payload }, null, 2));
  assert.equal(serializeWorkfile({ ...payload, semantic_decisions: [], semantic_texts: [], semantic_history: [] }), v1);
  assert.deepEqual(semanticPartsOf(parseWorkfile(v1)), { semantic_decisions: [], semantic_texts: [], semantic_history: [] });
});

test('v2 round trips byte for byte and parse keeps the full object', () => {
  assert.equal(valid.format, WORKFILE_FORMAT_V2);
  const again = serializeWorkfile(valid);
  assert.equal(again, read(cases.valid[0].file));
  assert.deepEqual(parseWorkfile(again), valid);
  const parts = semanticPartsOf(valid);
  assert.equal(parts.semantic_decisions.length, 3); assert.equal(parts.semantic_texts.length, 1); assert.equal(parts.semantic_history.length, 1);
});

test('every invalid fixture is rejected with its code', () => {
  assert.equal(cases.invalid.length, 6);
  for (const c of cases.invalid) assert.throws(() => parseWorkfile(read(c.file)), { code: c.error }, c.file);
  assert.throws(() => parseWorkfile(JSON.stringify({ ...valid, extra: 1 })), { code: 'workfile_unsupported_format' });
});

test('the fixture generator output equals the committed bytes', async () => {
  const files = await buildFixtures();
  assert.ok(files.size >= 8);
  for (const [name, content] of files) assert.equal(read(name), content, name);
});

test('history is trimmed oldest-first over 1 MiB while decisions survive; decisions alone over the cap throw', () => {
  const snapshot = (text) => ({ ...valid.semantic_history[0], source: text + valid.source, segments: valid.semantic_history[0].segments.map(s => ({ ...s, source_start: Array.from(text).length, source_end: Array.from(text).length + 5 })) });
  const first = snapshot('一'.repeat(400_000)); const second = snapshot('二'.repeat(10));
  assert.ok(new TextEncoder().encode(JSON.stringify(first)).length > 1_100_000);
  // Rebuild the second snapshot's report for its own slice: the slice text is unchanged ('第三天到了。').
  const out = serializeWorkfile({ ...valid, semantic_history: [first, second] });
  const parsed = parseWorkfile(out);
  assert.equal(parsed.semantic_history.length, 1);
  assert.equal(parsed.semantic_history[0].source.startsWith('二'), true);
  assert.equal(parsed.semantic_decisions.length, 3);
  assert.throws(() => serializeWorkfile({ ...valid, source: 'a'.repeat(MAX_WORKFILE_BYTES) }), { code: 'workfile_too_large' });
});

test('an unreferenced semantic text is dropped by the writer', () => {
  const extra = { revision: 'e'.repeat(64), text: 'unused' };
  assert.equal(parseWorkfile(serializeWorkfile({ ...valid, semantic_texts: [...valid.semantic_texts, extra] })).semantic_texts.length, 1);
});

test('toDocumentIssue shifts spans by the segment cores and buildSemanticTexts keeps only verified needed texts', async () => {
  const pair = { index: 3, source: { core_start: 10 }, target: { core_start: 20 } };
  const shifted = toDocumentIssue({ ...issue('i'.repeat(32), [{ start: 1, end: 3, text: 'ab' }, { start: 2, end: 4, text: 'cd' }]),
    suggestion: { target_span: { start: 2, end: 4, text: 'cd' }, replacement: 'z', term_effect: 'none' } }, pair);
  assert.deepEqual([shifted.source_span.start, shifted.target_span.start, shifted.suggestion.target_span.end, shifted.segment_index], [11, 22, 24, 3]);
  const old = 'old text'; const d = await decide('src', old, [span('src', 'src'), null]);
  const revision = await revisionOf(old);
  assert.deepEqual(await buildSemanticTexts({ decisions: [d], texts: [{ revision, text: old }, { revision: 'f'.repeat(64), text: 'junk' }], source: 'src', target: 'new' }),
    [{ revision, text: old }]);
  assert.deepEqual(await buildSemanticTexts({ decisions: [d], texts: [{ revision, text: 'tampered' }], source: 'src', target: 'new' }), []);
  assert.deepEqual(await buildSemanticTexts({ decisions: [d], texts: [], source: 'src', target: old }), []);
});

const SRC = '甲乙。\n丙丁。'; const TGT = 'alpha.\nbeta.';
const sp = [span(SRC, '丙丁'), span(TGT, 'beta')];

test('ignored carries when both blocks are unique and one candidate sits at the recovered spans, even if another target line changed', async () => {
  const d = await decide(SRC, TGT, sp);
  const same = await reconcileSemanticDecisions({ decisions: [d], texts: [], source: SRC, target: TGT, issues: [issue('n'.repeat(32), sp)] });
  assert.deepEqual([same.results[0].status, same.carried_issue_ids], ['carried', ['n'.repeat(32)]]);
  const target = 'ALPHA CHANGED.\nbeta.'; const moved = [span(SRC, '丙丁'), span(target, 'beta')];
  const texts = await buildSemanticTexts({ decisions: [d], texts: [{ revision: await revisionOf(TGT), text: TGT }], source: SRC, target });
  assert.equal(texts.length, 1);
  const r = await reconcileSemanticDecisions({ decisions: [d], texts, source: SRC, target, issues: [issue('m'.repeat(32), moved)] });
  assert.equal(r.results[0].status, 'carried');
  assert.deepEqual(r.results[0].target_span, moved[1]);
  assert.deepEqual(await status({ decisions: [d], texts: [], source: SRC, target, issues: [issue('m'.repeat(32), moved)] }), [['needs_reconfirmation', 'old_text_unavailable']]);
});

test('a duplicated source or target line block never carries', async () => {
  const d = await decide(SRC, TGT, sp);
  const dupSource = '丙丁。\n丙丁。'; const dupTarget = 'beta.\nbeta.';
  assert.equal((await status({ decisions: [d], texts: [{ revision: await revisionOf(SRC), text: SRC }], source: dupSource, target: TGT, issues: [issue('n'.repeat(32), [span(dupSource, '丙丁'), sp[1]])] }))[0][0], 'needs_reconfirmation');
  assert.equal((await status({ decisions: [d], texts: [{ revision: await revisionOf(TGT), text: TGT }], source: SRC, target: dupTarget, issues: [issue('n'.repeat(32), [sp[0], span(dupTarget, 'beta')])] }))[0][0], 'needs_reconfirmation');
});

test('two candidates, a candidate elsewhere, and a tampered stored text all need reconfirmation; none reported is not_reported', async () => {
  const d = await decide(SRC, TGT, sp);
  const args = { decisions: [d], texts: [], source: SRC, target: TGT };
  assert.deepEqual(await status({ ...args, issues: [issue('1'.repeat(32), sp), issue('2'.repeat(32), [sp[0], span(TGT, 'alpha')])] }), [['needs_reconfirmation', 'multiple_candidates']]);
  assert.deepEqual(await status({ ...args, issues: [issue('1'.repeat(32), [span(SRC, '甲乙'), sp[1]])] }), [['needs_reconfirmation', 'candidate_elsewhere']]);
  assert.deepEqual(await status({ ...args, issues: [issue('1'.repeat(32), sp, '0'.repeat(32))] }), [['not_reported', 'not_reported']]);
  const target = 'changed.\nbeta.';
  const tampered = [{ revision: await revisionOf(TGT), text: 'alpha tampered.\nbeta.' }];
  assert.equal((await status({ ...args, target, texts: tampered, issues: [issue('1'.repeat(32), [sp[0], span(target, 'beta')])] }))[0][0], 'needs_reconfirmation');
});

test('accepted decisions never carry; reported again at the same place they are previously_applied', async () => {
  const d = await decide(SRC, TGT, sp, 'accepted');
  const args = { decisions: [d], texts: [], source: SRC, target: TGT };
  const same = await reconcileSemanticDecisions({ ...args, issues: [issue('1'.repeat(32), sp)] });
  assert.deepEqual([same.results[0].status, same.results[0].issue_id, same.carried_issue_ids], ['previously_applied', '1'.repeat(32), []]);
  assert.deepEqual(await status({ ...args, issues: [issue('1'.repeat(32), [span(SRC, '甲乙'), null])] }), [['needs_reconfirmation', 'applied_not_carried']]);
});

test('two decisions converging on one issue both need reconfirmation', async () => {
  const oldTarget = 'ALPHA.\nbeta.'; const oldSpans = [sp[0], span(oldTarget, 'beta')];
  const d1 = await decide(SRC, TGT, sp);
  const d2 = await decide(SRC, oldTarget, oldSpans);
  const texts = [{ revision: await revisionOf(oldTarget), text: oldTarget }];
  const r = await reconcileSemanticDecisions({ decisions: [d1, d2], texts, source: SRC, target: TGT, issues: [issue('1'.repeat(32), sp)] });
  assert.deepEqual(r.results.map(x => [x.status, x.code]), [['needs_reconfirmation', 'converged_on_one_issue'], ['needs_reconfirmation', 'converged_on_one_issue']]);
  assert.deepEqual(r.carried_issue_ids, []);
});
