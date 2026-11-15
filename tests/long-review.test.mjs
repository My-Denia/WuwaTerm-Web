import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as L from '../lib/long-review.js';
import { alignmentInput as generatorInput, alignmentList as generatorList, canonicalV3 } from '../scripts/build-manuscript-v3-fixtures.mjs';

// Each test names the SPEC step (contracts/manuscript-v3/SPEC.md) its expectation comes from.
const dir = new URL('../contracts/manuscript-v3/', import.meta.url);
const read = name => readFileSync(new URL(name, dir), 'utf8');
const cases = JSON.parse(read('cases.json'));
const fixture = name => JSON.parse(read(name));
const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');
const draftOf = x => ({ source: x.source, target: x.target, direction: x.direction, alignments: x.alignments });
const replaceOnce = (text, from, to) => {
  assert.equal(text.split(from).length, 2, `exactly one ${from}`);
  return text.replace(from, () => to);
};
const without = (x, key) => Object.fromEntries(Object.entries(x).filter(([k]) => k !== key));
const edit = (draft, side, from, to) => ({ ...draft, [side]: replaceOnce(draft[side], from, to) });
const save = (parsed, long, draft, basis) => canonicalV3({ ...parsed, ...draft, ...L.workfileParts(long, draft, { basis }) });

// valid-v3-all-parts.json: record 0 pending with an unconfirmed not_a_term at 示例地; record 1 done under B with a confirmed
// official_pair at 0:3, a confirmed not_a_term at 6:9 (finding with candidates_truncated) and an unconfirmed official_pair at 16:19
// without a finding; record 2 stale under B_OLD; progress {current: 0, completed: [1, 2]}; one history entry.
const ALL = fixture('valid-v3-all-parts.json');
const DRAFT = draftOf(ALL);
const B = ALL.segments[1].basis;
const B_OLD = ALL.segments[2].basis;
const B_MATCHER = { ...B, matcher_revision: sha('another matcher revision') };
const ctx = (draft, basis) => ({ draft, basis });
const item = (draft, i) => L.segmentInputs(draft).items[i];
const PLACE = { candidate_id: sha('candidate:current:示例地:Sample Place:place'), zh: '示例地', en: 'Sample Place', category: 'place' };
assert.deepEqual(ALL.segments[0].choices[0].offered, [PLACE.candidate_id]);
const RESULTS = [
  { truncated: false, evaluated: 1, not_evaluated: 0, findings: [{ verdict: 'needs_review', source: [0, 3], target: null, candidates: [PLACE], candidates_truncated: false }] },
  ALL.segments[1].result,
  ALL.segments[2].result,
];

/** A review-v2 response as the BFF returns it, for the current cores of `index`. */
function respond(draft, index, result, basis = B) {
  const it = item(draft, index);
  return { ...L.expandResult({ source_hash: it.sourceHash, target_hash: it.targetHash, basis, result }, it.sourceCore, it.targetCore), request_id: 'req-1' };
}

/** One segment check as the UI runs it (step 6): the planned first request, then the second one when applyResult asks for it. */
function check(long, index, context, result = RESULTS[index], basis = B) {
  let withResolutions = L.recheckPlan(long, index, context) === 'with_resolutions';
  const sent = [];
  for (;;) {
    const request = L.segmentRequest(long, index, context, { withResolutions });
    sent.push(request.body);
    const out = L.applyResult(long, context, request, respond(context.draft, index, result, basis));
    assert.equal(out.error, null);
    long = out.long;
    if (!out.secondRequest || sent.length === 2) return { long, sent };
    withResolutions = true;
  }
}

// ---- Segment request: the alignment input ----

test('Segment request: alignmentList and alignmentInput equal the generator on the g2 cases', () => {
  const source = 'abcdefghij';
  const target = 'ABCDEFGHIJKLMNOP';
  const range = { source_start: 2, source_end: 6, target_start: 3, target_end: 9 };
  const span = (start, end, text) => ({ start, end, text });
  const inputs = [
    [{ source: span(0, 4, 'abcd'), target: span(0, 5, 'ABCDE') }, { source: span(4, 8, 'efgh'), target: null }, { source: span(8, 10, 'ij'), target: span(12, 14, 'MN') }],
    [{ source: span(2, 6, 'cdef'), target: span(10, 12, 'KL') }],
    [],
    null,
  ];
  for (const alignments of inputs) {
    assert.equal(JSON.stringify(L.alignmentList(alignments, source, target, range)), JSON.stringify(generatorList(alignments, source, target, range)));
    assert.equal(L.alignmentInput(alignments, source, target, range), generatorInput(alignments, source, target, range));
  }
  assert.equal(L.alignmentInput([], source, target, range), sha('[]'));
  assert.equal(L.alignmentInput(null, source, target, range), 'automatic');
});

test('Segment request: alignmentInput equals the generator for every record of every v3 fixture, and segmentInputs carries it', () => {
  for (const c of cases.valid.filter(c => c.file.startsWith('valid-v3-') && !c.pad_to_bytes)) {
    const x = fixture(c.file);
    for (const r of x.segments) assert.equal(L.alignmentInput(x.alignments, x.source, x.target, r), generatorInput(x.alignments, x.source, x.target, r), `${c.file} ${r.index}`);
  }
  const x = fixture('valid-v3-explicit-alignments.json');
  const done = x.segments.filter(r => r.status !== 'pending');
  assert.ok(done.length > 0 && done.every(r => r.alignment_input === item(draftOf(x), r.index).alignmentInput));
});

// ---- Runtime step 2 and Writing: opening and saving ----

