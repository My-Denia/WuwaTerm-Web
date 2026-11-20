// Workbench state for semantic review results and decisions (W2).
// Pure and browser-safe. Two coordinate systems are kept apart on purpose:
// - `issue` spans are whole-document coordinates of the texts the segment was
//   sent from (`result.doc`); decisions are recorded in them (manuscript v2).
// - `live` spans follow the current texts through edits; they are what the UI
//   highlights, locates and replaces. An edit that touches a live span makes the
//   issue stale instead of guessing where it went.
import { diffSplice, mapRegion, mapSpan, placeSegmentIssues, segmentKey } from './semantic-run.js';
import { reconcileSemanticDecisions } from './semantic-decisions.js';
import { MAX_SEMANTIC_DECISIONS } from './manuscript.js';
import { emptyLong, reconcileLong, recordView, segmentInputs, termSegmentKey } from './long-review.js';

export const DECIDED = Object.freeze(['accepted', 'adjusted', 'ignored']);

// `long` is the long-manuscript term review state (lib/long-review.js): segment records, choices,
// choice history and progress. It is user work, saved in manuscript v3 and carried by undo.
export function emptySemantic() {
  return { results: [], placed: [], decisions: [], texts: [], outcomes: [], history: [], long: emptyLong() };
}

/** Semantic state for a newly installed draft (typed, received or a text import): long-mode records for its segments. */
export function freshSemantic(draft) {
  return { ...emptySemantic(), long: reconcileLong(emptyLong(), { source: '', target: '', direction: draft.direction, alignments: null }, draft) };
}

function range(span) { return span === null || span === undefined ? null : [span.start, span.end]; }

/** Same key as the manuscript's duplicate check: one decision per occurrence. */
export function occurrenceKey(d) {
  return JSON.stringify([d.category, d.source_revision, d.target_revision, range(d.source_span), range(d.target_span)]);
}

/** The occurrence key an issue would get when decided now. */
export function placedOccurrence(result, issue) {
  return occurrenceKey({
    category: issue.category,
    source_revision: result.doc.sourceRevision,
    target_revision: result.doc.targetRevision,
    source_span: issue.source_span,
    target_span: issue.target_span,
  });
}

function overlaps(a, b) { return a.start < b.end && b.start < a.end; }

/** Derive the same segment identities and review state for display and request scheduling. */
export function semanticSegmentViews(draft, state, basis) {
  const inputs = segmentInputs(draft);
  const seen = new Map();
  const context = { draft, basis };
  const items = inputs.items.map((item, index) => {
    const { pair, sourceCore: sCore, targetCore: tCore } = item;
    const key = segmentKey(draft.direction, sCore, tCore);
    const ordinal = seen.get(key) ?? 0;
    seen.set(key, ordinal + 1);
    const sourceRegion = { start: pair.source.core_start, end: pair.source.core_end };
    const targetRegion = { start: pair.target.core_start, end: pair.target.core_end };
    const result = state.results.find(row => row.segmentKey === key
      && row.region.source.start === sourceRegion.start && row.region.target.start === targetRegion.start) ?? null;
    const edited = !result && state.results.some(row => overlaps(row.region.source, sourceRegion) || overlaps(row.region.target, targetRegion));
    return {
      pair, sCore, tCore, key, itemKey: `${key}#${ordinal}`, termKey: termSegmentKey(index, item),
      result, edited, record: inputs.long ? recordView(state.long, index, context) : null,
    };
  });
  return { long: inputs.long, pairs: items.map(item => item.pair), items };
}

