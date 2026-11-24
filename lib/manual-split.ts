// Manual paragraph repair for pairs that need a manual split. Pure and
// browser-safe; all coordinates are Unicode scalar indices (Array.from).
import { WHITESPACE, paragraphRanges, sentenceRangesV2 } from './segmentation.ts';
import type { Pair, Region, ScalarOffset, Splice } from './workbench-model.ts';
import { scalarOffset } from './workbench-model.ts';

export type { Splice };
export type SplitSentence = { start: ScalarOffset; end: ScalarOffset };
export type SplitParagraph = {
  start: ScalarOffset;
  end: ScalarOffset;
  coreStart: ScalarOffset;
  coreEnd: ScalarOffset;
  length: number;
  sentences: SplitSentence[];
};
export type ManualEdit = { text: string; splice: Splice | null };
export type PairShape = {
  sourceParagraphs: number;
  targetParagraphs: number;
  sourceSentences: number;
  targetSentences: number;
  sourceLength: number;
  targetLength: number;
};

const WS = new Set(WHITESPACE.map(c => String.fromCodePoint(c)));
const CJK = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|[　-〿＀-￯]/u;

function trimmed(chars: readonly string[], start: number, end: number): [ScalarOffset, ScalarOffset] {
  let a = start; let b = end;
  while (a < b && WS.has(chars[a])) a++;
  while (b > a && WS.has(chars[b - 1])) b--;
  return [scalarOffset(a), scalarOffset(b)];
}

/**
 * Paragraphs inside a region of the text, with their core and sentences, using
 * segmentation's blank-line and sentence rules.
 */
export function splitLayout(text: string, region: Region): SplitParagraph[] {
  const chars = Array.from(text);
  const base = Math.max(0, region.start);
  const slice = chars.slice(base, Math.min(chars.length, region.end));
  return paragraphRanges(slice).map(([a, b]): SplitParagraph => {
    const [cs, ce] = trimmed(slice, a, b);
    const sentences: SplitSentence[] = sentenceRangesV2(slice.slice(cs, ce)).map(([x, y]) => ({
      start: scalarOffset(base + cs + x),
      end: scalarOffset(base + cs + y),
    }));
    return {
      start: scalarOffset(base + a),
      end: scalarOffset(base + b),
      coreStart: scalarOffset(base + cs),
      coreEnd: scalarOffset(base + ce),
      length: ce - cs,
      sentences,
    };
  });
}

/**
 * Insert a blank line at a scalar offset. Spaces and tabs next to the offset
 * are dropped; an existing line break there is reused. null when the offset is
 * invalid, nothing precedes or follows it, or a blank line is already there.
 */
export function insertParagraphBreak(text: string, offset: ScalarOffset): ManualEdit | null {
  const chars = Array.from(text);
  if (!Number.isInteger(offset) || offset < 0 || offset > chars.length) return null;
  let runStart: number = offset; let runEnd: number = offset;
  while (runStart > 0 && WS.has(chars[runStart - 1])) runStart--;
  while (runEnd < chars.length && WS.has(chars[runEnd])) runEnd++;
  if (runStart === 0 || runEnd === chars.length) return null;
  const newlines = chars.slice(runStart, runEnd).filter(c => c === '\n').length;
  if (newlines >= 2) return null;
  let left: number = offset; let right: number = offset;
  while (left > 0 && (chars[left - 1] === ' ' || chars[left - 1] === '\t')) left--;
  while (right < chars.length && (chars[right] === ' ' || chars[right] === '\t')) right++;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const inserted = eol.repeat(2 - newlines);
  const next = chars.slice(0, left).join('') + inserted + chars.slice(right).join('');
  return {
    text: next,
    splice: { start: scalarOffset(left), oldEnd: scalarOffset(right), newEnd: scalarOffset(left + inserted.length) },
  };
}

/**
 * Replace the pure-whitespace gap [gapStart, gapEnd), which must contain a blank
 * line, with one space, or nothing next to CJK text.
 */
export function mergeParagraphs(text: string, gapStart: ScalarOffset, gapEnd: ScalarOffset): ManualEdit | null {
  const chars = Array.from(text);
  if (!Number.isInteger(gapStart) || !Number.isInteger(gapEnd) || gapStart <= 0 || gapStart >= gapEnd || gapEnd >= chars.length) return null;
  const gap = chars.slice(gapStart, gapEnd);
  if (!gap.every(c => WS.has(c)) || gap.filter(c => c === '\n').length < 2) return null;
  const joiner = CJK.test(chars[gapStart - 1]) || CJK.test(chars[gapEnd]) ? '' : ' ';
  const next = chars.slice(0, gapStart).join('') + joiner + chars.slice(gapEnd).join('');
  return {
    text: next,
    splice: { start: scalarOffset(gapStart), oldEnd: scalarOffset(gapEnd), newEnd: scalarOffset(gapStart + joiner.length) },
  };
}

/** Counts for the manual-split hint of one pair. */
export function pairShape(source: string, target: string, pair: Pair): PairShape {
  const s = splitLayout(source, pair.source);
  const t = splitLayout(target, pair.target);
  const sentences = (list: readonly SplitParagraph[]): number => list.reduce((n, p) => n + p.sentences.length, 0);
  return {
    sourceParagraphs: s.length,
    targetParagraphs: t.length,
    sourceSentences: sentences(s),
    targetSentences: sentences(t),
    sourceLength: pair.source.core_end - pair.source.core_start,
    targetLength: pair.target.core_end - pair.target.core_start,
  };
}

/**
 * Every single line break between two non-blank lines inside `region` becomes a
 * blank line, so each line is its own paragraph. An explicit, user-triggered
 * formatting edit for texts that separate paragraphs by single line breaks; it
 * changes no words and pairs nothing by itself.
 */
export function linesToParagraphs(text: string, region: Region | null = null): { text: string; count: number } | null {
  const chars = Array.from(text);
  const from = region ? Math.max(0, region.start) : 0;
  const to = region ? Math.min(chars.length, region.end) : chars.length;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const out: string[] = [];
  let count = 0;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const lf = c === '\n' || (c === '\r' && chars[i + 1] === '\n');
    if (!lf || i < from || i >= to) { out.push(c); continue; }
    const width = c === '\r' ? 2 : 1;
    // A single break: the previous and next lines both hold text, with only spaces or tabs around the break.
    let a = i - 1; while (a >= 0 && (chars[a] === ' ' || chars[a] === '\t')) a--;
    let b = i + width; while (b < chars.length && (chars[b] === ' ' || chars[b] === '\t')) b++;
    const single = a >= 0 && chars[a] !== '\n' && chars[a] !== '\r' && b < chars.length && chars[b] !== '\n' && chars[b] !== '\r';
    if (single) { out.push(eol + eol); count++; } else { out.push(c); if (width === 2) out.push('\n'); }
    i += width - 1;
  }
  return count ? { text: out.join(''), count } : null;
}

/**
 * Single line breaks inside `region` that linesToParagraphs would turn into blank lines.
 */
export function singleBreaks(text: string, region: Region | null = null): number {
  return linesToParagraphs(text, region)?.count ?? 0;
}
