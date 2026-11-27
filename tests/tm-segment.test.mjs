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
  describeTmSegmentAlignment,
  resolveActiveSegment,
  segmentParagraphs,
  sourceSegmentIndexForTargetOffset,
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

  // Start from blank target: filling segment 0 (`Uno`) establishes explicit alignments `[Uno, null, null]`.
  const step0 = applySegmentSuggestionResult('', srcSegs, 0, 'Uno', { source, alignments: null });
  assert.equal(step0.applied, true);
  assert.equal(step0.target, 'Uno');
  assert.ok(step0.alignments);
  assert.equal(step0.alignments.length, 3);
  assert.equal(step0.alignments[0].target?.text, 'Uno');
  assert.equal(step0.alignments[1].target, null);
  assert.equal(step0.alignments[2].target, null);

  // Skip segment 1 to fill segment 2 (`Tres`) using those explicit alignments.
  const step1 = applySegmentSuggestionResult(step0.target, srcSegs, 2, 'Tres', { source, alignments: step0.alignments });
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
  // Case 1: trailing spaces + mixed CRLF/LF + tab (`Uno \r\n \n\t`) preserved verbatim when appending segment 2 with explicit alignments.
  const source2 = '一。\n\n二。';
  const src2 = segmentParagraphs(source2);
  const align2 = [
    { source: { start: scalarOffset(0), end: scalarOffset(2), text: '一。' }, target: { start: scalarOffset(0), end: scalarOffset(3), text: 'Uno' } },
    { source: { start: scalarOffset(4), end: scalarOffset(6), text: '二。' }, target: null },
  ];
  const appended = applySegmentSuggestionToTarget('Uno \r\n \n\t', src2, 1, 'Dos', { source: source2, alignments: align2 });
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

test('target_gap_occupied refuses inserting into an unaligned gap when handwritten target text already sits there', () => {
  const source = '第一段。\n\n第二段。\n\n第三段。';
  const srcSegs = segmentParagraphs(source);
  const step0 = applySegmentSuggestionResult('', srcSegs, 0, 'Uno', { source, alignments: null });
  const step1 = applySegmentSuggestionResult(step0.target, srcSegs, 2, 'Tres', { source, alignments: step0.alignments });
  assert.ok(step1.alignments);

  // Simulate user typing handwritten `Dos draft` in the unaligned middle gap while `step1.alignments[1].target` is still null.
  const draftedTarget = 'Uno\n\nDos draft\n\nTres';
  const tresOffset = Array.from('Uno\n\nDos draft\n\n').length;
  const shiftedAlignments = [
    step1.alignments[0],
    step1.alignments[1],
    {
      source: step1.alignments[2].source,
      target: { start: scalarOffset(tresOffset), end: scalarOffset(tresOffset + 4), text: 'Tres' },
    },
  ];
  assert.equal(describeTmSegmentAlignment(source, draftedTarget, resolveActiveSegment(source, draftedTarget, { kind: 'index', index: 1 }, shiftedAlignments), shiftedAlignments).status, 'target_gap_occupied');

  const refused = applySegmentSuggestionResult(draftedTarget, srcSegs, 1, 'Dos TM', {
    source,
    alignments: shiftedAlignments,
  });
  assert.equal(refused.applied, false);
  assert.equal(refused.reason, 'target_gap_occupied');
  assert.equal(refused.target, draftedTarget);

  // Even when every alignment has target: null, non-empty manual target text in the gap refuses blind overwrite.
  const allNull = srcSegs.map(seg => ({
    source: { start: seg.coreStart, end: seg.coreEnd, text: seg.text },
    target: null,
  }));
  const refusedAllNull = applySegmentSuggestionResult('Manual draft', srcSegs, 1, 'Dos TM', {
    source,
    alignments: allNull,
  });
  assert.equal(refusedAllNull.applied, false);
  assert.equal(refusedAllNull.reason, 'target_gap_occupied');
});