const EXCLUDED = {
  'valid-v3-hash-not-current.json': 'record 1 stored source hash is not its core: written pending (tested below)',
  'valid-v3-inputs-not-current.json': 'record 1 direction differs from the manuscript: written pending (tested below)',
  'valid-v3-512-segments.json': 'paragraph ranges, not a pairSegments result',
  'valid-v3-2000-core-8-offered.json': '2,000-scalar cores, not a pairSegments result',
};

test('Runtime step 2 and Writing: an unchanged file maps by position and writes back its canonical bytes', () => {
  const files = cases.valid.filter(c => !c.pad_to_bytes && !EXCLUDED[c.file]);
  assert.equal(files.length, 10);
  for (const c of files) {
    const parsed = fixture(c.file);
    assert.equal(save(parsed, L.longFromWorkfile(parsed), draftOf(parsed), null), read(c.canonical), c.file);
  }
  const parts = L.workfileParts(L.longFromWorkfile(ALL), DRAFT, { basis: null });
  const keys = ['index', 'segmentation_version', 'source_start', 'source_end', 'target_start', 'target_end', 'source_hash', 'target_hash', 'status', 'direction', 'alignment_input', 'basis', 'result', 'choices'];
  for (const r of parts.segments) assert.deepEqual(Object.keys(r), keys);
  assert.deepEqual(Object.keys(parts), ['segments', 'segment_choice_history', 'progress']);
});

test('Writing: a stored hash that is not the current core\'s makes the record pending; a direction mismatch too; an alignment-input mismatch stays stale', () => {
  for (const file of ['valid-v3-hash-not-current.json', 'valid-v3-inputs-not-current.json']) {
    const parsed = fixture(file);
    const long = L.longFromWorkfile(parsed);
    const { segments, progress } = L.workfileParts(long, draftOf(parsed), { basis: null });
    assert.equal(segments[1].status, 'pending', file);
    assert.equal(segments[1].source_hash, sha('示例名遇见了示例物，示例名又回到示例城。'), file);
    assert.deepEqual(segments[1].choices.map(c => c.confirmed), [false, false, false], file);
    assert.equal(segments[2].status, 'stale', file);
    assert.deepEqual(progress.completed, [2], file);
  }
});

test('Runtime step 2: after re-segmentation a record with both hashes equal moves with its result; progress follows', () => {
  const lead = 'Opening line keeps this paragraph long. '.repeat(23).trim();
  const parsed = { ...ALL, source: `新的开头。\n\n${ALL.source}`, target: `${lead}\n\n${ALL.target}` };
  const long = L.longFromWorkfile(parsed);
  assert.equal(long.records.length, 4);
  assert.deepEqual(long.records.map(r => r.status), ['pending', 'pending', 'done', 'stale']);
  assert.deepEqual(long.records[2].choices, ALL.segments[1].choices);
  assert.equal(long.records[2].source_start, ALL.segments[1].source_start + 7);
  assert.deepEqual(long.progress, { current: 1, completed: [2, 3] });
  assert.equal(L.recordView(long, 2, ctx(draftOf(parsed), B)).state, 'current');
  assert.deepEqual(long.history, ALL.segment_choice_history);
});

test('Runtime step 2: a segment matched by source hash only keeps the choices unconfirmed, not the result', () => {
  const parsed = { ...ALL, target: replaceOnce(ALL.target, 'returned to', 'went back to') };
  const long = L.longFromWorkfile(parsed);
  const r = long.records[1];
  assert.equal(r.result, null);
  assert.deepEqual(r.choices.map(c => [c.source_span.text, c.confirmed]), [['示例名', false], ['示例物', false], ['示例城', false]]);
  assert.equal(r.prior, null);
  assert.deepEqual(long.records.map(x => x.status), ['pending', 'pending', 'stale']);
  assert.deepEqual(long.progress.completed, [2]);
});

test('Runtime step 2: a changed core loses its result; a choice that no longer reads the same and the choices of unused records move to history', () => {
  // Same length, so the ranges still equal the pairing: records map by position.
  const positional = L.longFromWorkfile({ ...ALL, source: replaceOnce(ALL.source, '示例城', '示例镇') });
  assert.equal(positional.records[1].status, 'pending');
  assert.deepEqual(positional.records[1].choices.map(c => [c.source_span.text, c.confirmed]), [['示例名', false], ['示例物', false]]);
  assert.deepEqual(positional.history.map(e => [e.source_span.text, e.source_hash]), [['示例名', ALL.segment_choice_history[0].source_hash], ['示例城', ALL.segments[1].source_hash]]);
  // A longer core shifts the ranges: no record matches the middle segment, so its record is unused.
  const shifted = L.longFromWorkfile({ ...ALL, source: replaceOnce(ALL.source, '又回到', '又一次回到') });
  assert.deepEqual(shifted.records[1].choices, []);
  assert.deepEqual(shifted.history.slice(1).map(e => [e.source_span.text, e.source_hash]), ALL.segments[1].choices.map(c => [c.source_span.text, ALL.segments[1].source_hash]));
  assert.equal(shifted.records[2].status, 'stale');
});

// ---- Runtime steps 1 to 5: saved, current, stale; the probe ----

test('Runtime steps 1, 3 and 5: before the live basis a reusable record is saved; under the same basis current; a stored stale record stays stale', () => {
  const long = L.longFromWorkfile(ALL);
  assert.deepEqual([0, 1, 2].map(i => L.recordView(long, i, ctx(DRAFT, null)).state), ['pending', 'saved', 'stale']);
  const current = L.recordView(long, 1, ctx(DRAFT, B));
  assert.equal(current.state, 'current');
  assert.equal(current.needsCheck, false);
  assert.deepEqual(current.choices.map(c => c.view), ['applies', 'applies', 'needs_reconfirmation']);
  assert.deepEqual(L.recordView(long, 1, ctx(DRAFT, null)).choices.map(c => c.view), ['waiting', 'waiting', 'needs_reconfirmation']);
  assert.deepEqual(L.recordView(long, 0, ctx(DRAFT, B)).choices.map(c => c.view), ['waiting']);
  // No v3 basis in the live responses: no saved result is reused this session.
  assert.equal(L.recordView(long, 1, ctx(DRAFT, false)).state, 'stale');
});

