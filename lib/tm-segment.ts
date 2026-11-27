// Deterministic per-segment TM slicing, active-segment resolution, and single-segment target application (MY-491).
//
// Reuses core's `paragraphRanges` and `core` from `lib/segmentation.ts` and alignment remap helpers from
// `lib/manuscript.js` so TM paragraph boundaries and explicit alignments stay consistent across the workbench.
// All offsets are Unicode scalar indices (`Array.from`).
import { remapForSplice, remapForTargetFill, validAlignments, type InvalidatedAlignment } from './manuscript.js';
import { core, paragraphRanges } from './segmentation.ts';
import { scalarOffset, type Alignment, type ScalarOffset, type Span, type Splice } from './workbench-model.ts';

export type TmSegment = {
  index: number;
  start: ScalarOffset;
  end: ScalarOffset;
  coreStart: ScalarOffset;
  coreEnd: ScalarOffset;
  text: string;
};

export type TmActiveSegment = {
  index: number;
  total: number;
  sourceText: string;
  targetText: string;
  prevSource: string | null;
  nextSource: string | null;
  targetRange: { start: number; end: number } | null;
  hasAlignedTarget: boolean;
};

export type TmSegmentCursor =
  | { kind: 'index'; index: number }
  | { kind: 'offset'; side: 'source' | 'target'; offset: number };

export type TmApplySegmentOptions = {
  source?: string;
  alignments?: readonly Alignment[] | null;
};

export type TmApplySegmentResult = {
  target: string;
  alignments: Alignment[] | null;
  splice: Splice | null;
  invalidated: InvalidatedAlignment[];
  applied: boolean;
  reason: 'replaced' | 'inserted' | 'unaligned_target' | 'multi_paragraph_suggestion' | 'target_gap_occupied';
};

export type TmSegmentAlignmentStatus = {
  status: 'ok' | 'target_extra_paragraphs' | 'alignment_ambiguous' | 'target_gap_occupied';
  sourceTotal: number;
  targetTotal: number;
};

const MAX_AUTO_ALIGNMENTS = 64;

/** Splits `text` into deterministic paragraph segments using `lib/segmentation.ts` rules. */
export function segmentParagraphs(text: string): TmSegment[] {
  if (!text) return [];
  const chars = Array.from(text);
  return paragraphRanges(chars).map(([start, end], index): TmSegment => {
    const [coreStart, coreEnd] = core(chars, start, end);
    return {
      index,
      start,
      end,
      coreStart,
      coreEnd,
      text: chars.slice(coreStart, coreEnd).join(''),
    };
  });
}

function countNewlines(chars: readonly string[], start: number, end: number): number {
  let count = 0;
  for (let i = start; i < end; i += 1) {
    if (chars[i] === '\n') count += 1;
  }
  return count;
}

function indexAfterNthNewline(chars: readonly string[], start: number, end: number, targetCount: number): number {
  let seen = 0;
  for (let i = start; i < end; i += 1) {
    if (chars[i] === '\n') {
      seen += 1;
      if (seen === targetCount) return i + 1;
    }
  }
  return end;
}

function clampIndex(index: number, total: number): number {
  if (total <= 0) return 0;
  if (!Number.isFinite(index)) return 0;
  return Math.max(0, Math.min(total - 1, Math.trunc(index)));
}

function segmentIndexAtOffset(
  text: string,
  segments: readonly TmSegment[],
  offset: number,
  options: { allowTrailingNewParagraph?: boolean } = {},
): number {
  if (segments.length === 0) return 0;
  const chars = Array.from(text);
  const clamped = Math.max(0, Math.min(chars.length, Math.trunc(offset)));

  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i]!;
    if (clamped >= seg.start && clamped < seg.end) {
      if (
        options.allowTrailingNewParagraph &&
        i === segments.length - 1 &&
        clamped > seg.coreEnd &&
        countNewlines(chars, seg.coreEnd, clamped) >= 2
      ) {
        return segments.length;
      }
      return i;
    }
  }

  const last = segments[segments.length - 1]!;
  if (options.allowTrailingNewParagraph && clamped > last.coreEnd && countNewlines(chars, last.coreEnd, clamped) >= 2) {
    return segments.length;
  }
  return segments.length - 1;
}