test('sourceSegmentIndexForTargetOffset uses half-open [start, end) hit testing for adjacent spans with trailing fallback', () => {
  const source = '甲。\n\n乙。';
  const alignments = [
    { source: { start: scalarOffset(0), end: scalarOffset(2), text: '甲。' }, target: { start: scalarOffset(0), end: scalarOffset(1), text: 'X' } },
    { source: { start: scalarOffset(4), end: scalarOffset(6), text: '乙。' }, target: { start: scalarOffset(1), end: scalarOffset(2), text: 'Y' } },
  ];

  const at0 = resolveActiveSegment(source, 'XY', { kind: 'offset', side: 'target', offset: 0 }, alignments);
  assert.equal(at0.index, 0);
  assert.equal(at0.targetText, 'X');

  const at1 = resolveActiveSegment(source, 'XY', { kind: 'offset', side: 'target', offset: 1 }, alignments);
  assert.equal(at1.index, 1);
  assert.equal(at1.targetText, 'Y');

  const atEnd = resolveActiveSegment(source, 'XY', { kind: 'offset', side: 'target', offset: 2 }, alignments);
  assert.equal(atEnd.index, 1);
  assert.equal(atEnd.targetText, 'Y');
});

test('replacing aligned target preserves leading/trailing whitespace & newlines inside entry.target, matches source by trimmed core, and treats [] as null', () => {
  const source = '甲。\n\n  乙。';
  const srcSegs = segmentParagraphs(source);
  const target = 'Uno \r\n\n  Dos';
  // Explicit alignment includes trailing ` \r\n\n` in target[0] and leading `\n  ` in source[1].
  const alignments = [
    { source: { start: scalarOffset(0), end: scalarOffset(2), text: '甲。' }, target: { start: scalarOffset(0), end: scalarOffset(7), text: 'Uno \r\n\n' } },
    { source: { start: scalarOffset(3), end: scalarOffset(8), text: '\n  乙。' }, target: { start: scalarOffset(9), end: scalarOffset(12), text: 'Dos' } },
  ];

  const active0 = resolveActiveSegment(source, target, { kind: 'index', index: 0 }, alignments);
  assert.equal(active0.targetText, 'Uno');
  assert.deepEqual(active0.targetRange, { start: 0, end: 3 });

  const replaced0 = applySegmentSuggestionResult(target, srcSegs, 0, 'First', { source, alignments });
  assert.equal(replaced0.applied, true);
  assert.equal(replaced0.target, 'First \r\n\n  Dos');

  const active1 = resolveActiveSegment(source, replaced0.target, { kind: 'index', index: 1 }, replaced0.alignments);
  assert.equal(active1.targetText, 'Dos');
  const replaced1 = applySegmentSuggestionResult(replaced0.target, srcSegs, 1, 'Second', {
    source,
    alignments: replaced0.alignments,
  });
  assert.equal(replaced1.applied, true);
  assert.equal(replaced1.target, 'First \r\n\n  Second');

  // Empty alignments `[]` behaves identically to `null` in matching/slicing AND preserves `[]` (never converts to `null`)
  // so cleared-alignment mode keeps sending `alignments: []` to backend review-v2.
  const emptySingle = resolveActiveSegment('甲。', 'Old', { kind: 'index', index: 0 }, []);
  assert.equal(emptySingle.targetText, 'Old');
  assert.equal(emptySingle.hasAlignedTarget, true);
  const emptyApplied = applySegmentSuggestionResult('Old', segmentParagraphs('甲。'), 0, 'New', { source: '甲。', alignments: [] });
  assert.equal(emptyApplied.applied, true);
  assert.equal(emptyApplied.target, 'New');
  assert.deepEqual(emptyApplied.alignments, []);

  const emptyMulti = applySegmentSuggestionResult('Uno.\n\nOldDos.', segmentParagraphs('甲。\n\n乙。'), 1, 'NewDos.', {
    source: '甲。\n\n乙。',
    alignments: [],
  });
  assert.equal(emptyMulti.applied, true);
  assert.equal(emptyMulti.target, 'Uno.\n\nNewDos.');
  assert.deepEqual(emptyMulti.alignments, []);

  // Explicit alignment with extra target paragraph does NOT report target_extra_paragraphs warning when resolved cleanly.
  const extraStatus = describeTmSegmentAlignment('甲。\n\n乙。', 'One A.\n\nOne B.\n\nTwo.', active0, [
    { source: { start: scalarOffset(0), end: scalarOffset(2), text: '甲。' }, target: { start: scalarOffset(0), end: scalarOffset(14), text: 'One A.\n\nOne B.' } },
    { source: { start: scalarOffset(4), end: scalarOffset(6), text: '乙。' }, target: { start: scalarOffset(16), end: scalarOffset(20), text: 'Two.' } },
  ]);
  assert.equal(extraStatus.status, 'ok');
});

