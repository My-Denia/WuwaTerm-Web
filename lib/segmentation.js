// Browser-safe port of Core's segmentation-v1 reference implementation
// (src/wuwaterm/segmentation.py). All offsets are Unicode scalar indices.

export const SEGMENTATION_VERSION = 'segmentation-v1';
export const SEGMENT_LIMIT = 1800;
export const HARD_CUT_WINDOW = 200;
export const BOUNDARY_PUNCTUATION = '，、；：,;:';

// Exactly the scalars of the spec; not JS \s and not Python isspace().
const WS_CODES = [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680];
for (let c = 0x2000; c <= 0x200a; c++) WS_CODES.push(c);
WS_CODES.push(0x2028, 0x2029, 0x202f, 0x205f, 0x3000);
export const WHITESPACE = Object.freeze(WS_CODES);

const WS = new Set(WS_CODES.map(c => String.fromCodePoint(c)));
const PUNCT = new Set(Array.from(BOUNDARY_PUNCTUATION));
const NATURAL = new Set([...WS, ...PUNCT]);
// Python str.isspace() = WS plus U+001C-U+001F and U+0085 (checked against 3.12).
const PY_SPACE_EXTRA = new Set(['\x1c', '\x1d', '\x1e', '\x1f', '\x85']);
const SENTENCE_END = new Set(Array.from('。．.！？!?\n'));

