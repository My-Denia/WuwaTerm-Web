// Long-manuscript term review runtime (contracts/manuscript-v3/SPEC.md, limits of contracts/manuscript-v4/SPEC.md): segment
// records, choices, choice history and progress; matching on import, re-check
// planning, realignment, edit reconciliation and the writer's v3/v4 parts. Also the
// per-term grouping of every segment's findings and the single-span edits the term
// view offers. Pure and browser-safe (no fetch, no React). Offsets are Unicode scalar
// indexes. The state is plain JSON data, so undo snapshots and structuredClone keep it.
import { REASON_VALUES, mentionId } from './manuscript.js';
import { scalarToUtf16 } from './review-report.js';
import { diffSplice, mapRegion, shiftSpan } from './semantic-run.js';
import { SEGMENT_LIMIT, SEGMENTATION_VERSION, guardPairForRequest, pairSegments } from './segmentation.ts';
import { sha256Hex } from './sha256.js';
import type {
  Alignment, Basis, ChoiceKind, ChoiceView, Direction, Draft, DraftEditSplices, Pair,
  ReasonValue, RecordStatus, RecordView, Report, Resolution, ScalarOffset, SegmentIndex,
  SegmentInput, SegmentRange, SessionBasis, Span, Verdict,
} from './workbench-model.ts';
import { scalarOffset, segmentIndex } from './workbench-model.ts';

export type { Basis, Direction, DraftEditSplices } from './workbench-model.ts';

export type Candidate = {
  candidate_id: string;
  zh: string;
  en: string;
  category: string;
};

export type CompactFinding = {
  verdict: Verdict;
  source: [ScalarOffset, ScalarOffset];
  target: [ScalarOffset, ScalarOffset] | null;
  candidates: Candidate[];
  candidates_truncated: boolean;
  /** `reason` (one of REASON_VALUES) only on `not_evaluated`, and last: such a result is a v4 segment record. */
  reason?: ReasonValue;
};

export type CompactResult = {
  truncated: boolean;
  evaluated: number;
  not_evaluated: number;
  findings: CompactFinding[];
};

export type Choice = {
  source_span: Span;
  choice: ChoiceKind;
  candidate: Candidate | null;
  offered: string[];
  confirmed: boolean;
};

export type SegmentChoice = Choice;

export type HistoryEntry = {
  source_hash: string;
  source_span: Span;
  choice: ChoiceKind;
  candidate: Candidate | null;
  offered: string[];
};

export type Prior = {
  source_hash: string;
  direction: Direction;
  basis: Basis;
};

/**
 * The SPEC segment record plus:
 * - `report`, the full review-v2 response obtained in this session (null when restored);
 * - `sent`, the key of the resolutions sent with the request that produced `result` (null: unknown, so never current);
 * - `prior`, kept after an in-session target-only edit so the re-check is one request with resolutions.
 */
export type RuntimeRecord = {
  index: SegmentIndex;
  segmentation_version: typeof SEGMENTATION_VERSION | string;
  source_start: ScalarOffset;
  source_end: ScalarOffset;
  target_start: ScalarOffset;
  target_end: ScalarOffset;
  source_hash: string;
  target_hash: string;
  status: RecordStatus;
  direction: Direction | null;
  alignment_input: string | null;
  basis: Basis | null;
  result: CompactResult | null;
  choices: Choice[];
  report: ExpandedReport | null;
  sent: string | null;
  prior: Prior | null;
};

export type LongState = {
  records: RuntimeRecord[];
  history: HistoryEntry[];
  progress: { current: SegmentIndex | null; completed: SegmentIndex[] };
};

/**
 * `basis` is the session basis: null before the first live response, false when live responses carry no v3 basis.
 */
export type Context = {
  draft: Draft;
  basis: SessionBasis;
};

export type SegmentRequest = {
  index: SegmentIndex;
  body: Record<string, unknown>;
  alignmentInput: string;
  sentKey: string;
  withResolutions?: boolean;
};

export type ExpandedFinding = {
  id: string;
  verdict: Verdict;
  rule_id: string;
  source_span: Span;
  target_span: Span | null;
  candidates: (Candidate & { sources: unknown[] })[];
  candidates_truncated: boolean;
  reason?: ReasonValue;
};

export type ExpandedReport = {
  request_id: string | null;
  source_revision: string;
  target_revision: string;
  rule_version: string;
  matcher_revision?: string;
  dictionary: Basis['dictionary'];
  coverage: { evaluated: number; not_evaluated: number; rules: string[] };
  findings: ExpandedFinding[];
  truncated: boolean;
};

export type ExportFinding = {
  verdict: Verdict;
  source_span: Span;
  target_span: Span | null;
  candidates: { zh: string; en: string }[];
  candidates_truncated: boolean;
  reason?: ReasonValue;
};

export type ExportSegmentRow = {
  index: SegmentIndex;
  state: 'pending' | 'saved' | 'current' | 'stale';
  stale: boolean;
  truncated: boolean;
  source_start: ScalarOffset;
  source_end: ScalarOffset;
  target_start: ScalarOffset;
  target_end: ScalarOffset;
  report: ExpandedReport | Report;
  findings: ExportFinding[];
};

export const LONG_LIMIT = 2000;
// v4 raised both caps from 32 (manuscript v3) to 128; a result or a record over 32 is written as v4 (lib/manuscript.js writeWorkfile).
export const MAX_SEGMENT_CHOICES = 128;
export const MAX_SEGMENT_FINDINGS = 128;
const RULES = ['review.term_pair', 'review.sentence_meaning'];
const TERM_PAIR = 'review.term_pair';
const HEX = /^[a-f0-9]{64}$/u;
const EMPTY_KEY = '[]';

const scalars = (text: string): string[] => Array.from(text);
const sliceOf = (chars: readonly string[], start: number, end: number): string => chars.slice(start, end).join('');
const hex = (x: unknown): x is string => typeof x === 'string' && HEX.test(x);
const longText = (text: string): boolean => text.length > LONG_LIMIT && (text.length > 2 * LONG_LIMIT || scalars(text).length > LONG_LIMIT);
const replaceAt = <T>(list: readonly T[], i: number, value: T): T[] => list.map((x, j) => (j === i ? value : x));
const sameSpan = (a: { start: number; end: number }, b: { start: number; end: number }): boolean => a.start === b.start && a.end === b.end;

// ---- key order (SPEC "Segment record", "Segment choice history") ----

const orderSpan = (s: Span): Span => ({ start: s.start, end: s.end, text: s.text });
const orderCandidate = (c: Candidate | null): Candidate | null =>
  (c === null ? null : { candidate_id: c.candidate_id, zh: c.zh, en: c.en, category: c.category });
const orderCandidateStrict = (c: Candidate): Candidate => ({
  candidate_id: c.candidate_id,
  zh: c.zh,
  en: c.en,
  category: c.category,
});
const orderBasis = (b: Basis): Basis => ({
  rule_version: b.rule_version,
  dictionary: {
    schema_version: b.dictionary.schema_version,
    source_commit: b.dictionary.source_commit,
    term_count: b.dictionary.term_count,
    revision: b.dictionary.revision,
  },
  matcher_revision: b.matcher_revision,
});
const orderChoice = (c: Choice): Choice => ({
  source_span: orderSpan(c.source_span),
  choice: c.choice,
  candidate: orderCandidate(c.candidate),
  offered: [...c.offered],
  confirmed: c.confirmed,
});
const historyEntry = (c: Pick<Choice, 'source_span' | 'choice' | 'candidate' | 'offered'>, sourceHash: string): HistoryEntry => ({
  source_hash: sourceHash,
  source_span: orderSpan(c.source_span),
  choice: c.choice,
  candidate: orderCandidate(c.candidate),
  offered: [...c.offered],
});
const orderFinding = (f: CompactFinding): CompactFinding => ({
  verdict: f.verdict,
  source: [...f.source] as [ScalarOffset, ScalarOffset],
  target: f.target === null ? null : ([...f.target] as [ScalarOffset, ScalarOffset]),
  candidates: f.candidates.map(orderCandidateStrict),
  candidates_truncated: f.candidates_truncated,
  ...(Object.hasOwn(f, 'reason') && f.reason !== undefined ? { reason: f.reason } : {}),
});
// `reason` is valid only on not_evaluated and only with a known value (REASON_VALUES); a finding without one has none.
const reasonHolds = (f: { verdict: string; reason?: unknown }): boolean =>
  !Object.hasOwn(f, 'reason') || (f.verdict === 'not_evaluated' && typeof f.reason === 'string' && (REASON_VALUES as readonly string[]).includes(f.reason));
const orderResult = (r: CompactResult): CompactResult => ({
  truncated: r.truncated,
  evaluated: r.evaluated,
  not_evaluated: r.not_evaluated,
  findings: r.findings.map(orderFinding),
});

// ---- pairing, hashes and request inputs ----

/** Long mode: either side has more than 2,000 scalars. */
export function isLong(draft: Pick<Draft, 'source' | 'target'>): boolean {
  return longText(draft.source) || longText(draft.target);
}

/**
 * The one pairing of records, requests and the writer (the workbench's safePairs): blank texts and a pairing that throws give [];
 * guardPairForRequest only downgrades a ready pair that could not be sent.
 */
export function corePairs({ source, target, alignments }: Pick<Draft, 'source' | 'target' | 'alignments'>): Pair[] {
  if (!source.trim() && !target.trim()) return [];
  try {
    const explicit = alignments && alignments.length ? alignments : null;
    return pairSegments(source, target, SEGMENT_LIMIT, explicit).map(p => guardPairForRequest(p));
  } catch { return []; }
}

const HASH_CACHE_LIMIT = 4096;
const hashCache = new Map<string, string>();

