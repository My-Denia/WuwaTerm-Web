// Browser-safe port of Core's segmentation-v1 reference implementation
// (src/wuwaterm/segmentation.py). All offsets are Unicode scalar indices.

import type { Alignment, Pair, PairRegion, PairStatus, ScalarOffset, SegmentIndex } from './workbench-model.ts';
import { scalarOffset, segmentIndex } from './workbench-model.ts';

export type Segment = {
  start: ScalarOffset;
  end: ScalarOffset;
  core_start: ScalarOffset;
  core_end: ScalarOffset;
  hard_cut: boolean;
};

type RawPair = {
  status: PairStatus;
  hard: boolean;
  sStart: ScalarOffset;
  sEnd: ScalarOffset;
  tStart: ScalarOffset;
  tEnd: ScalarOffset;
};

export const SEGMENTATION_VERSION = 'segmentation-v1';
/**
 * Pairing label of a draft whose explicit alignments leave text outside every span (contracts/manuscript-v5/SPEC.md "Gap-tolerant
 * segment records"). segmentation-v1 makes such a draft one needs_manual_split pair; pairSegmentsWithGaps keeps every alignment
 * region and turns only the uncovered text into gap regions.
 */
export const GAP_SEGMENTATION_VERSION = 'segmentation-v1-gaps';
export const SEGMENT_LIMIT = 1800;
export const HARD_CUT_WINDOW = 200;
export const BOUNDARY_PUNCTUATION = '，、；：,;:';

// Exactly the scalars of the spec; not JS \s and not Python isspace().
const WS_CODES: number[] = [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680];
for (let c = 0x2000; c <= 0x200a; c++) WS_CODES.push(c);
WS_CODES.push(0x2028, 0x2029, 0x202f, 0x205f, 0x3000);
export const WHITESPACE: readonly number[] = Object.freeze(WS_CODES);

const WS = new Set(WS_CODES.map(c => String.fromCodePoint(c)));
const PUNCT = new Set(Array.from(BOUNDARY_PUNCTUATION));
const NATURAL = new Set([...WS, ...PUNCT]);
// Python str.isspace() = WS plus U+001C-U+001F and U+0085 (checked against 3.12).
const PY_SPACE_EXTRA = new Set(['\x1c', '\x1d', '\x1e', '\x1f', '\x85']);
const SENTENCE_END = new Set(Array.from('。．.！？!?\n'));

// Code points where Python str.isdigit() is true (Unicode 15.0 as shipped in Python 3.12).
const DIGIT_RANGES: [number, number][] = (
  '30-39,b2-b3,b9,660-669,6f0-6f9,7c0-7c9,966-96f,9e6-9ef,a66-a6f,ae6-aef,b66-b6f,be6-bef,c66-c6f,ce6-cef,' +
  'd66-d6f,de6-def,e50-e59,ed0-ed9,f20-f29,1040-1049,1090-1099,1369-1371,17e0-17e9,1810-1819,1946-194f,' +
  '19d0-19da,1a80-1a89,1a90-1a99,1b50-1b59,1bb0-1bb9,1c40-1c49,1c50-1c59,2070,2074-2079,2080-2089,2460-2468,' +
  '2474-247c,2488-2490,24ea,24f5-24fd,24ff,2776-277e,2780-2788,278a-2792,a620-a629,a8d0-a8d9,a900-a909,' +
  'a9d0-a9d9,a9f0-a9f9,aa50-aa59,abf0-abf9,ff10-ff19,104a0-104a9,10a40-10a43,10d30-10d39,10e60-10e68,' +
  '11052-1105a,11066-1106f,110f0-110f9,11136-1113f,111d0-111d9,112f0-112f9,11450-11459,114d0-114d9,' +
  '11650-11659,116c0-116c9,11730-11739,118e0-118e9,11950-11959,11c50-11c59,11d50-11d59,11da0-11da9,' +
  '11f50-11f59,16a60-16a69,16ac0-16ac9,16b50-16b59,1d7ce-1d7ff,1e140-1e149,1e2f0-1e2f9,1e4f0-1e4f9,' +
  '1e950-1e959,1f100-1f10a,1fbf0-1fbf9'
)
  .split(',')
  .map(part => {
    const [a, b] = part.split('-');
    return [parseInt(a, 16), parseInt(b ?? a, 16)];
  });