type AlignedLookup =
  | { kind: 'aligned'; entry: Alignment; alignmentIndex: number }
  | { kind: 'ambiguous' };

function locateAlignmentForSourceSegment(
  sourceChars: readonly string[],
  seg: TmSegment,
  alignments: readonly Alignment[],
): AlignedLookup {
  const overlapping: { entry: Alignment; alignmentIndex: number; coreStart: number; coreEnd: number }[] = [];
  for (let i = 0; i < alignments.length; i += 1) {
    const entry = alignments[i]!;
    const [eCoreStart, eCoreEnd] = core(sourceChars, entry.source.start, entry.source.end);
    if (eCoreStart < seg.coreEnd && eCoreEnd > seg.coreStart) {
      overlapping.push({ entry, alignmentIndex: i, coreStart: eCoreStart, coreEnd: eCoreEnd });
    }
  }
  if (overlapping.length !== 1) return { kind: 'ambiguous' };
  const { entry, alignmentIndex, coreStart, coreEnd } = overlapping[0]!;
  if (coreStart !== seg.coreStart || coreEnd !== seg.coreEnd) {
    return { kind: 'ambiguous' };
  }
  return { kind: 'aligned', entry, alignmentIndex };
}

function sourceSegmentIndexForTargetOffset(
  sourceChars: readonly string[],
  sourceSegments: readonly TmSegment[],
  alignments: readonly Alignment[],
  offset: number,
): number | null {
  const targetEntries = alignments
    .filter((a): a is Alignment & { target: Span } => a.target !== null)
    .sort((a, b) => a.target.start - b.target.start);
  if (targetEntries.length === 0) return null;
  let matched: (Alignment & { target: Span }) | null = null;
  // Half-open [start, end) hit test first so adjacent spans [0,1) and [1,2) resolve offset=1 to the second span.
  for (const entry of targetEntries) {
    if (offset >= entry.target.start && offset < entry.target.end) {
      matched = entry;
      break;
    }
  }
  // Fall back to a trailing end boundary or nearest preceding span only when no half-open interval contains offset.
  if (!matched) {
    for (const entry of targetEntries) {
      if (offset === entry.target.end || offset > entry.target.end) {
        matched = entry;
      }
    }
  }
  if (!matched) matched = targetEntries[0]!;
  const [mCoreStart, mCoreEnd] = core(sourceChars, matched.source.start, matched.source.end);
  const sIdx = sourceSegments.findIndex(seg => {
    const lookup = locateAlignmentForSourceSegment(sourceChars, seg, alignments);
    if (lookup.kind === 'aligned') return lookup.entry === matched;
    return mCoreStart < seg.coreEnd && mCoreEnd > seg.coreStart;
  });
  return sIdx >= 0 ? sIdx : null;
}

function findAlignmentGapBounds(
  alignments: readonly Alignment[],
  alignmentIndex: number,
  targetLen: number,
): { prevAligned: (Alignment & { target: Span }) | null; nextAligned: (Alignment & { target: Span }) | null; prevEnd: number; nextStart: number } {
  let prevAligned: (Alignment & { target: Span }) | null = null;
  for (let i = alignmentIndex - 1; i >= 0; i -= 1) {
    const item = alignments[i]!;
    if (item.target !== null) {
      prevAligned = item as Alignment & { target: Span };
      break;
    }
  }
  let nextAligned: (Alignment & { target: Span }) | null = null;
  for (let i = alignmentIndex + 1; i < alignments.length; i += 1) {
    const item = alignments[i]!;
    if (item.target !== null) {
      nextAligned = item as Alignment & { target: Span };
      break;
    }
  }
  const prevEnd = prevAligned ? prevAligned.target.end : 0;
  const nextStart = nextAligned ? nextAligned.target.start : targetLen;
  return { prevAligned, nextAligned, prevEnd, nextStart };
}

/**
 * Resolves the active source segment and its corresponding target slice from `source`, `target`, the most recent
 * cursor/selection state, and any explicit `alignments`. Defaults to segment 0.
 */
