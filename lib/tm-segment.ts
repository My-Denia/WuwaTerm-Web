// Deterministic per-segment TM slicing, active-segment resolution, and single-segment target application (MY-491).
//
// Reuses core's `paragraphRanges` and `core` from `lib/segmentation.ts` so TM paragraph boundaries never diverge
// from the manuscript segmentation rules. All offsets are Unicode scalar indices (`Array.from`).
import { core, paragraphRanges } from './segmentation.ts';
import { scalarOffset, type ScalarOffset } from './workbench-model.ts';

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

export type TmApplySegmentResult = {
  target: string;
  applied: boolean;
  reason: 'replaced' | 'inserted' | 'unaligned_target';
};

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

function leadingBlankSlots(
  targetChars: readonly string[],
  targetSegments: readonly TmSegment[],
  sourceTotal: number,
): number {
  if (targetSegments.length === 0 || targetSegments.length >= sourceTotal) return 0;
  const newlines = countNewlines(targetChars, 0, targetSegments[0]!.coreStart);
  if (newlines < 2) return 0;
  return Math.min(sourceTotal - targetSegments.length, Math.floor(newlines / 2));
}

function segmentIndexAtOffset(
  text: string,
  segments: readonly TmSegment[],
  offset: number,
  options: { allowTrailingNewParagraph?: boolean; leadingSlots?: number } = {},
): number {
  if (segments.length === 0) return 0;
  const chars = Array.from(text);
  const clamped = Math.max(0, Math.min(chars.length, Math.trunc(offset)));
  const leadingSlots = options.leadingSlots ?? 0;

  if (leadingSlots > 0 && clamped < segments[0]!.coreStart) {
    const newlinesBeforeCaret = countNewlines(chars, 0, clamped);
    return Math.min(leadingSlots, Math.floor(newlinesBeforeCaret / 2));
  }

  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i]!;
    if (clamped >= seg.start && clamped < seg.end) {
      if (
        options.allowTrailingNewParagraph &&
        i === segments.length - 1 &&
        clamped > seg.coreEnd &&
        countNewlines(chars, seg.coreEnd, clamped) >= 2
      ) {
        return leadingSlots + segments.length;
      }
      return leadingSlots + i;
    }
  }

  const last = segments[segments.length - 1]!;
  if (options.allowTrailingNewParagraph && clamped > last.coreEnd && countNewlines(chars, last.coreEnd, clamped) >= 2) {
    return leadingSlots + segments.length;
  }
  return leadingSlots + segments.length - 1;
}

function clampIndex(index: number, total: number): number {
  if (total <= 0) return 0;
  if (!Number.isFinite(index)) return 0;
  return Math.max(0, Math.min(total - 1, Math.trunc(index)));
}

/**
 * Resolves the active source segment and its corresponding target slice from `source`, `target`, and the most recent
 * cursor/selection state. Defaults to segment 0.
 */
export function resolveActiveSegment(
  source: string,
  target: string,
  cursor: TmSegmentCursor | null = null,
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

  const targetSegments = segmentParagraphs(target);
  const targetChars = Array.from(target);
  const leadingSlots = leadingBlankSlots(targetChars, targetSegments, total);

  let index = 0;
  if (cursor?.kind === 'index') {
    index = clampIndex(cursor.index, total);
  } else if (cursor?.kind === 'offset') {
    if (cursor.side === 'source') {
      index = clampIndex(segmentIndexAtOffset(source, sourceSegments, cursor.offset), total);
    } else if (targetSegments.length > 0) {
      index = clampIndex(
        segmentIndexAtOffset(target, targetSegments, cursor.offset, {
          allowTrailingNewParagraph: true,
          leadingSlots,
        }),
        total,
      );
    }
  }

  const activeSource = sourceSegments[index]!;
  const prevSource = index > 0 ? sourceSegments[index - 1]!.text : null;
  const nextSource = index + 1 < total ? sourceSegments[index + 1]!.text : null;

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

  const mappedTargetIndex = index - leadingSlots;
  if (mappedTargetIndex >= 0 && mappedTargetIndex < targetSegments.length) {
    const aligned = targetSegments[mappedTargetIndex]!;
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

function preferredSeparator(target: string): string {
  return target.includes('\r\n') ? '\r\n\r\n' : '\n\n';
}

/**
 * Applies `suggestionText` only to `activeIndex` in `target`, preserving all other segments and original separators.
 * When `target` is empty or shorter than `activeIndex + 1`, pads blank-line boundaries safely without overwriting
 * existing translated paragraphs; when `target` has more paragraphs than `sourceSegments` (`total > 1`), refuses to
 * overwrite ambiguous segments and returns `target` unchanged.
 */
export function applySegmentSuggestionResult(
  target: string,
  sourceSegments: readonly TmSegment[],
  activeIndex: number,
  suggestionText: string,
): TmApplySegmentResult {
  const total = sourceSegments.length;
  if (total <= 1) {
    return { target: suggestionText, applied: true, reason: 'replaced' };
  }

  const index = clampIndex(activeIndex, total);
  const targetSegments = segmentParagraphs(target);

  if (targetSegments.length > total) {
    return { target, applied: false, reason: 'unaligned_target' };
  }

  const sep = preferredSeparator(target);
  if (targetSegments.length === 0) {
    const next = index === 0 ? suggestionText : `${sep.repeat(index)}${suggestionText}`;
    return { target: next, applied: true, reason: 'inserted' };
  }

  const tChars = Array.from(target);
  const leadingSlots = leadingBlankSlots(tChars, targetSegments, total);
  const mappedTargetIndex = index - leadingSlots;

  if (mappedTargetIndex < 0) {
    // Inserting into an empty leading slot before existing target paragraphs without overwriting them.
    const prefixSlots = index;
    const afterSlots = leadingSlots - index;
    const rest = tChars.slice(targetSegments[0]!.coreStart).join('');
    const next = `${prefixSlots > 0 ? sep.repeat(prefixSlots) : ''}${suggestionText}${sep.repeat(Math.max(1, afterSlots))}${rest}`;
    return { target: next, applied: true, reason: 'inserted' };
  }

  if (mappedTargetIndex < targetSegments.length) {
    const seg = targetSegments[mappedTargetIndex]!;
    const before = tChars.slice(0, seg.coreStart).join('');
    const after = tChars.slice(seg.coreEnd).join('');
    return { target: `${before}${suggestionText}${after}`, applied: true, reason: 'replaced' };
  }

  const last = targetSegments[targetSegments.length - 1]!;
  const missingCount = mappedTargetIndex - targetSegments.length + 1;
  const head = tChars.slice(0, last.coreEnd).join('');
  const tail = tChars.slice(last.coreEnd).join('').replace(/^(?:\r?\n|[ \t])+/, '');
  return {
    target: `${head}${sep.repeat(missingCount)}${suggestionText}${tail}`,
    applied: true,
    reason: 'inserted',
  };
}

export function applySegmentSuggestionToTarget(
  target: string,
  sourceSegments: readonly TmSegment[],
  activeIndex: number,
  suggestionText: string,
): string {
  return applySegmentSuggestionResult(target, sourceSegments, activeIndex, suggestionText).target;
}