test('Runtime step 5: a matcher_revision-only change makes the done record stale and keeps its finished mark', () => {
  const long = L.longFromWorkfile(ALL);
  const view = L.recordView(long, 1, ctx(DRAFT, B_MATCHER));
  assert.deepEqual([view.state, view.needsCheck, view.finished], ['stale', true, true]);
  const { segments, progress } = L.workfileParts(long, DRAFT, { basis: B_MATCHER });
  assert.deepEqual(segments.map(r => r.status), ['pending', 'stale', 'stale']);
  assert.deepEqual(progress.completed, [1, 2]);
  assert.equal(L.workfileParts(long, DRAFT, { basis: B }).segments[1].status, 'done');
});

test('Runtime step 4: the probe goes to progress.current if it needs a check, else the first that does, else current or 0', () => {
  const long = L.longFromWorkfile(ALL);
  const unknown = ctx(DRAFT, null);
  assert.equal(L.probeIndex(long, unknown), 0);
  assert.equal(L.probeIndex(L.setCurrent(long, 2), unknown), 2);
  assert.equal(L.probeIndex(L.setCurrent(long, 1), unknown), 0);
  let all = long;
  for (const i of [0, 1, 2]) all = check(all, i, ctx(DRAFT, B)).long;
  assert.deepEqual([0, 1, 2].map(i => L.recordView(all, i, unknown).state), ['saved', 'saved', 'saved']);
  assert.equal(L.probeIndex(L.setCurrent(all, 2), unknown), 2);
  assert.equal(L.probeIndex(L.setCurrent(all, null), unknown), 0);
});

test('Runtime step 4: reopening an unchanged manuscript under an unchanged basis costs one request and keeps every record as stored', () => {
  let long = L.longFromWorkfile(ALL);
  for (const i of [0, 1, 2]) long = check(long, i, ctx(DRAFT, B)).long;
  const file = save(ALL, long, DRAFT, B);
  const reopened = L.longFromWorkfile(JSON.parse(file));
  const target = L.probeIndex(reopened, ctx(DRAFT, null));
  const probe = L.segmentRequest(reopened, target, ctx(DRAFT, null), { withResolutions: true });
  assert.equal(Object.hasOwn(probe.body, 'resolutions'), false);
  const out = L.applyResult(reopened, ctx(DRAFT, null), probe, respond(DRAFT, target, RESULTS[target]));
  assert.deepEqual([out.error, out.secondRequest, out.long === reopened], [null, false, true]);
  assert.deepEqual(out.basis, B);
  assert.deepEqual([0, 1, 2].map(i => L.recordView(out.long, i, ctx(DRAFT, out.basis)).needsCheck), [false, false, false]);
  assert.equal(save(ALL, out.long, DRAFT, out.basis), file);
});

// ---- Runtime step 6: one or two requests ----

test('Runtime step 6: a target-only edit in the session is one request with the confirmed choices as resolutions', () => {
  const after = edit(DRAFT, 'target', 'returned to', 'went back to');
  const long = L.reconcileLong(L.longFromWorkfile(ALL), DRAFT, after);
  const r = long.records[1];
  assert.deepEqual([r.status, r.result], ['pending', null]);
  assert.deepEqual(r.prior, { source_hash: ALL.segments[1].source_hash, direction: 'en', basis: B });
  assert.deepEqual(r.choices.map(c => c.confirmed), [true, true, false]);
  assert.deepEqual(long.progress.completed, [2]);
  assert.equal(L.recheckPlan(long, 1, ctx(after, B)), 'with_resolutions');
  assert.equal(L.recheckPlan(long, 1, ctx(after, B_MATCHER)), 'without_resolutions');
  const { long: checked, sent } = check(long, 1, ctx(after, B));
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].resolutions, [
    { mention_id: '0:3:示例名', choice: 'official_pair', candidate_id: ALL.segments[1].choices[0].candidate.candidate_id },
    { mention_id: '6:9:示例物', choice: 'not_a_term' },
  ]);
  assert.equal(L.recordView(checked, 1, ctx(after, B)).state, 'current');
  // Saved before the re-check, the record is pending and no choice is confirmed (SPEC "Records", "Segment choice").
  const written = L.workfileParts(long, after, { basis: B }).segments[1];
  assert.deepEqual([written.status, written.choices.map(c => c.confirmed)], ['pending', [false, false, false]]);
});

test('Runtime step 6: after a target-only edit the re-check never confirms a choice that was unconfirmed before, even when it matches', () => {
  // Record 1 with its official_pair at 0:3 unconfirmed: it matches its finding, but the user has not confirmed it.
  const base = L.longFromWorkfile(ALL);
  const choices = base.records[1].choices.map((c, i) => (i === 0 ? { ...c, confirmed: false } : c));
  const opened = { ...base, records: base.records.map((r, i) => (i === 1 ? { ...r, choices } : r)) };
  const after = edit(DRAFT, 'target', 'returned to', 'went back to');
  const long = L.reconcileLong(opened, DRAFT, after);
  assert.deepEqual(long.records[1].choices.map(c => c.confirmed), [false, true, false]);
  const { long: checked, sent } = check(long, 1, ctx(after, B));
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].resolutions, [{ mention_id: '6:9:示例物', choice: 'not_a_term' }]);
  assert.deepEqual(checked.records[1].choices.map(c => c.confirmed), [false, true, false]);
  const written = L.workfileParts(checked, after, { basis: B }).segments[1];
  assert.deepEqual([written.status, written.choices.map(c => c.confirmed)], ['done', [false, true, false]]);
});