export function resolveActiveSegment(
  source: string,
  target: string,
  cursor: TmSegmentCursor | null = null,
  alignments: readonly Alignment[] | null = null,
): TmActiveSegment {
  const sourceSegments = segmentParagraphs(source);
  const total = sourceSegments.length;
  if (total === 0) {
    return {
      index: 0,
      total: 0,
      sourceText: '',
      targetText: target,
      prevSource: null,
      nextSource: null,
      targetRange: target.length > 0 ? { start: 0, end: Array.from(target).length } : null,
      hasAlignedTarget: target.trim().length > 0,
    };
  }

  const effectiveAlignments = alignments && alignments.length > 0 ? alignments : null;
  const targetSegments = segmentParagraphs(target);
  const sourceChars = Array.from(source);
  const targetChars = Array.from(target);

  let index = 0;
  if (cursor?.kind === 'index') {
    index = clampIndex(cursor.index, total);
  } else if (cursor?.kind === 'offset') {
    if (cursor.side === 'source') {
      index = clampIndex(segmentIndexAtOffset(source, sourceSegments, cursor.offset), total);
    } else if (effectiveAlignments !== null) {
      const mapped = sourceSegmentIndexForTargetOffset(sourceChars, sourceSegments, effectiveAlignments, cursor.offset);
      index = mapped !== null ? clampIndex(mapped, total) : 0;
    } else if (targetSegments.length > 0) {
      index = clampIndex(
        segmentIndexAtOffset(target, targetSegments, cursor.offset, {
          allowTrailingNewParagraph: true,
        }),
        total,
      );
    }
  }

  const activeSource = sourceSegments[index]!;
  const prevSource = index > 0 ? sourceSegments[index - 1]!.text : null;
  const nextSource = index + 1 < total ? sourceSegments[index + 1]!.text : null;

  if (effectiveAlignments !== null) {
    const lookup = locateAlignmentForSourceSegment(sourceChars, activeSource, effectiveAlignments);
    if (lookup.kind === 'aligned' && lookup.entry.target !== null) {
      const [tCoreStart, tCoreEnd] = core(targetChars, lookup.entry.target.start, lookup.entry.target.end);
      const hasCore = tCoreStart < tCoreEnd;
      const rStart = hasCore ? tCoreStart : lookup.entry.target.start;
      const rEnd = hasCore ? tCoreEnd : lookup.entry.target.end;
      return {
        index,
        total,
        sourceText: activeSource.text,
        targetText: targetChars.slice(rStart, rEnd).join(''),
        prevSource,
        nextSource,
        targetRange: { start: scalarOffset(rStart), end: scalarOffset(rEnd) },
        hasAlignedTarget: true,
      };
    }
    return {
      index,
      total,
      sourceText: activeSource.text,
      targetText: '',
      prevSource,
      nextSource,
      targetRange: null,
      hasAlignedTarget: false,
    };
  }

  if (total === 1) {
    return {
      index: 0,
      total: 1,
      sourceText: activeSource.text,
      targetText: target,
      prevSource: null,
      nextSource: null,
      targetRange: target.length > 0 ? { start: 0, end: targetChars.length } : null,
      hasAlignedTarget: target.trim().length > 0,
    };
  }

  // Multi-paragraph target longer than source has ambiguous alignment; do not map arbitrarily.
  if (targetSegments.length > total) {
    return {
      index,
      total,
      sourceText: activeSource.text,
      targetText: '',
      prevSource,
      nextSource,
      targetRange: null,
      hasAlignedTarget: false,
    };
  }

  if (index < targetSegments.length) {
    const aligned = targetSegments[index]!;
    return {
      index,
      total,
      sourceText: activeSource.text,
      targetText: aligned.text,
      prevSource,
      nextSource,
      targetRange: { start: scalarOffset(aligned.coreStart), end: scalarOffset(aligned.coreEnd) },
      hasAlignedTarget: true,
    };
  }

  return {
    index,
    total,
    sourceText: activeSource.text,
    targetText: '',
    prevSource,
    nextSource,
    targetRange: null,
    hasAlignedTarget: false,
  };
}

function preferredEol(target: string, source = ''): string {
  if (target.includes('\r\n')) return '\r\n';
  if (!target && source.includes('\r\n')) return '\r\n';
  return '\n';
}

