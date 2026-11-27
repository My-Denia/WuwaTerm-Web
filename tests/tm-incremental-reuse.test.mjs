// Unit tests for Part 5: Batch trusted TM reuse & incremental re-translation in WorkbenchController.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkbenchController } from '../lib/workbench-controller.ts';
import { confirmTranslationMemoryEntry } from '../lib/translation-memory.ts';
import { CAPABILITY_STRUCTURE_CHECK, STRUCTURE_CHECKS } from '../lib/structure-check.js';
import { CAPABILITY_TRANSLATION_CONTEXT } from '../lib/semantic-review.js';
import { structureSummary, structureViews } from '../lib/structure-layer.ts';
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
    pendingRetranslate: 0,
    demotedByStructureCheck: 0,
    demotedSegmentIndices: [],
    modelCalls: 0,
    baselineRequests: 3,
    termsDbRevision: REV,
    gameVersion: GAME,
    structureCheckStatus: 'passed',
  });
  const l1Views = structureViews(snap.draft, snap.structure);
  assert.equal(l1Views.length, 3);
  assert.deepEqual(structureSummary(l1Views), { checked: 3, withFindings: 0, findings: 0, omitted: 0, unchecked: 0 });
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
    pendingRetranslate: 0,
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

test('blank draft with short reused paragraph and 1900-scalar unreused paragraph sub-segments and translates the long paragraph without dropping it', async () => {
  const shortPara = '首段文';
  const longPara = '长'.repeat(1900);
  const confirmed = confirmTranslationMemoryEntry([], {
    sourceText: shortPara,
    targetText: 'First short paragraph.',
    direction: 'en',
    prevSource: null,
    nextSource: longPara,
    origin: 'human_confirmed',
    termsDbRevision: REV,
    gameVersion: '3.7.0',
  });
  assert.equal(confirmed.status, 'added');

  const calls = [];
  const doc = createWorkbenchController({
    initialMode: 'manuscript',
    initialCapabilities: [CAPABILITY_STRUCTURE_CHECK],
    getTmEntries: () => confirmed.entries,
    resolveTmAutoReuseBasis: async () => BASIS,
    post: async (path, body) => {
      calls.push({ path, body });
      if (path === '/api/structure-checks') {
        return { response: new Response(null, { status: 200 }), value: okStructureResponse(body) };
      }
      if (path === '/api/translations') {
        const len = Array.from(body.text).length;
        return {
          response: new Response(null, { status: 200 }),
          value: { kind: 'llm', text: `Translated(${len})`, direction: 'en', dictionary_miss: false, request_id: `req-${len}` },
        };
      }
      throw new Error(`Unexpected path: ${path}`);
    },
  });

  doc.editText('source', `${shortPara}\n\n${longPara}`);
  await doc.startTranslateRun();
  await flushMicrotasks();

  const translateCalls = calls.filter(c => c.path === '/api/translations');
  assert.equal(translateCalls.length, 2);
  assert.deepEqual(
    translateCalls.map(c => Array.from(c.body.text).length),
    [1800, 100],
  );
  const snap = doc.getSnapshot();
  assert.equal(snap.draft.target, 'First short paragraph.\n\nTranslated(1800)\n\nTranslated(100)');
  assert.equal(snap.tmReceipt?.reused, 1);
  assert.equal(snap.tmReceipt?.retranslated, 2);
  assert.equal(snap.tmReceipt?.pendingRetranslate, 0);
  assert.equal(snap.tmReceipt?.modelCalls, 2);
  assert.equal(snap.tmReceipt?.baselineRequests, 3);
});