test('Runtime step 6: after save and reopen the same record is checked without resolutions, then once more with the kept choices', () => {
  const after = edit(DRAFT, 'target', 'returned to', 'went back to');
  const file = save(ALL, L.reconcileLong(L.longFromWorkfile(ALL), DRAFT, after), after, B);
  const reopened = L.longFromWorkfile(JSON.parse(file));
  assert.deepEqual([reopened.records[1].status, reopened.records[1].prior], ['pending', null]);
  assert.equal(L.recheckPlan(reopened, 1, ctx(after, B)), 'without_resolutions');
  const { long, sent } = check(reopened, 1, ctx(after, B));
  assert.equal(sent.length, 2);
  assert.equal(Object.hasOwn(sent[0], 'resolutions'), false);
  assert.deepEqual(sent[1].resolutions.map(x => x.mention_id), ['0:3:示例名', '6:9:示例物']);
  assert.deepEqual(long.records[1].choices.map(c => c.confirmed), [true, true, false]);
  assert.equal(L.recordView(long, 1, ctx(after, B)).state, 'current');
});

test('Runtime steps 4 and 6: the second request after the probe carries the resolutions only under the basis the probe returned', () => {
  const long = L.longFromWorkfile(ALL);
  const probe = L.segmentRequest(long, 0, ctx(DRAFT, null), { withResolutions: true });
  const first = L.applyResult(long, ctx(DRAFT, null), probe, respond(DRAFT, 0, RESULTS[0]));
  assert.deepEqual([first.error, first.secondRequest, first.basis], [null, true, B]);
  // Built from the probe's context (basis still unknown), it sends nothing and would ask for another request again.
  const unknown = L.segmentRequest(first.long, 0, ctx(DRAFT, null), { withResolutions: true });
  assert.equal(Object.hasOwn(unknown.body, 'resolutions'), false);
  assert.equal(L.applyResult(first.long, ctx(DRAFT, null), unknown, respond(DRAFT, 0, RESULTS[0])).secondRequest, true);
  const second = L.segmentRequest(first.long, 0, ctx(DRAFT, first.basis), { withResolutions: true });
  assert.deepEqual(second.body.resolutions, [{ mention_id: '0:3:示例地', choice: 'not_a_term' }]);
  const done = L.applyResult(first.long, ctx(DRAFT, first.basis), second, respond(DRAFT, 0, RESULTS[0]));
  assert.deepEqual([done.error, done.secondRequest], [null, false]);
  assert.equal(L.recordView(done.long, 0, ctx(DRAFT, done.basis)).state, 'current');
});

// ---- Runtime step 7: realignment ----

const NAME = ALL.segments[1].choices[0].candidate;
const [ITEM_A, ITEM_B] = ALL.segments[1].result.findings[1].candidates;
function realign(findings) {
  const long = L.longFromWorkfile(ALL);
  const request = L.segmentRequest(long, 1, ctx(DRAFT, B));
  const result = { truncated: false, evaluated: findings.length, not_evaluated: 0, findings };
  const out = L.applyResult(long, ctx(DRAFT, B), request, respond(DRAFT, 1, result, B_MATCHER));
  assert.equal(out.error, null);
  return out;
}
const finding = (source, candidates, truncated = false) => ({ verdict: 'needs_review', source, target: null, candidates, candidates_truncated: truncated });

test('Runtime step 7: an official_pair is kept only while its finding has a candidate with the same id, zh, en and category', () => {
  assert.equal(realign([finding([0, 3], [NAME])]).long.records[1].choices[0].confirmed, true);
  for (const changed of [{ zh: '示例名二' }, { en: 'Sample Name II' }, { category: 'item' }, { candidate_id: sha('other id') }]) {
    assert.equal(realign([finding([0, 3], [{ ...NAME, ...changed }])]).long.records[1].choices[0].confirmed, false, JSON.stringify(changed));
  }
});

test('Runtime step 7: a not_a_term is kept when the candidate ids equal offered as a set, whatever candidates_truncated is', () => {
  for (const truncated of [true, false]) {
    assert.equal(realign([finding([6, 9], [ITEM_B, ITEM_A], truncated)]).long.records[1].choices[1].confirmed, true);
    assert.equal(realign([finding([6, 9], [ITEM_A], truncated)]).long.records[1].choices[1].confirmed, false);
  }
});

test('Runtime step 7: any other choice becomes unconfirmed, needs reconfirmation and is never dropped', () => {
  const out = realign([finding([0, 3], [NAME])]);
  const r = out.long.records[1];
  assert.deepEqual(r.choices.map(c => [c.source_span.text, c.confirmed]), [['示例名', true], ['示例物', false], ['示例城', false]]);
  assert.equal(out.secondRequest, true);
  assert.deepEqual(L.recordView(out.long, 1, ctx(DRAFT, B_MATCHER)).choices.map(c => c.view), ['waiting', 'needs_reconfirmation', 'needs_reconfirmation']);
  assert.deepEqual(L.reconfirmChoice(out.long, { index: 1, start: 6, end: 9 }).error, 'finding_missing');
});

// ---- Writing ----

test('Writing: a content change makes the record pending, recomputes its hashes, unconfirms its choices and leaves completed', () => {
  const after = edit(DRAFT, 'source', '又回到', '又一次回到');
  const long = L.reconcileLong(L.longFromWorkfile(ALL), DRAFT, after);
  const { segments, progress } = L.workfileParts(long, after, { basis: B });
  assert.deepEqual([segments[1].status, segments[1].source_hash], ['pending', sha('示例名遇见了示例物，示例名又一次回到示例城。')]);
  assert.deepEqual(segments[1].choices.map(c => [c.source_span.start, c.source_span.text, c.confirmed]), [[0, '示例名', false], [6, '示例物', false], [18, '示例城', false]]);
  assert.deepEqual(progress, { current: 0, completed: [2] });
});

