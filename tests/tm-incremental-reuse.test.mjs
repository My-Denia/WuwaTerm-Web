// Unit tests for Part 5: Batch trusted TM reuse & incremental re-translation in WorkbenchController.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkbenchController } from '../lib/workbench-controller.ts';
import { confirmTranslationMemoryEntry } from '../lib/translation-memory.ts';
import { CAPABILITY_STRUCTURE_CHECK, STRUCTURE_CHECKS } from '../lib/structure-check.js';
import { CAPABILITY_TRANSLATION_CONTEXT } from '../lib/semantic-review.js';
import { scalarOffset } from '../lib/workbench-model.ts';

const REV = 'd'.repeat(64);
const GAME = '3.7.0';
const BASIS = { currentTermsDbRevision: REV, currentGameVersion: GAME };

function okStructureResponse(batch, findingsById = {}) {
  return {
    request_id: 'req-struct',
    check_version: 'structure-check-v1',
    checks: [...STRUCTURE_CHECKS],
    segments: batch.segments.map((seg, index) => ({
      index,
      segment_id: seg.segment_id,
      findings: findingsById[seg.segment_id] ?? [],
      omitted_findings: 0,
      layout: { source_paragraphs: 1, target_paragraphs: 1, source_lines: 1, target_lines: 1 },
    })),
  };
}

function buildEntries() {
  const s1 = '第一段原文：攻击力提升 10%。';
  const s2 = '第二段原文：暴击率提升 20%。';
  const s3 = '第三段原文：共鸣效率提升 30%。';
  let entries = [];
  entries = confirmTranslationMemoryEntry(entries, {
    sourceText: s1,
    targetText: 'Para 1: ATK +10%.',
    direction: 'en',
    prevSource: null,
    nextSource: s2,
    termsDbRevision: REV,
    gameVersion: GAME,
  }).entries;
  entries = confirmTranslationMemoryEntry(entries, {
    sourceText: s2,
    targetText: 'Para 2: CRIT Rate +20%.',
    direction: 'en',
    prevSource: s1,
    nextSource: s3,
    termsDbRevision: REV,
    gameVersion: GAME,
  }).entries;
  entries = confirmTranslationMemoryEntry(entries, {
    sourceText: s3,
    targetText: 'Para 3: Energy Regen +30%.',
    direction: 'en',
    prevSource: s2,
    nextSource: null,
    termsDbRevision: REV,
    gameVersion: GAME,
  }).entries;
  return { s1, s2, s3, entries };
}

async function flushMicrotasks(rounds = 12) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

test('full context_exact + verified_fresh document reuses all 3 segments with 0 model calls, runs Layer 1 structure check, and emits non-text receipt', async () => {
  const { s1, s2, s3, entries } = buildEntries();
  const calls = [];
  const doc = createWorkbenchController({
    initialMode: 'manuscript',
    initialCapabilities: [CAPABILITY_STRUCTURE_CHECK, CAPABILITY_TRANSLATION_CONTEXT],
    getTmEntries: () => entries,
    resolveTmAutoReuseBasis: async () => BASIS,
    post: async (path, body) => {
      calls.push({ path, body });
      if (path === '/api/structure-checks') {
        return { response: new Response(null, { status: 200 }), value: okStructureResponse(body) };
      }
      throw new Error(`Unexpected POST to ${path}`);
    },
  });

  doc.editText('source', `${s1}\n\n${s2}\n\n${s3}`);
  await doc.translateInReview();

  const snap = doc.getSnapshot();
  assert.equal(snap.draft.target, 'Para 1: ATK +10%.\n\nPara 2: CRIT Rate +20%.\n\nPara 3: Energy Regen +30%.');
  assert.equal(snap.draft.alignments?.length, 3);
  assert.equal(calls.filter(c => c.path === '/api/translations').length, 0);
  assert.equal(calls.filter(c => c.path === '/api/structure-checks').length, 1);

  assert.deepEqual(snap.tmReceipt, {
    reused: 3,
    referenced: 0,
    staleOrUnknown: 0,
    retranslated: 0,
    demotedByStructureCheck: 0,
    demotedSegmentIndices: [],
    modelCalls: 0,
    baselineRequests: 3,
    termsDbRevision: REV,
    gameVersion: GAME,
    structureCheckStatus: 'passed',
  });
  // Receipt must contain ZERO segment text!
  const receiptJson = JSON.stringify(snap.tmReceipt);
  for (const text of [s1, s2, s3, 'ATK', 'CRIT', 'Energy']) {
    assert.equal(receiptJson.includes(text), false);
  }
});

