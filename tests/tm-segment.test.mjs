// Unit tests for per-segment TM slicing, active-segment resolution, neighbour context matching,
// explicit alignment synchronization, whitespace preservation, and single-segment apply (MY-491).
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TM_MATCH_CONTEXT_EXACT,
  TM_MATCH_EXACT,
  confirmTranslationMemoryEntry,
  matchTranslationMemory,
} from '../lib/translation-memory.ts';
import {
  applySegmentSuggestionResult,
  applySegmentSuggestionToTarget,
  resolveActiveSegment,
  segmentParagraphs,
} from '../lib/tm-segment.ts';
import { scalarOffset } from '../lib/workbench-model.ts';

test('segmentParagraphs handles empty, whitespace-only, single-paragraph, and CRLF multi-paragraph texts', () => {
  assert.deepEqual(segmentParagraphs(''), []);
  assert.deepEqual(segmentParagraphs('  \n\n\t '), []);

  const single = segmentParagraphs('  今汐。\n');
  assert.equal(single.length, 1);
  assert.equal(single[0].text, '今汐。');

  const multi = segmentParagraphs('第一段。\r\n\r\n第二段。\n\n第三段。');
  assert.deepEqual(multi.map(s => s.text), ['第一段。', '第二段。', '第三段。']);
});

test('resolveActiveSegment tracks source/target offsets, defaults to segment 0, and supplies prevSource/nextSource', () => {
  const source = '首段原文。\n\n中段原文。\n\n末段原文。';
  const target = 'First target.\n\nSecond target.\n\nThird target.';
  const segs = segmentParagraphs(source);

  assert.deepEqual(resolveActiveSegment(source, target), {
    index: 0,
    total: 3,
    sourceText: '首段原文。',
    targetText: 'First target.',
    prevSource: null,
    nextSource: '中段原文。',
    targetRange: { start: 0, end: 13 },
    hasAlignedTarget: true,
  });

  // Caret in middle source segment -> index 1 with both neighbours.
  const midSource = resolveActiveSegment(source, target, { kind: 'offset', side: 'source', offset: segs[1].coreStart + 2 });
  assert.deepEqual(midSource, {
    index: 1,
    total: 3,
    sourceText: '中段原文。',
    targetText: 'Second target.',
    prevSource: '首段原文。',
    nextSource: '末段原文。',
    targetRange: { start: 15, end: 29 },
    hasAlignedTarget: true,
  });

  // Caret in last target segment -> index 2.
  const lastTarget = resolveActiveSegment(source, target, { kind: 'offset', side: 'target', offset: Array.from(target).length });
  assert.equal(lastTarget.index, 2);
  assert.equal(lastTarget.sourceText, '末段原文。');
  assert.equal(lastTarget.targetText, 'Third target.');
  assert.equal(lastTarget.prevSource, '中段原文。');
  assert.equal(lastTarget.nextSource, null);
  assert.equal(lastTarget.hasAlignedTarget, true);

  // Trailing blank line at end of partial target (`First target.\n\n`) advances active segment to segment 1.
  const partialTarget = 'First target.\n\n';
  const pendingNext = resolveActiveSegment(source, partialTarget, {
    kind: 'offset',
    side: 'target',
    offset: Array.from(partialTarget).length,
  });
  assert.equal(pendingNext.index, 1);
  assert.equal(pendingNext.sourceText, '中段原文。');
  assert.equal(pendingNext.targetText, '');
  assert.equal(pendingNext.targetRange, null);
  assert.equal(pendingNext.hasAlignedTarget, false);
});