const STATUS_READY: PairStatus = 'ready';
const STATUS_MANUAL: PairStatus = 'needs_manual_split';
const STATUS_UNTRANSLATED: PairStatus = 'untranslated';
const STATUS_UNPAIRED_TARGET: PairStatus = 'unpaired_target';

const isDigit = (ch: string): boolean => {
  const c = ch.codePointAt(0);
  return c !== undefined && DIGIT_RANGES.some(([a, b]) => c >= a && c <= b);
};
const isPySpace = (ch: string): boolean => WS.has(ch) || PY_SPACE_EXTRA.has(ch);
const ceilDiv = (a: number, b: number): number => Math.floor((a + b - 1) / b);

// ---- review-v2 sentence ranges (review._sentence_ranges_v2) ----

function isSentenceEndV2(t: readonly string[], i: number): boolean {
  const ch = t[i];
  if (!SENTENCE_END.has(ch)) return false;
  if ((ch === '.' || ch === '．') && i > 0 && i + 1 < t.length && isDigit(t[i - 1]) && isDigit(t[i + 1])) {
    return false;
  }
  return true;
}

function separatorOnly(t: readonly string[], start: number, end: number): boolean {
  if (!(start < end)) return false;
  for (let i = start; i < end; i++) {
    if (!SENTENCE_END.has(t[i]) && !isPySpace(t[i])) return false;
  }
  return true;
}

export function sentenceRangesV2(t: readonly string[]): [ScalarOffset, ScalarOffset][] {
  const ranges: [ScalarOffset, ScalarOffset][] = [];
  const length = t.length;
  let start = 0;
  let index = 0;
  while (index < length) {
    if (isSentenceEndV2(t, index)) {
      let end = index + 1;
      while (end < length && isSentenceEndV2(t, end)) end++;
      if (start < end && !separatorOnly(t, start, end)) ranges.push([scalarOffset(start), scalarOffset(end)]);
      start = end;
      index = end;
      continue;
    }
    index++;
  }
  if (start < length && !separatorOnly(t, start, length)) ranges.push([scalarOffset(start), scalarOffset(length)]);
  if (!ranges.length && length && !separatorOnly(t, 0, length)) ranges.push([scalarOffset(0), scalarOffset(length)]);
  return ranges;
}

// ---- building blocks ----

export function core(t: readonly string[], start: number, end: number): [ScalarOffset, ScalarOffset] {
  let a = start;
  while (a < end && WS.has(t[a])) a++;
  if (a === end) return [scalarOffset(start), scalarOffset(start)];
  let b = end;
  while (WS.has(t[b - 1])) b--;
  return [scalarOffset(a), scalarOffset(b)];
}

function coreLen(t: readonly string[], start: number, end: number): number {
  const [a, b] = core(t, start, end);
  return b - a;
}

function pairsOf(bounds: readonly number[]): [ScalarOffset, ScalarOffset][] {
  const out: [ScalarOffset, ScalarOffset][] = [];
  for (let i = 0; i + 1 < bounds.length; i++) out.push([scalarOffset(bounds[i]), scalarOffset(bounds[i + 1])]);
  return out;
}

export function paragraphRanges(t: readonly string[]): [ScalarOffset, ScalarOffset][] {
  const length = t.length;
  const cuts: number[] = [];
  let i = 0;
  while (i < length) {
    if (!WS.has(t[i])) {
      i++;
      continue;
    }
    let j = i;
    let newlines = 0;
    while (j < length && WS.has(t[j])) {
      if (t[j] === '\n') newlines++;
      j++;
    }
    if (newlines >= 2 && i > 0 && j < length) cuts.push(j);
    i = j;
  }
  const [cs, ce] = core(t, 0, length);
  if (cs === ce) return [];
  return pairsOf([0, ...cuts, length]);
}

