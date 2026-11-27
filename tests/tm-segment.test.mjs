// Unit tests for per-segment TM slicing, active-segment resolution, neighbour context matching, and single-segment apply (MY-491).
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

  // When user typed a blank line at the end of a partial target (`First target.\n\n`) and caret is after it,
  // active segment advances to segment 1 even though segment 1 has no text yet.
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
  // Single segment: full replacement compatible with short-text mode.
  const singleSrc = segmentParagraphs('今汐。');
  assert.equal(applySegmentSuggestionToTarget('old target\n\nextra', singleSrc, 0, 'Jinhsi.'), 'Jinhsi.');

  // Multi-segment with CRLF, leading/trailing spaces, and non-BMP emoji characters.
  const multiSrc = segmentParagraphs('甲😀。\r\n\r\n乙。\r\n\r\n丙。');
  const multiTgt = '  Alpha 😀.\r\n\r\nBeta.\r\n\r\nGamma.  ';
  const replacedMid = applySegmentSuggestionToTarget(multiTgt, multiSrc, 1, 'Beta (TM).');
  assert.equal(replacedMid, '  Alpha 😀.\r\n\r\nBeta (TM).\r\n\r\nGamma.  ');

  const replacedFirst = applySegmentSuggestionToTarget(multiTgt, multiSrc, 0, 'Alpha (TM).');
  assert.equal(replacedFirst, '  Alpha (TM).\r\n\r\nBeta.\r\n\r\nGamma.  ');

  const replacedLast = applySegmentSuggestionToTarget(multiTgt, multiSrc, 2, 'Gamma (TM).');
  assert.equal(replacedLast, '  Alpha 😀.\r\n\r\nBeta.\r\n\r\nGamma (TM).  ');
});

test('applySegmentSuggestionToTarget handles empty/shorter target safely and refuses to overwrite when target has more segments than source', () => {
  const src3 = segmentParagraphs('一。\n\n二。\n\n三。');

  // Empty target at index 0 -> direct insert.
  assert.equal(applySegmentSuggestionToTarget('', src3, 0, 'One.'), 'One.');

  // Empty target at index 1 -> pads blank line; applying index 0 afterwards inserts before without overwriting index 1.
  const afterIdx1 = applySegmentSuggestionToTarget('', src3, 1, 'Two.');
  assert.equal(afterIdx1, '\n\nTwo.');
  const resolvedZero = resolveActiveSegment('一。\n\n二。\n\n三。', afterIdx1, { kind: 'index', index: 0 });
  assert.equal(resolvedZero.hasAlignedTarget, false);
  assert.equal(resolvedZero.targetText, '');
  const afterIdx0 = applySegmentSuggestionToTarget(afterIdx1, src3, 0, 'One.');
  assert.equal(afterIdx0, 'One.\n\nTwo.');

  // Shorter target with 1 translated segment -> appends segment 1 cleanly without touching segment 0.
  assert.equal(applySegmentSuggestionToTarget('One.', src3, 1, 'Two.'), 'One.\n\nTwo.');
  assert.equal(applySegmentSuggestionToTarget('One.\r\n\r\n', src3, 1, 'Two.'), 'One.\r\n\r\nTwo.');
  assert.equal(applySegmentSuggestionToTarget('One.', src3, 2, 'Three.'), 'One.\n\n\n\nThree.');

  // Longer target (more paragraphs than source) -> refuses to overwrite existing translations.
  const src2 = segmentParagraphs('一。\n\n二。');
  const longerTgt = 'One-A.\n\nOne-B.\n\nTwo.';
  const active = resolveActiveSegment('一。\n\n二。', longerTgt, { kind: 'index', index: 1 });
  assert.equal(active.hasAlignedTarget, false);
  assert.equal(active.targetRange, null);
  const outcome = applySegmentSuggestionResult(longerTgt, src2, 1, 'Overwrite attempt');
  assert.deepEqual(outcome, { target: longerTgt, applied: false, reason: 'unaligned_target' });
});
