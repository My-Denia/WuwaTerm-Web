// Long-manuscript term review runtime (contracts/manuscript-v3/SPEC.md): segment
// records, choices, choice history and progress; matching on import, re-check
// planning, realignment, edit reconciliation and the writer's v3 parts. Pure and
// browser-safe (no fetch, no React). Offsets are Unicode scalar indexes. The
// state is plain JSON data, so undo snapshots and structuredClone keep it.
import { mentionId } from './manuscript.js';
import { diffSplice, mapRegion, shiftSpan } from './semantic-run.js';
import { SEGMENT_LIMIT, SEGMENTATION_VERSION, guardPairForRequest, pairSegments } from './segmentation.js';
import { sha256Hex } from './sha256.js';

/**
 * @typedef {'en' | 'zh'} Direction
 * @typedef {{start: number, end: number, text: string}} Span
 * @typedef {{source: Span, target: Span | null}} Alignment
 * @typedef {{source: string, target: string, direction: Direction, alignments: Alignment[] | null}} Draft
 * @typedef {{candidate_id: string, zh: string, en: string, category: string}} Candidate
 * @typedef {{rule_version: string, dictionary: {schema_version: string, source_commit: string, term_count: number, revision: string}, matcher_revision: string}} Basis
 * @typedef {{verdict: string, source: number[], target: number[] | null, candidates: Candidate[], candidates_truncated: boolean}} CompactFinding
 * @typedef {{truncated: boolean, evaluated: number, not_evaluated: number, findings: CompactFinding[]}} CompactResult
 * @typedef {{source_span: Span, choice: 'official_pair' | 'not_a_term', candidate: Candidate | null, offered: string[], confirmed: boolean}} Choice
 * @typedef {{source_hash: string, source_span: Span, choice: 'official_pair' | 'not_a_term', candidate: Candidate | null, offered: string[]}} HistoryEntry
 * @typedef {{source_hash: string, direction: Direction, basis: Basis}} Prior
 * @typedef {{
 *   index: number, segmentation_version: string, source_start: number, source_end: number, target_start: number, target_end: number,
 *   source_hash: string, target_hash: string, status: 'pending' | 'done' | 'stale', direction: Direction | null,
 *   alignment_input: string | null, basis: Basis | null, result: CompactResult | null, choices: Choice[],
 *   report: object | null, sent: string | null, prior: Prior | null,
 * }} RuntimeRecord
 *   The SPEC segment record plus: `report`, the full review-v2 response obtained in this session (null when restored);
 *   `sent`, the key of the resolutions sent with the request that produced `result` (null: unknown, so never current);
 *   `prior`, kept after an in-session target-only edit so the re-check is one request with resolutions.
 * @typedef {{records: RuntimeRecord[], history: HistoryEntry[], progress: {current: number | null, completed: number[]}}} LongState
 * @typedef {{draft: Draft, basis: Basis | null | false}} Context
 *   `basis` is the session basis: null before the first live response, false when live responses carry no v3 basis.
 * @typedef {{index: number, body: Record<string, unknown>, alignmentInput: string, sentKey: string, withResolutions?: boolean}} SegmentRequest
 */

export const LONG_LIMIT = 2000;
export const MAX_SEGMENT_CHOICES = 32;
const RULES = ['review.term_pair', 'review.sentence_meaning'];
const TERM_PAIR = 'review.term_pair';
const HEX = /^[a-f0-9]{64}$/u;
const EMPTY_KEY = '[]';

const scalars = text => Array.from(text);
const sliceOf = (chars, start, end) => chars.slice(start, end).join('');
const hex = x => typeof x === 'string' && HEX.test(x);
const longText = text => text.length > LONG_LIMIT && (text.length > 2 * LONG_LIMIT || scalars(text).length > LONG_LIMIT);
const replaceAt = (list, i, value) => list.map((x, j) => (j === i ? value : x));
const sameSpan = (a, b) => a.start === b.start && a.end === b.end;

// ---- key order (SPEC "Segment record", "Segment choice history") ----

const orderSpan = s => ({ start: s.start, end: s.end, text: s.text });
const orderCandidate = c => (c === null ? null : { candidate_id: c.candidate_id, zh: c.zh, en: c.en, category: c.category });
const orderBasis = b => ({
  rule_version: b.rule_version,
  dictionary: { schema_version: b.dictionary.schema_version, source_commit: b.dictionary.source_commit, term_count: b.dictionary.term_count, revision: b.dictionary.revision },
  matcher_revision: b.matcher_revision,
});
const orderChoice = c => ({ source_span: orderSpan(c.source_span), choice: c.choice, candidate: orderCandidate(c.candidate), offered: [...c.offered], confirmed: c.confirmed });
const historyEntry = (c, sourceHash) => ({
  source_hash: sourceHash, source_span: orderSpan(c.source_span), choice: c.choice, candidate: orderCandidate(c.candidate), offered: [...c.offered],
});
const orderFinding = f => ({
  verdict: f.verdict, source: [...f.source], target: f.target === null ? null : [...f.target], candidates: f.candidates.map(orderCandidate),
  candidates_truncated: f.candidates_truncated,
});
const orderResult = r => ({ truncated: r.truncated, evaluated: r.evaluated, not_evaluated: r.not_evaluated, findings: r.findings.map(orderFinding) });