/** Content hash of a core (SPEC "Terms"), cached by text with a bounded least-recently-used cache. */
export function contentHash(core: string): string {
  let hash = hashCache.get(core);
  if (hash === undefined) {
    hash = sha256Hex(core) as string;
    if (hashCache.size >= HASH_CACHE_LIMIT) {
      const oldest = hashCache.keys().next().value;
      if (oldest !== undefined) hashCache.delete(oldest);
    }
  } else hashCache.delete(core);
  hashCache.set(core, hash);
  return hash;
}

const clip = (span: Span, from: number, to: number): { start: number; end: number } | null => {
  const start = Math.max(span.start, from);
  const end = Math.min(span.end, to);
  return start < end ? { start, end } : null;
};

/**
 * The `alignments` list a segment request sends (SPEC "Segment request"), or null when the manuscript's alignments is null. Each
 * alignment is clipped to the cores and rebased; its text is the core slice; one whose source or non-null target misses its core is
 * left out. Keys in the order source, target and start, end, text.
 */
export function alignmentList(
  alignments: readonly Alignment[] | null,
  source: string | readonly string[],
  target: string | readonly string[],
  range: SegmentRange,
): Alignment[] | null {
  if (alignments === null) return null;
  const s = typeof source === 'string' ? scalars(source) : source;
  const t = typeof target === 'string' ? scalars(target) : target;
  const list: Alignment[] = [];
  for (const item of alignments) {
    const sourceRange = clip(item.source, range.source_start, range.source_end);
    if (sourceRange === null) continue;
    let targetSide: Span | null = null;
    if (item.target !== null) {
      const targetRange = clip(item.target, range.target_start, range.target_end);
      if (targetRange === null) continue;
      targetSide = {
        start: scalarOffset(targetRange.start - range.target_start),
        end: scalarOffset(targetRange.end - range.target_start),
        text: sliceOf(t, targetRange.start, targetRange.end),
      };
    }
    list.push({
      source: {
        start: scalarOffset(sourceRange.start - range.source_start),
        end: scalarOffset(sourceRange.end - range.source_start),
        text: sliceOf(s, sourceRange.start, sourceRange.end),
      },
      target: targetSide,
    });
  }
  return list;
}

/** `"automatic"` for null alignments, else the SHA-256 of the list's minified JSON (`[]` included). Same arguments as alignmentList. */
export function alignmentInput(
  alignments: readonly Alignment[] | null,
  source: string | readonly string[],
  target: string | readonly string[],
  range: SegmentRange,
): string {
  const list = alignmentList(alignments, source, target, range);
  return list === null ? 'automatic' : sha256Hex(JSON.stringify(list));
}

const inputCache = new WeakMap<Draft, { long: boolean; items: SegmentInput[] }>();

/**
 * Per-pair inputs of a draft, cached per draft object (drafts are treated as immutable): `long`, and for each pair of corePairs
 * `{pair, range, sourceCore, targetCore, sourceHash, targetHash, alignments, alignmentInput}`, where `alignments` is the list a
 * request sends now (null: omitted) and `range` the core range in record field names.
 */
export function segmentInputs(draft: Draft): { long: boolean; items: SegmentInput[] } {
  const cached = inputCache.get(draft);
  if (cached) return cached;
  const s = scalars(draft.source);
  const t = scalars(draft.target);
  const items: SegmentInput[] = corePairs(draft).map(pair => {
    const range: SegmentRange = {
      source_start: pair.source.core_start,
      source_end: pair.source.core_end,
      target_start: pair.target.core_start,
      target_end: pair.target.core_end,
    };
    const sourceCore = sliceOf(s, range.source_start, range.source_end);
    const targetCore = sliceOf(t, range.target_start, range.target_end);
    const alignments = alignmentList(draft.alignments, s, t, range);
    return {
      pair,
      range,
      sourceCore,
      targetCore,
      sourceHash: contentHash(sourceCore),
      targetHash: contentHash(targetCore),
      alignments,
      alignmentInput: alignments === null ? 'automatic' : contentHash(JSON.stringify(alignments)),
    };
  });
  const value = { long: isLong(draft), items };
  inputCache.set(draft, value);
  return value;
}

// ---- basis and results ----

const boundedText = (x: unknown, max: number): x is string => typeof x === 'string' && x.length > 0 && scalars(x).length <= max;
const isBasis = (b: unknown): b is Basis => {
  if (!b || typeof b !== 'object') return false;
  const candidate = b as Partial<Basis>;
  const d = candidate.dictionary;
  return candidate.rule_version === 'review-v2'
    && !!d
    && typeof d === 'object'
    && boundedText(d.schema_version, 4096)
    && boundedText(d.source_commit, 4096)
    && Number.isSafeInteger(d.term_count)
    && (d.term_count as number) >= 0
    && hex(d.revision)
    && hex(candidate.matcher_revision);
};

/** The v3 basis of a review-v2 response, or null when any of the six values is missing, null or invalid (fails closed). */
export function basisOfReport(report: unknown): Basis | null {
  if (!report || typeof report !== 'object') return null;
  const rep = report as Record<string, unknown>;
  if (!rep.dictionary || typeof rep.dictionary !== 'object') return null;
  const d = rep.dictionary as Record<string, unknown>;
  const basis = {
    rule_version: rep.rule_version,
    dictionary: { schema_version: d.schema_version, source_commit: d.source_commit, term_count: d.term_count, revision: d.revision },
    matcher_revision: rep.matcher_revision,
  };
  return isBasis(basis) ? basis : null;
}

/** Strict v3 basis equality: both valid and all six values equal (unlike lib/manuscript.js sameBasis). */
export function sameV3Basis(a: unknown, b: unknown): boolean {
  return isBasis(a) && isBasis(b) && a.rule_version === b.rule_version && a.matcher_revision === b.matcher_revision
    && a.dictionary.schema_version === b.dictionary.schema_version && a.dictionary.source_commit === b.dictionary.source_commit
    && a.dictionary.term_count === b.dictionary.term_count && a.dictionary.revision === b.dictionary.revision;
}

/**
 * The compact term result of a validated review-v2 response (SPEC "Compact term result"), or null when it cannot be stored: a
 * finding whose rule_id is not review.term_pair, coverage rules other than the review-v2 constant, more than 128 findings or 8
 * candidates, repeated candidate ids, two findings with one source span, or a `reason` on a finding that is not not_evaluated or is
 * not one of REASON_VALUES. A `reason` is kept, last.
 */
export function compactResult(report: Report | null | undefined): CompactResult | null {
  const coverage = report?.coverage;
  if (!report || typeof report.truncated !== 'boolean' || !Array.isArray(report.findings) || report.findings.length > MAX_SEGMENT_FINDINGS || !coverage
    || !Number.isSafeInteger(coverage.evaluated) || coverage.evaluated < 0 || !Number.isSafeInteger(coverage.not_evaluated) || coverage.not_evaluated < 0
    || JSON.stringify(coverage.rules) !== JSON.stringify(RULES)) return null;
  const sources = new Set<string>();
  const findings: CompactFinding[] = [];
  for (const f of report.findings) {
    const key = `${f.source_span.start}:${f.source_span.end}`;
    if (f.rule_id !== TERM_PAIR || f.candidates.length > 8 || sources.has(key) || !f.candidates.every(c => hex(c.candidate_id))
      || new Set(f.candidates.map(c => c.candidate_id)).size !== f.candidates.length || !reasonHolds(f)) return null;
    sources.add(key);
    findings.push(orderFinding({
      verdict: f.verdict,
      source: [f.source_span.start, f.source_span.end],
      target: f.target_span ? [f.target_span.start, f.target_span.end] : null,
      candidates: f.candidates,
      candidates_truncated: f.candidates_truncated,
      ...(Object.hasOwn(f, 'reason') && f.reason !== undefined ? { reason: f.reason } : {}),
    }));
  }
  return { truncated: report.truncated, evaluated: coverage.evaluated, not_evaluated: coverage.not_evaluated, findings };
}

/**
 * The review-v2 report rebuilt from a record with a result (SPEC "Compact term result"): request_id null, candidates with
 * `sources: []`, revisions from the hashes, basis fields, the review-v2 coverage rules, finding ids, rule_id and span texts derived
 * from the cores. Key order as the Web BFF returns a live response.
 */
export function expandResult(record: RuntimeRecord, sourceCore: string, targetCore: string): ExpandedReport {
  const s = scalars(sourceCore);
  const t = scalars(targetCore);
  const span = (chars: readonly string[], pair: [ScalarOffset, ScalarOffset]): Span => ({
    start: pair[0],
    end: pair[1],
    text: sliceOf(chars, pair[0], pair[1]),
  });
  const basis = record.basis as Basis;
  const result = record.result as CompactResult;
  return {
    request_id: null,
    source_revision: record.source_hash,
    target_revision: record.target_hash,
    rule_version: basis.rule_version,
    matcher_revision: basis.matcher_revision,
    dictionary: orderBasis(basis).dictionary,
    coverage: { evaluated: result.evaluated, not_evaluated: result.not_evaluated, rules: [...RULES] },
    findings: result.findings.map(f => {
      const sourceSpan = span(s, f.source);
      return {
        id: mentionId(sourceSpan),
        verdict: f.verdict,
        rule_id: TERM_PAIR,
        source_span: sourceSpan,
        target_span: f.target === null ? null : span(t, f.target),
        candidates: f.candidates.map(c => ({ zh: c.zh, en: c.en, category: c.category, candidate_id: c.candidate_id, sources: [] })),
        candidates_truncated: f.candidates_truncated,
        ...(Object.hasOwn(f, 'reason') && f.reason !== undefined ? { reason: f.reason } : {}),
      };
    }),
    truncated: result.truncated,
  };
}

// ---- choices ----

const sameCandidate = (a: Candidate | null | undefined, b: Candidate | null | undefined): boolean =>
  !!a && !!b && a.candidate_id === b.candidate_id && a.zh === b.zh && a.en === b.en && a.category === b.category;
const findingAt = (result: CompactResult | null, span: { start: number; end: number }): CompactFinding | null =>
  result?.findings.find(f => f.source[0] === span.start && f.source[1] === span.end) ?? null;
