// The shared edit-transaction contract (contracts/workbench-state/edit-transactions.json) on Web: the pure transaction in
// lib/manuscript.js, the controller's free edits, notices and undo/redo steps, and the saved manuscript (R9).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  INVALIDATION_REASONS, applyEditTransaction, computeMinimalScalarSplice, parseWorkfile, serializeWorkfile,
} from '../lib/manuscript.js';
import * as L from '../lib/long-review.ts';
import { freshSemantic } from '../lib/semantic-state.js';
import { MAX_UNDO, TYPING_COALESCE_MS, canonicalOf, createWorkbenchController } from '../lib/workbench-controller.ts';

const fixture = JSON.parse(readFileSync(new URL('../contracts/workbench-state/edit-transactions.json', import.meta.url), 'utf8'));

const NOTICE = { all: 'editedAlignments', partial: 'editedAlignmentsPartial' };
const toTx = tx => (tx.kind === 'fill'
  ? { kind: 'fill', pairSource: tx.pair_source, at: tx.at, insert: tx.insert, core: tx.core }
  : tx);
const snake = out => ({
  source: out.draft.source,
  target: out.draft.target,
  direction: out.draft.direction,
  alignments: out.draft.alignments,
  invalidated: out.invalidated.map(x => ({ original_index: x.originalIndex, reason: x.reason, entry: x.entry })),
  emptied_targets: out.emptiedTargets.map(x => ({ original_index: x.originalIndex, entry: x.entry })),
  fallback_all: out.fallbackAll,
});
const utf16 = (text, scalar) => Array.from(text).slice(0, scalar).join('').length;

function stepClock(start = 1_700_000_000_000) {
  let now = start;
  let id = 0;
  return {
    clock: {
      now: () => now,
      setTimeout: () => ++id,
      clearTimeout: () => {},
      setInterval: () => ++id,
      clearInterval: () => {},
    },
    at: ms => { now = start + ms; },
  };
}

/** Load `draft` as a new document through the public replacement path (one protected undo step, fresh semantic state). */
function load(doc, draft) {
  doc.replaceWithWorkfile({ draft, choices: [], reports: [], semantic: freshSemantic(draft), importedBody: null });
}

/** A controller holding `draft`; trace depths count only steps after this load. */
function loaded(draft) {
  const { clock, at } = stepClock();
  const doc = createWorkbenchController({ clock, onPoolRefresh: () => {} });
  load(doc, draft);
  const base = doc.getSnapshot().history.at(-1).serial;
  const undoDepth = () => {
    const history = doc.getSnapshot().history;
    return history.length - (history[0]?.serial === base ? 1 : 0);
  };
  return { doc, at, undoDepth };
}