/** Place a returned segment on the current draft, preserving unrelated edits. */
export function placeSemanticResult({ id, sentDoc, current, pair, sentSource, sentTarget, report, key, sourceRevision, targetRevision, imported = false }) {
  if (current.direction !== sentDoc.direction || JSON.stringify(current.alignments) !== JSON.stringify(sentDoc.alignments)) return null;
  const sourceEdit = diffSplice(sentDoc.source, current.source);
  const targetEdit = diffSplice(sentDoc.target, current.target);
  const region = {
    source: mapRegion({ start: pair.source.core_start, end: pair.source.core_end }, sourceEdit),
    target: mapRegion({ start: pair.target.core_start, end: pair.target.core_end }, targetEdit),
  };
  const slice = (text, range) => Array.from(text).slice(range.start, range.end).join('');
  if (slice(current.source, region.source) !== sentSource || slice(current.target, region.target) !== sentTarget) return null;
  const result = { id, segmentKey: key, index: pair.index, sentSource, sentTarget, report, imported,
    doc: { source: sentDoc.source, target: sentDoc.target, sourceRevision, targetRevision }, region };
  const follow = (span, edit, text) => span === null ? null : edit ? mapSpan(span, edit, text) : span;
  const placed = placeSegmentIssues({ report, pair }).map(issue => {
    const live = {
      source_span: follow(issue.source_span, sourceEdit, current.source),
      target_span: follow(issue.target_span, targetEdit, current.target),
      suggestion_span: follow(issue.suggestion?.target_span ?? null, targetEdit, current.target),
    };
    const stale = (issue.source_span !== null && live.source_span === null) || (issue.target_span !== null && live.target_span === null)
      || (issue.suggestion !== null && live.suggestion_span === null);
    return { id: `${id}:${issue.id}`, resultId: id, issue, occurrence: placedOccurrence(result, issue), live, stale };
  });
  return { result, placed };
}

/**
 * Follow one edit (the drafts before and after it) with every live span and
 * region. Nothing is guessed: a span the edit touched becomes stale. The long
 * state is reconciled on every edit, including a direction or alignment change
 * that leaves both texts as they were (lib/long-review.js reconcileLong).
 */
export function mapSemanticEdit(state, before, after) {
  // Drafts are full {source, target, direction, alignments} objects in the workbench; pass the same objects so
  // the per-draft caches of lib/long-review.js hold. A partial draft (texts only) leaves the long state alone.
  const full = d => typeof d.direction === 'string' && d.alignments !== undefined;
  const long = state.long && full(before) && full(after) ? reconcileLong(state.long, before, after) : state.long;
  const s = diffSplice(before.source, after.source);
  const t = diffSplice(before.target, after.target);
  if (!s && !t) return long === state.long ? state : { ...state, long };
  const results = state.results.map(r => ({
    ...r,
    region: {
      source: s ? mapRegion(r.region.source, s) : r.region.source,
      target: t ? mapRegion(r.region.target, t) : r.region.target,
    },
  }));
  const placed = state.placed.map(p => {
    const follow = (span, splice, text) => (span === null ? null : splice ? mapSpan(span, splice, text) : span);
    const live = {
      source_span: follow(p.live.source_span, s, after.source),
      target_span: follow(p.live.target_span, t, after.target),
      suggestion_span: follow(p.live.suggestion_span, t, after.target),
    };
    const lost = (p.live.source_span !== null && live.source_span === null)
      || (p.live.target_span !== null && live.target_span === null)
      || (p.live.suggestion_span !== null && live.suggestion_span === null);
    return { ...p, live, stale: p.stale || lost };
  });
  return { ...state, results, placed, long };
}

/** Whether the long state holds user work: a result, a choice or a history choice. */
export function longHoldsWork(long) {
  return !!long && (long.history.length > 0 || long.records.some(r => r.result !== null || r.choices.length > 0));
}

/**
 * Add one segment result. Results whose live regions overlap the new one on
 * either side are replaced (the segment was reviewed again), together with
 * their issues. `placed` are the new issues, live spans already current.
 */
export function addSegmentResult(state, result, placed, texts = []) {
  const replaced = new Set(state.results
    .filter(r => overlaps(r.region.source, result.region.source) || overlaps(r.region.target, result.region.target))
    .map(r => r.id));
  const known = new Set(state.texts.map(x => x.revision));
  const fresh = texts.filter(x => !known.has(x.revision) && known.add(x.revision));
  return {
    ...state,
    results: [...state.results.filter(r => !replaced.has(r.id)), result],
    placed: [...state.placed.filter(p => !replaced.has(p.resultId)), ...placed],
    // Newest first: the save budget keeps the newest texts.
    texts: [...fresh.reverse(), ...state.texts],
    outcomes: state.outcomes.filter(o => !replaced.has(o.resultId)),
  };
}