// Code points where Python str.isdigit() is true (Unicode 15.0 as shipped in Python 3.12).
const DIGIT_RANGES = (
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

const STATUS_READY = 'ready';
const STATUS_MANUAL = 'needs_manual_split';
const STATUS_UNTRANSLATED = 'untranslated';
const STATUS_UNPAIRED_TARGET = 'unpaired_target';

const isDigit = ch => {
  const c = ch.codePointAt(0);
  return DIGIT_RANGES.some(([a, b]) => c >= a && c <= b);
};
const isPySpace = ch => WS.has(ch) || PY_SPACE_EXTRA.has(ch);
const ceilDiv = (a, b) => Math.floor((a + b - 1) / b);

// ---- review-v2 sentence ranges (review._sentence_ranges_v2) ----

function isSentenceEndV2(t, i) {
  const ch = t[i];
  if (!SENTENCE_END.has(ch)) return false;
  if ((ch === '.' || ch === '．') && i > 0 && i + 1 < t.length && isDigit(t[i - 1]) && isDigit(t[i + 1])) {
    return false;
  }
  return true;
}

function separatorOnly(t, start, end) {
  if (!(start < end)) return false;
  for (let i = start; i < end; i++) {
    if (!SENTENCE_END.has(t[i]) && !isPySpace(t[i])) return false;
  }
  return true;
}

function sentenceRangesV2(t) {
  const ranges = [];
  const length = t.length;
  let start = 0;
  let index = 0;
  while (index < length) {
    if (isSentenceEndV2(t, index)) {
      let end = index + 1;
      while (end < length && isSentenceEndV2(t, end)) end++;
      if (start < end && !separatorOnly(t, start, end)) ranges.push([start, end]);
      start = end;
      index = end;
      continue;
    }
    index++;
  }
  if (start < length && !separatorOnly(t, start, length)) ranges.push([start, length]);
  if (!ranges.length && length && !separatorOnly(t, 0, length)) ranges.push([0, length]);
  return ranges;
}

// ---- building blocks ----

function core(t, start, end) {
  let a = start;
  while (a < end && WS.has(t[a])) a++;
  if (a === end) return [start, start];
  let b = end;
  while (WS.has(t[b - 1])) b--;
  return [a, b];
}

function coreLen(t, start, end) {
  const [a, b] = core(t, start, end);
  return b - a;
}

function pairsOf(bounds) {
  const out = [];
  for (let i = 0; i + 1 < bounds.length; i++) out.push([bounds[i], bounds[i + 1]]);
  return out;
}

function paragraphRanges(t) {
  const length = t.length;
  const cuts = [];
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

function sentencePieces(t, start, end) {
  const [cs, ce] = core(t, start, end);
  if (cs === ce) return [[start, end]];
  const cuts = [];
  for (const [rangeStart] of sentenceRangesV2(t.slice(cs, ce)).slice(1)) {
    let p = cs + rangeStart;
    while (p < ce && WS.has(t[p])) p++;
    if (p < ce && p > (cuts.length ? cuts[cuts.length - 1] : cs)) cuts.push(p);
  }
  return pairsOf([start, ...cuts, end]);
}

function hardCutPoint(t, pos, limit) {
  const hi = pos + limit;
  const lo = Math.max(pos + limit - HARD_CUT_WINDOW, pos + 1);
  for (const chars of [WS, PUNCT]) {
    for (let p = hi; p >= lo; p--) {
      if (chars.has(t[p - 1])) return p;
    }
  }
  return hi;
}

function hardCut(t, start, end, limit) {
  const [s, e] = core(t, start, end);
  const cuts = [];
  let pos = s;
  while (e - pos > limit) {
    pos = hardCutPoint(t, pos, limit);
    cuts.push(pos);
  }
  const pieces = [];
  for (const [a, b] of pairsOf([start, ...cuts, end])) {
    if (pieces.length && coreLen(t, a, b) === 0) {
      pieces[pieces.length - 1] = [pieces[pieces.length - 1][0], b];
    } else {
      pieces.push([a, b]);
    }
  }
  return pieces;
}

function checkPartition(regions, length, name) {
  let pos = 0;
  for (const [start, end] of regions) {
    if (start !== pos || end < start) throw new Error(`${name} regions do not partition the text`);
    pos = end;
  }
  if (pos !== length) throw new Error(`${name} regions do not cover the text`);
}

const makeSegment = (start, end, coreStart, coreEnd, hard) => ({
  start,
  end,
  core_start: coreStart,
  core_end: coreEnd,
  hard_cut: hard,
});

// ---- single side ----

export function segmentText(text, limit = SEGMENT_LIMIT) {
  const t = Array.from(text);
  const length = t.length;
  if (length === 0) return [];
  const paragraphs = paragraphRanges(t);
  if (!paragraphs.length) return [makeSegment(0, length, 0, 0, false)];

  const units = [];
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

  const segments = [];
  let cur = null;
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

const isMapping = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasExactKeys = (v, keys) => {
  const k = Object.keys(v);
  return k.length === keys.length && keys.every(x => k.includes(x));
};

function coerceSpan(name, item, t) {
  if (!isMapping(item) || !hasExactKeys(item, ['start', 'end', 'text'])) {
    throw new Error(`${name} span is not valid`);
  }
  const { start, end } = item;
  if (!Number.isInteger(start) || !Number.isInteger(end)) throw new Error(`${name} offsets must be integers`);
  if (start < 0 || start >= end || end > t.length) throw new Error(`${name} span is out of bounds`);
  if (typeof item.text !== 'string' || t.slice(start, end).join('') !== item.text) {
    throw new Error(`${name} span text does not match the text`);
  }
  return [start, end];
}

function hasNonWs(t, start, end) {
  for (let i = start; i < end; i++) if (!WS.has(t[i])) return true;
  return false;
}

function alignmentRegionPairs(s, t, alignments) {
  const srcSpans = [];
  const tgtSpans = [];
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
  const sBounds = [0];
  for (let i = 1; i < n; i++) sBounds.push(srcSpans[i][0]);
  sBounds.push(s.length);
  const tBounds = new Array(n + 1).fill(0);
  tBounds[n] = t.length;
  for (let i = n - 1; i > 0; i--) tBounds[i] = tgtSpans[i] !== null ? tgtSpans[i][0] : tBounds[i + 1];
  return Array.from({ length: n }, (_, i) => [sBounds[i], sBounds[i + 1], tBounds[i], tBounds[i + 1]]);
}

function dropEmptyPairs(s, t, regions) {
  const kept = regions.filter(r => coreLen(s, r[0], r[1]) || coreLen(t, r[2], r[3]));
  return kept.map((r, k) => {
    const sStart = k === 0 ? 0 : r[0];
    const tStart = k === 0 ? 0 : r[2];
    const last = k + 1 >= kept.length;
    return [sStart, last ? s.length : kept[k + 1][0], tStart, last ? t.length : kept[k + 1][2]];
  });
}

function fallbackCuts(t, a, b, k) {
  const cuts = [];
  let prev = a;
  const n = b - a;
  for (let i = 1; i < k; i++) {
    const ti = a + Math.floor((i * n) / k);
    let found = null;
    for (let d = 0; d <= HARD_CUT_WINDOW && found === null; d++) {
      for (const p of [ti - d, ti + d]) {
        if (a < p && p < b && p > prev && NATURAL.has(t[p - 1])) {
          found = p;
          break;
        }
      }
    }
    if (found === null) return null;
    cuts.push(found);
    prev = found;
  }
  return cuts;
}

const makePair = (status, hard, sStart, sEnd, tStart, tEnd) => ({ status, hard, sStart, sEnd, tStart, tEnd });

function fallbackPairs(s, t, sRange, tRange, limit) {
  const [sA, sB] = core(s, sRange[0], sRange[1]);
  const [tA, tB] = core(t, tRange[0], tRange[1]);
  const k = Math.max(ceilDiv(sB - sA, limit), ceilDiv(tB - tA, limit));
  const manual = [makePair(STATUS_MANUAL, false, ...sRange, ...tRange)];
  const sCuts = fallbackCuts(s, sA, sB, k);
  const tCuts = fallbackCuts(t, tA, tB, k);
  if (sCuts === null || tCuts === null) return manual;
  const sBounds = [sRange[0], ...sCuts, sRange[1]];
  const tBounds = [tRange[0], ...tCuts, tRange[1]];
  const pairs = [];
  for (let i = 0; i < k; i++) {
    const sLen = coreLen(s, sBounds[i], sBounds[i + 1]);
    const tLen = coreLen(t, tBounds[i], tBounds[i + 1]);
    if (!(sLen > 0 && sLen <= limit && tLen > 0 && tLen <= limit)) return manual;
    pairs.push(makePair(STATUS_READY, true, sBounds[i], sBounds[i + 1], tBounds[i], tBounds[i + 1]));
  }
  return pairs;
}

function classifyRegionPair(s, t, r, limit, aligned) {
  const [sStart, sEnd, tStart, tEnd] = r;
  const sLen = coreLen(s, sStart, sEnd);
  const tLen = coreLen(t, tStart, tEnd);
  if (sLen && !tLen) return [makePair(STATUS_UNTRANSLATED, false, ...r)];
  if (tLen && !sLen) return [makePair(STATUS_UNPAIRED_TARGET, false, ...r)];
  if (sLen <= limit && tLen <= limit) return [makePair(STATUS_READY, false, ...r)];
  if (!aligned) return [makePair(STATUS_MANUAL, false, ...r)];
  const sSents = sentencePieces(s, sStart, sEnd);
  const tSents = sentencePieces(t, tStart, tEnd);
  if (sSents.length !== tSents.length) return [makePair(STATUS_MANUAL, false, ...r)];
  const pairs = [];
  sSents.forEach((sp, i) => {
    const tp = tSents[i];
    if (coreLen(s, ...sp) <= limit && coreLen(t, ...tp) <= limit) {
      pairs.push(makePair(STATUS_READY, false, ...sp, ...tp));
    } else {
      pairs.push(...fallbackPairs(s, t, sp, tp, limit));
    }
  });
  return pairs;
}

function validatePairs(s, t, pairs, limit) {
  for (const pair of pairs) {
    if (pair.status !== STATUS_READY) continue;
    for (const region of [pair.source, pair.target]) {
      const len = region.core_end - region.core_start;
      if (!(len > 0 && len <= limit)) throw new Error('ready pair core is empty or over the limit');
    }
  }
  checkPartition(pairs.map(p => [p.source.start, p.source.end]), s.length, 'source');
  checkPartition(pairs.map(p => [p.target.start, p.target.end]), t.length, 'target');
}

const region = (start, end, [coreStart, coreEnd]) => ({ start, end, core_start: coreStart, core_end: coreEnd });

export function pairSegments(source, target, limit = SEGMENT_LIMIT, alignments = null) {
  if (alignments !== null && alignments !== undefined && !Array.isArray(alignments)) {
    throw new Error('alignments must be an array');
  }
  const s = Array.from(source);
  const t = Array.from(target);
  if (!hasNonWs(s, 0, s.length) && !hasNonWs(t, 0, t.length)) {
    if (alignments && alignments.length) alignmentRegionPairs(s, t, alignments);
    return [];
  }

  let pairs = [];
  const whole = [0, s.length, 0, t.length];
  if (alignments && alignments.length) {
    const regions = alignmentRegionPairs(s, t, alignments);
    if (regions === null) {
      pairs = [makePair(STATUS_MANUAL, false, ...whole)];
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

  const merged = [];
  for (const pair of pairs) {
    const prev = merged.length ? merged[merged.length - 1] : null;
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

  const result = merged.map((p, index) => ({
    index,
    status: p.status,
    hard_cut: p.hard,
    source: region(p.sStart, p.sEnd, core(s, p.sStart, p.sEnd)),
    target: region(p.tStart, p.tEnd, core(t, p.tStart, p.tEnd)),
  }));
  validatePairs(s, t, result, limit);
  return result;
}

// Never let an oversized or empty-core request go out: a ready pair that
// violates the limit is downgraded to needs_manual_split.
export function guardPairForRequest(pair, limit = SEGMENT_LIMIT) {
  if (pair.status !== STATUS_READY) return pair;
  const ok = side => {
    const len = side.core_end - side.core_start;
    return len > 0 && len <= limit;
  };
  return ok(pair.source) && ok(pair.target) ? pair : { ...pair, status: STATUS_MANUAL };
}