test('prevSource/nextSource differentiate context_exact from plain exact in multi-segment manuscripts', () => {
  const repeated = '共鸣效率提高 10%。';
  const source = `开场说明。\n\n${repeated}\n\n结算说明。\n\n${repeated}\n\n尾声说明。`;
  const segs = segmentParagraphs(source);

  const first = confirmTranslationMemoryEntry([], {
    sourceText: repeated,
    targetText: 'Energy Regen +10% (opening context).',
    direction: 'en',
    prevSource: '开场说明。',
    nextSource: '结算说明。',
  });
  const second = confirmTranslationMemoryEntry(first.entries, {
    sourceText: repeated,
    targetText: 'Energy Regen +10% (epilogue context).',
    direction: 'en',
    prevSource: '结算说明。',
    nextSource: '尾声说明。',
  });
  assert.equal(second.status, 'added');

  const activeAtSeg1 = resolveActiveSegment(source, '', { kind: 'offset', side: 'source', offset: segs[1].coreStart });
  const hits1 = matchTranslationMemory(second.entries, activeAtSeg1.sourceText, 'en', {
    prevSource: activeAtSeg1.prevSource,
    nextSource: activeAtSeg1.nextSource,
  });
  assert.equal(hits1.length, 2);
  assert.equal(hits1[0].matchKind, TM_MATCH_CONTEXT_EXACT);
  assert.equal(hits1[0].entry.target_text, 'Energy Regen +10% (opening context).');
  assert.equal(hits1[1].matchKind, TM_MATCH_EXACT);

  const activeAtSeg3 = resolveActiveSegment(source, '', { kind: 'offset', side: 'source', offset: segs[3].coreStart });
  const hits3 = matchTranslationMemory(second.entries, activeAtSeg3.sourceText, 'en', {
    prevSource: activeAtSeg3.prevSource,
    nextSource: activeAtSeg3.nextSource,
  });
  assert.equal(hits3.length, 2);
  assert.equal(hits3[0].matchKind, TM_MATCH_CONTEXT_EXACT);
  assert.equal(hits3[0].entry.target_text, 'Energy Regen +10% (epilogue context).');
  assert.equal(hits3[1].matchKind, TM_MATCH_EXACT);
});

test('applySegmentSuggestionToTarget replaces only the active segment and preserves separators, emojis, and non-active segments', () => {
  const singleSrc = segmentParagraphs('今汐。');
  assert.equal(applySegmentSuggestionToTarget('old target\n\nextra', singleSrc, 0, 'Jinhsi.'), 'Jinhsi.');

  const multiSrc = segmentParagraphs('甲😀。\r\n\r\n乙。\r\n\r\n丙。');
  const multiTgt = '  Alpha 😀.\r\n\r\nBeta.\r\n\r\nGamma.  ';
  assert.equal(
    applySegmentSuggestionToTarget(multiTgt, multiSrc, 1, 'Beta (TM).'),
    '  Alpha 😀.\r\n\r\nBeta (TM).\r\n\r\nGamma.  ',
  );
  assert.equal(
    applySegmentSuggestionToTarget(multiTgt, multiSrc, 0, 'Alpha (TM).'),
    '  Alpha (TM).\r\n\r\nBeta.\r\n\r\nGamma.  ',
  );
  assert.equal(
    applySegmentSuggestionToTarget(multiTgt, multiSrc, 2, 'Gamma (TM).'),
    '  Alpha 😀.\r\n\r\nBeta.\r\n\r\nGamma (TM).  ',
  );
});

test('skip-segment fill establishes explicit alignments so filling segment 3 then segment 2 never overwrites Tres', () => {
  const source = '第一段。\n\n第二段。\n\n第三段。';
  const srcSegs = segmentParagraphs(source);

  // Start with only segment 0 translated (`Uno`), no explicit alignments.
  const step1 = applySegmentSuggestionResult('Uno', srcSegs, 2, 'Tres', { source, alignments: null });
  assert.equal(step1.applied, true);
  assert.equal(step1.target, 'Uno\n\nTres');
  assert.ok(step1.alignments);
  assert.equal(step1.alignments.length, 3);
  assert.equal(step1.alignments[0].target?.text, 'Uno');
  assert.equal(step1.alignments[1].target, null);
  assert.equal(step1.alignments[2].target?.text, 'Tres');

  // Moving to segment 1 (`第二段。`) must read targetText as '' (never borrow `Tres`!).
  const activeSeg1 = resolveActiveSegment(source, step1.target, { kind: 'index', index: 1 }, step1.alignments);
  assert.equal(activeSeg1.targetText, '');
  assert.equal(activeSeg1.targetRange, null);
  assert.equal(activeSeg1.hasAlignedTarget, false);

  // Clicking on `Tres` in target must map back to segment 2 (`第三段。`), not segment 1!
  const tresOffset = step1.target.indexOf('Tres') + 1;
  const fromTargetClick = resolveActiveSegment(source, step1.target, { kind: 'offset', side: 'target', offset: tresOffset }, step1.alignments);
  assert.equal(fromTargetClick.index, 2);
  assert.equal(fromTargetClick.targetText, 'Tres');

  // Filling segment 1 (`Dos`) inserts cleanly between `Uno` and `Tres` and keeps all 3 alignments exact.
  const step2 = applySegmentSuggestionResult(step1.target, srcSegs, 1, 'Dos', {
    source,
    alignments: step1.alignments,
  });
  assert.equal(step2.applied, true);
  assert.equal(step2.target, 'Uno\n\nDos\n\nTres');
  assert.deepEqual(step2.alignments?.map(a => a.target?.text), ['Uno', 'Dos', 'Tres']);
});