test('Finding #1: swapped 10%/20% findings appear in structureViews per segment, survive partial reuse completion, and 64 reused segments stay in 1 batch', async () => {
  // Part A: Swapped 10% and 20% between paragraph 1 and paragraph 2 on a 3-para short doc.
  // A merged whole-doc check would see both 10 and 20 and report 0 findings, but per-segment checks catch both!
  const s1 = '首段：攻击力提高 10%。';
  const s2 = '中段：暴击率提高 20%。';
  const s3 = '末段：共鸣效率提高 30%。';
  let entries = [];
  entries = confirmTranslationMemoryEntry(entries, {
    sourceText: s1,
    targetText: 'Para 1: ATK +20%.', // swapped 20% instead of 10%!
    direction: 'en',
    prevSource: null,
    nextSource: s2,
    termsDbRevision: REV,
    gameVersion: GAME,
  }).entries;
  entries = confirmTranslationMemoryEntry(entries, {
    sourceText: s2,
    targetText: 'Para 2: CRIT Rate +10%.', // swapped 10% instead of 20%!
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

  const structBatches = [];
  const doc = createWorkbenchController({
    initialMode: 'manuscript',
    initialCapabilities: [CAPABILITY_STRUCTURE_CHECK],
    getTmEntries: () => entries,
    resolveTmAutoReuseBasis: async () => BASIS,
    post: async (path, body) => {
      assert.equal(path, '/api/structure-checks');
      structBatches.push(body);
      return {
        response: new Response(null, { status: 200 }),
        value: okStructureResponse(body, {
          'tm-0': [{ rule_id: 'number_missing', source_span: { start: 9, end: 11, text: '10' }, target_span: null }],
          'tm-1': [{ rule_id: 'number_missing', source_span: { start: 9, end: 11, text: '20' }, target_span: null }],
        }),
      };
    },
  });

  doc.editText('source', `${s1}\n\n${s2}\n\n${s3}`);
  await doc.startTranslateRun();

  const snap = doc.getSnapshot();
  assert.equal(structBatches.length, 1);
  assert.equal(structBatches[0].segments.length, 3, 'must send only the 3 reused segments, never an extra merged tmv-0');
  assert.equal(snap.tmReceipt?.demotedByStructureCheck, 2);
  assert.deepEqual(snap.tmReceipt?.demotedSegmentIndices, [0, 1]);

  const views = structureViews(snap.draft, snap.structure);
  const summary = structureSummary(views);
  assert.equal(views.length, 3);
  assert.deepEqual(summary, { checked: 3, withFindings: 2, findings: 2, omitted: 0, unchecked: 0 });
  assert.equal(views[0].result?.findings[0].rule_id, 'number_missing');
  assert.equal(views[0].result?.findings[0].source_span?.text, '10');
  assert.equal(views[1].result?.findings[0].rule_id, 'number_missing');
  assert.equal(views[1].result?.findings[0].source_span?.text, '20');
  assert.equal(views[2].result?.findings.length, 0);

  // Part B: Partial reuse where segment 0 has a finding and segments 1..2 finish translating afterwards:
  // segment 0's Layer 1 finding MUST remain visible after translation finishes!
  const s3Edited = '末段已改：暴伤提高 40%。';
  const docPartial = createWorkbenchController({
    initialMode: 'manuscript',
    initialCapabilities: [CAPABILITY_STRUCTURE_CHECK],
    getTmEntries: () => entries,
    resolveTmAutoReuseBasis: async () => BASIS,
    post: async (path, body) => {
      if (path === '/api/structure-checks') {
        return {
          response: new Response(null, { status: 200 }),
          value: okStructureResponse(body, {
            'tm-0': [{ rule_id: 'number_missing', source_span: { start: 9, end: 11, text: '10' }, target_span: null }],
          }),
        };
      }
      if (path === '/api/translations') {
        return {
          response: new Response(null, { status: 200 }),
          value: { kind: 'llm', text: 'Model translated segment.', direction: 'en', dictionary_miss: false, request_id: 'tr-p' },
        };
      }
      throw new Error(`Unexpected path: ${path}`);
    },
  });
  docPartial.editText('source', `${s1}\n\n${s2}\n\n${s3Edited}`);
  await docPartial.startTranslateRun();
  await flushMicrotasks();

  const partialSnap = docPartial.getSnapshot();
  const partialViews = structureViews(partialSnap.draft, partialSnap.structure);
  assert.equal(partialViews.length, 3);
  assert.equal(partialViews[0].result?.findings.length, 1);
  assert.equal(partialViews[0].result?.findings[0].rule_id, 'number_missing');
  assert.equal(partialViews[1].result, null);
  assert.equal(partialViews[2].result, null);

  // Part C: 64 reused segments stay in exactly 1 structure-checks batch of 64 (never 65 items / 2 batches)!
  const segs64 = Array.from({ length: 64 }, (_, i) => `段${i + 1}。`);
  let entries64 = [];
  for (let i = 0; i < 64; i += 1) {
    entries64 = confirmTranslationMemoryEntry(entries64, {
      sourceText: segs64[i],
      targetText: `S${i + 1}.`,
      direction: 'en',
      prevSource: i > 0 ? segs64[i - 1] : null,
      nextSource: i + 1 < 64 ? segs64[i + 1] : null,
      termsDbRevision: REV,
      gameVersion: GAME,
    }).entries;
  }
  const batches64 = [];
  const doc64 = createWorkbenchController({
    initialMode: 'manuscript',
    initialCapabilities: [CAPABILITY_STRUCTURE_CHECK],
    getTmEntries: () => entries64,
    resolveTmAutoReuseBasis: async () => BASIS,
    post: async (path, body) => {
      assert.equal(path, '/api/structure-checks');
      batches64.push(body);
      return { response: new Response(null, { status: 200 }), value: okStructureResponse(body) };
    },
  });
  doc64.editText('source', segs64.join('\n\n'));
  await doc64.startTranslateRun();
  assert.equal(batches64.length, 1);
  assert.equal(batches64[0].segments.length, 64);
  assert.equal(doc64.getSnapshot().tmReceipt?.reused, 64);
});

test('Finding #5: unaligned short draft A/B/C vs A\'/C\' (including 1801..2000 scalars) never offers prefix resume or translates C skipping B', async () => {
  const pA = `甲段：${'文'.repeat(640)}`;
  const pB = `乙段：${'文'.repeat(640)}`;
  const pC = `丙段：${'文'.repeat(600)}`;
  const calls = [];
  const doc = createWorkbenchController({
    initialMode: 'manuscript',
    post: async (path, body) => {
      calls.push({ path, body });
      return {
        response: new Response(null, { status: 200 }),
        value: { kind: 'llm', text: 'Should never run.', direction: 'en', dictionary_miss: false, request_id: 'tr-never' },
      };
    },
  });
  doc.editText('source', `${pA}\n\n${pB}\n\n${pC}`);
  doc.editText('target', 'Alpha translated.\n\nGamma translated.');
  assert.equal(doc.hasResumableTranslate(), false);
  await doc.startTranslateRun();
  await flushMicrotasks();
  assert.equal(calls.length, 0);
  assert.equal(doc.getSnapshot().draft.target, 'Alpha translated.\n\nGamma translated.');
});

test('Finding #6: source-dirty update reuses untouched verified TM segments, and undo/redo/edit/editText clear tmReceipt', async () => {
  const { s1, s2, s3, entries } = buildEntries();
  const s3Edited = '末段修改：暴击伤害提升 50%。';
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
        const text = body.text === s2 ? 'Model Para 2.' : 'Model Para 3 updated.';
        return {
          response: new Response(null, { status: 200 }),
          value: { kind: 'llm', text, direction: 'en', dictionary_miss: false, request_id: 'tr-upd' },
        };
      }
      throw new Error(`Unexpected path: ${path}`);
    },
  });

  // Start with a translated 3-paragraph manuscript, then edit paragraph 3 so sourceDirtyForTranslation becomes true.
  doc.edit({
    source: `${s1}\n\n${s2}\n\n${s3}`,
    target: 'Para 1: ATK +10%.\n\nPara 2: CRIT Rate +20%.\n\nPara 3: Energy Regen +30%.',
    direction: 'en',
    alignments: null,
  });
  doc.editText('source', `${s1}\n\n${s2}\n\n${s3Edited}`);
  assert.equal(doc.getSnapshot().sourceDirtyForTranslation, true);

  await doc.translateInReview();
  await flushMicrotasks();

  const afterUpdate = doc.getSnapshot();
  assert.equal(afterUpdate.sourceDirtyForTranslation, false);
  assert.equal(afterUpdate.draft.target, 'Para 1: ATK +10%.\n\nModel Para 2.\n\nModel Para 3 updated.');
  assert.deepEqual(calls.filter(c => c.path === '/api/translations').map(c => c.body.text), [s2, s3Edited]);
  assert.equal(afterUpdate.tmReceipt?.reused, 1);
  assert.equal(afterUpdate.tmReceipt?.retranslated, 2);
  assert.equal(afterUpdate.tmReceipt?.pendingRetranslate, 0);
  assert.equal(afterUpdate.tmReceipt?.modelCalls, 2);

  // undo() and redo() clear tmReceipt
  doc.undo();
  assert.equal(doc.getSnapshot().tmReceipt, null);
  doc.redo();
  assert.equal(doc.getSnapshot().tmReceipt, null);

  // Re-run to produce a receipt, then editText() clears it
  doc.editText('target', '');
  await doc.startTranslateRun();
  await flushMicrotasks();
  assert.notEqual(doc.getSnapshot().tmReceipt, null);
  doc.editText('target', 'Manual edit.');
  assert.equal(doc.getSnapshot().tmReceipt, null);
});

