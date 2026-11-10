// Pure helpers for the semantic-review workbench: text-edit tracking, precedent
// and context selection, request fitting, failure classification, the serial run
// state machine and export shaping. Browser-safe; every coordinate is a Unicode
// scalar index (Array.from), as in Core.
import { serializeWorkfile, MAX_SEMANTIC_TEXTS } from './manuscript.js';
import { validPrecedent } from './semantic-review.js';
import { toDocumentIssue } from './semantic-decisions.js';
import { sentenceRangesV2 } from './segmentation.js';

const scalars = text => Array.from(text);

// ---- edit tracking ----

/**
 * Single replacement turning oldText into newText: longest common prefix and
 * suffix (never overlapping). null when the texts are equal.
 * @returns {{start: number, oldEnd: number, newEnd: number} | null}
 */
export function diffSplice(oldText, newText) {
  if (oldText === newText) return null;
  const a = scalars(oldText);
  const b = scalars(newText);
  const max = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < max && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < max - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  return { start: prefix, oldEnd: a.length - suffix, newEnd: b.length - suffix };
}

/** Coordinates only: where the span sits after the edit, or null when the edit touches it. */
export function shiftSpan(span, splice) {
  if (span === null || span === undefined) return null;
  if (splice === null || splice === undefined) return { start: span.start, end: span.end, text: span.text };
  const { start: s, oldEnd, newEnd } = splice;
  if (span.end <= s) return { start: span.start, end: span.end, text: span.text };
  if (oldEnd <= span.start) {
    const delta = newEnd - oldEnd;
    return { start: span.start + delta, end: span.end + delta, text: span.text };
  }
  return null;
}

function sliceEquals(text, span) {
  return scalars(text).slice(span.start, span.end).join('') === span.text;
}

/** Map a span through one edit and check it still reads the same in newText. */
export function mapSpan(span, splice, newText) {
  if (span === null || span === undefined) return null;
  if (splice === null || splice === undefined) return span;
  const mapped = shiftSpan(span, splice);
  return mapped !== null && sliceEquals(newText, mapped) ? mapped : null;
}

/** A region boundary always maps: inside the edit, start goes to the edit start and end to its new end. */
export function mapRegion(region, splice) {
  if (splice === null || splice === undefined) return { start: region.start, end: region.end };
  const { start: s, oldEnd, newEnd } = splice;
  const point = (p, isEnd) => {
    if (p <= s) return p;
    if (p >= oldEnd) return p + (newEnd - oldEnd);
    return isEnd ? newEnd : s;
  };
  const start = point(region.start, false);
  return { start, end: Math.max(start, point(region.end, true)) };
}

export function segmentKey(direction, sourceCore, targetCore) {
  return JSON.stringify([direction, sourceCore, targetCore]);
}

// ---- precedents and context ----

const WS_RE = /\s/u;

function snippetOf(chars, span, limit) {
  const spanLen = span.end - span.start;
  if (spanLen > limit) return null;
  let lo = 0; let hi = chars.length;
  const sentence = sentenceRangesV2(chars).find(([a, b]) => a <= span.start && span.end <= b);
  if (sentence) [lo, hi] = sentence;
  else { lo = Math.max(0, span.start - limit); hi = Math.min(chars.length, span.end + limit); }
  while (lo < span.start && WS_RE.test(chars[lo])) lo++;
  while (hi > span.end && WS_RE.test(chars[hi - 1])) hi--;
  if (hi - lo > limit) {
    const extra = limit - spanLen;
    const left = Math.floor(extra / 2);
    let a = Math.max(lo, span.start - left);
    let b = Math.min(hi, span.end + (extra - (span.start - a)));
    a = Math.max(lo, Math.min(a, b - limit));
    b = Math.min(hi, a + limit);
    lo = a; hi = b;
  }
  return chars.slice(lo, hi).join('');
}

/**
 * Earlier decisions of this document as precedents for the segment at
 * `segmentIndex` (translation-context-v1 / semantic-review-v1, Core ADR 0019).
 * `items` are already in current whole-text coordinates.
 */