test('manual alignments with target: null respect omitted target and insert cleanly without corrupting neighbour whitespace or indentation', () => {
  // Case 1: trailing spaces + mixed CRLF/LF + tab (`Uno \r\n \n\t`) preserved verbatim when appending segment 2.
  const source2 = '一。\n\n二。';
  const src2 = segmentParagraphs(source2);
  const appended = applySegmentSuggestionToTarget('Uno \r\n \n\t', src2, 1, 'Dos', { source: source2 });
  assert.equal(appended, 'Uno \r\n \n\tDos');

  // Case 2: manual alignment where segment 0 is `target: null` and segment 1 has leading indentation (`  Dos`).
  const targetLeadingIndent = '\n\n  Dos';
  const alignmentsLeading = [
    { source: { start: scalarOffset(0), end: scalarOffset(2), text: '一。' }, target: null },
    { source: { start: scalarOffset(4), end: scalarOffset(6), text: '二。' }, target: { start: scalarOffset(4), end: scalarOffset(7), text: 'Dos' } },
  ];
  const active0 = resolveActiveSegment(source2, targetLeadingIndent, { kind: 'index', index: 0 }, alignmentsLeading);
  assert.equal(active0.targetText, '');
  assert.equal(active0.hasAlignedTarget, false);

  const filled0 = applySegmentSuggestionResult(targetLeadingIndent, src2, 0, 'Uno', {
    source: source2,
    alignments: alignmentsLeading,
  });
  assert.equal(filled0.applied, true);
  assert.equal(filled0.target, 'Uno\n\n  Dos');
  assert.equal(filled0.alignments?.[0].target?.text, 'Uno');
  assert.equal(filled0.alignments?.[1].target?.text, 'Dos');
  assert.equal(filled0.alignments?.[1].target?.start, 7);

  // Case 3: manual alignment filling middle segment 1 between `Uno \r\n \n\tTres` preserves mixed whitespace and `\t` indent!
  const source3 = '一。\n\n二。\n\n三。';
  const src3 = segmentParagraphs(source3);
  const mixedTarget = 'Uno \r\n \n\tTres';
  const tresStart = Array.from('Uno \r\n \n\t').length;
  const alignmentsMidNull = [
    { source: { start: scalarOffset(0), end: scalarOffset(2), text: '一。' }, target: { start: scalarOffset(0), end: scalarOffset(3), text: 'Uno' } },
    { source: { start: scalarOffset(4), end: scalarOffset(6), text: '二。' }, target: null },
    { source: { start: scalarOffset(8), end: scalarOffset(10), text: '三。' }, target: { start: scalarOffset(tresStart), end: scalarOffset(tresStart + 4), text: 'Tres' } },
  ];
  const filledMid = applySegmentSuggestionResult(mixedTarget, src3, 1, 'Dos', {
    source: source3,
    alignments: alignmentsMidNull,
  });
  assert.equal(filledMid.applied, true);
  assert.equal(filledMid.target, 'Uno \r\n \nDos\r\n\r\n\tTres');
  assert.deepEqual(filledMid.alignments?.map(a => a.target?.text), ['Uno', 'Dos', 'Tres']);
});

test('multi-paragraph suggestion without explicit alignments is refused, and longer target refuses overwrite', () => {
  const source = '一。\n\n二。\n\n三。';
  const src3 = segmentParagraphs(source);
  const target = 'Uno.\n\nDos.';

  const multiSegSuggestion = applySegmentSuggestionResult(target, src3, 0, 'Part A.\n\nPart B.', {
    source,
    alignments: null,
  });
  assert.equal(multiSegSuggestion.applied, false);
  assert.equal(multiSegSuggestion.reason, 'multi_paragraph_suggestion');
  assert.equal(multiSegSuggestion.target, target);

  // Longer target (more paragraphs than source) -> refuses to overwrite existing translations.
  const src2 = segmentParagraphs('一。\n\n二。');
  const longerTgt = 'One-A.\n\nOne-B.\n\nTwo.';
  const active = resolveActiveSegment('一。\n\n二。', longerTgt, { kind: 'index', index: 1 });
  assert.equal(active.hasAlignedTarget, false);
  assert.equal(active.targetRange, null);
  const outcome = applySegmentSuggestionResult(longerTgt, src2, 1, 'Overwrite attempt', { source: '一。\n\n二。' });
  assert.equal(outcome.applied, false);
  assert.equal(outcome.reason, 'unaligned_target');
  assert.equal(outcome.target, longerTgt);
});