function sentencePieces(t: readonly string[], start: number, end: number): [ScalarOffset, ScalarOffset][] {
  const [cs, ce] = core(t, start, end);
  if (cs === ce) return [[scalarOffset(start), scalarOffset(end)]];
  const cuts: number[] = [];
  for (const [rangeStart] of sentenceRangesV2(t.slice(cs, ce)).slice(1)) {
    let p = cs + rangeStart;
    while (p < ce && WS.has(t[p])) p++;
    if (p < ce && p > (cuts.length ? cuts[cuts.length - 1] : cs)) cuts.push(p);
  }
  return pairsOf([start, ...cuts, end]);
}

function hardCutPoint(t: readonly string[], pos: number, limit: number): number {
  const hi = pos + limit;
  const lo = Math.max(pos + limit - HARD_CUT_WINDOW, pos + 1);
  for (const chars of [WS, PUNCT]) {
    for (let p = hi; p >= lo; p--) {
      if (chars.has(t[p - 1])) return p;
    }
  }
  return hi;
}

function hardCut(t: readonly string[], start: number, end: number, limit: number): [ScalarOffset, ScalarOffset][] {
  const [s, e] = core(t, start, end);
  const cuts: number[] = [];
  let pos: number = s;
  while (e - pos > limit) {
    pos = hardCutPoint(t, pos, limit);
    cuts.push(pos);
  }
  const pieces: [ScalarOffset, ScalarOffset][] = [];
  for (const [a, b] of pairsOf([start, ...cuts, end])) {
    if (pieces.length && coreLen(t, a, b) === 0) {
      pieces[pieces.length - 1] = [pieces[pieces.length - 1][0], b];
    } else {
      pieces.push([a, b]);
    }
  }
  return pieces;
}

function checkPartition(regions: readonly [number, number][], length: number, name: string): void {
  let pos = 0;
  for (const [start, end] of regions) {
    if (start !== pos || end < start) throw new Error(`${name} regions do not partition the text`);
    pos = end;
  }
  if (pos !== length) throw new Error(`${name} regions do not cover the text`);
}

const makeSegment = (
  start: ScalarOffset,
  end: ScalarOffset,
  coreStart: ScalarOffset,
  coreEnd: ScalarOffset,
  hard: boolean,
): Segment => ({
  start,
  end,
  core_start: coreStart,
  core_end: coreEnd,
  hard_cut: hard,
});

// ---- single side ----

export function segmentText(text: string, limit: number = SEGMENT_LIMIT): Segment[] {
  const t = Array.from(text);
  const length = t.length;
  if (length === 0) return [];
  const paragraphs = paragraphRanges(t);
  if (!paragraphs.length) return [makeSegment(scalarOffset(0), scalarOffset(length), scalarOffset(0), scalarOffset(0), false)];

  const units: [ScalarOffset, ScalarOffset, boolean][] = [];
  for (const [pStart, pEnd] of paragraphs) {
    if (coreLen(t, pStart, pEnd) <= limit) {
      units.push([pStart, pEnd, false]);
      continue;
    }
    for (const [sStart, sEnd] of sentencePieces(t, pStart, pEnd)) {
      if (coreLen(t, sStart, sEnd) <= limit) {
        units.push([sStart, sEnd, false]);
      } else {
        for (const [hStart, hEnd] of hardCut(t, sStart, sEnd, limit)) units.push([hStart, hEnd, true]);
      }
    }
  }

  const segments: Segment[] = [];
  let cur: Segment | null = null;
  for (const [start, end, hard] of units) {
    const [cs, ce] = core(t, start, end);
    const nxt = makeSegment(start, end, cs, ce, hard);
    if (cur === null) {
      cur = nxt;
    } else if (!cur.hard_cut && !nxt.hard_cut && nxt.core_end - cur.core_start <= limit) {
      cur = makeSegment(cur.start, nxt.end, cur.core_start, nxt.core_end, false);
    } else {
      segments.push(cur);
      cur = nxt;
    }
  }
  if (cur !== null) segments.push(cur);
  checkPartition(segments.map(s => [s.start, s.end]), length, 'segment');
  return segments;
}