export function selectPrecedents({ items, source, pairs, segmentIndex, limit = 12 }) {
  const current = pairs[segmentIndex];
  if (!current) return [];
  const chars = scalars(source);
  const coreStart = current.source.core_start;
  const currentCore = chars.slice(coreStart, current.source.core_end).join('');
  const found = new Map();
  for (const item of items) {
    const span = item?.span;
    if (!span || !(span.end <= coreStart) || span.start < 0 || span.start >= span.end || !sliceEquals(source, span)) continue;
    const surface = span.text;
    const surfaceLen = span.end - span.start;
    if (surfaceLen < 1 || surfaceLen > 32) continue;
    const rendering = item.rendering ?? null;
    if (item.choice === 'not_a_term') { if (rendering !== null) continue; }
    else {
      if (typeof rendering !== 'string') continue;
      const n = scalars(rendering).length;
      if (n < 1 || n > 48) continue;
    }
    const pair = pairs.find(p => span.start >= p.source.core_start && span.end <= p.source.core_end);
    if (!pair) continue;
    const snippet = snippetOf(chars, span, 80);
    if (snippet === null || !snippet.includes(surface)) continue;
    const precedent = {
      surface, choice: item.choice, rendering, snippet,
      anchor: { segment_index: pair.index, source_start: span.start - pair.source.core_start, source_end: span.end - pair.source.core_start },
      scope: 'occurrence',
    };
    if (!validPrecedent(precedent)) continue;
    const entry = { precedent, distance: coreStart - span.end, start: span.start, inCurrent: currentCore.includes(surface) };
    const key = JSON.stringify([surface, item.choice, rendering]);
    const prev = found.get(key);
    if (!prev || entry.distance < prev.distance) found.set(key, entry);
  }
  return [...found.values()]
    .sort((x, y) => Number(y.inCurrent) - Number(x.inCurrent) || x.distance - y.distance || y.start - x.start)
    .slice(0, limit)
    .map(entry => entry.precedent);
}

/** Tail (<= 400 scalars) of the previous pair's cores, or null when there is nothing to say. */
export function contextBefore({ pairs, segmentIndex, source, target }) {
  const prev = segmentIndex > 0 ? pairs[segmentIndex - 1] : undefined;
  if (!prev) return null;
  const tail = (text, region) => scalars(text).slice(region.core_start, region.core_end).slice(-400).join('');
  const before = { source: tail(source, prev.source), target: tail(target, prev.target) };
  return before.source === '' && before.target === '' ? null : before;
}

// ---- request fitting ----

const byteLength = body => new TextEncoder().encode(JSON.stringify(body)).length;

function halve(text) { const chars = scalars(text); return chars.slice(chars.length - Math.floor(chars.length / 2)).join(''); }

/**
 * Trim a request to the byte limit without touching the input: furthest
 * precedents first, then the previous-segment context.
 * @returns {{body: object, bytes: number, droppedPrecedents: number, contextTrimmed: boolean, fits: boolean}}
 */
export function fitRequestBody(body, maxBytes = 32768) {
  const next = JSON.parse(JSON.stringify(body));
  let bytes = byteLength(next);
  let droppedPrecedents = 0;
  let contextTrimmed = false;
  const semantic = Object.hasOwn(next, 'review_version') || Array.isArray(next.precedents);
  const precedents = semantic ? next.precedents : next.context?.precedents;
  if (Array.isArray(precedents)) {
    while (bytes > maxBytes && precedents.length > 0) {
      precedents.pop();
      droppedPrecedents++;
      bytes = byteLength(next);
    }
  }
  while (bytes > maxBytes && next.context && typeof next.context === 'object' && next.context.before) {
    const before = next.context.before;
    contextTrimmed = true;
    before.source = halve(before.source);
    before.target = halve(before.target);
    if (before.source === '' && before.target === '') {
      if (semantic) delete next.context;
      else {
        delete next.context.before;
        if (Object.keys(next.context).length === 0) delete next.context;
      }
    }
    bytes = byteLength(next);
  }
  return { body: next, bytes, droppedPrecedents, contextTrimmed, fits: bytes <= maxBytes };
}

// ---- failures and the serial run ----

const WAIT = new Set(['shared_pool_busy', 'upstream_rate_limited', 'rate_limited']);
const PAUSE = new Set(['translation_pool_exhausted', 'reviews_pool_exhausted', 'llm_budget_exhausted', 'translation_disabled']);
const STOP = new Set(['llm_unavailable', 'semantic_review_unavailable', 'site_not_configured', 'upstream_unauthorized',
  'upstream_forbidden', 'unauthorized', 'forbidden']);

/** @returns {{action: 'wait', seconds: number} | {action: 'pause_quota' | 'stop' | 'manual_retry' | 'segment_failed'}} */
export function classifyFailure({ reason, retryAfterSeconds } = {}) {
  if (WAIT.has(reason)) {
    const seconds = Number.isFinite(retryAfterSeconds) ? Math.min(600, Math.max(5, retryAfterSeconds)) : 30;
    return { action: 'wait', seconds };
  }
  if (PAUSE.has(reason)) return { action: 'pause_quota' };
  if (STOP.has(reason)) return { action: 'stop' };
  if (reason === 'upstream_timeout') return { action: 'manual_retry' };
  return { action: 'segment_failed' };
}