function insertIntoTargetGap(
  target: string,
  tChars: readonly string[],
  prevEnd: number,
  nextStart: number,
  hasPrev: boolean,
  hasNext: boolean,
  suggestionText: string,
  eol: string,
): { nextTarget: string; insertAt: number; coreStart: number; coreEnd: number; delta: number } {
  const sep = eol + eol;
  let insertAt = prevEnd;
  let lead = '';
  let trail = '';

  if (!hasPrev && !hasNext) {
    insertAt = tChars.length;
  } else if (hasPrev && !hasNext) {
    const nl = countNewlines(tChars, prevEnd, tChars.length);
    if (nl >= 2) {
      insertAt = tChars.length;
    } else if (nl === 1) {
      insertAt = indexAfterNthNewline(tChars, prevEnd, tChars.length, 1);
      lead = eol;
    } else {
      insertAt = tChars.length;
      lead = sep;
    }
  } else if (!hasPrev && hasNext) {
    const nl = countNewlines(tChars, 0, nextStart);
    insertAt = 0;
    if (nl >= 2) {
      trail = '';
    } else if (nl === 1) {
      trail = eol;
    } else {
      trail = sep;
    }
  } else {
    const nl = countNewlines(tChars, prevEnd, nextStart);
    if (nl >= 2) {
      insertAt = indexAfterNthNewline(tChars, prevEnd, nextStart, 2);
      const remainingNl = countNewlines(tChars, insertAt, nextStart);
      trail = remainingNl >= 2 ? '' : remainingNl === 1 ? eol : sep;
    } else if (nl === 1) {
      insertAt = indexAfterNthNewline(tChars, prevEnd, nextStart, 1);
      lead = eol;
      trail = sep;
    } else {
      insertAt = prevEnd;
      lead = sep;
      trail = sep;
    }
  }

  const inserted = `${lead}${suggestionText}${trail}`;
  const leadLen = Array.from(lead).length;
  const suggestionLen = Array.from(suggestionText).length;
  const delta = Array.from(inserted).length;
  const nextTarget = `${tChars.slice(0, insertAt).join('')}${inserted}${tChars.slice(insertAt).join('')}`;
  const coreStart = insertAt + leadLen;
  const coreEnd = coreStart + suggestionLen;
  return { nextTarget, insertAt, coreStart, coreEnd, delta };
}

function spanOfSegment(seg: TmSegment): Span {
  return { start: seg.coreStart, end: seg.coreEnd, text: seg.text };
}

/**
 * Applies `suggestionText` only to `activeIndex` in `target`, preserving every character outside the replaced/inserted
 * range and keeping explicit `alignments` synchronized.
 *
 * - Single-segment source (`total <= 1`, `alignments === null`): replaces whole `target` directly.
 * - Multi-segment source without explicit alignments: rejects multi-paragraph suggestions (`segmentParagraphs(suggestion).length > 1`),
 *   refuses overwriting when `targetSegments.length > total`, and when skipping untranslated segments (`index > targetSegments.length`)
 *   creates explicit `alignments` keeping skipped segments `target: null` (or refuses if > 64 segments / no source context).
 * - With explicit `alignments`: respects `target === null` (inserts at the exact alignment gap without altering neighbours'
 *   whitespace/indentation and updates `alignments` via `remapForTargetFill`), and replaces aligned targets via `remapForSplice`.
 */