const offeredOf = (finding: CompactFinding): string[] => finding.candidates.map(c => c.candidate_id).sort();
const unconfirm = (c: Choice): Choice => ({ ...c, confirmed: false });

/** SPEC Runtime step 7: an official_pair needs the identical candidate at its span, a not_a_term the same candidate ids as a set. */
function holds(choice: Choice, result: CompactResult | null): boolean {
  const finding = findingAt(result, choice.source_span);
  if (!finding) return false;
  if (choice.choice === 'official_pair') return finding.candidates.some(c => sameCandidate(c, choice.candidate));
  const ids = offeredOf(finding);
  const offered = [...choice.offered].sort();
  return ids.length === offered.length && ids.every((id, i) => id === offered[i]);
}

const resolutionOf = (c: Choice): Resolution => (c.choice === 'official_pair' && c.candidate !== null
  ? { mention_id: mentionId(c.source_span), choice: c.choice, candidate_id: c.candidate.candidate_id }
  : { mention_id: mentionId(c.source_span), choice: c.choice });
const resolutionsOf = (choices: readonly Choice[]): Resolution[] => choices.filter(c => c.confirmed)
  .sort((a, b) => a.source_span.start - b.source_span.start || a.source_span.end - b.source_span.end).map(resolutionOf);
const choiceKey = (choices: readonly Choice[]): string => JSON.stringify(resolutionsOf(choices));

// ---- records ----

const BLANK = {
  status: 'pending' as const,
  direction: null,
  alignment_input: null,
  basis: null,
  result: null,
  report: null,
  sent: null,
};

function pendingRecord(index: number, item: SegmentInput, choices: Choice[] = []): RuntimeRecord {
  return {
    index: segmentIndex(index),
    segmentation_version: SEGMENTATION_VERSION,
    ...item.range,
    source_hash: item.sourceHash,
    target_hash: item.targetHash,
    ...BLANK,
    choices,
    prior: null,
  };
}

/** Done, both hashes and the direction current, the alignment input current and the confirmed choices those that were sent (step 3). */
function reusable(record: RuntimeRecord, item: SegmentInput, draft: Draft): boolean {
  return record.status === 'done' && !!record.result && record.source_hash === item.sourceHash && record.target_hash === item.targetHash
    && record.direction === draft.direction && record.alignment_input === item.alignmentInput && record.sent === choiceKey(record.choices);
}

function stateOf(record: RuntimeRecord, item: SegmentInput, ctx: Context): 'pending' | 'saved' | 'current' | 'stale' {
  if (!record.result) return 'pending';
  if (reusable(record, item, ctx.draft)) {
    if (ctx.basis === null) return 'saved';
    if (sameV3Basis(record.basis, ctx.basis)) return 'current';
  }
  return 'stale';
}

const withRecord = (long: LongState, index: number, record: RuntimeRecord): LongState => ({
  ...long,
  records: replaceAt(long.records, index, record),
});

export function emptyLong(): LongState {
  return { records: [], history: [], progress: { current: null, completed: [] } };
}

const overlap = (a: number, b: number, c: number, d: number): number => Math.max(0, Math.min(b, d) - Math.max(a, c));

type Rank5 = [number, number, number, number, number];

/**
 * Compare two `(recordRange, itemRange, j, k)` candidates by the 5-tuple
 * `(sourceOverlap, targetOverlap, -|r.source_start - item.source_start|, -j, -k)`.
 * Returns positive when `a` ranks strictly higher than `b`.
 */
function compareMatchRank(a: Rank5, b: Rank5): number {
  for (let idx = 0; idx < 5; idx++) {
    if (a[idx] !== b[idx]) return a[idx] - b[idx];
  }
  return 0;
}

/**
 * SPEC Runtime step 2 matching: `owner[j]` is the old record for item j, or -1.
 * `rangeOf(r, k)` supplies `(source_start, source_end, target_start, target_end)`: stored ranges on reopen, or
 * edit-mapped ranges in a session. Three passes prevent duplicate paragraphs from swapping choices or results:
 * 1. Exact source occurrence (`source_start`/`source_end` and `source_hash` equal).
 * 2. Both hashes equal, picking the globally highest-ranked `(k, j)` pair at each step.
 * 3. `source_hash` equal only, picking the globally highest-ranked `(k, j)` pair at each step.
 */
function matchRecords(
  old: readonly RuntimeRecord[],
  items: readonly SegmentInput[],
  rangeOf: (r: RuntimeRecord, k: number) => SegmentRange = r => r,
): number[] {
  const owner = items.map(() => -1);
  const used = new Set<number>();
  const ranges = old.map((r, k) => rangeOf(r, k));
  // Pass 1: exact source occurrence (`source_start:source_end:source_hash`) in O(N).
  const pass1 = new Map<string, number[]>();
  for (let k = 0; k < old.length; k++) {
    const key = `${ranges[k].source_start}:${ranges[k].source_end}:${old[k].source_hash}`;
    const list = pass1.get(key);
    if (list) list.push(k);
    else pass1.set(key, [k]);
  }
  items.forEach((item, j) => {
    const bucket = pass1.get(`${item.range.source_start}:${item.range.source_end}:${item.sourceHash}`);
    if (!bucket) return;
    const k = bucket.find(kk => !used.has(kk));
    if (k !== undefined) { owner[j] = k; used.add(k); }
  });
  const rank = (k: number, j: number): Rank5 => {
    const rr = ranges[k];
    const ir = items[j].range;
    return [
      overlap(rr.source_start, rr.source_end, ir.source_start, ir.source_end),
      overlap(rr.target_start, rr.target_end, ir.target_start, ir.target_end),
      -Math.abs(rr.source_start - ir.source_start),
      -j,
      -k,
    ];
  };
  // Pass 2 & Pass 3: hash-bucketed global-best assignment (identical to O(N^2) scan, O(N) on distinct segments).
  const globalBestPass = (keyOfRecord: (r: RuntimeRecord) => string, keyOfItem: (item: SegmentInput) => string): void => {
    const recBuckets = new Map<string, number[]>();
    for (let k = 0; k < old.length; k++) {
      if (used.has(k)) continue;
      const key = keyOfRecord(old[k]);
      const list = recBuckets.get(key);
      if (list) list.push(k);
      else recBuckets.set(key, [k]);
    }
    const itemBuckets = new Map<string, number[]>();
    for (let j = 0; j < items.length; j++) {
      if (owner[j] >= 0) continue;
      const key = keyOfItem(items[j]);
      if (!recBuckets.has(key)) continue;
      const list = itemBuckets.get(key);
      if (list) list.push(j);
      else itemBuckets.set(key, [j]);
    }
    for (const [key, jList] of itemBuckets) {
      const kList = recBuckets.get(key)!;
      if (jList.length === 1 && kList.length === 1) {
        const j = jList[0];
        const k = kList[0];
        owner[j] = k;
        used.add(k);
        continue;
      }
      const pairs: { j: number; k: number; score: Rank5 }[] = [];
      for (const j of jList) {
        for (const k of kList) pairs.push({ j, k, score: rank(k, j) });
      }
      pairs.sort((a, b) => compareMatchRank(b.score, a.score));
      for (const { j, k } of pairs) {
        if (owner[j] >= 0 || used.has(k)) continue;
        owner[j] = k;
        used.add(k);
      }
    }
  };
  globalBestPass(r => `${r.source_hash}\0${r.target_hash}`, item => `${item.sourceHash}\0${item.targetHash}`);
  globalBestPass(r => r.source_hash, item => item.sourceHash);
  return owner;
}

/**
 * Progress through a mapping (`owner[j]` = old index): the current record moves with it; completed keeps records that hold a result.
 * `fallback` gives the new current index when the current record was not matched.
 */
function followProgress(
  progress: { current: number | null; completed: readonly number[] },
  owner: readonly number[],
  records: readonly RuntimeRecord[],
  fallback: (k: number) => number | null = () => null,
): LongState['progress'] {
  const moved = new Map<number, number>(owner.map((k, j) => [k, j] as [number, number]).filter(([k]) => k >= 0));
  const rawCurrent = progress.current === null ? null : moved.get(progress.current) ?? fallback(progress.current);
  const current = rawCurrent === null ? null : segmentIndex(rawCurrent);
  const completed = progress.completed
    .filter(k => moved.has(k))
    .map(k => segmentIndex(moved.get(k) as number))
    .filter(j => records[j]?.result !== null)
    .sort((a, b) => a - b);
  return { current, completed };
}

const readsIn = (core: readonly string[], span: Span): boolean => span.end <= core.length && sliceOf(core, span.start, span.end) === span.text;
const fitsCores = (result: CompactResult | null, sourceLength: number, targetLength: number): boolean =>
  result !== null
  && sourceLength >= 1 && sourceLength <= LONG_LIMIT && targetLength >= 1 && targetLength <= LONG_LIMIT
  && result.findings.every(f => f.source[1] <= sourceLength && (f.target === null || f.target[1] <= targetLength));

/**
 * Runtime state of an opened manuscript (SPEC Runtime step 2). Records map by position when the count and every core range equal
 * the current pairing, else by hashes. A record keeps its result only when both hashes and the direction are current; any other
 * matched record is pending with its choices unconfirmed. A choice that does not read the same in its new core, and the choices of
 * unused records, move to the end of the history with their record's stored source hash. Never sends anything (step 1).
 */