test('Writing: a direction change makes every record pending', () => {
  const after = { ...DRAFT, direction: 'zh' };
  const long = L.reconcileLong(L.longFromWorkfile(ALL), DRAFT, after);
  const { segments, progress } = L.workfileParts(long, after, { basis: B });
  assert.deepEqual(segments.map(r => r.status), ['pending', 'pending', 'pending']);
  assert.ok(segments.every(r => r.choices.every(c => !c.confirmed)));
  assert.deepEqual(progress.completed, []);
  assert.ok(long.records.every(r => r.prior === null));
});

test('Writing: a changed alignment input or a different known basis writes the record stale, not pending', () => {
  const long = L.longFromWorkfile(ALL);
  const after = { ...DRAFT, alignments: [] };
  const aligned = L.reconcileLong(long, DRAFT, after);
  assert.deepEqual([aligned.records[1].status, aligned.records[1].result], ['done', ALL.segments[1].result]);
  assert.equal(L.recordView(aligned, 1, ctx(after, B)).state, 'stale');
  assert.deepEqual(L.workfileParts(aligned, after, { basis: B }).segments.map(r => r.status), ['pending', 'stale', 'stale']);
  assert.deepEqual(L.workfileParts(long, DRAFT, { basis: B_OLD }).segments.map(r => r.status), ['pending', 'stale', 'stale']);
  // Back to automatic correspondence: the stored inputs are current again.
  assert.equal(L.recordView(L.reconcileLong(aligned, after, DRAFT), 1, ctx(DRAFT, B)).state, 'current');
});

test('Writing: adding, changing or confirming a choice in a done record makes it stale', () => {
  const long = L.longFromWorkfile(ALL);
  const at = (l, i) => L.workfileParts(l, DRAFT, { basis: B }).segments[i].status;
  assert.equal(at(long, 1), 'done');
  const added = L.chooseTerm(long, { index: 1, finding: { source: [10, 13] }, candidate: NAME }, ctx(DRAFT, B));
  assert.equal(added.error, null);
  assert.deepEqual(added.long.records[1].choices[3], { source_span: { start: 10, end: 13, text: '示例名' }, choice: 'official_pair', candidate: NAME, offered: [], confirmed: true });
  assert.equal(at(added.long, 1), 'stale');
  const expanded = L.expandResult(long.records[1], item(DRAFT, 1).sourceCore, item(DRAFT, 1).targetCore);
  assert.deepEqual(L.chooseTerm(long, { index: 1, finding: expanded.findings[2], candidate: NAME }, ctx(DRAFT, B)), added);
  const changed = L.chooseTerm(long, { index: 1, finding: { source: [6, 9] }, candidate: ITEM_A }, ctx(DRAFT, B));
  assert.equal(changed.long.records[1].choices.length, 3);
  assert.equal(at(changed.long, 1), 'stale');
  // Confirming again: the not_a_term takes offered from the current finding (step 7).
  const findings = [finding([0, 3], [NAME]), finding([6, 9], [ITEM_A])];
  const realigned = realign(findings);
  assert.deepEqual(realigned.long.records[1].choices.map(c => c.confirmed), [true, false, false]);
  const current = check(realigned.long, 1, ctx(DRAFT, B_MATCHER), { truncated: false, evaluated: 2, not_evaluated: 0, findings }, B_MATCHER);
  assert.equal(current.sent.length, 1);
  assert.equal(L.recordView(current.long, 1, ctx(DRAFT, B_MATCHER)).state, 'current');
  const confirmed = L.reconfirmChoice(current.long, { index: 1, start: 6, end: 9 });
  assert.deepEqual(confirmed.long.records[1].choices[1], { ...ALL.segments[1].choices[1], offered: [ITEM_A.candidate_id], confirmed: true });
  assert.equal(L.recordView(confirmed.long, 1, ctx(DRAFT, B_MATCHER)).state, 'stale');
  assert.equal(L.workfileParts(confirmed.long, DRAFT, { basis: B_MATCHER }).segments[1].status, 'stale');
  assert.equal(L.chooseTerm(long, { index: 0, finding: { source: [0, 3] }, candidate: null }, ctx(DRAFT, B)).error, 'finding_missing');
});

test('Writing: leaving long mode moves every choice to history with its record\'s source hash', () => {
  const after = { ...DRAFT, target: 'Short.' };
  const long = L.reconcileLong(L.longFromWorkfile(ALL), DRAFT, after);
  assert.deepEqual(long.records, []);
  assert.deepEqual(long.history.slice(1).map(e => [e.source_span.text, e.source_hash]),
    ALL.segments.flatMap(r => r.choices.map(c => [c.source_span.text, r.source_hash])));
  assert.deepEqual(L.workfileParts(long, after, { basis: B }), { segments: [], segment_choice_history: long.history, progress: { current: null, completed: [] } });
});

test('Writing: a choice whose occurrence was edited moves to history; nothing is dropped silently, and it can be restored (step 8)', () => {
  const count = l => l.records.reduce((n, r) => n + r.choices.length, 0) + l.history.length;
  const start = L.longFromWorkfile(ALL);
  assert.deepEqual(L.restorableHistory(start, ctx(DRAFT, B)), [null]);
  const after = edit(DRAFT, 'source', '示例城', '示例镇');
  const edited = L.reconcileLong(start, DRAFT, after);
  assert.equal(count(edited), count(start));
  assert.deepEqual(edited.history.at(-1), { source_hash: ALL.segments[1].source_hash, source_span: { start: 16, end: 19, text: '示例城' }, choice: 'official_pair', candidate: ALL.segments[1].choices[2].candidate, offered: [] });
  const back = L.reconcileLong(edited, after, DRAFT);
  assert.deepEqual(L.restorableHistory(back, ctx(DRAFT, B)), [null, 1]);
  assert.equal(L.restoreHistoryEntry(back, 1, 0, ctx(DRAFT, B)).error, 'not_restorable');
  const restored = L.restoreHistoryEntry(back, 1, 1, ctx(DRAFT, B));
  assert.equal(restored.error, null);
  assert.deepEqual(restored.long.records[1].choices.at(-1), { source_span: { start: 16, end: 19, text: '示例城' }, choice: 'official_pair', candidate: ALL.segments[1].choices[2].candidate, offered: [], confirmed: false });
  assert.equal(count(restored.long), count(start));
});