export function applySegmentSuggestionResult(
  target: string,
  sourceSegments: readonly TmSegment[],
  activeIndex: number,
  suggestionText: string,
  options: TmApplySegmentOptions = {},
): TmApplySegmentResult {
  const total = sourceSegments.length;
  const rawAlignments = options.alignments ?? null;
  const alignments = rawAlignments && rawAlignments.length > 0 ? rawAlignments : null;
  const source = options.source ?? '';
  const tChars = Array.from(target);

  if (total <= 1 && alignments === null) {
    const repLen = Array.from(suggestionText).length;
    return {
      target: suggestionText,
      alignments: null,
      splice: { start: scalarOffset(0), oldEnd: scalarOffset(tChars.length), newEnd: scalarOffset(repLen) },
      invalidated: [],
      applied: true,
      reason: 'replaced',
    };
  }

  if (total === 0) {
    return { target, alignments: alignments ? [...alignments] : null, splice: null, invalidated: [], applied: false, reason: 'unaligned_target' };
  }

  const index = clampIndex(activeIndex, total);
  const suggestionSegments = segmentParagraphs(suggestionText);

  if (total > 1 && alignments === null && suggestionSegments.length > 1) {
    return {
      target,
      alignments: null,
      splice: null,
      invalidated: [],
      applied: false,
      reason: 'multi_paragraph_suggestion',
    };
  }

  if (alignments !== null) {
    if (!source) {
      return {
        target,
        alignments: [...alignments],
        splice: null,
        invalidated: [],
        applied: false,
        reason: 'unaligned_target',
      };
    }
    const sourceChars = Array.from(source);
    const lookup = locateAlignmentForSourceSegment(sourceChars, sourceSegments[index]!, alignments);
    if (lookup.kind !== 'aligned') {
      return {
        target,
        alignments: [...alignments],
        splice: null,
        invalidated: [],
        applied: false,
        reason: 'unaligned_target',
      };
    }
    const { entry, alignmentIndex } = lookup;
    if (entry.target !== null) {
      const [tCoreStart, tCoreEnd] = core(tChars, entry.target.start, entry.target.end);
      const replaceStart = tCoreStart < tCoreEnd ? tCoreStart : entry.target.start;
      const replaceEnd = tCoreStart < tCoreEnd ? tCoreEnd : entry.target.end;
      const repLen = Array.from(suggestionText).length;
      const nextTarget = `${tChars.slice(0, replaceStart).join('')}${suggestionText}${tChars.slice(replaceEnd).join('')}`;
      const remap = remapForSplice([...alignments], 'target', source, nextTarget, replaceStart, replaceEnd, repLen);
      return {
        target: nextTarget,
        alignments: remap.alignments,
        splice: {
          start: scalarOffset(replaceStart),
          oldEnd: scalarOffset(replaceEnd),
          newEnd: scalarOffset(replaceStart + repLen),
        },
        invalidated: remap.invalidated,
        applied: true,
        reason: 'replaced',
      };
    }

    const { prevAligned, nextAligned, prevEnd, nextStart } = findAlignmentGapBounds(alignments, alignmentIndex, tChars.length);
    if (prevEnd > nextStart || tChars.slice(prevEnd, nextStart).join('').trim().length > 0) {
      return {
        target,
        alignments: [...alignments],
        splice: null,
        invalidated: [],
        applied: false,
        reason: 'target_gap_occupied',
      };
    }
    const eol = preferredEol(target, source);
    const placed = insertIntoTargetGap(
      target,
      tChars,
      prevEnd,
      nextStart,
      prevAligned !== null,
      nextAligned !== null,
      suggestionText,
      eol,
    );
    const remap = remapForTargetFill(
      [...alignments],
      source,
      placed.nextTarget,
      entry.source.start,
      entry.source.end,
      placed.insertAt,
      placed.coreStart,
      placed.coreEnd,
      placed.delta,
    );
    return {
      target: placed.nextTarget,
      alignments: remap.alignments,
      splice: {
        start: scalarOffset(placed.insertAt),
        oldEnd: scalarOffset(placed.insertAt),
        newEnd: scalarOffset(placed.insertAt + placed.delta),
      },
      invalidated: remap.invalidated,
      applied: true,
      reason: 'inserted',
    };
  }

  // No explicit alignments yet (`total > 1`).
  const targetSegments = segmentParagraphs(target);
  if (targetSegments.length > total) {
    return {
      target,
      alignments: null,
      splice: null,
      invalidated: [],
      applied: false,
      reason: 'unaligned_target',
    };
  }

  if (index < targetSegments.length) {
    const seg = targetSegments[index]!;
    const repLen = Array.from(suggestionText).length;
    const nextTarget = `${tChars.slice(0, seg.coreStart).join('')}${suggestionText}${tChars.slice(seg.coreEnd).join('')}`;
    return {
      target: nextTarget,
      alignments: null,
      splice: { start: seg.coreStart, oldEnd: seg.coreEnd, newEnd: scalarOffset(seg.coreStart + repLen) },
      invalidated: [],
      applied: true,
      reason: 'replaced',
    };
  }

  const isSkipInsert = index > targetSegments.length;
  if (isSkipInsert && (!source || total > MAX_AUTO_ALIGNMENTS)) {
    return {
      target,
      alignments: null,
      splice: null,
      invalidated: [],
      applied: false,
      reason: 'unaligned_target',
    };
  }

  const last = targetSegments.length > 0 ? targetSegments[targetSegments.length - 1]! : null;
  const eol = preferredEol(target, source);
  const placed = insertIntoTargetGap(
    target,
    tChars,
    last ? last.coreEnd : 0,
    tChars.length,
    last !== null,
    false,
    suggestionText,
    eol,
  );
  const splice: Splice = {
    start: scalarOffset(placed.insertAt),
    oldEnd: scalarOffset(placed.insertAt),
    newEnd: scalarOffset(placed.insertAt + placed.delta),
  };

  if (!isSkipInsert) {
    return {
      target: placed.nextTarget,
      alignments: null,
      splice,
      invalidated: [],
      applied: true,
      reason: 'inserted',
    };
  }

  const nextAlignments: Alignment[] = sourceSegments.map((seg, i): Alignment => {
    if (i < targetSegments.length) {
      return { source: spanOfSegment(seg), target: spanOfSegment(targetSegments[i]!) };
    }
    if (i === index) {
      return {
        source: spanOfSegment(seg),
        target: { start: scalarOffset(placed.coreStart), end: scalarOffset(placed.coreEnd), text: suggestionText },
      };
    }
    return { source: spanOfSegment(seg), target: null };
  });

  if (!validAlignments(nextAlignments, source, placed.nextTarget)) {
    return {
      target,
      alignments: null,
      splice: null,
      invalidated: [],
      applied: false,
      reason: 'unaligned_target',
    };
  }

  return {
    target: placed.nextTarget,
    alignments: nextAlignments,
    splice,
    invalidated: [],
    applied: true,
    reason: 'inserted',
  };
}