export function longFromWorkfile(parsed: {
  source: string;
  target: string;
  direction: Direction;
  alignments: Alignment[] | null;
  segments?: readonly RuntimeRecord[];
  segment_choice_history?: readonly HistoryEntry[];
  progress?: { current: number | null; completed: number[] };
}): LongState {
  const draft: Draft = { source: parsed.source, target: parsed.target, direction: parsed.direction, alignments: parsed.alignments };
  const saved = (parsed.segments ?? []) as RuntimeRecord[];
  const history = (parsed.segment_choice_history ?? []).map(e => historyEntry(e, e.source_hash));
  const { long, items } = segmentInputs(draft);
  if (!long) {
    for (const r of saved) for (const c of r.choices) history.push(historyEntry(c, r.source_hash));
    return { records: [], history, progress: { current: null, completed: [] } };
  }
  const positional = saved.length === items.length && saved.every((r, i) => r.source_start === items[i].range.source_start
    && r.source_end === items[i].range.source_end && r.target_start === items[i].range.target_start && r.target_end === items[i].range.target_end);
  const owner = positional ? saved.map((_, i) => i) : matchRecords(saved, items);
  const records: RuntimeRecord[] = items.map((item, j) => {
    const old = owner[j] >= 0 ? saved[owner[j]] : undefined;
    if (!old) return pendingRecord(j, item);
    const core = scalars(item.sourceCore);
    const choices: Choice[] = [];
    for (const c of old.choices) if (readsIn(core, c.source_span)) choices.push(orderChoice(c)); else history.push(historyEntry(c, old.source_hash));
    // A result on a pair that is not ready now is not kept: the record is pending (SPEC "Segment record").
    const keep = old.status !== 'pending' && item.pair.status === 'ready' && old.source_hash === item.sourceHash && old.target_hash === item.targetHash
      && old.direction === draft.direction && old.basis !== null && old.result !== null && fitsCores(old.result, core.length, scalars(item.targetCore).length);
    if (!keep) return pendingRecord(j, item, choices.map(unconfirm));
    return {
      ...pendingRecord(j, item, choices),
      status: old.status,
      direction: old.direction,
      alignment_input: old.alignment_input,
      basis: orderBasis(old.basis as Basis),
      result: orderResult(old.result as CompactResult),
      sent: old.status === 'done' ? choiceKey(old.choices) : null,
    };
  });
  const used = new Set(owner);
  saved.forEach((r, k) => { if (!used.has(k)) for (const c of r.choices) history.push(historyEntry(c, r.source_hash)); });
  // An unused current record (mapping not by position) moves to the pair whose region holds its start, as after an edit.
  const near = (k: number): number | null => {
    const rec = saved[k];
    if (!rec) return null;
    const j = items.findIndex(item => rec.source_start < item.pair.source.end);
    return j >= 0 ? j : items.length - 1;
  };
  return { records, history, progress: followProgress(parsed.progress ?? { current: null, completed: [] }, owner, records, near) };
}

const sameAlignments = (a: Alignment[] | null, b: Alignment[] | null): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * Long state after an edit from `before` to `after` (drafts). Not long after it: every choice moves to history with its record's
 * source hash. Otherwise a record whose mapped source core is the new pair's, with the same source content, stays with that pair
 * (its occurrence); the rest are matched by content. Both cores equal keeps everything (a changed alignment input then derives
 * stale); only the source core equal drops
 * the result, keeps a `prior` and the confirmed choices (one re-check with resolutions); anything else is pending. Choices of
 * unmatched records follow the source edit into the pair whose core holds them, unconfirmed; one that cannot be placed moves to
 * history with the hash of its last core. A direction change makes every record pending with unconfirmed choices.
 */
export function reconcileLong(
  long: LongState,
  before: Draft,
  after: Draft,
  splices?: DraftEditSplices,
): LongState {
  if (before.source === after.source && before.target === after.target && before.direction === after.direction
    && sameAlignments(before.alignments, after.alignments)) return long;
  const history = [...long.history];
  const { long: isLongNow, items } = segmentInputs(after);
  if (!isLongNow) {
    for (const r of long.records) for (const c of r.choices) history.push(historyEntry(c, r.source_hash));
    return { records: [], history, progress: { current: null, completed: [] } };
  }
  const old = long.records;
  const splice = splices && 'source' in splices ? (splices.source ?? null) : diffSplice(before.source, after.source);
  const targetSplice = splices && 'target' in splices ? (splices.target ?? null) : diffSplice(before.target, after.target);
  const mapped = old.map(r => mapRegion({ start: r.source_start, end: r.source_end }, splice));
  const mappedTargets = old.map(r => mapRegion({ start: r.target_start, end: r.target_end }, targetSplice));
  const owner = matchRecords(old, items, (_, k) => ({
    source_start: scalarOffset(mapped[k].start),
    source_end: scalarOffset(mapped[k].end),
    target_start: scalarOffset(mappedTargets[k].start),
    target_end: scalarOffset(mappedTargets[k].end),
  }));
  let records: RuntimeRecord[] = items.map((item, j) => {
    const r = owner[j] >= 0 ? old[owner[j]] : undefined;
    if (!r) return pendingRecord(j, item);
    const moved: RuntimeRecord = { ...r, index: segmentIndex(j), ...item.range };
    if (r.target_hash === item.targetHash) return moved;
    const prior: Prior | null = r.result
      ? { source_hash: r.source_hash, direction: r.direction as Direction, basis: r.basis as Basis }
      : r.prior;
    return { ...moved, ...BLANK, target_hash: item.targetHash, prior };
  });
  const used = new Set(owner);
  old.forEach((r, k) => {
    if (used.has(k)) return;
    for (const c of r.choices) {
      const span = shiftSpan(
        { start: r.source_start + c.source_span.start, end: r.source_start + c.source_span.end, text: c.source_span.text },
        splice,
      );
      const j = span ? items.findIndex(item => item.range.source_start <= span.start && span.end <= item.range.source_end) : -1;
      const into = j >= 0 ? records[j] : undefined;
      const relative: Span | null = span && into ? {
        start: scalarOffset(span.start - into.source_start),
        end: scalarOffset(span.end - into.source_start),
        text: span.text,
      } : null;
      if (!into || !relative || !readsIn(scalars(items[j].sourceCore), relative) || into.choices.length >= MAX_SEGMENT_CHOICES
        || into.choices.some(x => sameSpan(x.source_span, relative))) {
        history.push(historyEntry(c, r.source_hash));
        continue;
      }
      records = replaceAt(records, j, { ...into, choices: [...into.choices, { ...orderChoice(c), source_span: relative, confirmed: false }] });
    }
  });
  if (before.direction !== after.direction) records = records.map(r => ({ ...r, ...BLANK, prior: null, choices: r.choices.map(unconfirm) }));
  // A current segment that changed follows its position via binary search on ordered pair regions.
  const findItemIndex = (predicate: (item: SegmentInput) => number): number => {
    let lo = 0;
    let hi = items.length - 1;
    let match = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (predicate(items[mid]) > 0) { match = mid; hi = mid - 1; } else lo = mid + 1;
    }
    return match;
  };
  const near = (k: number): number | null => {
    if (!mapped[k] || !items.length) return null;
    const pos = mapped[k].start;
    const j = findItemIndex(item => (pos < item.pair.source.end ? 1 : -1));
    return j >= 0 ? j : items.length - 1;
  };
  return { records, history, progress: followProgress(long.progress, owner, records, near) };
}

// ---- derived state ----

/**
 * Derived view of record `index` under `ctx`: `state` pending (no result), saved (a reuse candidate while the session basis is
 * unknown), current (a reuse candidate under the session basis) or stale (any other result); `ready` (the pair can be sent);
 * `needsCheck`; `finished`; and the choices with `view`: applies (confirmed, record current), needs_reconfirmation (unconfirmed in a
 * record with a result) or waiting (for the next check). null when there is no such record.
 */
export function recordView(long: LongState, index: number, ctx: Context): RecordView | null {
  const record = long.records[index];
  const item = segmentInputs(ctx.draft).items[index];
  if (!record || !item) return null;
  const state = stateOf(record, item, ctx);
  const ready = item.pair.status === 'ready';
  const view = (c: Choice): ChoiceView => (state === 'pending' ? 'waiting' : !c.confirmed ? 'needs_reconfirmation' : state === 'current' ? 'applies' : 'waiting');
  return {
    state,
    ready,
    needsCheck: ready && (state === 'pending' || state === 'stale'),
    finished: long.progress.completed.includes(segmentIndex(index)),
    choices: record.choices.map(c => ({ ...c, view: view(c) })),
  };
}

/**
 * Target of the live-basis probe (SPEC Runtime step 4): progress.current if it needs a check, else the first segment that does,
 * else progress.current or index 0. When that last pair is not ready, the first ready pair; null when no pair is ready.
 */
export function probeIndex(long: LongState, ctx: Context): SegmentIndex | null {
  const needs = (i: number): boolean => recordView(long, i, ctx)?.needsCheck === true;
  const { current } = long.progress;
  if (current !== null && needs(current)) return current;
  const first = long.records.findIndex((_, i) => needs(i));
  if (first >= 0) return segmentIndex(first);
  const { items } = segmentInputs(ctx.draft);
  const fallback = current ?? 0;
  if (items[fallback]?.pair.status === 'ready' && long.records[fallback]) return segmentIndex(fallback);
  const ready = items.findIndex((item, i) => item.pair.status === 'ready' && long.records[i]);
  return ready >= 0 ? segmentIndex(ready) : null;
}

/** The segment identity used by both the term planner and the run scheduler. */
export function termSegmentKey(index: number, item: Pick<SegmentInput, 'sourceHash' | 'targetHash'>): string {
  return `t:${index}:${item.sourceHash}:${item.targetHash}`;
}

/** Plan the pending checks, including the first live-basis probe after opening a file. */
export function termPlan(long: LongState, ctx: Context): {
  due: number;
  saved: number;
  probe: SegmentIndex | null;
  order: SegmentIndex[];
  cost: number;
} {
  const views = long.records.map((_, index) => recordView(long, index, ctx));
  const due: SegmentIndex[] = views.flatMap((view, index) => (view?.needsCheck ? [segmentIndex(index)] : []));
  const saved = views.filter(view => view?.state === 'saved' && view.ready).length;
  const probe = ctx.basis === null && (due.length > 0 || saved > 0) ? probeIndex(long, ctx) : null;
  const order = probe === null ? due : [probe, ...due.filter(index => index !== probe)];
  return { due: due.length, saved, probe, order, cost: order.length };
}