// ---- Segment request bodies ----

test('Segment request: null alignments omit the key, a list is clipped and rebased to the cores, [] is sent as []', () => {
  const long = L.longFromWorkfile(ALL);
  const automatic = L.segmentRequest(long, 1, ctx(DRAFT, null));
  assert.deepEqual(Object.keys(automatic.body), ['source', 'target', 'direction', 'review_version']);
  assert.deepEqual([automatic.alignmentInput, automatic.sentKey], ['automatic', '[]']);
  const empty = { ...DRAFT, alignments: [] };
  const sentEmpty = L.segmentRequest(L.reconcileLong(long, DRAFT, empty), 1, ctx(empty, null));
  assert.deepEqual([sentEmpty.body.alignments, sentEmpty.alignmentInput], [[], sha('[]')]);
  const x = fixture('valid-v3-explicit-alignments.json');
  const listed = L.segmentRequest(L.longFromWorkfile(x), 1, ctx(draftOf(x), null));
  assert.equal(JSON.stringify(listed.body.alignments), JSON.stringify(generatorList(x.alignments, x.source, x.target, x.segments[1])));
  assert.equal(listed.body.alignments[0].source.start, 0);
  assert.equal(listed.alignmentInput, x.segments[1].alignment_input);
});

test('Segment request and step 6: resolutions and the four-key resolution_context go out only under a known session basis', () => {
  const long = L.longFromWorkfile(ALL);
  for (const basis of [null, false]) {
    const request = L.segmentRequest(long, 1, ctx(DRAFT, basis), { withResolutions: true });
    assert.deepEqual([Object.hasOwn(request.body, 'resolutions'), Object.hasOwn(request.body, 'resolution_context'), request.sentKey], [false, false, '[]']);
  }
  const request = L.segmentRequest(long, 1, ctx(DRAFT, B), { withResolutions: true });
  assert.equal(request.body.resolutions.length, 2);
  assert.deepEqual(request.body.resolution_context, {
    source_revision: ALL.segments[1].source_hash, rule_version: 'review-v2', dictionary_revision: B.dictionary.revision, matcher_revision: B.matcher_revision,
  });
  assert.deepEqual(Object.keys(request.body.resolution_context), ['source_revision', 'rule_version', 'dictionary_revision', 'matcher_revision']);
  assert.equal(request.sentKey, JSON.stringify(request.body.resolutions));
  assert.equal(Object.hasOwn(L.segmentRequest(long, 1, ctx(DRAFT, B)).body, 'resolutions'), false);
});

// ---- Basis and compact results ----

test('Terms (basis): basisOfReport fails closed on a null schema_version or source_commit or a missing matcher_revision', () => {
  const report = respond(DRAFT, 1, RESULTS[1]);
  assert.deepEqual(L.basisOfReport(report), B);
  assert.equal(L.basisOfReport({ ...report, dictionary: { ...report.dictionary, schema_version: null } }), null);
  assert.equal(L.basisOfReport({ ...report, dictionary: { ...report.dictionary, source_commit: null } }), null);
  assert.equal(L.basisOfReport(without(report, 'matcher_revision')), null);
  assert.equal(L.basisOfReport({ ...report, rule_version: 'review-v1' }), null);
  assert.equal(L.sameV3Basis(B, structuredClone(B)), true);
  assert.equal(L.sameV3Basis(B, B_MATCHER), false);
  const noMatcher = { rule_version: B.rule_version, dictionary: B.dictionary };
  assert.equal(L.sameV3Basis(noMatcher, noMatcher), false);
});

test('Runtime step 9: a response for changed text, without a v3 basis or with another rule_id stores nothing', () => {
  const long = L.longFromWorkfile(ALL);
  const request = L.segmentRequest(long, 1, ctx(DRAFT, null));
  const report = respond(DRAFT, 1, RESULTS[1], B_MATCHER);
  const after = edit(DRAFT, 'target', 'returned to', 'went back to');
  const moved = L.reconcileLong(long, DRAFT, after);
  assert.deepEqual(L.applyResult(moved, ctx(after, null), request, report), { long: moved, basis: B_MATCHER, secondRequest: false, error: 'segment_changed' });
  assert.deepEqual(L.applyResult(long, ctx(DRAFT, null), request, respond(DRAFT, 0, RESULTS[0], B_MATCHER)), { long, basis: null, secondRequest: false, error: 'response_invalid' });
  assert.deepEqual(L.applyResult(long, ctx(DRAFT, null), request, without(report, 'matcher_revision')), { long, basis: false, secondRequest: false, error: 'no_basis' });
  const otherRule = { ...report, findings: report.findings.map((f, i) => (i === 1 ? { ...f, rule_id: 'review.sentence_meaning' } : f)) };
  assert.equal(L.compactResult(otherRule), null);
  assert.equal(L.applyResult(long, ctx(DRAFT, null), request, otherRule).error, 'not_storable');
  assert.equal(L.compactResult({ ...report, coverage: { ...report.coverage, rules: ['review.term_pair'] } }), null);
});