export function initialRun() {
  return { kind: null, phase: 'idle', items: [], waitUntil: null, stopCode: null, streak: { code: null, count: 0 } };
}

const patchItem = (state, key, patch) => state.items.map(item => (item.key === key ? { ...item, ...patch } : item));
const open = state => state.items.some(item => item.status === 'queued' || item.status === 'sending');
// Nothing queued or in flight any more: a running, paused or waiting run is complete.
const settle = state => (['running', 'paused', 'waiting'].includes(state.phase) && !open(state)
  ? { ...state, phase: 'done', waitUntil: null } : state);

/** Serial run state machine; the caller performs the request and reports back with sent/done/failed. */
export function runReducer(state, event) {
  const item = event.key === undefined ? undefined : state.items.find(i => i.key === event.key);
  switch (event.type) {
    case 'start': {
      const items = event.items.map(i => ({ key: i.key, index: i.index, status: 'queued', code: null }));
      return { ...initialRun(), kind: event.kind, items, phase: items.length ? 'running' : 'done' };
    }
    case 'sent':
      return item && item.status === 'queued' ? { ...state, items: patchItem(state, event.key, { status: 'sending' }) } : state;
    case 'done':
      return item ? settle({ ...state, items: patchItem(state, event.key, { status: 'done', code: null }), streak: { code: null, count: 0 } }) : state;
    case 'failed': {
      if (!item) return state;
      const action = event.classification?.action;
      if (action === 'segment_failed' || action === 'manual_retry') {
        const count = state.streak.code === event.code ? state.streak.count + 1 : 1;
        const next = { ...state, items: patchItem(state, event.key, { status: 'failed', code: event.code }), streak: { code: event.code, count } };
        return count >= 2 ? { ...next, phase: 'stopped', stopCode: event.code, waitUntil: null } : settle(next);
      }
      const items = patchItem(state, event.key, { status: 'queued', code: null });
      if (action === 'wait') {
        // A user pause stays a pause: the run must not resume on its own.
        if (state.phase === 'paused') return { ...state, items };
        return { ...state, items, phase: 'waiting', waitUntil: event.now + event.classification.seconds * 1000 };
      }
      if (action === 'pause_quota') return { ...state, items, phase: 'paused', waitUntil: null, stopCode: event.code };
      return { ...state, items, phase: 'stopped', waitUntil: null, stopCode: event.code };
    }
    case 'pause':
      return state.phase === 'running' || state.phase === 'waiting' ? { ...state, phase: 'paused', waitUntil: null } : state;
    case 'resume':
      return ['paused', 'waiting', 'stopped'].includes(state.phase)
        ? settle({ ...state, phase: 'running', waitUntil: null, stopCode: null, streak: { code: null, count: 0 } }) : state;
    case 'retry': {
      if (!item || item.status !== 'failed') return state;
      const next = { ...state, items: patchItem(state, event.key, { status: 'queued', code: null }) };
      return state.phase === 'done' || state.phase === 'idle' ? { ...next, phase: 'running' } : next;
    }
    case 'skip':
      // The segment text changed under the run: neither a success nor a failure.
      return item && (item.status === 'queued' || item.status === 'sending')
        ? settle({ ...state, items: patchItem(state, event.key, { status: 'skipped', code: 'segment_changed' }) }) : state;
    case 'reset':
      return initialRun();
    default:
      return state;
  }
}

/** The next item to send: only while running and nothing is in flight. */
export function nextQueued(state) {
  if (state.phase !== 'running' || state.items.some(item => item.status === 'sending')) return null;
  return state.items.find(item => item.status === 'queued') ?? null;
}

export function runProgress(state) {
  return {
    done: state.items.filter(item => item.status === 'done').length,
    failed: state.items.filter(item => item.status === 'failed').length,
    skipped: state.items.filter(item => item.status === 'skipped').length,
    total: state.items.length,
  };
}

// ---- issues, decisions, history, export ----

/** A segment report's issues in whole-document coordinates, tagged with the segment index. */
export function placeSegmentIssues({ report, pair }) {
  return report.issues.map(issue => toDocumentIssue(issue, pair));
}

function through(span, splices, finalText) {
  if (span === null || span === undefined) return null;
  let mapped = span;
  for (const splice of splices ?? []) {
    mapped = shiftSpan(mapped, splice);
    if (mapped === null) return null;
  }
  return sliceEquals(finalText, mapped) ? mapped : null;
}