/**
 * SPEC Runtime step 6: one request with resolutions when the source hash, direction and basis of the record's result (or of its
 * `prior` after a target-only edit) equal the current ones under a known session basis; otherwise first a request without.
 */
export function recheckPlan(long: LongState, index: number, ctx: Context): 'with_resolutions' | 'without_resolutions' {
  const record = long.records[index];
  const item = segmentInputs(ctx.draft).items[index];
  const base = record?.result ? { source_hash: record.source_hash, direction: record.direction, basis: record.basis } : record?.prior;
  return base && item && base.source_hash === item.sourceHash && base.direction === ctx.draft.direction && sameV3Basis(base.basis, ctx.basis)
    ? 'with_resolutions' : 'without_resolutions';
}

/**
 * The review-v2 term check for record `index` (SPEC "Segment request"), or null when its pair is not ready. `alignments` is omitted
 * for null manuscript alignments; `[]` is sent as `[]`. Only with `withResolutions` and a known session basis, the confirmed
 * choices go out as resolutions with the four-key resolution_context; with none, both keys are omitted. Pass the returned object
 * to applyResult with the response. The caller adds the `X-WuwaTerm-Matcher-Basis: 1` header.
 */
export function segmentRequest(
  long: LongState,
  index: number,
  ctx: Context,
  { withResolutions = false }: { withResolutions?: boolean } = {},
): SegmentRequest | null {
  const record = long.records[index];
  const item = segmentInputs(ctx.draft).items[index];
  if (!record || !item || item.pair.status !== 'ready') return null;
  const body: Record<string, unknown> = { source: item.sourceCore, target: item.targetCore, direction: ctx.draft.direction, review_version: 'review-v2' };
  if (item.alignments !== null) body.alignments = structuredClone(item.alignments);
  const basis = ctx.basis;
  const resolutions = withResolutions && isBasis(basis) ? resolutionsOf(record.choices) : [];
  if (resolutions.length && basis) {
    body.resolutions = resolutions;
    body.resolution_context = {
      source_revision: item.sourceHash,
      rule_version: basis.rule_version,
      dictionary_revision: basis.dictionary.revision,
      matcher_revision: basis.matcher_revision,
    };
  }
  // `withResolutions` records the plan (step 6, first bullet), even when no choice is confirmed and nothing goes out.
  return {
    index: segmentIndex(index),
    body,
    alignmentInput: item.alignmentInput,
    sentKey: JSON.stringify(resolutions),
    withResolutions: withResolutions && isBasis(basis),
  };
}

/**
 * Store a validated review-v2 response for `request` (from segmentRequest). Returns `{long, basis, secondRequest, error}`:
 * - `basis`: the new session basis (the response's v3 basis, or false when it has none; unchanged for response_invalid);
 * - `error`: response_invalid (its revisions are not the request's cores), segment_changed (the record, direction or cores moved
 *   on), no_basis or not_storable; with an error nothing is stored and the record keeps what it had, like a failed check;
 * - a record that is current under the response's basis stays as stored (the probe only supplied the basis, step 4);
 * - otherwise the compact result, basis, inputs, full report and `sent` are stored and `prior` cleared. Choices are realigned:
 *   without resolutions by step 7 (a kept choice becomes confirmed); with resolutions a confirmed choice stays confirmed only if
 *   it still holds and an unconfirmed one stays unconfirmed;
 * - `secondRequest`: the confirmed choices now differ from those sent, so one more request with resolutions is due (step 6).
 *   Build it with the returned basis (`{draft, basis: out.basis}`), not the context of the first request, and send at most one
 *   second request per run item.
 */
export function applyResult(
  long: LongState,
  ctx: Context,
  request: SegmentRequest,
  report: Report | Record<string, unknown> | null | undefined,
): {
  long: LongState;
  basis: SessionBasis;
  secondRequest: boolean;
  error: 'response_invalid' | 'segment_changed' | 'no_basis' | 'not_storable' | null;
} {
  const { index, body } = request;
  const sourceHash = contentHash(String(body.source));
  const targetHash = contentHash(String(body.target));
  const repObj = report as Report | null | undefined;
  if (repObj?.source_revision !== sourceHash || repObj?.target_revision !== targetHash) {
    return { long, basis: ctx.basis, secondRequest: false, error: 'response_invalid' };
  }
  const basis = basisOfReport(report);
  const nextBasis: SessionBasis = basis ?? false;
  const out = (
    error: 'segment_changed' | 'no_basis' | 'not_storable' | null,
    next: LongState = long,
    secondRequest = false,
  ) => ({ long: next, basis: nextBasis, secondRequest, error });
  const record = long.records[index];
  const item = segmentInputs(ctx.draft).items[index];
  if (!record || !item || body.direction !== ctx.draft.direction || item.sourceHash !== sourceHash || item.targetHash !== targetHash
    || record.source_hash !== sourceHash || record.target_hash !== targetHash) return out('segment_changed');
  if (!basis) return out('no_basis');
  const result = compactResult(repObj);
  if (!result) return out('not_storable');
  if (stateOf(record, item, { draft: ctx.draft, basis }) === 'current') return out(null);
  // Step 6, first bullet: a re-check planned with resolutions never confirms a choice that was not, even when none was confirmed.
  // Only the request without resolutions realigns by step 7.
  const withResolutions = request.withResolutions ?? request.sentKey !== EMPTY_KEY;
  const choices = record.choices.map(c => ({ ...c, confirmed: withResolutions ? c.confirmed && holds(c, result) : holds(c, result) }));
  const next: RuntimeRecord = {
    ...record,
    status: 'done',
    direction: ctx.draft.direction,
    alignment_input: request.alignmentInput,
    basis,
    result,
    choices,
    report: repObj as ExpandedReport,
    sent: request.sentKey,
    prior: null,
  };
  return out(null, withRecord(long, index, next), choiceKey(choices) !== request.sentKey);
}

// ---- user actions ----

/**
 * Adopt `candidate` for a finding of record `index`, or mark it not a term (`candidate` null): adds or replaces the choice at the
 * finding's span, confirmed, with `offered` the finding's candidate ids for not_a_term. The record then derives stale until checked
 * again. Errors: finding_missing, candidate_missing, too_many_choices (128 per record).
 */
export function chooseTerm(
  long: LongState,
  { index, finding, candidate }: {
    index: number;
    finding: { source?: readonly ScalarOffset[]; source_span?: Span };
    candidate: Candidate | null;
  },
  ctx: Context,
): { long: LongState; error: 'finding_missing' | 'candidate_missing' | 'too_many_choices' | null } {
  const record = long.records[index];
  const item = segmentInputs(ctx.draft).items[index];
  const start = finding.source ? finding.source[0] : finding.source_span?.start;
  const end = finding.source ? finding.source[1] : finding.source_span?.end;
  if (start === undefined || end === undefined) return { long, error: 'finding_missing' };
  const span = { start: scalarOffset(start), end: scalarOffset(end) };
  const found = record && item ? findingAt(record.result, span) : null;
  if (!record || !item || !found) return { long, error: 'finding_missing' };
  const picked = candidate === null ? null : found.candidates.find(c => sameCandidate(c, candidate)) ?? null;
  if (candidate !== null && !picked) return { long, error: 'candidate_missing' };
  const choice: Choice = {
    source_span: { ...span, text: sliceOf(scalars(item.sourceCore), span.start, span.end) },
    choice: picked ? 'official_pair' : 'not_a_term',
    candidate: orderCandidate(picked),
    offered: picked ? [] : offeredOf(found),
    confirmed: true,
  };
  const at = record.choices.findIndex(c => sameSpan(c.source_span, span));
  if (at < 0 && record.choices.length >= MAX_SEGMENT_CHOICES) return { long, error: 'too_many_choices' };
  const choices = at < 0 ? [...record.choices, choice] : replaceAt(record.choices, at, choice);
  return { long: withRecord(long, index, { ...record, choices }), error: null };
}

const choiceIndex = (record: RuntimeRecord | undefined, { start, end }: { start: number; end: number }): number =>
  record?.choices.findIndex(c => sameSpan(c.source_span, { start, end })) ?? -1;

/**
 * Confirm again a choice that needs reconfirmation (SPEC step 7): a not_a_term takes `offered` from the current finding; an
 * official_pair only while the finding still has its candidate. Errors: finding_missing, candidate_missing.
 */
export function reconfirmChoice(
  long: LongState,
  { index, start, end }: { index: number; start: number; end: number },
): { long: LongState; error: 'finding_missing' | 'candidate_missing' | null } {
  const record = long.records[index];
  const at = choiceIndex(record, { start, end });
  const found = record && at >= 0 ? findingAt(record.result, record.choices[at].source_span) : null;
  if (!record || !found) return { long, error: 'finding_missing' };
  const old = record.choices[at];
  if (old.choice === 'official_pair' && !found.candidates.some(c => sameCandidate(c, old.candidate))) return { long, error: 'candidate_missing' };
  const choice: Choice = { ...old, offered: old.choice === 'not_a_term' ? offeredOf(found) : [], confirmed: true };
  return { long: withRecord(long, index, { ...record, choices: replaceAt(record.choices, at, choice) }), error: null };
}

/** Remove the choice at that span of record `index`. */
export function removeChoice(long: LongState, { index, start, end }: { index: number; start: number; end: number }): LongState {
  const record = long.records[index];
  const at = choiceIndex(record, { start, end });
  return !record || at < 0 ? long : withRecord(long, index, { ...record, choices: record.choices.filter((_, i) => i !== at) });
}

/** Remove history entry `position` (the user frees room before a save). */
export function removeHistoryEntry(long: LongState, position: number): LongState {
  return { ...long, history: long.history.filter((_, i) => i !== position) };
}