test('Compact term result: expandResult rebuilds exactly the dropped fields, and compacting it again gives the stored result', () => {
  const long = L.longFromWorkfile(ALL);
  const it = item(DRAFT, 1);
  const report = L.expandResult(long.records[1], it.sourceCore, it.targetCore);
  assert.deepEqual(Object.keys(report), ['request_id', 'source_revision', 'target_revision', 'rule_version', 'matcher_revision', 'dictionary', 'coverage', 'findings', 'truncated']);
  assert.deepEqual([report.request_id, report.source_revision, report.target_revision], [null, ALL.segments[1].source_hash, ALL.segments[1].target_hash]);
  assert.deepEqual(L.basisOfReport(report), B);
  assert.deepEqual(report.coverage, { evaluated: RESULTS[1].evaluated, not_evaluated: RESULTS[1].not_evaluated, rules: ['review.term_pair', 'review.sentence_meaning'] });
  assert.deepEqual(report.findings[0], {
    id: '0:3:示例名', verdict: 'verified_constraint', rule_id: 'review.term_pair', source_span: { start: 0, end: 3, text: '示例名' },
    target_span: { start: 0, end: 11, text: 'Sample Name' }, candidates: [{ zh: NAME.zh, en: NAME.en, category: NAME.category, candidate_id: NAME.candidate_id, sources: [] }],
    candidates_truncated: false,
  });
  assert.ok(report.findings.every(f => f.candidates.every(c => c.sources.length === 0)));
  assert.deepEqual(L.compactResult(report), RESULTS[1]);
  const rows = L.exportSegments(long, ctx(DRAFT, null));
  assert.deepEqual(rows.map(r => [r.index, r.state, r.stale]), [[1, 'saved', true], [2, 'stale', true]]);
  assert.deepEqual(rows[0].findings[0].source_span, { start: 9, end: 12, text: '示例名' });
  assert.deepEqual(rows[0].report, report);
});

// ---- Progress ----

test('Progress: only a record with a result can be finished; current follows a changed segment by position', () => {
  const long = L.longFromWorkfile(ALL);
  assert.equal(L.setFinished(long, 0, true), long);
  assert.deepEqual(L.setFinished(long, 2, false).progress.completed, [1]);
  assert.deepEqual(L.setFinished(L.setFinished(long, 1, false), 1, true).progress.completed, [1, 2]);
  const onMiddle = L.setCurrent(long, 1);
  const after = edit(DRAFT, 'source', '又回到', '又一次回到');
  assert.equal(L.reconcileLong(onMiddle, DRAFT, after).progress.current, 1);
  assert.equal(L.reconcileLong(onMiddle, DRAFT, DRAFT), onMiddle);
});

test('Long mode boundary: entering long mode gives a pending record per segment; the 645k-scalar fixture opens and saves in time', () => {
  const short = { ...DRAFT, target: 'Short.' };
  assert.equal(L.isLong(short), false);
  const entered = L.reconcileLong(L.emptyLong(), short, DRAFT);
  assert.deepEqual(entered.records.map(r => [r.status, r.source_hash]), ALL.segments.map(r => ['pending', r.source_hash]));
  const x = fixture('valid-v3-over-1mib.json');
  const started = performance.now();
  const long = L.longFromWorkfile(x);
  const content = save(x, long, draftOf(x), null);
  const ms = performance.now() - started;
  console.log(`long-review: ${long.records.length} records, ${Array.from(x.source).length + Array.from(x.target).length} scalars opened and saved in ${ms.toFixed(0)} ms`);
  assert.equal(content, read('valid-v3-over-1mib.json'));
});

// ---- choices settled with the Windows client (SPEC steps 2, 4 and 6 and "Segment record") ----

test('Segment record and Runtime step 2: a done record on a pair that is not ready opens and saves as pending, its choice unconfirmed and out of completed', () => {
  // A 1,900-scalar paragraph pair whose sentence counts differ needs a manual split; the cores still fit a done record's 2,000.
  const source = `${'甲'.repeat(949)}。${'乙'.repeat(949)}。\n\n${'丙'.repeat(199)}。`;
  const target = `${'b'.repeat(1899)}.\n\n${'c'.repeat(199)}.`;
  const draft = { source, target, direction: 'en', alignments: null };
  const [first, second] = L.segmentInputs(draft).items;
  assert.deepEqual([first.pair.status, second.pair.status], ['needs_manual_split', 'ready']);
  const K = { candidate_id: sha('candidate:甲'), zh: '甲', en: 'Jia', category: 'item' };
  const head = (i, it) => ({ index: i, segmentation_version: 'segmentation-v1', ...it.range, source_hash: it.sourceHash, target_hash: it.targetHash });
  const done = { ...head(0, first), status: 'done', direction: 'en', alignment_input: 'automatic', basis: B,
    result: { truncated: false, evaluated: 1, not_evaluated: 0, findings: [{ verdict: 'needs_review', source: [0, 1], target: null, candidates: [K], candidates_truncated: false }] },
    choices: [{ source_span: { start: 0, end: 1, text: '甲' }, choice: 'official_pair', candidate: K, offered: [], confirmed: true }] };
  const pending = { ...head(1, second), status: 'pending', direction: null, alignment_input: null, basis: null, result: null, choices: [] };
  const opened = L.longFromWorkfile({ ...draft, segments: [done, pending], segment_choice_history: [], progress: { current: 0, completed: [0] } });
  assert.deepEqual([opened.records[0].status, opened.records[0].result, opened.records[0].choices[0].confirmed], ['pending', null, false]);
  assert.deepEqual(opened.progress, { current: 0, completed: [] });
  // The writer applies the same rule to a runtime record that still holds a result for that pair.
  const sent = JSON.stringify([{ mention_id: '0:1:甲', choice: 'official_pair', candidate_id: K.candidate_id }]);
  const held = { records: [{ ...done, report: null, sent, prior: null }, { ...pending, report: null, sent: null, prior: null }], history: [], progress: { current: 0, completed: [0] } };
  const { segments, progress } = L.workfileParts(held, draft, { basis: B });
  assert.deepEqual([segments[0].status, segments[0].result, segments[0].choices[0].confirmed], ['pending', null, false]);
  assert.deepEqual(progress.completed, []);
});