export function applySegmentSuggestionToTarget(
  target: string,
  sourceSegments: readonly TmSegment[],
  activeIndex: number,
  suggestionText: string,
  options: TmApplySegmentOptions = {},
): string {
  return applySegmentSuggestionResult(target, sourceSegments, activeIndex, suggestionText, options).target;
}

/**
 * Summarizes whether `activeSegment` is cleanly aligned for TM apply/confirm without naive paragraph-count false alarms
 * when explicit `alignments` already isolate each source segment.
 */
export function describeTmSegmentAlignment(
  source: string,
  target: string,
  activeSegment: TmActiveSegment,
  alignments: readonly Alignment[] | null = null,
): TmSegmentAlignmentStatus {
  const sourceSegments = segmentParagraphs(source);
  const targetSegments = segmentParagraphs(target);
  const sourceTotal = sourceSegments.length;
  const targetTotal = targetSegments.length;
  const effectiveAlignments = alignments && alignments.length > 0 ? alignments : null;

  if (effectiveAlignments !== null) {
    const activeSource = sourceSegments[activeSegment.index];
    if (!activeSource) return { status: 'ok', sourceTotal, targetTotal };
    const sourceChars = Array.from(source);
    const lookup = locateAlignmentForSourceSegment(sourceChars, activeSource, effectiveAlignments);
    if (lookup.kind !== 'aligned') {
      return { status: 'alignment_ambiguous', sourceTotal, targetTotal };
    }
    if (lookup.entry.target === null) {
      const tChars = Array.from(target);
      const { prevEnd, nextStart } = findAlignmentGapBounds(effectiveAlignments, lookup.alignmentIndex, tChars.length);
      if (prevEnd > nextStart || tChars.slice(prevEnd, nextStart).join('').trim().length > 0) {
        return { status: 'target_gap_occupied', sourceTotal, targetTotal };
      }
    }
    return { status: 'ok', sourceTotal, targetTotal };
  }

  if (sourceTotal > 1 && targetTotal > sourceTotal) {
    return { status: 'target_extra_paragraphs', sourceTotal, targetTotal };
  }
  return { status: 'ok', sourceTotal, targetTotal };
}