/** Records that history entry `position` could go back into: same source hash, the span reads the same, room and no choice there. */
function restoreTargets(long: LongState, position: number, ctx: Context): SegmentIndex[] {
  const entry = long.history[position];
  const { items } = segmentInputs(ctx.draft);
  if (!entry) return [];
  return long.records.flatMap((r, i) => (items[i] && r.source_hash === entry.source_hash && items[i].sourceHash === entry.source_hash
    && readsIn(scalars(items[i].sourceCore), entry.source_span) && r.choices.length < MAX_SEGMENT_CHOICES
    && choiceIndex(r, entry.source_span) < 0 ? [segmentIndex(i)] : []));
}

/** For each history entry, the record index it can be restored into (SPEC step 8), or null. */
export function restorableHistory(long: LongState, ctx: Context): (SegmentIndex | null)[] {
  return long.history.map((_, position) => restoreTargets(long, position, ctx)[0] ?? null);
}

/**
 * Restore history entry `position` into record `index` as an unconfirmed choice (SPEC step 8) and remove it from the history.
 * Error not_restorable when restorableHistory would not offer that record.
 */
export function restoreHistoryEntry(
  long: LongState,
  position: number,
  index: number,
  ctx: Context,
): { long: LongState; error: 'not_restorable' | null } {
  if (!restoreTargets(long, position, ctx).includes(segmentIndex(index))) return { long, error: 'not_restorable' };
  const entry = long.history[position];
  const record = long.records[index];
  const choice: Choice = {
    source_span: orderSpan(entry.source_span),
    choice: entry.choice,
    candidate: orderCandidate(entry.candidate),
    offered: [...entry.offered],
    confirmed: false,
  };
  const next = withRecord(long, index, { ...record, choices: [...record.choices, choice] });
  return { long: removeHistoryEntry(next, position), error: null };
}

/** The user's segment, or null. */
export function setCurrent(long: LongState, index: number | null): LongState {
  if (index !== null && !long.records[index]) return long;
  return { ...long, progress: { ...long.progress, current: index === null ? null : segmentIndex(index) } };
}

/** Mark or unmark record `index` finished; only a record with a result can be marked. */
export function setFinished(long: LongState, index: number, finished: boolean): LongState {
  const seg = segmentIndex(index);
  const rest = long.progress.completed.filter(i => i !== seg);
  if (finished && !long.records[index]?.result) return long;
  const completed = finished ? [...rest, seg].sort((a, b) => a - b) : rest;
  return { ...long, progress: { ...long.progress, completed } };
}

// ---- writing and export ----

function writeRecord(record: RuntimeRecord | null, item: SegmentInput, index: number, ctx: Context) {
  const head = {
    index: segmentIndex(index),
    segmentation_version: SEGMENTATION_VERSION,
    ...item.range,
    source_hash: item.sourceHash,
    target_hash: item.targetHash,
  };
  const choices = record?.choices ?? [];
  const live = record?.result && item.pair.status === 'ready' && record.source_hash === item.sourceHash && record.target_hash === item.targetHash
    && record.direction === ctx.draft.direction && record.basis !== null;
  if (!live || !record || !record.result || !record.basis) {
    return { ...head, status: 'pending' as const, direction: null, alignment_input: null, basis: null, result: null, choices: choices.map(c => orderChoice(unconfirm(c))) };
  }
  // Basis null: no live response yet, the stored status stands. A live response without a v3 basis (false) fails closed: stale.
  const done = record.status === 'done' && record.alignment_input === item.alignmentInput && record.sent === choiceKey(choices)
    && (ctx.basis === null || (isBasis(ctx.basis) && sameV3Basis(record.basis, ctx.basis)));
  return {
    ...head,
    status: (done ? 'done' : 'stale') as 'done' | 'stale',
    direction: record.direction,
    alignment_input: record.alignment_input,
    basis: orderBasis(record.basis),
    result: orderResult(record.result),
    choices: choices.map(orderChoice),
  };
}

/**
 * The v3 parts for the writer (SPEC "Writing"), keys in SPEC order. Document mode: no segments and progress `{null, []}`, so with
 * an empty history the file stays v1/v2. Long mode: one record per pair; a record without a current result is pending (hashes of
 * the current cores, choices unconfirmed); a done record is written stale when its alignment input, its sent resolutions or (with a
 * known session basis) its basis differ; completed keeps done and stale records only. Throws long_state_out_of_sync when records
 * holding choices do not line up with the pairs, rather than dropping them.
 */
export function workfileParts(long: LongState, draft: Draft, ctx: { basis: SessionBasis }) {
  const history = long.history.map(e => historyEntry(e, e.source_hash));
  const { long: isLongMode, items } = segmentInputs(draft);
  if (!isLongMode) return { segments: [], segment_choice_history: history, progress: { current: null, completed: [] } };
  if (long.records.length !== items.length && long.records.length > 0) {
    throw Object.assign(new Error('long-mode records do not match the segments'), { code: 'long_state_out_of_sync' });
  }
  const segments = items.map((item, i) => writeRecord(long.records[i] ?? null, item, i, { ...ctx, draft }));
  const current = long.progress.current !== null && segments[long.progress.current] ? long.progress.current : null;
  const completed = [...new Set(long.progress.completed)].filter(i => segments[i] && segments[i].status !== 'pending').sort((a, b) => a - b);
  return { segments, segment_choice_history: history, progress: { current, completed } };
}

/**
 * Rows for the current-result JSON `segment_term_reports` and the Markdown export: every record with a result, in order, with its
 * derived `state`, `stale` (not current), core ranges, the report (the live one, else expandResult) and the findings in whole-text
 * positions.
 */
export function exportSegments(long: LongState, ctx: Context): ExportSegmentRow[] {
  const { items } = segmentInputs(ctx.draft);
  const shiftNonNull = (span: Span, offset: number): Span => ({
    start: scalarOffset(span.start + offset),
    end: scalarOffset(span.end + offset),
    text: span.text,
  });
  return long.records.flatMap((record, i): ExportSegmentRow[] => {
    const item = items[i];
    if (!record.result || !item) return [];
    const state = stateOf(record, item, ctx);
    const report = record.report ?? expandResult(record, item.sourceCore, item.targetCore);
    // `truncated` and each finding's `candidates_truncated` go with the rows, so an export never reads complete when findings or
    // candidates were left out.
    return [{
      index: segmentIndex(i),
      state,
      stale: state !== 'current',
      truncated: report.truncated === true,
      ...item.range,
      report,
      findings: report.findings.map(f => ({
        verdict: f.verdict,
        source_span: shiftNonNull(f.source_span, record.source_start),
        target_span: f.target_span === null ? null : shiftNonNull(f.target_span, record.target_start),
        candidates: f.candidates.map(c => ({ zh: c.zh, en: c.en })),
        candidates_truncated: f.candidates_truncated === true,
        ...(Object.hasOwn(f, 'reason') && f.reason !== undefined ? { reason: f.reason } : {}),
      })),
    }];
  });
}

// ---- the term view: every segment's findings grouped by term, one occurrence at a time ----

export type TermFindingItem = {
  id?: string;
  verdict: Verdict;
  source_span: Span;
  target_span: Span | null;
  candidates: Candidate[];
  candidates_truncated: boolean;
  reason?: ReasonValue;
};

/**
 * A segment with a result, as termSegments builds it; the finding spans are core-relative, the segment ranges are whole-text.
 */
export type TermSegment = {
  index: SegmentIndex;
  state: 'saved' | 'current' | 'stale';
  source_start: ScalarOffset;
  source_end: ScalarOffset;
  target_start: ScalarOffset;
  target_end: ScalarOffset;
  report: { findings: TermFindingItem[] };
  choices: Array<Choice & { view?: ChoiceView }>;
};

export type Snippet = {
  before: string;
  hit: string;
  after: string;
  clippedBefore: boolean;
  clippedAfter: boolean;
};

export type Excerpt = {
  text: string;
  clipped: boolean;
  approximate: boolean;
};

export type Rendering = {
  text: string | null;
  count: number;
  kind: 'hit' | 'none' | 'not_evaluated';
};

export type Occurrence = {
  key: string;
  segmentIndex: SegmentIndex;
  segmentNumber: number;
  finding: TermFindingItem;
  docSource: Span;
  docTarget: Span | null;
  coreSource: Span;
  coreTarget: Span | null;
  sourceContext: Snippet | null;
  targetContext: Snippet | null;
  targetExcerpt: Excerpt | null;
  translation: string | null;
  verdict: Verdict;
  reason: ReasonValue | null;
  candidates: Candidate[];
  freshness: 'saved' | 'current' | 'stale';
  choice: (Choice & { view?: ChoiceView | string }) | null;
  attention: 'settled' | 'conflict' | 'pending' | 'not_evaluated' | 'ok';
};

/**
 * `status` is the one most urgent trait; `inconsistent`, `pendingCount`, `notEvaluatedCount` and `confirmedCount` are all of them: every
 * place is in exactly one of the three counts (`attention` conflict/pending, not_evaluated, settled/ok). `savedCount` says how many of
 * its places come from a saved result that this session has not checked against the live basis yet: they are pending, never settled.
 */
export type TermGroup = {
  key: string;
  surface: string;
  surfaces: string[];
  candidates: Candidate[];
  occurrenceCount: number;
  segments: number[];
  renderings: Rendering[];
  status: 'inconsistent' | 'pending' | 'not_evaluated' | 'confirmed';
  inconsistent: boolean;
  pendingCount: number;
  notEvaluatedCount: number;
  confirmedCount: number;
  savedCount: number;
  unverifiedSegments: number[];
  notEvaluated: number;
  occurrences: Occurrence[];
};

/** A ready segment with no term result (never checked, or edited since), whose source core may hold a term of a group. */
export type UncheckedSegment = {
  index: SegmentIndex;
  sourceCore: string;
};

/** Scalars of context on each side of a hit in a group occurrence. */
export const GROUP_CONTEXT_RADIUS = 36;
const EXCERPT_SCALARS = 96;
const URGENCY: TermGroup['status'][] = ['inconsistent', 'pending', 'not_evaluated', 'confirmed'];