// ---- pairing, hashes and request inputs ----

/** Long mode: either side has more than 2,000 scalars. @param {Draft} draft */
export function isLong(draft) {
  return longText(draft.source) || longText(draft.target);
}

/**
 * The one pairing of records, requests and the writer (the workbench's safePairs): blank texts and a pairing that throws give [];
 * guardPairForRequest only downgrades a ready pair that could not be sent. @param {Draft} draft
 */
export function corePairs({ source, target, alignments }) {
  if (!source.trim() && !target.trim()) return [];
  try {
    const explicit = /** @type {any} */ (alignments && alignments.length ? alignments : null);
    return pairSegments(source, target, SEGMENT_LIMIT, explicit).map(p => guardPairForRequest(p));
  } catch { return []; }
}

const HASH_CACHE_LIMIT = 4096;
const hashCache = new Map();

/** Content hash of a core (SPEC "Terms"), cached by text with a bounded least-recently-used cache. @param {string} core */
export function contentHash(core) {
  let hash = hashCache.get(core);
  if (hash === undefined) {
    hash = sha256Hex(core);
    if (hashCache.size >= HASH_CACHE_LIMIT) hashCache.delete(hashCache.keys().next().value);
  } else hashCache.delete(core);
  hashCache.set(core, hash);
  return hash;
}

const clip = (span, from, to) => {
  const start = Math.max(span.start, from);
  const end = Math.min(span.end, to);
  return start < end ? { start, end } : null;
};

/**
 * The `alignments` list a segment request sends (SPEC "Segment request"), or null when the manuscript's alignments is null. Each
 * alignment is clipped to the cores and rebased; its text is the core slice; one whose source or non-null target misses its core is
 * left out. Keys in the order source, target and start, end, text.
 * @param {Alignment[] | null} alignments
 * @param {string | string[]} source the whole source, as a string or scalar array
 * @param {string | string[]} target
 * @param {{source_start: number, source_end: number, target_start: number, target_end: number}} range the core range
 */
export function alignmentList(alignments, source, target, range) {
  if (alignments === null) return null;
  const s = typeof source === 'string' ? scalars(source) : source;
  const t = typeof target === 'string' ? scalars(target) : target;
  const list = [];
  for (const item of alignments) {
    const sourceRange = clip(item.source, range.source_start, range.source_end);
    if (sourceRange === null) continue;
    let targetSide = null;
    if (item.target !== null) {
      const targetRange = clip(item.target, range.target_start, range.target_end);
      if (targetRange === null) continue;
      targetSide = { start: targetRange.start - range.target_start, end: targetRange.end - range.target_start, text: sliceOf(t, targetRange.start, targetRange.end) };
    }
    list.push({
      source: { start: sourceRange.start - range.source_start, end: sourceRange.end - range.source_start, text: sliceOf(s, sourceRange.start, sourceRange.end) },
      target: targetSide,
    });
  }
  return list;
}

/** `"automatic"` for null alignments, else the SHA-256 of the list's minified JSON (`[]` included). Same arguments as alignmentList. */
export function alignmentInput(alignments, source, target, range) {
  const list = alignmentList(alignments, source, target, range);
  return list === null ? 'automatic' : sha256Hex(JSON.stringify(list));
}

const inputCache = new WeakMap();

/**
 * Per-pair inputs of a draft, cached per draft object (drafts are treated as immutable): `long`, and for each pair of corePairs
 * `{pair, range, sourceCore, targetCore, sourceHash, targetHash, alignments, alignmentInput}`, where `alignments` is the list a
 * request sends now (null: omitted) and `range` the core range in record field names.
 * @param {Draft} draft
 */
export function segmentInputs(draft) {
  const cached = inputCache.get(draft);
  if (cached) return cached;
  const s = scalars(draft.source);
  const t = scalars(draft.target);
  const items = corePairs(draft).map(pair => {
    const range = { source_start: pair.source.core_start, source_end: pair.source.core_end, target_start: pair.target.core_start, target_end: pair.target.core_end };
    const sourceCore = sliceOf(s, range.source_start, range.source_end);
    const targetCore = sliceOf(t, range.target_start, range.target_end);
    const alignments = alignmentList(draft.alignments, s, t, range);
    return {
      pair, range, sourceCore, targetCore, sourceHash: contentHash(sourceCore), targetHash: contentHash(targetCore),
      alignments, alignmentInput: alignments === null ? 'automatic' : contentHash(JSON.stringify(alignments)),
    };
  });
  const value = { long: isLong(draft), items };
  inputCache.set(draft, value);
  return value;
}

// ---- basis and results ----