// ---- bilingual pairing ----

const isMapping = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasExactKeys = (v: Record<string, unknown>, keys: readonly string[]): boolean => {
  const k = Object.keys(v);
  return k.length === keys.length && keys.every(x => k.includes(x));
};

function coerceSpan(name: string, item: unknown, t: readonly string[]): [ScalarOffset, ScalarOffset] {
  if (!isMapping(item) || !hasExactKeys(item, ['start', 'end', 'text'])) {
    throw new Error(`${name} span is not valid`);
  }
  const { start, end } = item;
  if (typeof start !== 'number' || typeof end !== 'number' || !Number.isInteger(start) || !Number.isInteger(end)) {
    throw new Error(`${name} offsets must be integers`);
  }
  if (start < 0 || start >= end || end > t.length) throw new Error(`${name} span is out of bounds`);
  if (typeof item.text !== 'string' || t.slice(start, end).join('') !== item.text) {
    throw new Error(`${name} span text does not match the text`);
  }
  return [scalarOffset(start), scalarOffset(end)];
}

function hasNonWs(t: readonly string[], start: number, end: number): boolean {
  for (let i = start; i < end; i++) if (!WS.has(t[i])) return true;
  return false;
}

type Bounds4 = [ScalarOffset, ScalarOffset, ScalarOffset, ScalarOffset];

function alignmentRegionPairs(s: readonly string[], t: readonly string[], alignments: readonly unknown[]): Bounds4[] | null {
  const srcSpans: [ScalarOffset, ScalarOffset][] = [];
  const tgtSpans: ([ScalarOffset, ScalarOffset] | null)[] = [];
  let prevS = 0;
  let prevT = 0;
  for (const item of alignments) {
    if (!isMapping(item) || !hasExactKeys(item, ['source', 'target'])) throw new Error('alignment keys are not valid');
    const sSpan = coerceSpan('source', item.source, s);
    const tSpan = item.target === null ? null : coerceSpan('target', item.target, t);
    if (sSpan[0] < prevS) throw new Error('source spans are out of order or overlap');
    prevS = sSpan[1];
    if (tSpan !== null) {
      if (tSpan[0] < prevT) throw new Error('target spans are out of order or overlap');
      prevT = tSpan[1];
    }
    srcSpans.push(sSpan);
    tgtSpans.push(tSpan);
  }

  let pos = 0;
  for (const [start, end] of srcSpans) {
    if (hasNonWs(s, pos, start)) return null;
    pos = end;
  }
  if (hasNonWs(s, pos, s.length)) return null;
  pos = 0;
  for (const tSpan of tgtSpans) {
    if (tSpan === null) continue;
    if (hasNonWs(t, pos, tSpan[0])) return null;
    pos = tSpan[1];
  }
  if (hasNonWs(t, pos, t.length)) return null;

  const n = alignments.length;
  const sBounds: number[] = [0];
  for (let i = 1; i < n; i++) sBounds.push(srcSpans[i][0]);
  sBounds.push(s.length);
  const tBounds: number[] = new Array<number>(n + 1).fill(0);
  tBounds[n] = t.length;
  for (let i = n - 1; i > 0; i--) {
    const tSpan = tgtSpans[i];
    tBounds[i] = tSpan !== null ? tSpan[0] : tBounds[i + 1];
  }
  return Array.from({ length: n }, (_, i): Bounds4 => [
    scalarOffset(sBounds[i]),
    scalarOffset(sBounds[i + 1]),
    scalarOffset(tBounds[i]),
    scalarOffset(tBounds[i + 1]),
  ]);
}

function dropEmptyPairs(s: readonly string[], t: readonly string[], regions: readonly Bounds4[]): Bounds4[] {
  const kept = regions.filter(r => coreLen(s, r[0], r[1]) || coreLen(t, r[2], r[3]));
  return kept.map((r, k): Bounds4 => {
    const sStart = k === 0 ? scalarOffset(0) : r[0];
    const tStart = k === 0 ? scalarOffset(0) : r[2];
    const last = k + 1 >= kept.length;
    return [sStart, last ? scalarOffset(s.length) : kept[k + 1][0], tStart, last ? scalarOffset(t.length) : kept[k + 1][2]];
  });
}