test('whitespace-only explicit target alignment refuses direct replacement so adjacent segments never merge', () => {
  const source = '甲。\n\n乙。\n\n丙。';
  const srcSegs = segmentParagraphs(source);
  const target = 'Uno\r\n\nTres';
  // Segment 1 aligned strictly to `\r\n\n` (empty once whitespace-trimmed).
  const alignments = [
    { source: { start: scalarOffset(0), end: scalarOffset(2), text: '甲。' }, target: { start: scalarOffset(0), end: scalarOffset(3), text: 'Uno' } },
    { source: { start: scalarOffset(4), end: scalarOffset(6), text: '乙。' }, target: { start: scalarOffset(3), end: scalarOffset(6), text: '\r\n\n' } },
    { source: { start: scalarOffset(8), end: scalarOffset(10), text: '丙。' }, target: { start: scalarOffset(6), end: scalarOffset(10), text: 'Tres' } },
  ];

  const active = resolveActiveSegment(source, target, { kind: 'index', index: 1 }, alignments);
  assert.equal(active.hasAlignedTarget, false);
  assert.equal(active.targetText, '');
  assert.equal(active.targetRange, null);
  assert.equal(describeTmSegmentAlignment(source, target, active, alignments).status, 'whitespace_target_alignment');

  const refused = applySegmentSuggestionResult(target, srcSegs, 1, 'Dos', { source, alignments });
  assert.equal(refused.applied, false);
  assert.equal(refused.reason, 'whitespace_target_alignment');
  assert.equal(refused.target, 'Uno\r\n\nTres');
});