const boundedText = (x, max) => typeof x === 'string' && x.length > 0 && scalars(x).length <= max;
const isBasis = b => !!b && typeof b === 'object' && b.rule_version === 'review-v2' && !!b.dictionary
  && boundedText(b.dictionary.schema_version, 4096) && boundedText(b.dictionary.source_commit, 4096)
  && Number.isSafeInteger(b.dictionary.term_count) && b.dictionary.term_count >= 0 && hex(b.dictionary.revision) && hex(b.matcher_revision);

/** The v3 basis of a review-v2 response, or null when any of the six values is missing, null or invalid (fails closed). */
export function basisOfReport(report) {
  if (!report || typeof report !== 'object' || !report.dictionary || typeof report.dictionary !== 'object') return null;
  const d = report.dictionary;
  const basis = {
    rule_version: report.rule_version,
    dictionary: { schema_version: d.schema_version, source_commit: d.source_commit, term_count: d.term_count, revision: d.revision },
    matcher_revision: report.matcher_revision,
  };
  return isBasis(basis) ? basis : null;
}

/** Strict v3 basis equality: both valid and all six values equal (unlike lib/manuscript.js sameBasis). */
export function sameV3Basis(a, b) {
  return isBasis(a) && isBasis(b) && a.rule_version === b.rule_version && a.matcher_revision === b.matcher_revision
    && a.dictionary.schema_version === b.dictionary.schema_version && a.dictionary.source_commit === b.dictionary.source_commit
    && a.dictionary.term_count === b.dictionary.term_count && a.dictionary.revision === b.dictionary.revision;
}

/**
 * The compact term result of a validated review-v2 response (SPEC "Compact term result"), or null when it cannot be stored: a
 * finding whose rule_id is not review.term_pair, coverage rules other than the review-v2 constant, more than 32 findings or 8
 * candidates, repeated candidate ids or two findings with one source span.
 * @returns {CompactResult | null}
 */
export function compactResult(report) {
  const coverage = report?.coverage;
  if (!report || typeof report.truncated !== 'boolean' || !Array.isArray(report.findings) || report.findings.length > 32 || !coverage
    || !Number.isSafeInteger(coverage.evaluated) || coverage.evaluated < 0 || !Number.isSafeInteger(coverage.not_evaluated) || coverage.not_evaluated < 0
    || JSON.stringify(coverage.rules) !== JSON.stringify(RULES)) return null;
  const sources = new Set();
  const findings = [];
  for (const f of report.findings) {
    const key = `${f.source_span.start}:${f.source_span.end}`;
    if (f.rule_id !== TERM_PAIR || f.candidates.length > 8 || sources.has(key) || !f.candidates.every(c => hex(c.candidate_id))
      || new Set(f.candidates.map(c => c.candidate_id)).size !== f.candidates.length) return null;
    sources.add(key);
    findings.push(orderFinding({
      verdict: f.verdict, source: [f.source_span.start, f.source_span.end], target: f.target_span ? [f.target_span.start, f.target_span.end] : null,
      candidates: f.candidates, candidates_truncated: f.candidates_truncated,
    }));
  }
  return { truncated: report.truncated, evaluated: coverage.evaluated, not_evaluated: coverage.not_evaluated, findings };
}

/**
 * The review-v2 report rebuilt from a record with a result (SPEC "Compact term result"): request_id null, candidates with
 * `sources: []`, revisions from the hashes, basis fields, the review-v2 coverage rules, finding ids, rule_id and span texts derived
 * from the cores. Key order as the Web BFF returns a live response.
 * @param {RuntimeRecord} record
 * @param {string} sourceCore
 * @param {string} targetCore
 */
export function expandResult(record, sourceCore, targetCore) {
  const s = scalars(sourceCore);
  const t = scalars(targetCore);
  const span = (chars, pair) => ({ start: pair[0], end: pair[1], text: sliceOf(chars, pair[0], pair[1]) });
  const { basis, result } = /** @type {{basis: Basis, result: CompactResult}} */ (record);
  return {
    request_id: null, source_revision: record.source_hash, target_revision: record.target_hash, rule_version: basis.rule_version,
    matcher_revision: basis.matcher_revision, dictionary: orderBasis(basis).dictionary,
    coverage: { evaluated: result.evaluated, not_evaluated: result.not_evaluated, rules: [...RULES] },
    findings: result.findings.map(f => {
      const sourceSpan = span(s, f.source);
      return {
        id: mentionId(sourceSpan), verdict: f.verdict, rule_id: TERM_PAIR, source_span: sourceSpan, target_span: f.target === null ? null : span(t, f.target),
        candidates: f.candidates.map(c => ({ zh: c.zh, en: c.en, category: c.category, candidate_id: c.candidate_id, sources: [] })),
        candidates_truncated: f.candidates_truncated,
      };
    }),
    truncated: result.truncated,
  };
}

// ---- choices ----

const sameCandidate = (a, b) => !!a && !!b && a.candidate_id === b.candidate_id && a.zh === b.zh && a.en === b.en && a.category === b.category;
const findingAt = (result, span) => result?.findings.find(f => f.source[0] === span.start && f.source[1] === span.end) ?? null;
const offeredOf = finding => finding.candidates.map(c => c.candidate_id).sort();
const unconfirm = c => ({ ...c, confirmed: false });