function fallbackCuts(t: readonly string[], a: number, b: number, k: number): ScalarOffset[] | null {
  const cuts: ScalarOffset[] = [];
  let prev = a;
  const n = b - a;
  for (let i = 1; i < k; i++) {
    const ti = a + Math.floor((i * n) / k);
    let found: number | null = null;
    for (let d = 0; d <= HARD_CUT_WINDOW && found === null; d++) {
      for (const p of [ti - d, ti + d]) {
        if (a < p && p < b && p > prev && NATURAL.has(t[p - 1])) {
          found = p;
          break;
        }
      }
    }
    if (found === null) return null;
    cuts.push(scalarOffset(found));
    prev = found;
  }
  return cuts;
}

const makePair = (
  status: PairStatus,
  hard: boolean,
  sStart: ScalarOffset,
  sEnd: ScalarOffset,
  tStart: ScalarOffset,
  tEnd: ScalarOffset,
): RawPair => ({ status, hard, sStart, sEnd, tStart, tEnd });

function fallbackPairs(
  s: readonly string[],
  t: readonly string[],
  sRange: [ScalarOffset, ScalarOffset],
  tRange: [ScalarOffset, ScalarOffset],
  limit: number,
): RawPair[] {
  const [sA, sB] = core(s, sRange[0], sRange[1]);
  const [tA, tB] = core(t, tRange[0], tRange[1]);
  const k = Math.max(ceilDiv(sB - sA, limit), ceilDiv(tB - tA, limit));
  const manual: RawPair[] = [makePair(STATUS_MANUAL, false, sRange[0], sRange[1], tRange[0], tRange[1])];
  const sCuts = fallbackCuts(s, sA, sB, k);
  const tCuts = fallbackCuts(t, tA, tB, k);
  if (sCuts === null || tCuts === null) return manual;
  const sBounds: ScalarOffset[] = [sRange[0], ...sCuts, sRange[1]];
  const tBounds: ScalarOffset[] = [tRange[0], ...tCuts, tRange[1]];
  const pairs: RawPair[] = [];
  for (let i = 0; i < k; i++) {
    const sLen = coreLen(s, sBounds[i], sBounds[i + 1]);
    const tLen = coreLen(t, tBounds[i], tBounds[i + 1]);
    if (!(sLen > 0 && sLen <= limit && tLen > 0 && tLen <= limit)) return manual;
    pairs.push(makePair(STATUS_READY, true, sBounds[i], sBounds[i + 1], tBounds[i], tBounds[i + 1]));
  }
  return pairs;
}

function classifyRegionPair(
  s: readonly string[],
  t: readonly string[],
  r: Bounds4,
  limit: number,
  aligned: boolean,
): RawPair[] {
  const [sStart, sEnd, tStart, tEnd] = r;
  const sLen = coreLen(s, sStart, sEnd);
  const tLen = coreLen(t, tStart, tEnd);
  if (sLen && !tLen) return [makePair(STATUS_UNTRANSLATED, false, sStart, sEnd, tStart, tEnd)];
  if (tLen && !sLen) return [makePair(STATUS_UNPAIRED_TARGET, false, sStart, sEnd, tStart, tEnd)];
  if (sLen <= limit && tLen <= limit) return [makePair(STATUS_READY, false, sStart, sEnd, tStart, tEnd)];
  if (!aligned) return [makePair(STATUS_MANUAL, false, sStart, sEnd, tStart, tEnd)];
  const sSents = sentencePieces(s, sStart, sEnd);
  const tSents = sentencePieces(t, tStart, tEnd);
  if (sSents.length !== tSents.length) return [makePair(STATUS_MANUAL, false, sStart, sEnd, tStart, tEnd)];
  const pairs: RawPair[] = [];
  sSents.forEach((sp, i) => {
    const tp = tSents[i];
    if (coreLen(s, sp[0], sp[1]) <= limit && coreLen(t, tp[0], tp[1]) <= limit) {
      pairs.push(makePair(STATUS_READY, false, sp[0], sp[1], tp[0], tp[1]));
    } else {
      pairs.push(...fallbackPairs(s, t, sp, tp, limit));
    }
  });
  return pairs;
}