/**
 * Follow an issue through the edits made since it was reported. Splices are
 * applied in order (coordinates only); the text is checked once, against the
 * current text. A span that cannot be followed makes the issue stale.
 */
export function liveIssue(issue, { sourceSplices, targetSplices, source, target }) {
  const sourceSpan = through(issue.source_span, sourceSplices, source);
  const targetSpan = through(issue.target_span, targetSplices, target);
  const original = issue.suggestion?.target_span ?? null;
  const suggestionSpan = through(original, targetSplices, target);
  const stale = (issue.source_span != null && sourceSpan === null)
    || (issue.target_span != null && targetSpan === null)
    || (original !== null && suggestionSpan === null);
  return { ...issue, live: { source_span: sourceSpan, target_span: targetSpan, suggestion_span: suggestionSpan }, stale };
}

/**
 * Choose the old whole texts that `ignored` decisions need and that still fit in
 * the workfile. `candidates` are {revision, text}, newest first, revisions already
 * computed by the caller. The oldest candidate goes first when the file is too large.
 * @returns {{texts: {revision: string, text: string}[], dropped: number}}
 */
export function semanticTextsWithinBudget({ payload, candidates, currentTexts }) {
  const needed = new Set((payload.semantic_decisions ?? []).filter(d => d.decision === 'ignored')
    .flatMap(d => [d.source_revision, d.target_revision]));
  const seen = new Set();
  const texts = [];
  for (const entry of candidates) {
    if (!needed.has(entry.revision) || seen.has(entry.revision)
      || entry.text === currentTexts.source || entry.text === currentTexts.target) continue;
    seen.add(entry.revision);
    texts.push({ revision: entry.revision, text: entry.text });
    if (texts.length === MAX_SEMANTIC_TEXTS) break;
  }
  let dropped = 0;
  for (;;) {
    try {
      serializeWorkfile({ ...payload, semantic_texts: texts });
      return { texts, dropped };
    } catch (error) {
      if (error?.code !== 'workfile_too_large') throw error;
      if (texts.length === 0) return { texts, dropped };
      texts.pop();
      dropped++;
    }
  }
}

/** Reference snapshot of the segments whose current text still equals what was sent. */
export function historySnapshot({ source, target, direction, segments }) {
  const s = scalars(source);
  const t = scalars(target);
  const ok = (chars, region, sent) => Number.isSafeInteger(region?.start) && Number.isSafeInteger(region?.end)
    && region.start >= 0 && region.start <= region.end && region.end <= chars.length
    && chars.slice(region.start, region.end).join('') === sent;
  const kept = segments
    .filter(seg => ok(s, seg.sourceRegion, seg.sentSource) && ok(t, seg.targetRegion, seg.sentTarget))
    .sort((a, b) => a.segment_index - b.segment_index)
    .slice(0, 64)
    .map(seg => ({
      segment_index: seg.segment_index,
      source_start: seg.sourceRegion.start, source_end: seg.sourceRegion.end,
      target_start: seg.targetRegion.start, target_end: seg.targetRegion.end,
      report: seg.report,
    }));
  return kept.length === 0 ? null : { source, target, direction, segments: kept };
}

export const EXPORT_STATUSES = Object.freeze(['pending', 'accepted', 'adjusted', 'ignored', 'needs_reconfirmation', 'previously_applied', 'stale']);

const statusOf = (statuses, id) => (statuses instanceof Map ? statuses.get(id) : statuses?.[id]);

/** Flat rows for the Markdown export; `statuses` is a Map or object keyed by issue id. */
export function semanticExportItems({ issues, statuses }) {
  return issues.map(issue => {
    const given = statusOf(statuses, issue.id);
    return {
      issue_id: issue.id,
      category: issue.category,
      confidence: issue.confidence,
      segment_index: issue.segment_index ?? null,
      source_excerpt: issue.source_excerpt ?? null,
      target_excerpt: issue.target_excerpt ?? null,
      rationale: issue.rationale,
      suggestion: issue.suggestion ? issue.suggestion.replacement : null,
      suggestion_withheld: issue.suggestion_withheld ?? null,
      status: EXPORT_STATUSES.includes(given) ? given : (issue.stale ? 'stale' : 'pending'),
    };
  });
}

export function semanticIssuesResolved(statuses) {
  const values = statuses instanceof Map ? [...statuses.values()] : Object.values(statuses ?? {});
  return values.filter(v => v === 'accepted' || v === 'adjusted' || v === 'ignored').length;
}