test('Finding #7: local pool 429/503 rejection on first remaining segment keeps modelCalls=0, retranslated=0, and pendingRetranslate accurate', async () => {
  const { s1, s2, entries } = buildEntries();
  const s3Edited = '第三段：暴击伤害提升 40%。';
  const doc = createWorkbenchController({
    initialMode: 'manuscript',
    initialCapabilities: [CAPABILITY_STRUCTURE_CHECK],
    getTmEntries: () => entries,
    resolveTmAutoReuseBasis: async () => BASIS,
    post: async (path, body) => {
      if (path === '/api/structure-checks') {
        return { response: new Response(null, { status: 200 }), value: okStructureResponse(body) };
      }
      if (path === '/api/translations') {
        return {
          response: new Response(null, { status: 429 }),
          value: { status: 'unavailable', reason: 'translation_pool_exhausted' },
        };
      }
      throw new Error(`Unexpected path: ${path}`);
    },
  });

  doc.editText('source', `${s1}\n\n${s2}\n\n${s3Edited}`);
  await doc.startTranslateRun();
  await flushMicrotasks();

  const snap = doc.getSnapshot();
  assert.equal(snap.tmReceipt?.reused, 1);
  assert.equal(snap.tmReceipt?.modelCalls, 0, 'locally pool-rejected 429 must not increment modelCalls');
  assert.equal(snap.tmReceipt?.retranslated, 0, 'untranslated segments rejected by pool must not count as completed');
  assert.equal(snap.tmReceipt?.pendingRetranslate, 2, 'both remaining segments must remain reported as pending');
});