function validatePairs(s: readonly string[], t: readonly string[], pairs: readonly Pair[], limit: number): void {
  for (const pair of pairs) {
    if (pair.status !== STATUS_READY) continue;
    for (const r of [pair.source, pair.target]) {
      const len = r.core_end - r.core_start;
      if (!(len > 0 && len <= limit)) throw new Error('ready pair core is empty or over the limit');
    }
  }
  checkPartition(pairs.map(p => [p.source.start, p.source.end]), s.length, 'source');
  checkPartition(pairs.map(p => [p.target.start, p.target.end]), t.length, 'target');
}

const region = (start: ScalarOffset, end: ScalarOffset, [coreStart, coreEnd]: [ScalarOffset, ScalarOffset]): PairRegion => ({
  start,
  end,
  core_start: coreStart,
  core_end: coreEnd,
});

export function pairSegments(
  source: string,
  target: string,
  limit: number = SEGMENT_LIMIT,
  alignments: readonly Alignment[] | null | undefined = null,
): Pair[] {
  if (alignments !== null && alignments !== undefined && !Array.isArray(alignments)) {
    throw new Error('alignments must be an array');
  }
  const s = Array.from(source);
  const t = Array.from(target);
  if (!hasNonWs(s, 0, s.length) && !hasNonWs(t, 0, t.length)) {
    if (alignments && alignments.length) alignmentRegionPairs(s, t, alignments);
    return [];
  }

  let pairs: RawPair[] = [];
  const whole: Bounds4 = [scalarOffset(0), scalarOffset(s.length), scalarOffset(0), scalarOffset(t.length)];
  if (alignments && alignments.length) {
    const regions = alignmentRegionPairs(s, t, alignments);
    if (regions === null) {
      pairs = [makePair(STATUS_MANUAL, false, whole[0], whole[1], whole[2], whole[3])];
    } else {
      for (const r of dropEmptyPairs(s, t, regions)) pairs.push(...classifyRegionPair(s, t, r, limit, true));
    }
  } else {
    const sParas = paragraphRanges(s);
    const tParas = paragraphRanges(t);
    if (sParas.length === tParas.length && sParas.length) {
      sParas.forEach(([a, b], i) => {
        pairs.push(...classifyRegionPair(s, t, [a, b, tParas[i][0], tParas[i][1]], limit, true));
      });
    } else {
      pairs = classifyRegionPair(s, t, whole, limit, false);
    }
  }

  return finishPairs(s, t, pairs, limit);
}

// The common tail of both pairings: adjacent small ready pairs merge, indexes are assigned, and the partition is checked.
function finishPairs(s: readonly string[], t: readonly string[], pairs: readonly RawPair[], limit: number): Pair[] {
  const merged: RawPair[] = [];
  for (const pair of pairs) {
    const prev: RawPair | null = merged.length ? merged[merged.length - 1] : null;
    if (prev && prev.status === STATUS_READY && pair.status === STATUS_READY && !prev.hard && !pair.hard) {
      const sA = core(s, prev.sStart, prev.sEnd)[0];
      const sB = core(s, pair.sStart, pair.sEnd)[1];
      const tA = core(t, prev.tStart, prev.tEnd)[0];
      const tB = core(t, pair.tStart, pair.tEnd)[1];
      if (sB - sA <= limit && tB - tA <= limit) {
        merged[merged.length - 1] = makePair(STATUS_READY, false, prev.sStart, pair.sEnd, prev.tStart, pair.tEnd);
        continue;
      }
    }
    merged.push(pair);
  }

  const result: Pair[] = merged.map((p, index): Pair => ({
    index: segmentIndex(index) as SegmentIndex,
    status: p.status,
    hard_cut: p.hard,
    source: region(p.sStart, p.sEnd, core(s, p.sStart, p.sEnd)),
    target: region(p.tStart, p.tEnd, core(t, p.tStart, p.tEnd)),
  }));
  validatePairs(s, t, result, limit);
  return result;
}