test('Runtime step 2: when records do not map by position, an unused current record moves to the pair holding its start', () => {
  const parsed = { ...ALL, source: replaceOnce(ALL.source, '又回到', '又一次回到'), progress: { current: 1, completed: [1, 2] } };
  const long = L.longFromWorkfile(parsed);
  assert.deepEqual(long.records[1].choices, []);
  assert.deepEqual(long.progress, { current: 1, completed: [2] });
});

test('Runtime step 4: when the live response carries no v3 basis, every done record is written stale (fail closed)', () => {
  const long = L.longFromWorkfile(ALL);
  assert.deepEqual(L.workfileParts(long, DRAFT, { basis: null }).segments.map(r => r.status), ['pending', 'done', 'stale']);
  assert.deepEqual(L.workfileParts(long, DRAFT, { basis: false }).segments.map(r => r.status), ['pending', 'stale', 'stale']);
});

test('Runtime step 6: a re-check planned with resolutions but no confirmed choice keeps the unconfirmed choices unconfirmed', () => {
  const base = L.longFromWorkfile(ALL);
  // Record 1 with its two choices that hold in the result, both unconfirmed (they need reconfirmation).
  const unconfirmed = base.records[1].choices.slice(0, 2).map(c => ({ ...c, confirmed: false }));
  const long = { ...base, records: base.records.map((r, i) => (i === 1 ? { ...r, choices: unconfirmed } : r)) };
  const context = ctx(DRAFT, B);
  assert.equal(L.recheckPlan(long, 1, context), 'with_resolutions');
  const { long: after, sent } = check(long, 1, context);
  assert.equal(sent.length, 1);
  assert.equal(Object.hasOwn(sent[0], 'resolutions'), false);
  assert.deepEqual(after.records[1].choices.map(c => c.confirmed), [false, false]);
  assert.deepEqual(L.recordView(after, 1, context).choices.map(c => c.view), ['needs_reconfirmation', 'needs_reconfirmation']);
});

test('Runtime step 2 in a session: an edit that makes one segment equal another keeps each record and its choices at its own occurrence', () => {
  // Two segments with the same source core and different targets and choices: an official_pair in the first, a not_a_term in the
  // second. Editing the first target to read like the second must not hand either segment the other's record.
  const S = `今汐来了。${Array.from({ length: 130 }, (_, k) => `第${k + 1}句是合成句子。`).join('')}`;
  const en = tail => `Jinhsi came. ${Array.from({ length: 30 }, (_, k) => `Line ${k + 1} is ${tail}.`).join(' ')}`;
  const [T1, T2] = [en('first'), en('second')];
  const draft = { source: `${S}\n\n${S}`, target: `${T1}\n\n${T2}`, direction: 'en', alignments: null };
  assert.deepEqual(L.segmentInputs(draft).items.map(it => [it.pair.status, it.sourceCore === S]), [['ready', true], ['ready', true]]);
  const K = { candidate_id: sha('candidate:今汐'), zh: '今汐', en: 'Jinhsi', category: 'character' };
  const result = { truncated: false, evaluated: 1, not_evaluated: 0,
    findings: [{ verdict: 'verified_constraint', source: [0, 2], target: [0, 6], candidates: [K], candidates_truncated: false }] };
  const context = ctx(draft, B);
  let long = L.longFromWorkfile({ ...draft, segments: [], segment_choice_history: [], progress: { current: null, completed: [] } });
  for (const index of [0, 1]) ({ long } = check(long, index, context, result));
  long = L.chooseTerm(long, { index: 0, finding: { source: [0, 2] }, candidate: K }, context).long;
  long = L.chooseTerm(long, { index: 1, finding: { source: [0, 2] }, candidate: null }, context).long;
  for (const index of [0, 1]) ({ long } = check(long, index, context, result));
  const after = { ...draft, target: `${T2}\n\n${T2}` };
  const edited = L.reconcileLong(long, draft, after);
  assert.deepEqual(edited.records.map(r => r.choices.map(c => [c.choice, c.confirmed])), [[['official_pair', true]], [['not_a_term', true]]]);
  assert.deepEqual(edited.records.map(r => [r.status, r.result !== null, r.prior !== null]), [['pending', false, true], ['done', true, false]]);
  const { segments } = L.workfileParts(edited, after, { basis: B });
  assert.deepEqual(segments.map(r => [r.status, r.choices.map(c => [c.choice, c.confirmed])]),
    [['pending', [['official_pair', false]]], ['done', [['not_a_term', true]]]]);
});

test('Compact term result: exportSegments carries the result\'s truncated flag and each finding\'s candidates_truncated', () => {
  // Record 1's second finding has candidates_truncated; a copy of the record marks the result truncated (Core's 32-finding cap).
  const base = L.longFromWorkfile(ALL);
  const truncated = { ...base, records: base.records.map((r, i) => (i === 1 ? { ...r, result: { ...r.result, truncated: true } } : r)) };
  const rows = L.exportSegments(truncated, ctx(DRAFT, B));
  assert.deepEqual(rows.map(r => [r.index, r.truncated]), [[1, true], [2, false]]);
  assert.deepEqual(rows[0].findings.map(f => f.candidates_truncated), RESULTS[1].findings.map(f => f.candidates_truncated));
  assert.ok(rows[0].findings.some(f => f.candidates_truncated));
  assert.equal(rows[0].report.truncated, true);
});