test('the fixture names its schema, reasons and undo limits as Web implements them', () => {
  assert.equal(fixture.schema, 'wuwaterm-edit-transaction-cases-v1');
  assert.deepEqual(fixture.reasons, [...INVALIDATION_REASONS]);
  assert.deepEqual(fixture.undo, { limit: MAX_UNDO, coalesce_ms: TYPING_COALESCE_MS });
  assert.ok(fixture.cases.length >= 19);
  // Every rule the contract states has at least one case or trace.
  const covered = new Set([...fixture.cases, ...fixture.traces].flatMap(c => c.rules));
  for (const rule of ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8']) assert.ok(covered.has(rule), `${rule} has no case`);
  for (const reason of INVALIDATION_REASONS) {
    assert.ok(fixture.cases.some(c => c.expect.invalidated.some(x => x.reason === reason)), `${reason} has no case`);
  }
});

test('every case: applyEditTransaction gives the expected draft, invalidated and emptied entries, and never falls back', () => {
  for (const c of fixture.cases) {
    const out = applyEditTransaction(c.draft, toTx(c.transaction));
    const want = Object.fromEntries(Object.entries(c.expect).filter(([key]) => key !== 'alignment_notice'));
    assert.deepEqual(snake(out), want, c.id);
    assert.equal(out.fallbackAll, false, `${c.id}: fallback_all must not trigger`);
    if (c.splice) {
      const { side } = c.splice;
      const got = computeMinimalScalarSplice(c.draft[side], c.expect[side]);
      assert.deepEqual({ side, start: got.start, old_end: got.oldEnd, new_end: got.newEnd }, c.splice, `${c.id}: splice`);
    }
    if (c.utf16_splice) {
      const { side } = c.splice;
      assert.deepEqual({
        side,
        start: utf16(c.draft[side], c.splice.start),
        old_end: utf16(c.draft[side], c.splice.old_end),
        new_end: utf16(c.expect[side], c.splice.new_end),
      }, c.utf16_splice, `${c.id}: UTF-16 reference`);
    }
  }
});

test('the 64-alignment case touches one entry: 31 before it stay identical, 32 after it shift with the same texts', () => {
  const c = fixture.cases.find(x => x.id === 'sixty-four-alignments-one-affected');
  assert.equal(c.draft.alignments.length, 64);
  const out = applyEditTransaction(c.draft, toTx(c.transaction));
  assert.equal(out.draft.alignments.length, 63);
  assert.deepEqual(out.invalidated.map(x => x.originalIndex), [31]);
  assert.deepEqual(out.draft.alignments.slice(0, 31), c.draft.alignments.slice(0, 31));
  assert.deepEqual(out.draft.alignments.slice(31).map(a => a.target.text), c.draft.alignments.slice(32).map(a => a.target.text));
});

test('free-edit and direction cases through the controller: the same alignments, notice and session list', () => {
  for (const c of fixture.cases.filter(x => x.transaction.kind === 'edit' || x.transaction.kind === 'direction')) {
    const { doc } = loaded(c.draft);
    if (c.transaction.kind === 'edit') doc.editText(c.transaction.side, c.transaction.text);
    else doc.setDirection(c.transaction.direction);
    const snap = doc.getSnapshot();
    assert.deepEqual(
      { source: snap.draft.source, target: snap.draft.target, direction: snap.draft.direction, alignments: snap.draft.alignments },
      { source: c.expect.source, target: c.expect.target, direction: c.expect.direction, alignments: c.expect.alignments },
      c.id,
    );
    if (c.expect.alignment_notice) assert.equal(snap.notice, NOTICE[c.expect.alignment_notice], `${c.id}: notice`);
    else assert.ok(!['editedAlignments', 'editedAlignmentsPartial'].includes(snap.notice), `${c.id}: notice ${snap.notice}`);
    assert.deepEqual(
      snap.alignmentInvalidations.map(x => ({ original_index: x.originalIndex, reason: x.reason, entry: x.entry })),
      c.expect.invalidated,
      `${c.id}: session list`,
    );
    // R8: one undo restores the draft before the transaction, with every invalidated entry.
    doc.undo();
    assert.deepEqual(doc.getSnapshot().draft, c.draft, `${c.id}: undo`);
    assert.deepEqual(doc.getSnapshot().alignmentInvalidations, [], `${c.id}: undo session list`);
    doc.dispose();
  }
});

test('R9: a saved manuscript holds only the kept alignments and nothing of the session list', () => {
  for (const c of fixture.cases.filter(x => x.transaction.kind === 'edit' && x.expect.invalidated.length > 0)) {
    const { doc } = loaded(c.draft);
    doc.editText(c.transaction.side, c.transaction.text);
    const snap = doc.getSnapshot();
    assert.ok(snap.alignmentInvalidations.length > 0, c.id);
    const canonical = canonicalOf(snap.draft, snap.choices, snap.reports, snap.semantic, snap.basis);
    assert.ok(canonical, c.id);
    assert.deepEqual(parseWorkfile(canonical).alignments, c.expect.alignments, c.id);
    assert.doesNotMatch(canonical, /invalidat|originalIndex|original_index|fallback|emptied/u, c.id);
    const written = serializeWorkfile({ ...snap.draft, choices: [], history: [] });
    assert.deepEqual(Object.keys(JSON.parse(written)).sort(), ['alignments', 'choices', 'direction', 'format', 'history', 'source', 'target']);
    doc.dispose();
  }
});

test('every trace: undo, redo, coalescing and IME composition steps match through the controller', () => {
  for (const trace of fixture.traces) {
    const { doc, at, undoDepth } = loaded(trace.initial);
    trace.steps.forEach((step, i) => {
      const label = `${trace.id} step ${i} (${step.op})`;
      if (step.op === 'edit') {
        at(step.at_ms);
        doc.editText(step.side, step.text, step.composing ? { composing: true } : {});
      } else if (step.op === 'undo') doc.undo();
      else if (step.op === 'redo') doc.redo();
      else assert.equal(step.op, 'check', label);
      const e = step.expect;
      if (!e) return;
      const snap = doc.getSnapshot();
      if ('undo_depth' in e) assert.equal(undoDepth(), e.undo_depth, `${label}: undo depth`);
      if ('redo_depth' in e) assert.equal(doc.redoDepth(), e.redo_depth, `${label}: redo depth`);
      if ('alignments_count' in e) assert.equal(snap.draft.alignments?.length, e.alignments_count, `${label}: alignments`);
      if ('alignments' in e) assert.deepEqual(snap.draft.alignments, e.alignments, `${label}: alignments`);
      if ('session_invalidated' in e) assert.deepEqual(snap.alignmentInvalidations.map(x => x.reason), e.session_invalidated, `${label}: session`);
      if ('source' in e) assert.equal(snap.draft.source, e.source, `${label}: source`);
      if ('target' in e) assert.equal(snap.draft.target, e.target, `${label}: target`);
      if ('alignment_notice' in e) assert.equal(snap.notice, NOTICE[e.alignment_notice], `${label}: notice`);
    });
    doc.dispose();
  }
});

test('redo of a document replacement restores the replaced text and its protected checkpoint', () => {
  const { doc } = loaded({ source: 'Alpha', target: '甲', direction: 'en', alignments: null });
  doc.editText('source', 'Alpha!');
  load(doc, { source: 'Other', target: '乙', direction: 'en', alignments: null });
  const checkpoint = doc.getSnapshot().documentCheckpoint;
  assert.ok(checkpoint);
  doc.undo();
  assert.equal(doc.getSnapshot().draft.source, 'Alpha!');
  assert.equal(doc.getSnapshot().documentCheckpoint, null);
  assert.equal(doc.redo(), true);
  const snap = doc.getSnapshot();
  assert.equal(snap.draft.source, 'Other');
  assert.equal(snap.notice, 'redoLocal');
  assert.equal(snap.documentCheckpoint?.kind, checkpoint.kind);
  assert.equal(snap.documentCheckpoint?.entry.draft.source, 'Alpha!');
  assert.equal(snap.documentCheckpoint?.entry, snap.history.at(-1));
  assert.equal(doc.redo(), false);
  doc.dispose();
});

test('an IME composition judges alignments against the text before it: a crossing intermediate state that the end undoes keeps every entry', () => {
  const draft = {
    source: 'Alpha Beta', target: '甲 乙', direction: 'en',
    alignments: [
      { source: { start: 0, end: 5, text: 'Alpha' }, target: { start: 0, end: 1, text: '甲' } },
      { source: { start: 6, end: 10, text: 'Beta' }, target: { start: 2, end: 3, text: '乙' } },
    ],
  };
  const { doc, undoDepth } = loaded(draft);
  // An intermediate composition state that replaces the gap and Beta's start would cross a boundary on its own…
  doc.editText('source', 'AlphaXeta', { composing: true });
  assert.equal(doc.getSnapshot().draft.alignments.length, 1);
  // …but the committed text only inserts inside Alpha, so judged against the base nothing is invalidated.
  doc.editText('source', 'AlpXha Beta', { composing: true });
  doc.editText('source', 'AlpXha Beta');
  assert.deepEqual(doc.getSnapshot().draft.alignments, [
    { source: { start: 0, end: 6, text: 'AlpXha' }, target: { start: 0, end: 1, text: '甲' } },
    { source: { start: 7, end: 11, text: 'Beta' }, target: { start: 2, end: 3, text: '乙' } },
  ]);
  assert.deepEqual(doc.getSnapshot().alignmentInvalidations, []);
  assert.equal(undoDepth(), 1);
  doc.undo();
  assert.deepEqual(doc.getSnapshot().draft, draft);
  doc.dispose();
});

// ---- Long mode: which segment records an edit transaction leaves current --------------------------------------------------
// Four paragraphs of 1,301 scalars on each side, so no two ready pairs merge (segmentation-v1 merges neighbours up to 2,000),
// and explicit alignments covering every paragraph core, as an imported aligned manuscript has them.
const V3 = new URL('../contracts/manuscript-v3/', import.meta.url);
const BASIS = JSON.parse(readFileSync(new URL('valid-v3-all-parts.json', V3), 'utf8')).segments[1].basis;
const FILL_S = ['甲', '乙', '丙', '丁'];
const FILL_T = ['a', 'b', 'c', 'd'];
const LONG_S = FILL_S.map(x => `${x.repeat(1300)}。`);
const LONG_T = FILL_T.map(x => `${x.repeat(1300)}.`);
const LONG_SOURCE = LONG_S.join('\n\n');
const LONG_TARGET = LONG_T.join('\n\n');
const LONG_ALIGNMENTS = LONG_S.map((p, i) => {
  const s = i * 1303; const t = i * 1303;
  return { source: { start: s, end: s + 1301, text: p }, target: { start: t, end: t + 1301, text: LONG_T[i] } };
});
const LONG_DRAFT = { source: LONG_SOURCE, target: LONG_TARGET, direction: 'en', alignments: LONG_ALIGNMENTS };
const EMPTY_RESULT = { truncated: false, evaluated: 1, not_evaluated: 0, findings: [] };

/** Every record checked under BASIS with an empty result and marked finished. */
function checkedLong(draft) {
  let long = L.longFromWorkfile(draft);
  const context = { draft, basis: BASIS };
  for (let i = 0; i < long.records.length; i++) {
    const it = L.segmentInputs(draft).items[i];
    const report = {
      ...L.expandResult({ source_hash: it.sourceHash, target_hash: it.targetHash, basis: BASIS, result: EMPTY_RESULT }, it.sourceCore, it.targetCore),
      request_id: `long-${i}`,
    };
    const out = L.applyResult(long, context, L.segmentRequest(long, i, context), report);
    assert.equal(out.error, null);
    long = L.setFinished(out.long, i, true);
  }
  return long;
}
const states = (long, draft) => long.records.map((_, i) => {
  const view = L.recordView(long, i, { draft, basis: BASIS });
  return `${view.state}${view.finished ? '+finished' : ''}`;
});

test('long mode: the aligned draft pairs into four ready segments, all current and finished after a check', () => {
  const { long, items } = L.segmentInputs(LONG_DRAFT);
  assert.equal(long, true);
  assert.deepEqual(items.map(x => x.pair.status), ['ready', 'ready', 'ready', 'ready']);
  assert.deepEqual(states(checkedLong(LONG_DRAFT), LONG_DRAFT), Array(4).fill('current+finished'));
});

test('long mode R2: an edit inside one aligned paragraph leaves the other three segments current and finished', () => {
  const before = checkedLong(LONG_DRAFT);
  const out = applyEditTransaction(LONG_DRAFT, { kind: 'splice', side: 'source', start: 1303 + 10, end: 1303 + 10, replacement: '戊' });
  assert.deepEqual(out.invalidated, []);
  const after = L.reconcileLong(before, LONG_DRAFT, out.draft);
  assert.deepEqual(states(after, out.draft), ['current+finished', 'pending', 'current+finished', 'current+finished']);
});

test('long mode R1/R5: whitespace typed between aligned paragraphs keeps every segment current and finished', () => {
  const before = checkedLong(LONG_DRAFT);
  const out = applyEditTransaction(LONG_DRAFT, { kind: 'splice', side: 'target', start: 1302, end: 1302, replacement: ' ' });
  assert.deepEqual(out.invalidated, []);
  assert.equal(out.draft.alignments.length, 4);
  const after = L.reconcileLong(before, LONG_DRAFT, out.draft);
  assert.deepEqual(states(after, out.draft), Array(4).fill('current+finished'));
});

test('long mode R4: deleting one paragraph\'s translation keeps its source anchor; only that segment needs work again', () => {
  const before = checkedLong(LONG_DRAFT);
  const t = LONG_ALIGNMENTS[2].target;
  const out = applyEditTransaction(LONG_DRAFT, { kind: 'splice', side: 'target', start: t.start, end: t.end, replacement: '' });
  assert.deepEqual(out.emptiedTargets.map(x => x.originalIndex), [2]);
  assert.equal(out.draft.alignments[2].target, null);
  const { items } = L.segmentInputs(out.draft);
  assert.deepEqual(items.map(x => x.pair.status), ['ready', 'ready', 'untranslated', 'ready']);
  const after = L.reconcileLong(before, LONG_DRAFT, out.draft);
  assert.deepEqual(states(after, out.draft), ['current+finished', 'current+finished', 'pending', 'current+finished']);
});

// Pinned limitation, not a goal: segmentation-v1 (Core contracts/segmentation-v1.json) pairs explicit alignments only when they
// cover every non-whitespace scalar, and manuscript-v3 SPEC "Records" stores one record per segment of that pairing. Once an
// edit invalidates an entry of a covering list, the kept list leaves an uncovered gap and the whole manuscript becomes one
// needs_manual_split pair, so every record turns pending. The alignments themselves stay local (the user re-aligns one range,
// or uses automatic alignment), and undo restores the records exactly (next test).
test('long mode R3 with covering alignments: the kept list leaves a gap and the pairing becomes one manual segment', () => {
  const before = checkedLong(LONG_DRAFT);
  const out = applyEditTransaction(LONG_DRAFT, { kind: 'splice', side: 'source', start: 1303 + 1290, end: 2 * 1303 + 10, replacement: '' });
  assert.deepEqual(out.invalidated.map(x => [x.originalIndex, x.reason]), [[1, 'crossed_boundary'], [2, 'crossed_boundary']]);
  assert.equal(out.draft.alignments.length, 2);
  assert.deepEqual(L.segmentInputs(out.draft).items.map(x => x.pair.status), ['needs_manual_split']);
  const after = L.reconcileLong(before, LONG_DRAFT, out.draft);
  assert.deepEqual(states(after, out.draft), ['pending']);
});

test('long mode: undo after an invalidating edit restores the segment records, results and finished marks exactly', async () => {
  const long = checkedLong(LONG_DRAFT);
  const content = serializeWorkfile({ ...LONG_DRAFT, choices: [], history: [], ...L.workfileParts(long, LONG_DRAFT, { basis: BASIS }) });
  const bytes = new TextEncoder().encode(content);
  const doc = createWorkbenchController({ onPoolRefresh: () => {}, post: async () => { throw new Error('unexpected network call'); } });
  const outcome = await doc.importFile({ name: 'long.json', size: bytes.byteLength, arrayBuffer: async () => bytes.buffer.slice(0) });
  assert.equal(outcome.status, 'imported');
  const opened = doc.getSnapshot();
  assert.equal(opened.semantic.long.records.length, 4);
  assert.deepEqual(opened.semantic.long.progress.completed, [0, 1, 2, 3]);
  const chars = Array.from(LONG_SOURCE);
  doc.editText('source', chars.slice(0, 1303 + 1290).join('') + chars.slice(2 * 1303 + 10).join(''));
  const edited = doc.getSnapshot();
  assert.equal(edited.notice, 'editedAlignmentsPartial');
  assert.equal(edited.draft.alignments.length, 2);
  assert.equal(edited.semantic.long.records.length, 1);
  doc.undo();
  const undone = doc.getSnapshot();
  assert.deepEqual(undone.draft, opened.draft);
  assert.equal(undone.semantic.long, opened.semantic.long);
  assert.deepEqual(undone.alignmentInvalidations, []);
  doc.dispose();
});
