import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  addSegmentResult, emptySemantic, freshSemantic, issueStatus, longHoldsWork, mapSemanticEdit, occurrenceKey, placedOccurrence, reconcileState, upsertDecision,
} from '../lib/semantic-state.js';
import { longFromWorkfile } from '../lib/long-review.js';
import { makeSemanticDecision } from '../lib/semantic-decisions.js';
import { MAX_SEMANTIC_DECISIONS, parseWorkfile, serializeWorkfile } from '../lib/manuscript.js';
import { revisionOf } from '../lib/review-report.js';

const HEX = 'a'.repeat(64);
const span = (text, start, end) => ({ start, end, text: Array.from(text).slice(start, end).join('') });

async function setup(source, target, issueSpec) {
  const result = {
    id: 'r1', segmentKey: 'k', index: 0, sentSource: source, sentTarget: target, imported: false,
    report: { term_basis: { dictionary_revision: HEX, matcher_revision: HEX }, issues: [] },
    doc: { source, target, sourceRevision: await revisionOf(source), targetRevision: await revisionOf(target) },
    region: { source: { start: 0, end: Array.from(source).length }, target: { start: 0, end: Array.from(target).length } },
  };
  const issue = {
    id: '1'.repeat(32), fingerprint: '2'.repeat(32), category: 'meaning_shift', segment_index: 0,
    source_span: issueSpec.source, target_span: issueSpec.target,
    suggestion: issueSpec.suggestion ?? null, suggestion_withheld: null, alternatives: [],
  };
  const placed = {
    id: 'r1:1', resultId: 'r1', issue, occurrence: placedOccurrence(result, issue), stale: false,
    live: { source_span: issue.source_span, target_span: issue.target_span, suggestion_span: issue.suggestion?.target_span ?? null },
  };
  return { result, issue, placed, state: addSegmentResult(emptySemantic(), result, [placed], [{ revision: result.doc.targetRevision, text: target }]) };
}

test('an edit elsewhere moves live spans; an edit over them makes the issue stale', async () => {
  const source = 'Alpha beta.'; const target = '甲乙丙。丁戊。';
  const { state } = await setup(source, target, { source: span(source, 0, 5), target: span(target, 4, 6) });
  const moved = mapSemanticEdit(state, { source, target }, { source, target: `前言${target}` });
  assert.deepEqual(moved.placed[0].live.target_span, { start: 6, end: 8, text: '丁戊' });
  assert.equal(moved.placed[0].stale, false);
  const touched = mapSemanticEdit(state, { source, target }, { source, target: '甲乙丙。丁X。' });
  assert.equal(touched.placed[0].stale, true);
  assert.equal(issueStatus(touched, touched.placed[0]).status, 'stale');
  // The recorded issue keeps report-time coordinates for the decision.
  assert.deepEqual(touched.placed[0].issue.target_span, { start: 4, end: 6, text: '丁戊' });
});

test('one decision per occurrence, replaced in place, refused past the manuscript cap', async () => {
  const source = 'Alpha beta.'; const target = '甲乙丙。';
  const { result, issue, placed, state } = await setup(source, target, { source: span(source, 0, 5), target: span(target, 0, 2) });
  const make = decision => makeSemanticDecision({ issue, source: result.doc.source, target: result.doc.target, termBasis: result.report.term_basis, decision, appliedText: decision === 'ignored' ? null : '改' });
  const ignored = upsertDecision(state, await make('ignored'), placed.id);
  const accepted = upsertDecision(ignored, await make('accepted'), placed.id);
  assert.equal(accepted.decisions.length, 1);
  assert.equal(issueStatus(accepted, placed).status, 'accepted');
  assert.equal(occurrenceKey(accepted.decisions[0]), placed.occurrence);
  const full = { ...state, decisions: Array.from({ length: MAX_SEMANTIC_DECISIONS }, (_, i) => ({ ...accepted.decisions[0], source_span: { start: i, end: i + 1, text: 'x' } })) };
  assert.equal(upsertDecision(full, await make('ignored'), placed.id), null);
});

test('re-reviewing a segment replaces its issues; an older ignore carries without changing what is saved', async () => {
  const source = 'Alpha beta.'; const target = '甲乙丙。';
  const first = await setup(source, target, { source: span(source, 0, 5), target: span(target, 0, 2) });
  const decision = await makeSemanticDecision({ issue: first.issue, source, target, termBasis: first.result.report.term_basis, decision: 'ignored', appliedText: null });
  // The same occurrence reported again by a fresh review of the same segment.
  const again = await setup(source, target, { source: span(source, 0, 5), target: span(target, 0, 2) });
  const fresh = { ...again.result, id: 'r2' };
  const freshPlaced = { ...again.placed, id: 'r2:1', resultId: 'r2', occurrence: 'other-session' };
  let state = upsertDecision(first.state, decision, first.placed.id);
  state = addSegmentResult(state, fresh, [freshPlaced]);
  assert.deepEqual(state.placed.map(p => p.id), ['r2:1']);
  const merged = await reconcileState(state, { source, target });
  assert.equal(issueStatus(merged, freshPlaced).status, 'ignored');
  assert.deepEqual(merged.decisions, state.decisions);
  // The decision still round-trips through manuscript v2 unchanged.
  const file = serializeWorkfile({ source, target, direction: 'zh', alignments: null, choices: [], history: [], semantic_decisions: merged.decisions, semantic_texts: [], semantic_history: [] });
  assert.deepEqual(parseWorkfile(file).semantic_decisions, merged.decisions);
});

test('every edit reconciles the long state, including a direction change that leaves both texts as they were', () => {
  // manuscript-v3 SPEC Writing "Records": if the direction changes, every record becomes pending.
  const file = JSON.parse(readFileSync(new URL('../contracts/manuscript-v3/valid-v3-all-parts.json', import.meta.url), 'utf8'));
  const draft = { source: file.source, target: file.target, direction: file.direction, alignments: file.alignments };
  const state = { ...emptySemantic(), long: longFromWorkfile(file) };
  assert.equal(longHoldsWork(state.long), true);
  assert.ok(state.long.records.some(r => r.result !== null));
  const turned = mapSemanticEdit(state, draft, { ...draft, direction: draft.direction === 'en' ? 'zh' : 'en' });
  assert.deepEqual(turned.long.records.map(r => r.status), state.long.records.map(() => 'pending'));
  assert.ok(turned.long.records.every(r => r.choices.every(c => !c.confirmed)));
  // A texts-only call (no direction or alignments) leaves the long state as it is.
  assert.equal(mapSemanticEdit(state, { source: draft.source, target: draft.target }, { source: draft.source, target: `${draft.target}x` }).long, state.long);
  // A newly installed long draft starts with one pending record per segment.
  const fresh = freshSemantic(draft);
  assert.deepEqual(fresh.long.records.map(r => r.status), state.long.records.map(() => 'pending'));
  assert.equal(longHoldsWork(fresh.long), false);
});