test('edited third segment reuses untouched first segment, demotes second to exact reference, and sends only 2 segments to /api/translations', async () => {
  const { s1, s2, entries } = buildEntries();
  const s3Edited = '第三段已修改：暴击伤害提升 40%。';
  const calls = [];
  const doc = createWorkbenchController({
    initialMode: 'manuscript',
    initialCapabilities: [CAPABILITY_STRUCTURE_CHECK, CAPABILITY_TRANSLATION_CONTEXT],
    getTmEntries: () => entries,
    resolveTmAutoReuseBasis: async () => BASIS,
    post: async (path, body) => {
      calls.push({ path, body });
      if (path === '/api/structure-checks') {
        return { response: new Response(null, { status: 200 }), value: okStructureResponse(body) };
      }
      if (path === '/api/translations') {
        const text = body.text === s2 ? 'Model Para 2.' : 'Model Para 3 edited.';
        return {
          response: new Response(null, { status: 200 }),
          value: { kind: 'llm', text, direction: 'en', dictionary_miss: false, request_id: 'req-tr' },
        };
      }
      throw new Error(`Unexpected POST to ${path}`);
    },
  });

  doc.editText('source', `${s1}\n\n${s2}\n\n${s3Edited}`);
  await doc.startTranslateRun();
  await flushMicrotasks();

  const snap = doc.getSnapshot();
  // Segment 0 (`s1`, prev: null, next: s2) stayed context_exact + verified_fresh -> reused!
  // Segment 1 (`s2`, next changed from s3 to s3Edited) downgraded to `exact` -> referenced only, sent to model!
  // Segment 2 (`s3Edited`) -> unmatched, sent to model!
  assert.equal(snap.draft.target, 'Para 1: ATK +10%.\n\nModel Para 2.\n\nModel Para 3 edited.');
  const trCalls = calls.filter(c => c.path === '/api/translations');
  assert.equal(trCalls.length, 2);
  assert.deepEqual(trCalls.map(c => c.body.text), [s2, s3Edited]);
  assert.deepEqual(snap.tmReceipt, {
    reused: 1,
    referenced: 1,
    staleOrUnknown: 0,
    retranslated: 2,
    demotedByStructureCheck: 0,
    demotedSegmentIndices: [],
    modelCalls: 2,
    baselineRequests: 3,
    termsDbRevision: REV,
    gameVersion: GAME,
    structureCheckStatus: 'passed',
  });
});

test('Layer 1 structure-check-v1 finding on a reused segment demotes it to needs_review and surfaces finding in Layer 1', async () => {
  const { s1, s2, s3, entries } = buildEntries();
  const doc = createWorkbenchController({
    initialMode: 'manuscript',
    initialCapabilities: [CAPABILITY_STRUCTURE_CHECK],
    getTmEntries: () => entries,
    resolveTmAutoReuseBasis: async () => BASIS,
    post: async (path, body) => {
      assert.equal(path, '/api/structure-checks');
      return {
        response: new Response(null, { status: 200 }),
        value: okStructureResponse(body, {
          'tm-1': [{ rule_id: 'number_missing', source_span: { start: 12, end: 14, text: '20' }, target_span: null }],
        }),
      };
    },
  });

  doc.editText('source', `${s1}\n\n${s2}\n\n${s3}`);
  await doc.startTranslateRun();

  const snap = doc.getSnapshot();
  assert.equal(snap.tmReceipt?.reused, 3);
  assert.equal(snap.tmReceipt?.demotedByStructureCheck, 1);
  assert.deepEqual(snap.tmReceipt?.demotedSegmentIndices, [1]);
  assert.equal(snap.tmReceipt?.structureCheckStatus, 'findings');
  assert.equal(snap.structure.phase, 'done');
});