/** SPEC Runtime step 7: an official_pair needs the identical candidate at its span, a not_a_term the same candidate ids as a set. */
function holds(choice, result) {
  const finding = findingAt(result, choice.source_span);
  if (!finding) return false;
  if (choice.choice === 'official_pair') return finding.candidates.some(c => sameCandidate(c, choice.candidate));
  const ids = offeredOf(finding);
  const offered = [...choice.offered].sort();
  return ids.length === offered.length && ids.every((id, i) => id === offered[i]);
}

const resolutionOf = c => (c.choice === 'official_pair'
  ? { mention_id: mentionId(c.source_span), choice: c.choice, candidate_id: c.candidate.candidate_id }
  : { mention_id: mentionId(c.source_span), choice: c.choice });
const resolutionsOf = choices => choices.filter(c => c.confirmed)
  .sort((a, b) => a.source_span.start - b.source_span.start || a.source_span.end - b.source_span.end).map(resolutionOf);
const choiceKey = choices => JSON.stringify(resolutionsOf(choices));

// ---- records ----

const BLANK = { status: 'pending', direction: null, alignment_input: null, basis: null, result: null, report: null, sent: null };

/** @returns {RuntimeRecord} */
function pendingRecord(index, item, choices = []) {
  return {
    index, segmentation_version: SEGMENTATION_VERSION, ...item.range, source_hash: item.sourceHash, target_hash: item.targetHash,
    ...BLANK, choices, prior: null,
  };
}

/** Done, both hashes and the direction current, the alignment input current and the confirmed choices those that were sent (step 3). */
function reusable(record, item, draft) {
  return record.status === 'done' && !!record.result && record.source_hash === item.sourceHash && record.target_hash === item.targetHash
    && record.direction === draft.direction && record.alignment_input === item.alignmentInput && record.sent === choiceKey(record.choices);
}

/** @returns {'pending' | 'saved' | 'current' | 'stale'} */
function stateOf(record, item, ctx) {
  if (!record.result) return 'pending';
  if (reusable(record, item, ctx.draft)) {
    if (ctx.basis === null) return 'saved';
    if (sameV3Basis(record.basis, ctx.basis)) return 'current';
  }
  return 'stale';
}

const withRecord = (long, index, record) => ({ ...long, records: replaceAt(long.records, index, record) });

/** @returns {LongState} */
export function emptyLong() {
  return { records: [], history: [], progress: { current: null, completed: [] } };
}

/**
 * SPEC Runtime step 2 matching: `owner[j]` is the old record for item j, or -1. First every item takes the first unused record with
 * both hashes equal, then a still unmatched item the first unused one with an equal source hash. `preferred(k, j)` breaks ties.
 * @param {(k: number, j: number) => boolean} [preferred]
 */
function matchRecords(old, items, preferred = () => false) {
  const owner = items.map(() => -1);
  const used = new Set();
  const pass = same => items.forEach((item, j) => {
    if (owner[j] >= 0) return;
    const fits = k => !used.has(k) && same(old[k], item);
    let k = old.findIndex((_, kk) => fits(kk) && preferred(kk, j));
    if (k < 0) k = old.findIndex((_, kk) => fits(kk));
    if (k >= 0) { owner[j] = k; used.add(k); }
  });
  pass((r, item) => r.source_hash === item.sourceHash && r.target_hash === item.targetHash);
  pass((r, item) => r.source_hash === item.sourceHash);
  return owner;
}

/**
 * Progress through a mapping (`owner[j]` = old index): the current record moves with it; completed keeps records that hold a result.
 * @param {(k: number) => number | null} [fallback] the new current index when the current record was not matched
 */
function followProgress(progress, owner, records, fallback = () => null) {
  const moved = new Map(owner.map((k, j) => [k, j]).filter(([k]) => k >= 0));
  const current = progress.current === null ? null : moved.get(progress.current) ?? fallback(progress.current);
  const completed = progress.completed.filter(k => moved.has(k)).map(k => /** @type {number} */ (moved.get(k)))
    .filter(j => records[j].result !== null).sort((a, b) => a - b);
  return { current, completed };
}

const readsIn = (core, span) => span.end <= core.length && sliceOf(core, span.start, span.end) === span.text;
const fitsCores = (result, sourceLength, targetLength) => sourceLength >= 1 && sourceLength <= LONG_LIMIT && targetLength >= 1 && targetLength <= LONG_LIMIT
  && result.findings.every(f => f.source[1] <= sourceLength && (f.target === null || f.target[1] <= targetLength));