/**
 * The segments that hold a term result, in the shape groupTermOccurrences takes: every record with a result (pending ones have none),
 * with its derived freshness (`saved` while the session basis is unknown, `current`, or `stale`), its core ranges, the report (the live
 * one, else the one rebuilt from the record) and its choices with their `view`.
 */
export function termSegments(long: LongState, ctx: Context): TermSegment[] {
  const { items } = segmentInputs(ctx.draft);
  return long.records.flatMap((record, index): TermSegment[] => {
    const item = items[index];
    if (!record.result || !item) return [];
    const state = stateOf(record, item, ctx);
    const view = recordView(long, index, ctx);
    return [{
      index: segmentIndex(index),
      state: state === 'pending' ? 'stale' : state,
      ...item.range,
      report: record.report ?? expandResult(record, item.sourceCore, item.targetCore),
      choices: view ? view.choices : record.choices,
    }];
  });
}

/**
 * The ready segments with no term result, in the shape groupTermOccurrences takes as `unchecked`: never checked, or edited since (an edit
 * drops the result), so none of their terms is in a group.
 */
export function uncheckedTermSegments(long: LongState, ctx: Context): UncheckedSegment[] {
  const { items } = segmentInputs(ctx.draft);
  return long.records.flatMap((record, index): UncheckedSegment[] => {
    const item = items[index];
    return item && item.pair.status === 'ready' && !record.result ? [{ index: segmentIndex(index), sourceCore: item.sourceCore }] : [];
  });
}

const NFKC = (text: string): string => text.normalize('NFKC');
// Direction names the language of the translation: `zh` translates into Chinese, so its source is English.
const english = (direction: Direction): boolean => direction === 'zh';
// Surface identity inside a group: Unicode-compatible, and for an English source also case-insensitive.
const surfaceKey = (surface: string, direction: Direction): string => (english(direction) ? NFKC(surface).toLowerCase() : NFKC(surface));
// English plural folding, only to merge surfaces that already share a candidate set: Echoes/Echo, Tuners/Tuner, Entries/Entry.
function foldPlural(word: string): string {
  if (/(ss|us|is)$/u.test(word)) return word;
  if (word.length > 3 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && /(ches|shes|xes|sses|zes)$/u.test(word)) return word.slice(0, -2);
  if (word.length > 2 && word.endsWith('s')) return word.slice(0, -1);
  return word;
}
const candidateKey = (candidates: readonly Candidate[]): string => [...new Set(candidates.map(c => c.candidate_id))].sort().join(',');

/** One displayed pair per spelling, retaining every category represented by its candidates. */
export function summarizeTermCandidates(candidates: readonly Candidate[]): { zh: string; en: string; categories: string[] }[] {
  const pairs = new Map<string, { zh: string; en: string; categories: string[] }>();
  for (const candidate of candidates) {
    const key = JSON.stringify([candidate.zh, candidate.en]);
    let pair = pairs.get(key);
    if (!pair) {
      pair = { zh: candidate.zh, en: candidate.en, categories: [] };
      pairs.set(key, pair);
    }
    if (!pair.categories.includes(candidate.category)) pair.categories.push(candidate.category);
  }
  return [...pairs.values()];
}