// ---- gap-tolerant pairing (contracts/manuscript-v5/SPEC.md) ----

type Extent = [ScalarOffset, ScalarOffset] | null;
type GapItem = { kind: 'aligned' | 'gap'; s: Extent; t: Extent };

function alignmentSpans(s: readonly string[], t: readonly string[], alignments: readonly unknown[]): { src: [ScalarOffset, ScalarOffset][]; tgt: Extent[] } {
  const src: [ScalarOffset, ScalarOffset][] = [];
  const tgt: Extent[] = [];
  let prevS = 0;
  let prevT = 0;
  for (const item of alignments) {
    if (!isMapping(item) || !hasExactKeys(item, ['source', 'target'])) throw new Error('alignment keys are not valid');
    const sSpan = coerceSpan('source', item.source, s);
    const tSpan = item.target === null ? null : coerceSpan('target', item.target, t);
    if (sSpan[0] < prevS) throw new Error('source spans are out of order or overlap');
    prevS = sSpan[1];
    if (tSpan !== null) {
      if (tSpan[0] < prevT) throw new Error('target spans are out of order or overlap');
      prevT = tSpan[1];
    }
    src.push(sSpan);
    tgt.push(tSpan);
  }
  return { src, tgt };
}

/** Explicit alignments that leave a non-WS scalar outside every span on either side (segmentation-v1 rule 1.i's whole-document case). */
export function alignmentsLeaveGaps(source: string, target: string, alignments: readonly Alignment[] | null | undefined): boolean {
  if (!alignments || !alignments.length) return false;
  const s = Array.from(source);
  const t = Array.from(target);
  if (!hasNonWs(s, 0, s.length) && !hasNonWs(t, 0, t.length)) return false;
  return alignmentRegionPairs(s, t, alignments) === null;
}

const gapExtent = (t: readonly string[], a: number, b: number): Extent => (hasNonWs(t, a, b) ? core(t, a, b) : null);

/**
 * The items of a gapped alignment list, in text order. Between two alignments that have a target (anchors), the source gaps of
 * the slots in between and the one target gap there become:
 * - with no target gap, one source-only gap item per source gap (untranslated), the null-target alignments unchanged;
 * - with a target gap and exactly one source gap and no null-target alignment in between, one gap item holding both;
 * - with a target gap and no source gap and no null-target alignment in between, one target-only gap item (unpaired target);
 * - otherwise one gap item over everything between the two anchors, null-target alignments included: their pairing is unknown.
 */
function gapItems(s: readonly string[], t: readonly string[], src: readonly [ScalarOffset, ScalarOffset][], tgt: readonly Extent[]): GapItem[] {
  const n = src.length;
  const items: GapItem[] = [];
  const sourceGap = (k: number): Extent => gapExtent(s, k > 0 ? src[k - 1][1] : 0, k < n ? src[k][0] : s.length);
  const anchors = tgt.flatMap((span, i) => (span === null ? [] : [i]));
  let prev = -1;
  for (const b of [...anchors, n]) {
    const tFrom = prev >= 0 ? (tgt[prev] as [ScalarOffset, ScalarOffset])[1] : 0;
    const tTo = b < n ? (tgt[b] as [ScalarOffset, ScalarOffset])[0] : t.length;
    const tGap = gapExtent(t, tFrom, tTo);
    const slots: number[] = [];
    for (let k = prev + 1; k <= b; k++) slots.push(k);
    const sourceGaps = slots.filter(k => sourceGap(k) !== null);
    const nullTargets = b - prev - 1;
    if (tGap === null) {
      for (const k of slots) {
        const gap = sourceGap(k);
        if (gap) items.push({ kind: 'gap', s: gap, t: null });
        if (k < b) items.push({ kind: 'aligned', s: src[k], t: null });
      }
    } else if (nullTargets === 0 && sourceGaps.length <= 1) {
      items.push({ kind: 'gap', s: sourceGaps.length ? sourceGap(sourceGaps[0]) : null, t: tGap });
    } else {
      items.push({ kind: 'gap', s: gapExtent(s, prev >= 0 ? src[prev][1] : 0, b < n ? src[b][0] : s.length), t: tGap });
    }
    if (b < n) items.push({ kind: 'aligned', s: src[b], t: tgt[b] });
    prev = b;
  }
  return items;
}

