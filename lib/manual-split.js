// Manual paragraph repair for pairs that need a manual split. Pure and
// browser-safe; all coordinates are Unicode scalar indices (Array.from).
import { WHITESPACE, paragraphRanges, sentenceRangesV2 } from './segmentation.js';
import { diffSplice } from './semantic-run.js';

const WS = new Set(WHITESPACE.map(c => String.fromCodePoint(c)));
const CJK = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|[　-〿＀-￯]/u;

function trimmed(chars, start, end) {
  let a = start; let b = end;
  while (a < b && WS.has(chars[a])) a++;
  while (b > a && WS.has(chars[b - 1])) b--;
  return [a, b];
}

/**
 * Paragraphs inside a region of the text, with their core and sentences, using
 * segmentation's blank-line and sentence rules.
 * @returns {{start: number, end: number, coreStart: number, coreEnd: number, length: number, sentences: {start: number, end: number}[]}[]}
 */
export function splitLayout(text, region) {
  const chars = Array.from(text);
  const base = Math.max(0, region.start);
  const slice = chars.slice(base, Math.min(chars.length, region.end));
  return paragraphRanges(slice).map(([a, b]) => {
    const [cs, ce] = trimmed(slice, a, b);
    const sentences = sentenceRangesV2(slice.slice(cs, ce)).map(([x, y]) => ({ start: base + cs + x, end: base + cs + y }));
    return { start: base + a, end: base + b, coreStart: base + cs, coreEnd: base + ce, length: ce - cs, sentences };
  });
}

/**
 * Insert a blank line at a scalar offset. Spaces and tabs next to the offset
 * are dropped; an existing line break there is reused. null when the offset is
 * invalid, nothing precedes or follows it, or a blank line is already there.
 * @returns {{text: string, splice: {start: number, oldEnd: number, newEnd: number}} | null}
 */
export function insertParagraphBreak(text, offset) {
  const chars = Array.from(text);
  if (!Number.isInteger(offset) || offset < 0 || offset > chars.length) return null;
  let runStart = offset; let runEnd = offset;
  while (runStart > 0 && WS.has(chars[runStart - 1])) runStart--;
  while (runEnd < chars.length && WS.has(chars[runEnd])) runEnd++;
  if (runStart === 0 || runEnd === chars.length) return null;
  const newlines = chars.slice(runStart, runEnd).filter(c => c === '\n').length;
  if (newlines >= 2) return null;
  let left = offset; let right = offset;
  while (left > 0 && (chars[left - 1] === ' ' || chars[left - 1] === '\t')) left--;
  while (right < chars.length && (chars[right] === ' ' || chars[right] === '\t')) right++;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const next = chars.slice(0, left).join('') + eol.repeat(2 - newlines) + chars.slice(right).join('');
  return { text: next, splice: diffSplice(text, next) };
}

/**
 * Replace the pure-whitespace gap [gapStart, gapEnd), which must contain a blank
 * line, with one space, or nothing next to CJK text.
 * @returns {{text: string, splice: {start: number, oldEnd: number, newEnd: number}} | null}
 */
export function mergeParagraphs(text, gapStart, gapEnd) {
  const chars = Array.from(text);
  if (!Number.isInteger(gapStart) || !Number.isInteger(gapEnd) || gapStart <= 0 || gapStart >= gapEnd || gapEnd >= chars.length) return null;
  const gap = chars.slice(gapStart, gapEnd);
  if (!gap.every(c => WS.has(c)) || gap.filter(c => c === '\n').length < 2) return null;
  const joiner = CJK.test(chars[gapStart - 1]) || CJK.test(chars[gapEnd]) ? '' : ' ';
  const next = chars.slice(0, gapStart).join('') + joiner + chars.slice(gapEnd).join('');
  return { text: next, splice: diffSplice(text, next) };
}

/** Counts for the manual-split hint of one pair. */
export function pairShape(source, target, pair) {
  const s = splitLayout(source, pair.source);
  const t = splitLayout(target, pair.target);
  const sentences = list => list.reduce((n, p) => n + p.sentences.length, 0);
  return {
    sourceParagraphs: s.length, targetParagraphs: t.length,
    sourceSentences: sentences(s), targetSentences: sentences(t),
    sourceLength: pair.source.core_end - pair.source.core_start,
    targetLength: pair.target.core_end - pair.target.core_start,
  };
}

/**
 * Every single line break between two non-blank lines inside `region` becomes a
 * blank line, so each line is its own paragraph. An explicit, user-triggered
 * formatting edit for texts that separate paragraphs by single line breaks; it
 * changes no words and pairs nothing by itself.
 * @param {string} text
 * @param {{start: number, end: number} | null} [region]
 * @returns {{text: string, count: number} | null} null when there is nothing to change
 */
export function linesToParagraphs(text, region = null) {
  const chars = Array.from(text);
  const from = region ? Math.max(0, region.start) : 0;
  const to = region ? Math.min(chars.length, region.end) : chars.length;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const out = [];
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
 * @param {string} text
 * @param {{start: number, end: number} | null} [region]
 */
export function singleBreaks(text, region = null) {
  return linesToParagraphs(text, region)?.count ?? 0;
}