export function decisionFor(state, placed) {
  return state.decisions.find(d => occurrenceKey(d) === placed.occurrence) ?? null;
}

/**
 * Replace the decision at the same occurrence, else append; null when the cap is reached.
 * @param {object} state
 * @param {object} decision
 * @param {string | null} [placedId] the issue the user decided on; its merge outcome is cleared
 */
export function upsertDecision(state, decision, placedId = null) {
  const key = occurrenceKey(decision);
  const index = state.decisions.findIndex(d => occurrenceKey(d) === key);
  if (index < 0 && state.decisions.length >= MAX_SEMANTIC_DECISIONS) return null;
  const decisions = index < 0 ? [...state.decisions, decision] : state.decisions.map((d, i) => (i === index ? decision : d));
  return { ...state, decisions, outcomes: placedId === null ? state.outcomes : state.outcomes.filter(o => o.placedId !== placedId) };
}

export function removeDecision(state, key) {
  return { ...state, decisions: state.decisions.filter(d => occurrenceKey(d) !== key) };
}

/**
 * Status shown for one issue. Own decisions win; then the re-review merge
 * outcome for an older decision; then stale; else pending.
 */
export function issueStatus(state, placed) {
  const own = decisionFor(state, placed);
  if (own) return { status: own.decision, decision: own, reference: null };
  const outcome = state.outcomes.find(o => o.placedId === placed.id);
  // A carried `ignored` decision from an earlier review applies to this occurrence.
  if (outcome?.status === 'carried') return { status: 'ignored', decision: outcome.decision, reference: null };
  if (outcome?.status === 'previously_applied') return { status: 'previously_applied', decision: null, reference: outcome.decision };
  if (outcome?.status === 'needs_reconfirmation') return { status: 'needs_reconfirmation', decision: null, reference: outcome.decision };
  if (placed.stale) return { status: 'stale', decision: null, reference: null };
  return { status: 'pending', decision: null, reference: null };
}

export function isHandled(status) { return DECIDED.includes(status); }

/**
 * Re-review merge (lib/semantic-decisions.js) for decisions that do not sit on
 * an issue of this session. Outcomes are display state only: decisions are kept
 * as recorded (with the old texts they need), so importing a manuscript does not
 * by itself change what would be saved.
 */
export async function reconcileState(state, { source, target }) {
  const own = new Set(state.placed.map(p => p.occurrence));
  const open = state.decisions.filter(d => !own.has(occurrenceKey(d)));
  if (open.length === 0) return { ...state, outcomes: [] };
  const issues = state.placed.filter(p => !p.stale).map(p => ({
    id: p.id, fingerprint: p.issue.fingerprint, category: p.issue.category,
    source_span: p.live.source_span, target_span: p.live.target_span,
  }));
  const { results } = await reconcileSemanticDecisions({ decisions: open, texts: state.texts, source, target, issues });
  const outcomes = [];
  for (const r of results) {
    const placed = r.issue_id ? state.placed.find(p => p.id === r.issue_id) : null;
    if (placed && (r.status === 'carried' || r.status === 'previously_applied' || r.status === 'needs_reconfirmation')) {
      outcomes.push({ placedId: placed.id, resultId: placed.resultId, status: r.status, code: r.code, decision: r.decision });
    } else if (r.status === 'needs_reconfirmation') {
      // Candidates exist but none sits where the decision recovers: show it on each.
      for (const p of state.placed.filter(x => x.issue.fingerprint === r.decision.fingerprint && x.issue.category === r.decision.category)) {
        outcomes.push({ placedId: p.id, resultId: p.resultId, status: r.status, code: r.code, decision: r.decision });
      }
    }
  }
  return { ...state, outcomes };
}

/** Counts for the overview; `statusOf` is issueStatus bound to the state. */
export function semanticCounts(state) {
  const counts = { total: 0, pending: 0, handled: 0, reconfirm: 0, stale: 0 };
  for (const p of state.placed) {
    const { status } = issueStatus(state, p);
    counts.total += 1;
    if (isHandled(status)) counts.handled += 1;
    else if (status === 'needs_reconfirmation' || status === 'previously_applied') counts.reconfirm += 1;
    else if (status === 'stale') counts.stale += 1;
    else counts.pending += 1;
  }
  return counts;
}