/**
 * Pairs of a draft under its pairing label. Without explicit alignments, or when they cover the text, this is pairSegments
 * (segmentation-v1). When they leave text outside every span, every alignment keeps its own region and only the uncovered text
 * becomes gap regions (GAP_SEGMENTATION_VERSION): a gap with text on both sides needs a manual split, a source-only gap is
 * untranslated and a target-only gap is an unpaired target. A gap is never ready: its pairing is a guess.
 */
export function pairSegmentsWithGaps(
  source: string,
  target: string,
  limit: number = SEGMENT_LIMIT,
  alignments: readonly Alignment[] | null | undefined = null,
): { pairs: Pair[]; version: typeof SEGMENTATION_VERSION | typeof GAP_SEGMENTATION_VERSION } {
  if (!alignmentsLeaveGaps(source, target, alignments)) {
    return { pairs: pairSegments(source, target, limit, alignments), version: SEGMENTATION_VERSION };
  }
  const s = Array.from(source);
  const t = Array.from(target);
  const { src, tgt } = alignmentSpans(s, t, alignments as readonly Alignment[]);
  const items = gapItems(s, t, src, tgt);
  const m = items.length;
  const bounds = (side: 's' | 't', length: number): number[] => {
    const out = new Array<number>(m + 1).fill(0);
    out[m] = length;
    for (let i = m - 1; i > 0; i--) {
      const extent = items[i][side];
      out[i] = extent !== null ? extent[0] : out[i + 1];
    }
    return out;
  };
  const sB = bounds('s', s.length);
  const tB = bounds('t', t.length);
  // As segmentation-v1: a region whose two cores are empty (an all-WS alignment span) joins the region before it, or after it when first.
  const regions = items
    .map((item, i) => ({ kind: item.kind, r: [sB[i], sB[i + 1], tB[i], tB[i + 1]].map(scalarOffset) as Bounds4 }))
    .filter(({ r }) => coreLen(s, r[0], r[1]) || coreLen(t, r[2], r[3]))
    .map((entry, k, kept) => {
      const last = k + 1 >= kept.length;
      return {
        kind: entry.kind,
        r: [k === 0 ? scalarOffset(0) : entry.r[0], last ? scalarOffset(s.length) : kept[k + 1].r[0],
          k === 0 ? scalarOffset(0) : entry.r[2], last ? scalarOffset(t.length) : kept[k + 1].r[2]] as Bounds4,
      };
    });
  const pairs: RawPair[] = [];
  for (const { kind, r } of regions) {
    if (kind === 'aligned') {
      pairs.push(...classifyRegionPair(s, t, r, limit, true));
      continue;
    }
    const sLen = coreLen(s, r[0], r[1]);
    const tLen = coreLen(t, r[2], r[3]);
    pairs.push(makePair(sLen && tLen ? STATUS_MANUAL : sLen ? STATUS_UNTRANSLATED : STATUS_UNPAIRED_TARGET, false, r[0], r[1], r[2], r[3]));
  }
  return { pairs: finishPairs(s, t, pairs, limit), version: GAP_SEGMENTATION_VERSION };
}

// Never let an oversized or empty-core request go out: a ready pair that
// violates the limit is downgraded to needs_manual_split.
export function guardPairForRequest(pair: Pair, limit: number = SEGMENT_LIMIT): Pair {
  if (pair.status !== STATUS_READY) return pair;
  const ok = (side: PairRegion): boolean => {
    const len = side.core_end - side.core_start;
    return len > 0 && len <= limit;
  };
  return ok(pair.source) && ok(pair.target) ? pair : { ...pair, status: STATUS_MANUAL };
}