/**
 * Runtime state of an opened manuscript (SPEC Runtime step 2). Records map by position when the count and every core range equal
 * the current pairing, else by hashes. A record keeps its result only when both hashes and the direction are current; any other
 * matched record is pending with its choices unconfirmed. A choice that does not read the same in its new core, and the choices of
 * unused records, move to the end of the history with their record's stored source hash. Never sends anything (step 1).
 * @param {{source: string, target: string, direction: Direction, alignments: Alignment[] | null, segments?: object[], segment_choice_history?: HistoryEntry[], progress?: {current: number | null, completed: number[]}}} parsed
 * @returns {LongState}
 */
export function longFromWorkfile(parsed) {
  const draft = { source: parsed.source, target: parsed.target, direction: parsed.direction, alignments: parsed.alignments };
  const saved = /** @type {RuntimeRecord[]} */ (parsed.segments ?? []);
  const history = (parsed.segment_choice_history ?? []).map(e => historyEntry(e, e.source_hash));
  const { long, items } = segmentInputs(draft);
  if (!long) {
    for (const r of saved) for (const c of r.choices) history.push(historyEntry(c, r.source_hash));
    return { records: [], history, progress: { current: null, completed: [] } };
  }
  const positional = saved.length === items.length && saved.every((r, i) => r.source_start === items[i].range.source_start
    && r.source_end === items[i].range.source_end && r.target_start === items[i].range.target_start && r.target_end === items[i].range.target_end);
  const owner = positional ? saved.map((_, i) => i) : matchRecords(saved, items);
  const records = items.map((item, j) => {
    const old = saved[owner[j]];
    if (!old) return pendingRecord(j, item);
    const core = scalars(item.sourceCore);
    const choices = [];
    for (const c of old.choices) if (readsIn(core, c.source_span)) choices.push(orderChoice(c)); else history.push(historyEntry(c, old.source_hash));
    // A result on a pair that is not ready now is not kept: the record is pending (SPEC "Segment record").
    const keep = old.status !== 'pending' && item.pair.status === 'ready' && old.source_hash === item.sourceHash && old.target_hash === item.targetHash
      && old.direction === draft.direction && fitsCores(old.result, core.length, scalars(item.targetCore).length);
    if (!keep) return pendingRecord(j, item, choices.map(unconfirm));
    return {
      ...pendingRecord(j, item, choices), status: old.status, direction: old.direction, alignment_input: old.alignment_input,
      basis: orderBasis(old.basis), result: orderResult(old.result), sent: old.status === 'done' ? choiceKey(old.choices) : null,
    };
  });
  const used = new Set(owner);
  saved.forEach((r, k) => { if (!used.has(k)) for (const c of r.choices) history.push(historyEntry(c, r.source_hash)); });
  // An unused current record (mapping not by position) moves to the pair whose region holds its start, as after an edit.
  const near = k => {
    if (!saved[k]) return null;
    const j = items.findIndex(item => saved[k].source_start < item.pair.source.end);
    return j >= 0 ? j : items.length - 1;
  };
  return { records, history, progress: followProgress(parsed.progress ?? { current: null, completed: [] }, owner, records, near) };
}

const sameAlignments = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * Long state after an edit from `before` to `after` (drafts). Not long after it: every choice moves to history with its record's
 * source hash. Otherwise records are matched to the new pairs by content, preferring the record whose mapped source core is the
 * new pair's: both cores equal keeps everything (a changed alignment input then derives stale); only the source core equal drops
 * the result, keeps a `prior` and the confirmed choices (one re-check with resolutions); anything else is pending. Choices of
 * unmatched records follow the source edit into the pair whose core holds them, unconfirmed; one that cannot be placed moves to
 * history with the hash of its last core. A direction change makes every record pending with unconfirmed choices.
 * @param {LongState} long
 * @param {Draft} before
 * @param {Draft} after
 * @returns {LongState}
 */