const needsAction = (o: Occurrence): boolean => o.attention === 'pending' || o.attention === 'conflict';
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
// The 1-based numbers of the unchecked segments whose source core holds any of the spellings. A Chinese source is a substring match (a
// longer word that contains the term matches too: the segment is only said to need its check). An English source is a whole word,
// case-insensitive, with a plural ending allowed, as the plural merge of the groups does.
function uncheckedHolding(spellings: readonly string[], unchecked: readonly UncheckedSegment[], direction: Direction): number[] {
  const forms = spellings.map(name => NFKC(name)).filter(Boolean);
  if (forms.length === 0 || unchecked.length === 0) return [];
  const word = english(direction)
    ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${forms.map(escapeRegExp).join('|')})(?:es|s)?(?![\\p{L}\\p{N}])`, 'iu') : null;
  return unchecked.filter(u => { const core = NFKC(u.sourceCore); return word ? word.test(core) : forms.some(f => core.includes(f)); })
    .map(u => u.index + 1).sort((a, b) => a - b);
}

// The text around a span, read from the scalar array (a long text is not rescanned per occurrence); null when the span does not read
// `expected` there.
function contextOf(chars: readonly string[], start: number, end: number, expected: string): Snippet | null {
  if (end > chars.length || sliceOf(chars, start, end) !== expected) return null;
  const from = Math.max(0, start - GROUP_CONTEXT_RADIUS);
  const to = Math.min(chars.length, end + GROUP_CONTEXT_RADIUS);
  return { before: sliceOf(chars, from, start), hit: expected, after: sliceOf(chars, end, to), clippedBefore: from > 0, clippedAfter: to < chars.length };
}
// The sentence of a core that sits where the hit sits in its own core, by relative position: an estimate, said so by `approximate`.
// Shown when the finding has no target span, so a place with no hit still shows the translation around it.
function sentenceExcerpt(targetCore: string, ratio: number): Excerpt | null {
  const chars = scalars(targetCore);
  if (chars.length === 0) return null;
  const sentences: [number, number][] = [];
  let from = 0;
  chars.forEach((ch, i) => {
    if (/[。．.！？!?\n]/u.test(ch) || i === chars.length - 1) {
      if (i + 1 > from) sentences.push([from, i + 1]);
      from = i + 1;
    }
  });
  const at = Math.min(chars.length - 1, Math.max(0, Math.floor(ratio * chars.length)));
  const [start, end] = sentences.find(([a, b]) => a <= at && at < b) ?? [0, chars.length];
  const trimmed = sliceOf(chars, start, end).trim();
  if (!trimmed) return null;
  const list = scalars(trimmed);
  return { text: list.length > EXCERPT_SCALARS ? `${sliceOf(list, 0, EXCERPT_SCALARS)}` : trimmed, clipped: list.length > EXCERPT_SCALARS, approximate: true };
}

/**
 * Every finding of the given segments, grouped by source term and read one occurrence at a time. Pure; sends nothing.
 *
 * - **Group.** By the finding's source surface (NFKC; case-insensitive when the source is English). English surfaces that differ
 *   only by a plural ending (Tuner and Tuners) merge when their groups hold the same, non-empty set of candidates. `occurrences`
 *   are in text order; `segments` are the 1-based numbers of the segments that hold one.
 * - **Renderings.** What the target actually used at each evaluated occurrence: the text of its target span (`kind` hit), or `null` for
 *   no hit (`none`), a count per distinct rendering, most used first (`Camellya ×2`, no hit ×1). The occurrences Core did not evaluate
 *   are not a miss of the term: they come last as one entry of `kind` not_evaluated.
 * - **Status**, the most urgent that applies. An occurrence is *decided* when it has a confirmed choice.
 *   `inconsistent`: an undecided `confirmed_conflict`, or two or more distinct renderings among the evaluated occurrences while one of
 *   them is undecided. `pending`: a `needs_review`, a saved result this session has not checked against the live basis yet, a stale
 *   result, a choice that waits for the next check or needs reconfirmation, or a segment without a result that holds the term
 *   (`unverifiedSegments`). `not_evaluated`: an occurrence Core did not evaluate that the user has not decided. Otherwise `confirmed`.
 *   The traits behind it are separate: `inconsistent`, and the places in each state (`pendingCount`: conflict or pending;
 *   `notEvaluatedCount`; `confirmedCount`: settled or nothing to do), so a filter by state matches a group that holds such a place
 *   whatever its status is. A group with a saved place is never `confirmed` until the live basis makes that segment `current`;
 *   `savedCount` says how many of its places are still on a saved result.
 * - **Unverified segments.** `unchecked` lists the ready segments that have no result; the 1-based numbers of those whose source core
 *   holds one of the group's spellings (as a substring; for an English source as a whole word, case-insensitive, plural included).
 *   Their places are not in the group yet, so the group is never `confirmed` while any of them stands.
 * - **Occurrence.** The segment it is in, the whole-text and core spans, a context of about 36 scalars each side around the hit in the
 *   source and the target (when the target has no hit, `targetExcerpt`, a sentence of that segment's translation at the same relative
 *   position, so the target side is never blank), the translation used, the verdict and `reason`, the freshness of its segment and the
 *   user's choice at that place. `finding` is the segment's finding itself, for chooseTerm.
 */
export function groupTermOccurrences(
  segments: readonly TermSegment[],
  source: string,
  target: string,
  direction: Direction,
  unchecked: readonly UncheckedSegment[] = [],
): TermGroup[] {
  const s = scalars(source);
  const t = scalars(target);
  const exact = new Map<string, { surface: string; items: Occurrence[] }>();
  for (const seg of segments) {
    const targetCore = sliceOf(t, seg.target_start, seg.target_end);
    const sourceLength = seg.source_end - seg.source_start;
    for (const finding of seg.report.findings) {
      const shift = (span: Span, offset: number): Span => ({
        start: scalarOffset(span.start + offset),
        end: scalarOffset(span.end + offset),
        text: span.text,
      });
      const docSource = shift(finding.source_span, seg.source_start);
      const docTarget = finding.target_span === null ? null : shift(finding.target_span, seg.target_start);
      const choice = seg.choices.find(c => c.source_span.start === finding.source_span.start && c.source_span.end === finding.source_span.end) ?? null;
      const verdict = finding.verdict;
      let attention: Occurrence['attention'] = 'ok';
      // A saved result was computed under another session's basis and this one has not checked it against the current dictionary and
      // matcher yet, so it waits: it never reads as settled or as nothing to do. A confirmed conflict is still the more urgent trait.
      if (seg.state === 'saved') attention = verdict === 'confirmed_conflict' ? 'conflict' : 'pending';
      else if (choice?.confirmed && (choice.view === undefined || choice.view === 'applies') && seg.state !== 'stale') attention = 'settled';
      else if (choice && (!choice.confirmed || choice.view === 'waiting' || choice.view === 'needs_reconfirmation')) attention = 'pending';
      else if (seg.state === 'stale') attention = 'pending';
      else if (verdict === 'confirmed_conflict') attention = 'conflict';
      else if (verdict === 'needs_review') attention = 'pending';
      else if (verdict === 'not_evaluated') attention = 'not_evaluated';
      const occurrence: Occurrence = {
        key: `${seg.index}:${finding.source_span.start}:${finding.source_span.end}`,
        segmentIndex: seg.index,
        segmentNumber: seg.index + 1,
        finding,
        docSource,
        docTarget,
        coreSource: finding.source_span,
        coreTarget: finding.target_span,
        sourceContext: contextOf(s, docSource.start, docSource.end, docSource.text),
        targetContext: docTarget ? contextOf(t, docTarget.start, docTarget.end, docTarget.text) : null,
        targetExcerpt: docTarget ? null : sentenceExcerpt(targetCore, sourceLength > 0 ? finding.source_span.start / sourceLength : 0),
        translation: finding.target_span ? finding.target_span.text : null,
        verdict,
        reason: verdict === 'not_evaluated' && typeof finding.reason === 'string' ? finding.reason : null,
        candidates: finding.candidates,
        freshness: seg.state,
        choice,
        attention,
      };
      const key = surfaceKey(finding.source_span.text, direction);
      const group = exact.get(key);
      if (group) group.items.push(occurrence); else exact.set(key, { surface: finding.source_span.text, items: [occurrence] });
    }
  }
  // Plural merge: only between surfaces of an English source that share one candidate set.
  const merged = new Map<string, { surfaces: Map<string, Occurrence[]> }>();
  for (const [key, { items }] of exact) {
    const set = candidateKey(items.flatMap(o => o.candidates));
    const into = english(direction) && set ? `${foldPlural(key)}|${set}` : key;
    const holder = merged.get(into) ?? { surfaces: new Map<string, Occurrence[]>() };
    holder.surfaces.set(key, items);
    merged.set(into, holder);
  }
  const groups: TermGroup[] = [...merged.entries()].map(([key, { surfaces }]) => {
    const all = [...surfaces.values()].flat().sort((a, b) => a.docSource.start - b.docSource.start || a.docSource.end - b.docSource.end);
    const counts = new Map<string, number>();
    for (const o of all) counts.set(o.coreSource.text, (counts.get(o.coreSource.text) ?? 0) + 1);
    const names = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const evaluated = all.filter(o => o.verdict !== 'not_evaluated');
    const renderings: Rendering[] = [];
    for (const o of evaluated) {
      const at = renderings.findIndex(r => r.text === o.translation);
      if (at >= 0) renderings[at].count += 1; else renderings.push({ text: o.translation, count: 1, kind: o.translation === null ? 'none' : 'hit' });
    }
    renderings.sort((a, b) => b.count - a.count);
    // Not evaluated is not a miss: Core did not look at those places (香椿 is not 椿), so they are counted apart, last.
    const notEvaluated = all.length - evaluated.length;
    if (notEvaluated > 0) renderings.push({ text: null, count: notEvaluated, kind: 'not_evaluated' });
    const undecidedEvaluated = evaluated.some(o => !o.choice?.confirmed);
    const distinct = new Set(evaluated.map(o => o.translation)).size;
    const inconsistent = all.some(o => o.attention === 'conflict') || (distinct >= 2 && undecidedEvaluated);
    const pendingCount = all.filter(needsAction).length;
    const notEvaluatedCount = all.filter(o => o.attention === 'not_evaluated').length;
    const savedCount = all.filter(o => o.freshness === 'saved').length;
    const unverifiedSegments = uncheckedHolding([...names.map(([name]) => name)], unchecked, direction);
    const status: TermGroup['status'] = inconsistent ? 'inconsistent'
      : pendingCount > 0 || unverifiedSegments.length > 0 ? 'pending'
        : notEvaluatedCount > 0 ? 'not_evaluated' : 'confirmed';
    const candidates: Candidate[] = [];
    for (const o of all) for (const c of o.candidates) if (!candidates.some(x => x.candidate_id === c.candidate_id)) candidates.push(c);
    return {
      key,
      surface: names[0][0],
      surfaces: names.map(([name]) => name),
      candidates,
      occurrenceCount: all.length,
      segments: [...new Set(all.map(o => o.segmentNumber))].sort((a, b) => a - b),
      renderings,
      status,
      inconsistent,
      pendingCount,
      notEvaluatedCount,
      confirmedCount: all.length - pendingCount - notEvaluatedCount,
      savedCount,
      unverifiedSegments,
      notEvaluated,
      occurrences: all,
    };
  });
  return groups.sort((a, b) => URGENCY.indexOf(a.status) - URGENCY.indexOf(b.status)
    || a.occurrences[0].docSource.start - b.occurrences[0].docSource.start);
}

export const TERM_GROUP_FILTERS = ['all', 'inconsistent', 'pending', 'not_evaluated', 'confirmed'] as const;
export type TermGroupFilter = (typeof TERM_GROUP_FILTERS)[number];

// What a status filter shows of one group: `scoped` are its places in the selected segment (all of them without one) and `focus` the
// ones the filter is about; null when the group does not belong under that filter. One rule for the counts and for the list, so a
// count is what appears when it is clicked.
function groupMatch(group: TermGroup, filter: TermGroupFilter, segment: number | null): { scoped: Occurrence[]; focus: Occurrence[] } | null {
  const scoped = segment === null ? group.occurrences : group.occurrences.filter(o => o.segmentIndex === segment);
  if (scoped.length === 0) return null;
  const action = scoped.filter(needsAction);
  if (filter === 'all') return { scoped, focus: scoped };
  // The places that make a group inconsistent are the ones that need a decision; when none does, nothing narrows.
  if (filter === 'inconsistent') return group.inconsistent ? { scoped, focus: action.length > 0 ? action : scoped } : null;
  // A group that waits for a check of a segment without a result is pending though none of its places is: its head says so.
  if (filter === 'pending') return action.length > 0 || group.unverifiedSegments.length > 0 ? { scoped, focus: action } : null;
  if (filter === 'not_evaluated') {
    const focus = scoped.filter(o => o.attention === 'not_evaluated');
    return focus.length > 0 ? { scoped, focus } : null;
  }
  return group.status === 'confirmed' ? { scoped, focus: scoped } : null;
}

/**
 * How many groups each status filter shows (the number on its button), for the selected segment (null: all). A group counts under every
 * filter it belongs to: a group with one place to check and four settled ones is under `pending` and under `inconsistent` alike.
 */
export function termGroupCounts(groups: readonly TermGroup[], segment: number | null = null): Record<TermGroupFilter, number> {
  return Object.fromEntries(TERM_GROUP_FILTERS.map(f => [f, groups.filter(g => groupMatch(g, f, segment)).length])) as Record<TermGroupFilter, number>;
}

/**
 * The groups under a status filter, in the groups' order, each with the places to show: the ones the filter is about, or all of its
 * places in the selected segment when the group's key is in `expanded`. `hidden` is how many of the group's places the filter leaves out
 * (the ones a person can open with "show the rest"); `focus` how many it is about.
 */
export function filterTermGroups(
  groups: readonly TermGroup[],
  filter: TermGroupFilter,
  { segment = null, expanded = new Set<string>() }: { segment?: number | null; expanded?: ReadonlySet<string> } = {},
): Array<TermGroup & { focus: number; hidden: number }> {
  return groups.flatMap(g => {
    const match = groupMatch(g, filter, segment);
    if (!match) return [];
    const open = expanded.has(g.key);
    return [{ ...g, occurrences: open ? match.scoped : match.focus, focus: match.focus.length, hidden: match.scoped.length - match.focus.length }];
  });
}

/**
 * Replace exactly one whole-text target span of `target` with `replacement`: the one occurrence the user picked, never every place the
 * same word stands. Returns the new target and the span the replacement now covers, or an error: `span_mismatch` (the target no longer
 * reads `span.text` there), `replacement_invalid` (blank, or not text) or `noop` (it already reads so). The long text has no length
 * cap here; the segment check limits what is sent.
 */
export function spliceTargetSpan(
  target: string,
  span: Span,
  replacement: string,
): { target: string; span: Span; error?: undefined } | { error: 'span_mismatch' | 'replacement_invalid' | 'noop'; target?: undefined; span?: undefined } {
  if (typeof replacement !== 'string' || !replacement.trim() || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(replacement)) {
    return { error: 'replacement_invalid' };
  }
  const start = scalarToUtf16(target, span.start);
  const end = scalarToUtf16(target, span.end);
  if (start === null || end === null || start > end || target.slice(start, end) !== span.text) return { error: 'span_mismatch' };
  if (span.text === replacement) return { error: 'noop' };
  return {
    target: target.slice(0, start) + replacement + target.slice(end),
    span: { start: span.start, end: scalarOffset(span.start + scalars(replacement).length), text: replacement },
  };
}

/**
 * Revise one segment's translation: the target core `[start, end)` becomes `text`; the layout around it stays. Errors:
 * `core_mismatch` (the target no longer reads `expected` there), `text_blank`, `text_too_long` (more than 2,000 scalars, the size of a
 * checked core) or `noop`.
 */
export function reviseSegmentTarget(
  target: string,
  { start, end }: { start: number; end: number },
  expected: string,
  text: string,
): { target: string; error?: undefined } | { error: 'core_mismatch' | 'text_blank' | 'text_too_long' | 'noop'; target?: undefined } {
  if (typeof text !== 'string' || !text.trim()) return { error: 'text_blank' };
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)) return { error: 'text_blank' };
  if (scalars(text).length > LONG_LIMIT) return { error: 'text_too_long' };
  const chars = scalars(target);
  if (start < 0 || start > end || end > chars.length || sliceOf(chars, start, end) !== expected) return { error: 'core_mismatch' };
  if (text === expected) return { error: 'noop' };
  return { target: sliceOf(chars, 0, start) + text + sliceOf(chars, end, chars.length) };
}