test('target caret inside non-whitespace unaligned prose returns null instead of falling back to segment 1', () => {
  const source = '甲。\n\n乙。\n\n丙。';
  const srcSegs = segmentParagraphs(source);
  const target = 'Uno\n\nDos draft\n\nTres';
  const tresStart = Array.from('Uno\n\nDos draft\n\n').length;
  const alignments = [
    { source: { start: scalarOffset(0), end: scalarOffset(2), text: '甲。' }, target: { start: scalarOffset(0), end: scalarOffset(3), text: 'Uno' } },
    { source: { start: scalarOffset(4), end: scalarOffset(6), text: '乙。' }, target: null },
    { source: { start: scalarOffset(8), end: scalarOffset(10), text: '丙。' }, target: { start: scalarOffset(tresStart), end: scalarOffset(tresStart + 4), text: 'Tres' } },
  ];

  // Cursor inside `Dos draft` (middle unaligned prose): must return null, never segment 0 (`Uno`)!
  const midCaret = Array.from('Uno\n\nDos ').length;
  assert.equal(
    sourceSegmentIndexForTargetOffset(Array.from(source), Array.from(target), srcSegs, alignments, midCaret),
    null,
  );
  const activeMid = resolveActiveSegment(source, target, { kind: 'offset', side: 'target', offset: midCaret }, alignments);
  assert.equal(activeMid.targetOffsetUnaligned, true);
  assert.equal(activeMid.hasAlignedTarget, false);
  assert.equal(activeMid.targetText, '');
  assert.equal(describeTmSegmentAlignment(source, target, activeMid, alignments).status, 'target_cursor_unaligned');

  // Cursor in leading unaligned prose before first aligned span: also returns null, never segment 0/first!
  const leadingTarget = 'Intro draft\n\nUno';
  const leadingAlign = [
    { source: { start: scalarOffset(0), end: scalarOffset(2), text: '甲。' }, target: null },
    {
      source: { start: scalarOffset(4), end: scalarOffset(6), text: '乙。' },
      target: { start: scalarOffset(13), end: scalarOffset(16), text: 'Uno' },
    },
  ];
  assert.equal(
    sourceSegmentIndexForTargetOffset(Array.from(source), Array.from(leadingTarget), srcSegs, leadingAlign, 3),
    null,
  );

  // Even when segment 1's aligned range includes trailing newlines (`Uno\n\n` ending at offset 5) right up to the
  // start of `Dos draft` (offset 5), offset 5 and offset 14 (end of `Dos draft`) MUST hit the gap check before end-fallback!
  const withTrailingNl = [
    { source: { start: scalarOffset(0), end: scalarOffset(2), text: '甲。' }, target: { start: scalarOffset(0), end: scalarOffset(5), text: 'Uno\n\n' } },
    { source: { start: scalarOffset(4), end: scalarOffset(6), text: '乙。' }, target: null },
    { source: { start: scalarOffset(8), end: scalarOffset(10), text: '丙。' }, target: { start: scalarOffset(tresStart), end: scalarOffset(tresStart + 4), text: 'Tres' } },
  ];
  assert.equal(
    sourceSegmentIndexForTargetOffset(Array.from(source), Array.from(target), srcSegs, withTrailingNl, 5),
    null,
  );
  assert.equal(
    sourceSegmentIndexForTargetOffset(Array.from(source), Array.from(target), srcSegs, withTrailingNl, 14),
    null,
  );
  // Conversely, when segment 1 is `[0, 3)` (`Uno` only, followed by `\n\n` then `Dos draft` at 5..14),
  // offset 3 stays outside `[5, 14]` and still resolves cleanly to segment 0 (`Uno`).
  assert.equal(
    sourceSegmentIndexForTargetOffset(Array.from(source), Array.from(target), srcSegs, alignments, 3),
    0,
  );

  // Same guarantee under CRLF separators (`Uno\r\n\r\nDos draft\r\n\r\nTres`, segment 1 ends at offset 7).
  const crlfTarget = 'Uno\r\n\r\nDos draft\r\n\r\nTres';
  const crlfTresStart = Array.from('Uno\r\n\r\nDos draft\r\n\r\n').length;
  const crlfWithTrailingNl = [
    { source: { start: scalarOffset(0), end: scalarOffset(2), text: '甲。' }, target: { start: scalarOffset(0), end: scalarOffset(7), text: 'Uno\r\n\r\n' } },
    { source: { start: scalarOffset(4), end: scalarOffset(6), text: '乙。' }, target: null },
    { source: { start: scalarOffset(8), end: scalarOffset(10), text: '丙。' }, target: { start: scalarOffset(crlfTresStart), end: scalarOffset(crlfTresStart + 4), text: 'Tres' } },
  ];
  assert.equal(
    sourceSegmentIndexForTargetOffset(Array.from(source), Array.from(crlfTarget), srcSegs, crlfWithTrailingNl, 7),
    null,
  );
});