export function reconcileLong(long, before, after) {
  if (before.source === after.source && before.target === after.target && before.direction === after.direction
    && sameAlignments(before.alignments, after.alignments)) return long;
  const history = [...long.history];
  const { long: isLongNow, items } = segmentInputs(after);
  if (!isLongNow) {
    for (const r of long.records) for (const c of r.choices) history.push(historyEntry(c, r.source_hash));
    return { records: [], history, progress: { current: null, completed: [] } };
  }
  const old = long.records;
  const splice = diffSplice(before.source, after.source);
  const mapped = old.map(r => mapRegion({ start: r.source_start, end: r.source_end }, splice));
  const owner = matchRecords(old, items, (k, j) => mapped[k].start === items[j].range.source_start && mapped[k].end === items[j].range.source_end);
  let records = items.map((item, j) => {
    const r = old[owner[j]];
    if (!r) return pendingRecord(j, item);
    const moved = { ...r, index: j, ...item.range };
    if (r.target_hash === item.targetHash) return moved;
    const prior = r.result ? { source_hash: r.source_hash, direction: /** @type {Direction} */ (r.direction), basis: /** @type {Basis} */ (r.basis) } : r.prior;
    return { ...moved, ...BLANK, target_hash: item.targetHash, prior };
  });
  const used = new Set(owner);
  old.forEach((r, k) => {
    if (used.has(k)) return;
    for (const c of r.choices) {
      const span = shiftSpan({ start: r.source_start + c.source_span.start, end: r.source_start + c.source_span.end, text: c.source_span.text }, splice);
      const j = span ? items.findIndex(item => item.range.source_start <= span.start && span.end <= item.range.source_end) : -1;
      const into = records[j];
      const relative = span && into && { start: span.start - into.source_start, end: span.end - into.source_start, text: span.text };
      if (!relative || !readsIn(scalars(items[j].sourceCore), relative) || into.choices.length >= MAX_SEGMENT_CHOICES
        || into.choices.some(x => sameSpan(x.source_span, relative))) {
        history.push(historyEntry(c, r.source_hash));
        continue;
      }
      records = replaceAt(records, j, { ...into, choices: [...into.choices, { ...orderChoice(c), source_span: relative, confirmed: false }] });
    }
  });
  if (before.direction !== after.direction) records = records.map(r => ({ ...r, ...BLANK, prior: null, choices: r.choices.map(unconfirm) }));
  // A current segment that changed follows its position: the new pair whose region holds its mapped start.
  const near = k => {
    if (!mapped[k]) return null;
    const j = items.findIndex(item => mapped[k].start < item.pair.source.end);
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
 * @param {LongState} long
 * @param {number} index
 * @param {Context} ctx
 */
export function recordView(long, index, ctx) {
  const record = long.records[index];
  const item = segmentInputs(ctx.draft).items[index];
  if (!record || !item) return null;
  const state = stateOf(record, item, ctx);
  const ready = item.pair.status === 'ready';
  const view = c => (state === 'pending' ? 'waiting' : !c.confirmed ? 'needs_reconfirmation' : state === 'current' ? 'applies' : 'waiting');
  return {
    state, ready, needsCheck: ready && (state === 'pending' || state === 'stale'), finished: long.progress.completed.includes(index),
    choices: record.choices.map(c => ({ ...c, view: view(c) })),
  };
}

/**
 * Target of the live-basis probe (SPEC Runtime step 4): progress.current if it needs a check, else the first segment that does,
 * else progress.current or index 0. When that last pair is not ready, the first ready pair; null when no pair is ready.
 * @param {LongState} long
 * @param {Context} ctx
 */
export function probeIndex(long, ctx) {
  const needs = i => recordView(long, i, ctx)?.needsCheck === true;
  const { current } = long.progress;
  if (current !== null && needs(current)) return current;
  const first = long.records.findIndex((_, i) => needs(i));
  if (first >= 0) return first;
  const { items } = segmentInputs(ctx.draft);
  const fallback = current ?? 0;
  if (items[fallback]?.pair.status === 'ready' && long.records[fallback]) return fallback;
  const ready = items.findIndex((item, i) => item.pair.status === 'ready' && long.records[i]);
  return ready >= 0 ? ready : null;
}

/**
 * SPEC Runtime step 6: one request with resolutions when the source hash, direction and basis of the record's result (or of its
 * `prior` after a target-only edit) equal the current ones under a known session basis; otherwise first a request without.
 * @returns {'with_resolutions' | 'without_resolutions'}
 */
export function recheckPlan(long, index, ctx) {
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
 * @param {LongState} long
 * @param {number} index
 * @param {Context} ctx
 * @param {{withResolutions?: boolean}} [options]
 * @returns {SegmentRequest | null}
 */
export function segmentRequest(long, index, ctx, { withResolutions = false } = {}) {
  const record = long.records[index];
  const item = segmentInputs(ctx.draft).items[index];
  if (!record || !item || item.pair.status !== 'ready') return null;
  /** @type {Record<string, unknown>} */
  const body = { source: item.sourceCore, target: item.targetCore, direction: ctx.draft.direction, review_version: 'review-v2' };
  if (item.alignments !== null) body.alignments = structuredClone(item.alignments);
  const basis = ctx.basis;
  const resolutions = withResolutions && isBasis(basis) ? resolutionsOf(record.choices) : [];
  if (resolutions.length && basis) {
    body.resolutions = resolutions;
    body.resolution_context = {
      source_revision: item.sourceHash, rule_version: basis.rule_version, dictionary_revision: basis.dictionary.revision, matcher_revision: basis.matcher_revision,
    };
  }
  // `withResolutions` records the plan (step 6, first bullet), even when no choice is confirmed and nothing goes out.
  return { index, body, alignmentInput: item.alignmentInput, sentKey: JSON.stringify(resolutions), withResolutions: withResolutions && isBasis(basis) };
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
 * @param {LongState} long
 * @param {Context} ctx
 * @param {SegmentRequest} request
 * @param {any} report
 */
export function applyResult(long, ctx, request, report) {
  const { index, body } = request;
  const sourceHash = contentHash(String(body.source));
  const targetHash = contentHash(String(body.target));
  if (report?.source_revision !== sourceHash || report?.target_revision !== targetHash) {
    return { long, basis: ctx.basis, secondRequest: false, error: 'response_invalid' };
  }
  const basis = basisOfReport(report);
  const out = (error, next = long, secondRequest = false) => ({ long: next, basis: basis ?? false, secondRequest, error });
  const record = long.records[index];
  const item = segmentInputs(ctx.draft).items[index];
  if (!record || !item || body.direction !== ctx.draft.direction || item.sourceHash !== sourceHash || item.targetHash !== targetHash
    || record.source_hash !== sourceHash || record.target_hash !== targetHash) return out('segment_changed');
  if (!basis) return out('no_basis');
  const result = compactResult(report);
  if (!result) return out('not_storable');
  if (stateOf(record, item, { draft: ctx.draft, basis }) === 'current') return out(null);
  // Step 6, first bullet: a re-check planned with resolutions never confirms a choice that was not, even when none was confirmed.
  // Only the request without resolutions realigns by step 7.
  const withResolutions = request.withResolutions ?? request.sentKey !== EMPTY_KEY;
  const choices = record.choices.map(c => ({ ...c, confirmed: withResolutions ? c.confirmed && holds(c, result) : holds(c, result) }));
  const next = {
    ...record, status: /** @type {'done'} */ ('done'), direction: ctx.draft.direction, alignment_input: request.alignmentInput, basis, result, choices,
    report, sent: request.sentKey, prior: null,
  };
  return out(null, withRecord(long, index, next), choiceKey(choices) !== request.sentKey);
}

// ---- user actions ----

/**
 * Adopt `candidate` for a finding of record `index`, or mark it not a term (`candidate` null): adds or replaces the choice at the
 * finding's span, confirmed, with `offered` the finding's candidate ids for not_a_term. The record then derives stale until checked
 * again. Errors: finding_missing, candidate_missing, too_many_choices (32 per record).
 * @param {LongState} long
 * @param {{index: number, finding: {source?: number[], source_span?: Span}, candidate: Candidate | null}} choice a compact finding, or one of an
 *   expanded or live report (core-relative `source_span`)
 * @param {Context} ctx
 */
export function chooseTerm(long, { index, finding, candidate }, ctx) {
  const record = long.records[index];
  const item = segmentInputs(ctx.draft).items[index];
  const [start, end] = finding.source ?? [finding.source_span?.start, finding.source_span?.end];
  const span = { start, end };
  const found = record && item ? findingAt(record.result, span) : null;
  if (!record || !item || !found) return { long, error: 'finding_missing' };
  const picked = candidate === null ? null : found.candidates.find(c => sameCandidate(c, candidate)) ?? null;
  if (candidate !== null && !picked) return { long, error: 'candidate_missing' };
  const choice = {
    source_span: { ...span, text: sliceOf(scalars(item.sourceCore), span.start, span.end) }, choice: picked ? 'official_pair' : 'not_a_term',
    candidate: orderCandidate(picked), offered: picked ? [] : offeredOf(found), confirmed: true,
  };
  const at = record.choices.findIndex(c => sameSpan(c.source_span, span));
  if (at < 0 && record.choices.length >= MAX_SEGMENT_CHOICES) return { long, error: 'too_many_choices' };
  const choices = at < 0 ? [...record.choices, choice] : replaceAt(record.choices, at, choice);
  return { long: withRecord(long, index, { ...record, choices }), error: null };
}

const choiceIndex = (record, { start, end }) => record?.choices.findIndex(c => sameSpan(c.source_span, { start, end })) ?? -1;

/**
 * Confirm again a choice that needs reconfirmation (SPEC step 7): a not_a_term takes `offered` from the current finding; an
 * official_pair only while the finding still has its candidate. Errors: finding_missing, candidate_missing.
 * @param {LongState} long
 * @param {{index: number, start: number, end: number}} at
 */
export function reconfirmChoice(long, { index, start, end }) {
  const record = long.records[index];
  const at = choiceIndex(record, { start, end });
  const found = at >= 0 ? findingAt(record.result, record.choices[at].source_span) : null;
  if (!found) return { long, error: 'finding_missing' };
  const old = record.choices[at];
  if (old.choice === 'official_pair' && !found.candidates.some(c => sameCandidate(c, old.candidate))) return { long, error: 'candidate_missing' };
  const choice = { ...old, offered: old.choice === 'not_a_term' ? offeredOf(found) : [], confirmed: true };
  return { long: withRecord(long, index, { ...record, choices: replaceAt(record.choices, at, choice) }), error: null };
}

/** Remove the choice at that span of record `index`. @param {LongState} long @param {{index: number, start: number, end: number}} at */
export function removeChoice(long, { index, start, end }) {
  const record = long.records[index];
  const at = choiceIndex(record, { start, end });
  return at < 0 ? long : withRecord(long, index, { ...record, choices: record.choices.filter((_, i) => i !== at) });
}

/** Remove history entry `position` (the user frees room before a save). @param {LongState} long @param {number} position */
export function removeHistoryEntry(long, position) {
  return { ...long, history: long.history.filter((_, i) => i !== position) };
}

/** Records that history entry `position` could go back into: same source hash, the span reads the same, room and no choice there. */
function restoreTargets(long, position, ctx) {
  const entry = long.history[position];
  const { items } = segmentInputs(ctx.draft);
  if (!entry) return [];
  return long.records.flatMap((r, i) => (items[i] && r.source_hash === entry.source_hash && items[i].sourceHash === entry.source_hash
    && readsIn(scalars(items[i].sourceCore), entry.source_span) && r.choices.length < MAX_SEGMENT_CHOICES
    && choiceIndex(r, entry.source_span) < 0 ? [i] : []));
}

/** For each history entry, the record index it can be restored into (SPEC step 8), or null. @param {LongState} long @param {Context} ctx */
export function restorableHistory(long, ctx) {
  return long.history.map((_, position) => restoreTargets(long, position, ctx)[0] ?? null);
}

/**
 * Restore history entry `position` into record `index` as an unconfirmed choice (SPEC step 8) and remove it from the history.
 * Error not_restorable when restorableHistory would not offer that record.
 * @param {LongState} long
 * @param {number} position
 * @param {number} index
 * @param {Context} ctx
 */
export function restoreHistoryEntry(long, position, index, ctx) {
  if (!restoreTargets(long, position, ctx).includes(index)) return { long, error: 'not_restorable' };
  const entry = long.history[position];
  const record = long.records[index];
  const choice = { source_span: orderSpan(entry.source_span), choice: entry.choice, candidate: orderCandidate(entry.candidate), offered: [...entry.offered], confirmed: false };
  const next = withRecord(long, index, { ...record, choices: [...record.choices, choice] });
  return { long: removeHistoryEntry(next, position), error: null };
}

/** The user's segment, or null. @param {LongState} long @param {number | null} index */
export function setCurrent(long, index) {
  if (index !== null && !long.records[index]) return long;
  return { ...long, progress: { ...long.progress, current: index } };
}

/** Mark or unmark record `index` finished; only a record with a result can be marked. @param {LongState} long */
export function setFinished(long, index, finished) {
  const rest = long.progress.completed.filter(i => i !== index);
  if (finished && !long.records[index]?.result) return long;
  const completed = finished ? [...rest, index].sort((a, b) => a - b) : rest;
  return { ...long, progress: { ...long.progress, completed } };
}

// ---- writing and export ----

function writeRecord(record, item, index, ctx) {
  const head = {
    index, segmentation_version: SEGMENTATION_VERSION, ...item.range, source_hash: item.sourceHash, target_hash: item.targetHash,
  };
  const choices = record?.choices ?? [];
  const live = record?.result && item.pair.status === 'ready' && record.source_hash === item.sourceHash && record.target_hash === item.targetHash
    && record.direction === ctx.draft.direction;
  if (!live) return { ...head, status: 'pending', direction: null, alignment_input: null, basis: null, result: null, choices: choices.map(c => orderChoice(unconfirm(c))) };
  // Basis null: no live response yet, the stored status stands. A live response without a v3 basis (false) fails closed: stale.
  const done = record.status === 'done' && record.alignment_input === item.alignmentInput && record.sent === choiceKey(choices)
    && (ctx.basis === null || (isBasis(ctx.basis) && sameV3Basis(record.basis, ctx.basis)));
  return {
    ...head, status: done ? 'done' : 'stale', direction: record.direction, alignment_input: record.alignment_input, basis: orderBasis(record.basis),
    result: orderResult(record.result), choices: choices.map(orderChoice),
  };
}

/**
 * The v3 parts for the writer (SPEC "Writing"), keys in SPEC order. Document mode: no segments and progress `{null, []}`, so with
 * an empty history the file stays v1/v2. Long mode: one record per pair; a record without a current result is pending (hashes of
 * the current cores, choices unconfirmed); a done record is written stale when its alignment input, its sent resolutions or (with a
 * known session basis) its basis differ; completed keeps done and stale records only. Throws long_state_out_of_sync when records
 * holding choices do not line up with the pairs, rather than dropping them.
 * @param {LongState} long
 * @param {Draft} draft
 * @param {{basis: Basis | null | false}} ctx
 */
export function workfileParts(long, draft, ctx) {
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
 * positions. @param {LongState} long @param {Context} ctx
 */
export function exportSegments(long, ctx) {
  const { items } = segmentInputs(ctx.draft);
  const shift = (span, offset) => (span === null ? null : { start: span.start + offset, end: span.end + offset, text: span.text });
  return long.records.flatMap((record, i) => {
    const item = items[i];
    if (!record.result || !item) return [];
    const state = stateOf(record, item, ctx);
    const report = /** @type {any} */ (record.report ?? expandResult(record, item.sourceCore, item.targetCore));
    return [{
      index: i, state, stale: state !== 'current', ...item.range, report,
      findings: report.findings.map(f => ({
        verdict: f.verdict, source_span: shift(f.source_span, record.source_start), target_span: shift(f.target_span, record.target_start),
        candidates: f.candidates.map(c => ({ zh: c.zh, en: c.en })),
      })),
    }];
  });
}