test('auto-reuse fails closed (0 reused) when live server dictionary identity is unavailable or on unaligned partial target (P1-03)', async () => {
  const { s1, s2, s3, entries } = buildEntries();
  const calls = [];
  const doc = createWorkbenchController({
    initialMode: 'manuscript',
    initialCapabilities: [CAPABILITY_STRUCTURE_CHECK],
    getTmEntries: () => entries,
    resolveTmAutoReuseBasis: async () => ({ currentTermsDbRevision: null, currentGameVersion: null }),
    post: async (path, body) => {
      calls.push({ path, body });
      return {
        response: new Response(null, { status: 200 }),
        value: { kind: 'llm', text: 'Full model output.', direction: 'en', dictionary_miss: false, request_id: 'req-tr' },
      };
    },
  });

  doc.editText('source', `${s1}\n\n${s2}\n\n${s3}`);
  await doc.startTranslateRun();
  await flushMicrotasks();

  assert.equal(doc.getSnapshot().tmReceipt?.reused, 0);
  assert.equal(doc.getSnapshot().tmReceipt?.staleOrUnknown, 3);
  assert.equal(calls.filter(c => c.path === '/api/structure-checks').length, 0);
  assert.ok(calls.filter(c => c.path === '/api/translations').length > 0);

  // P1-03: unaligned non-empty partial target (`A'/C'` against `A/B/C`, `alignments: null`) NEVER auto-reuses!
  const callsPartial = [];
  const docPartial = createWorkbenchController({
    initialMode: 'manuscript',
    initialCapabilities: [CAPABILITY_STRUCTURE_CHECK],
    getTmEntries: () => entries,
    resolveTmAutoReuseBasis: async () => BASIS,
    post: async (path, body) => {
      callsPartial.push({ path, body });
      return {
        response: new Response(null, { status: 200 }),
        value: { kind: 'llm', text: 'Tail translated.', direction: 'en', dictionary_miss: false, request_id: 'req-tail' },
      };
    },
  });
  docPartial.editText('source', `${s1}\n\n${s2}\n\n${s3}`);
  docPartial.editText('target', 'Para 1: ATK +10%.\n\nPara 3: Energy Regen +30%.');
  await docPartial.startTranslateRun();
  await flushMicrotasks();
  assert.equal(docPartial.getSnapshot().tmReceipt, null);
  assert.equal(callsPartial.filter(c => c.path === '/api/structure-checks').length, 0);
});

test('explicit alignments with target: null reuses only the null segment with 0 model calls when context_exact + verified_fresh', async () => {
  const { s1, s2, s3, entries } = buildEntries();
  const source = `${s1}\n\n${s2}\n\n${s3}`;
  const target = 'Para 1: ATK +10%.\n\nPara 3: Energy Regen +30%.';
  const s1Len = Array.from(s1).length;
  const s2Start = s1Len + 2;
  const s2End = s2Start + Array.from(s2).length;
  const s3Start = s2End + 2;
  const s3End = s3Start + Array.from(s3).length;
  const t1Len = Array.from('Para 1: ATK +10%.').length;
  const t3Start = t1Len + 2;
  const t3End = t3Start + Array.from('Para 3: Energy Regen +30%.').length;

  const calls = [];
  const doc = createWorkbenchController({
    initialMode: 'manuscript',
    initialCapabilities: [CAPABILITY_STRUCTURE_CHECK],
    getTmEntries: () => entries,
    resolveTmAutoReuseBasis: async () => BASIS,
    post: async (path, body) => {
      calls.push({ path, body });
      return { response: new Response(null, { status: 200 }), value: okStructureResponse(body) };
    },
  });
  doc.edit({
    source,
    target,
    direction: 'en',
    alignments: [
      { source: { start: scalarOffset(0), end: scalarOffset(s1Len), text: s1 }, target: { start: scalarOffset(0), end: scalarOffset(t1Len), text: 'Para 1: ATK +10%.' } },
      { source: { start: scalarOffset(s2Start), end: scalarOffset(s2End), text: s2 }, target: null },
      { source: { start: scalarOffset(s3Start), end: scalarOffset(s3End), text: s3 }, target: { start: scalarOffset(t3Start), end: scalarOffset(t3End), text: 'Para 3: Energy Regen +30%.' } },
    ],
  });

  await doc.startTranslateRun();
  const snap = doc.getSnapshot();
  assert.equal(snap.draft.target, 'Para 1: ATK +10%.\n\nPara 2: CRIT Rate +20%.\n\nPara 3: Energy Regen +30%.');
  assert.equal(calls.filter(c => c.path === '/api/translations').length, 0);
  assert.equal(snap.tmReceipt?.reused, 1);
  assert.equal(snap.tmReceipt?.baselineRequests, 1);
  assert.equal(snap.tmReceipt?.modelCalls, 0);
});