test('invariant A: cleared-alignment mode (alignments: []) never turns into null or synthesizes non-empty alignments', () => {
  const source3 = '甲。\n\n乙。\n\n丙。';
  const segs3 = segmentParagraphs(source3);

  // Replace existing paragraph when paragraph counts match keeps []
  const replaced = applySegmentSuggestionResult('Uno\n\nDos\n\nTres', segs3, 0, 'Uno TM', { source: source3, alignments: [] });
  assert.equal(replaced.applied, true);
  assert.equal(replaced.target, 'Uno TM\n\nDos\n\nTres');
  assert.deepEqual(replaced.alignments, []);

  // Starting from blank target at index 0 keeps [] (never synthesizes alignments in cleared mode)
  const fromBlank = applySegmentSuggestionResult('', segs3, 0, 'Uno TM', { source: source3, alignments: [] });
  assert.equal(fromBlank.applied, true);
  assert.equal(fromBlank.target, 'Uno TM');
  assert.deepEqual(fromBlank.alignments, []);

  // Partial target (`Uno` on 3-para source) in cleared mode refuses overwrite with target_fewer_paragraphs and keeps []
  const partialRefused = applySegmentSuggestionResult('Uno', segs3, 0, 'Uno TM', { source: source3, alignments: [] });
  assert.equal(partialRefused.applied, false);
  assert.equal(partialRefused.reason, 'target_fewer_paragraphs');
  assert.deepEqual(partialRefused.alignments, []);

  // Multi-paragraph refusal keeps []
  const multiRefused = applySegmentSuggestionResult('Uno', segs3, 0, 'A\n\nB', { source: source3, alignments: [] });
  assert.equal(multiRefused.applied, false);
  assert.equal(multiRefused.reason, 'multi_paragraph_suggestion');
  assert.deepEqual(multiRefused.alignments, []);

  // Skip-fill while alignments === [] MUST refuse instead of synthesizing [Uno, null, Tres] alignments!
  const activeSkip = resolveActiveSegment(source3, 'Uno', { kind: 'index', index: 2 }, []);
  assert.equal(describeTmSegmentAlignment(source3, 'Uno', activeSkip, []).status, 'cleared_alignments_skip');

  const skipRefused = applySegmentSuggestionResult('Uno', segs3, 2, 'Tres TM', { source: source3, alignments: [] });
  assert.equal(skipRefused.applied, false);
  assert.equal(skipRefused.reason, 'cleared_alignments_skip');
  assert.equal(skipRefused.target, 'Uno');
  assert.deepEqual(skipRefused.alignments, []);
});

test('P1-03 regression: partial target A\'/C\' against source A/B/C without explicit alignments refuses positional mapping and silent overwrite', () => {
  const source = '段落A。\n\n段落B。\n\n段落C。';
  const target = "Target A'.\n\nTarget C'.";
  const srcSegs = segmentParagraphs(source);

  for (const alignments of [null, []]) {
    for (const index of [0, 1, 2]) {
      const active = resolveActiveSegment(source, target, { kind: 'index', index }, alignments);
      assert.equal(active.hasAlignedTarget, false, `index ${index} must not treat partial target as aligned`);
      assert.equal(active.targetText, '', `index ${index} must not borrow Target C' for B`);
      assert.equal(active.targetRange, null);

      const status = describeTmSegmentAlignment(source, target, active, alignments);
      assert.equal(status.status, 'target_fewer_paragraphs');
      assert.equal(status.sourceTotal, 3);
      assert.equal(status.targetTotal, 2);

      const outcome = applySegmentSuggestionResult(target, srcSegs, index, "Target B' (TM).", { source, alignments });
      assert.equal(outcome.applied, false);
      assert.equal(outcome.reason, 'target_fewer_paragraphs');
      assert.equal(outcome.target, target, 'existing Target C\' must never be overwritten');
      assert.deepEqual(outcome.alignments, alignments);
    }
  }

  // Once explicit alignments `[A -> A', B -> null, C -> C']` exist, segment 1 inserts cleanly without overwriting C'.
  const cStart = Array.from("Target A'.\n\n").length;
  const explicitAlignments = [
    { source: { start: srcSegs[0].coreStart, end: srcSegs[0].coreEnd, text: srcSegs[0].text }, target: { start: scalarOffset(0), end: scalarOffset(10), text: "Target A'." } },
    { source: { start: srcSegs[1].coreStart, end: srcSegs[1].coreEnd, text: srcSegs[1].text }, target: null },
    { source: { start: srcSegs[2].coreStart, end: srcSegs[2].coreEnd, text: srcSegs[2].text }, target: { start: scalarOffset(cStart), end: scalarOffset(cStart + 10), text: "Target C'." } },
  ];
  const activeB = resolveActiveSegment(source, target, { kind: 'index', index: 1 }, explicitAlignments);
  assert.equal(describeTmSegmentAlignment(source, target, activeB, explicitAlignments).status, 'ok');
  const appliedB = applySegmentSuggestionResult(target, srcSegs, 1, "Target B'.", { source, alignments: explicitAlignments });
  assert.equal(appliedB.applied, true);
  assert.equal(appliedB.target, "Target A'.\n\nTarget B'.\n\nTarget C'.");
  assert.deepEqual(appliedB.alignments?.map(a => a.target?.text), ["Target A'.", "Target B'.", "Target C'."]);
});
