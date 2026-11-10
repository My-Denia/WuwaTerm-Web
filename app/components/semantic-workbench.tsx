'use client';

// Semantic review, segmented runs and manual splitting for the review workbench (W2).
// The parent owns the draft, the undo history and the semantic state; this
// component owns the serial run (its own AbortController, so ordinary edits
// never abort an already charged request) and the issue navigation.
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { guardPairForRequest, pairSegments, segmentText, SEGMENT_LIMIT } from '../../lib/segmentation.js';
import {
  classifyFailure, contextBefore, diffSplice, fitRequestBody, initialRun, mapRegion, mapSpan, nextQueued,
  historySnapshot, placeSegmentIssues, runProgress, runReducer, segmentKey, selectPrecedents, semanticExportItems,
  semanticIssuesResolved, semanticTextsWithinBudget,
} from '../../lib/semantic-run.js';
import {
  CAPABILITY_SEMANTIC_REVIEW, CAPABILITY_TRANSLATION_CONTEXT, SEMANTIC_CATEGORIES, SEMANTIC_REVIEW_VERSION,
  applySemanticSuggestion, validSemanticReviewResponse, verifySemanticReviewIdentity,
} from '../../lib/semantic-review.js';
import { makeSemanticDecision } from '../../lib/semantic-decisions.js';
import {
  addSegmentResult, addTermResult, decisionFor, emptySemantic, isHandled, issueStatus, occurrenceKey, placedOccurrence,
  reconcileState, removeDecision, upsertDecision,
} from '../../lib/semantic-state.js';
import { insertParagraphBreak, linesToParagraphs, mergeParagraphs, pairShape, singleBreaks, splitLayout } from '../../lib/manual-split.js';
import { recoverSpan, validReport } from '../../lib/manuscript.js';
import { highlightSegments, revisionOf } from '../../lib/review-report.js';
import { compactScalarContext } from '../../lib/review-navigation.js';
import { fill, msg } from '../../lib/messages';
import { semanticMsg, type SemanticMessages } from '../../lib/semantic-messages';
import { requestPoolRefresh, type Pool } from '../../lib/pool-snapshot';
import { workbenchPath } from '../../lib/ui-runtime';
import { numberLocale, type UiLanguage } from '../../lib/ui-language';

/**
 * Precedents are sent by default only because the Core evaluation's M′ gates
 * (same-sense reuse and led-astray) were met for them; re-read the C2 receipt
 * when the backend pin moves and turn this off if they are not.
 */
export const PRECEDENTS_DEFAULT_ON = true;

export type Span = { start: number; end: number; text: string };
type Region = { start: number; end: number };
type PairRegion = { start: number; end: number; core_start: number; core_end: number };
type Pair = { index: number; status: 'ready' | 'needs_manual_split' | 'untranslated' | 'unpaired_target'; hard_cut: boolean; source: PairRegion; target: PairRegion };
export type Draft = { source: string; target: string; direction: 'en' | 'zh'; alignments: { source: Span; target: Span | null }[] | null };
type Suggestion = { target_span: Span; replacement: string; term_effect: string };
type Issue = {
  id: string; fingerprint: string; category: string; origin: string; confidence: string;
  source_span: Span | null; target_span: Span | null; source_excerpt: string | null; target_excerpt: string | null;
  rationale: string; suggestion: Suggestion | null; suggestion_withheld: string | null;
  alternatives: { replacement: string; term_effect: string }[]; segment_index: number;
};
type SemanticReport = { term_basis: { dictionary_revision: string; matcher_revision: string }; issues: Issue[]; status: string; truncated: boolean; omitted_issues: number; dropped_unanchored: number } & Record<string, unknown>;
export type SegResult = {
  id: string; segmentKey: string; index: number; sentSource: string; sentTarget: string; report: SemanticReport;
  doc: { source: string; target: string; sourceRevision: string; targetRevision: string };
  region: { source: Region; target: Region }; imported: boolean;
};
export type Placed = {
  id: string; resultId: string; issue: Issue; occurrence: string; stale: boolean;
  live: { source_span: Span | null; target_span: Span | null; suggestion_span: Span | null };
};
type TermFinding = { id: string; verdict: string; source_span: Span; target_span: Span | null; candidates: { candidate_id: string; zh: string; en: string; category: string }[] };
export type TermResult = { id: string; segmentKey: string; report: { findings: TermFinding[] }; sourceOffset: number; targetOffset: number; region: { source: Region; target: Region } };
export type Decision = {
  issue_id: string; fingerprint: string; category: string; segment_index: number; source_revision: string; target_revision: string;
  source_span: Span | null; target_span: Span | null; decision: 'accepted' | 'adjusted' | 'ignored'; applied_text: string | null;
  basis: { review_version: string; term_basis: { dictionary_revision: string; matcher_revision: string } };
};
type Outcome = { placedId: string; resultId: string; status: string; code: string; decision: Decision };
export type SemanticState = {
  results: SegResult[]; placed: Placed[]; decisions: Decision[]; texts: { revision: string; text: string }[];
  outcomes: Outcome[]; history: unknown[]; terms: TermResult[];
};
type ChoiceLike = { source: string; source_span: Span; choice: string; candidate: { zh: string; en: string } | null };
type PoolView = { kind: 'loading' } | { kind: 'success'; data: Pool } | { kind: 'error' };
type RunItem = { key: string; index: number; status: string; code: string | null };
type RunState = { kind: 'term' | 'semantic' | 'translate' | null; phase: string; items: RunItem[]; waitUntil: number | null; stopCode: string | null };
/** Applies a draft edit and/or semantic change; returns the serial of the undo entry it pushed, else null. */
export type Commit = (next: { draft?: Draft; semantic?: (state: SemanticState) => SemanticState; notice?: string | null; remember?: boolean }) => number | null;
export type WorkRef = MutableRefObject<{ draft: Draft; semantic: SemanticState }>;

type Props = {
  lang: UiLanguage;
  draft: Draft;
  semantic: SemanticState;
  setSemantic: (update: (state: SemanticState) => SemanticState) => void;
  commit: Commit;
  work: WorkRef;
  choices: ChoiceLike[];
  pool: PoolView;
  capabilities: string[] | null;
  resetSignal: number;
  canUndoLast: (serial: number) => boolean;
  undo: () => void;
  locate: (side: 'source' | 'target', span: Span) => void;
  onRunActive: (active: boolean) => void;
  termTrack: ReactNode;
};

const uid = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
const chars = (text: string) => Array.from(text);
const slice = (list: string[], start: number, end: number) => list.slice(start, end).join('');
const sliceEquals = (text: string, span: Span | null) => !!span && slice(chars(text), span.start, span.end) === span.text;
const overlaps = (a: Region, b: Region) => a.start < b.end && b.start < a.end;
function safePairs(source: string, target: string, alignments: Draft['alignments']): Pair[] {
  if (!source.trim() && !target.trim()) return [];
  try {
    const explicit = (alignments && alignments.length ? alignments : null) as never;
    return (pairSegments(source, target, SEGMENT_LIMIT, explicit) as Pair[]).map(p => guardPairForRequest(p) as Pair);
  } catch { return []; }
}
async function responseBody(response: Response): Promise<Record<string, unknown> | null> {
  try { const value = await response.json(); return value && typeof value === 'object' ? value as Record<string, unknown> : null; } catch { return null; }
}
function failureOf(response: Response, body: Record<string, unknown> | null) {
  const reason = typeof body?.reason === 'string' ? body.reason : 'fallback';
  const header = Number(response.headers.get('retry-after'));
  const retry = typeof body?.retry_after_seconds === 'number' ? body.retry_after_seconds : Number.isFinite(header) && header > 0 ? header : undefined;
  return { code: reason, classification: classifyFailure({ status: response.status, reason, retryAfterSeconds: retry }) };
}

type PairView = {
  pair: Pair; sCore: string; tCore: string; key: string; itemKey: string;
  result: SegResult | null; term: TermResult | null; edited: boolean; termEdited: boolean;
};

/** Text with the active issue (and quieter marks for others) highlighted. */
function Marked({ text, offset, marks, activeRef }: { text: string; offset: number; marks: { span: Span; active: boolean }[]; activeRef: MutableRefObject<HTMLElement | null> }) {
  const list = chars(text);
  const sorted = marks
    .map(m => ({ start: m.span.start - offset, end: m.span.end - offset, active: m.active }))
    .filter(m => m.start >= 0 && m.end <= list.length && m.start < m.end)
    .sort((a, b) => a.start - b.start || Number(b.active) - Number(a.active));
  const parts: { text: string; mark: null | 'active' | 'other' }[] = [];
  let at = 0;
  for (const m of sorted) {
    if (m.start < at) continue;
    if (m.start > at) parts.push({ text: slice(list, at, m.start), mark: null });
    parts.push({ text: slice(list, m.start, m.end), mark: m.active ? 'active' : 'other' });
    at = m.end;
  }
  if (at < list.length) parts.push({ text: slice(list, at, list.length), mark: null });
  return <p className="compare-text">{parts.map((part, i) => part.mark === null ? <span key={i}>{part.text}</span>
    : <mark key={i} className={part.mark === 'active' ? 'compare-active' : 'compare-other'} ref={part.mark === 'active' ? el => { activeRef.current = el; } : undefined}>{part.text}</mark>)}</p>;
}

function Snippet({ text, span, missing }: { text: string; span: Span | null; missing: string }) {
  const compact = span && highlightSegments(text, span) ? compactScalarContext(text, span) : null;
  if (!compact) return <p className="review-excerpt">{missing}</p>;
  return <p className="review-excerpt">{compact.clippedBefore ? '…' : null}{compact.before}<mark>{compact.hit}</mark>{compact.after}{compact.clippedAfter ? '…' : null}</p>;
}

export function SemanticWorkbench(props: Props) {
  const { lang, draft, semantic, setSemantic, commit, work, choices, pool, capabilities, resetSignal, locate, onRunActive } = props;
  const { source, target, direction } = draft;
  const s = semanticMsg(lang);
  const m = msg(lang);
  const locale = numberLocale(lang);
  const [run, dispatch] = useReducer(runReducer as (state: RunState, event: Record<string, unknown>) => RunState, undefined, initialRun as () => RunState);
  const runGeneration = useRef(0);
  const runAbort = useRef<AbortController | null>(null);
  const inflight = useRef<string | null>(null);
  const translateRun = useRef<{ source: string; direction: 'en' | 'zh'; segments: { start: number; end: number; core_start: number; core_end: number }[]; pieces: string[]; base: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [usePrecedents, setUsePrecedents] = useState(PRECEDENTS_DEFAULT_ON);
  const [statusFilter, setStatusFilter] = useState<'pending' | 'handled' | 'reconfirm' | 'all'>('pending');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [segmentFilter, setSegmentFilter] = useState<number | 'all'>('all');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [choiceState, setChoiceState] = useState<{ id: string | null; value: 'suggestion' | 'alternative' }>({ id: null, value: 'suggestion' });
  const [adjusting, setAdjusting] = useState<{ placedId: string; text: string } | null>(null);
  const [selectedSegment, setSelectedSegment] = useState<number | null>(null);
  const [splitOpen, setSplitOpen] = useState<number | null>(null);
  const [pendingCut, setPendingCut] = useState<{ side: 'source' | 'target'; offset: number; label: string } | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [lastAction, setLastAction] = useState<{ placedId: string; marker: number; kind: string } | null>(null);
  const [pairTranslating, setPairTranslating] = useState<number | null>(null);
  const activeMark = useRef<HTMLElement | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);

  const semanticOn = !!capabilities?.includes(CAPABILITY_SEMANTIC_REVIEW);
  const contextOn = !!capabilities?.includes(CAPABILITY_TRANSLATION_CONTEXT);
  const sourceChars = useMemo(() => chars(source), [source]);
  const targetChars = useMemo(() => chars(target), [target]);
  const long = sourceChars.length > 2000 || targetChars.length > 2000;
  const pairs = useMemo(() => safePairs(source, target, draft.alignments), [source, target, draft.alignments]);
  const views: PairView[] = useMemo(() => {
    const seen = new Map<string, number>();
    return pairs.map(pair => {
      const sCore = slice(sourceChars, pair.source.core_start, pair.source.core_end);
      const tCore = slice(targetChars, pair.target.core_start, pair.target.core_end);
      const key = segmentKey(direction, sCore, tCore) as string;
      const ordinal = seen.get(key) ?? 0; seen.set(key, ordinal + 1);
      const here = { start: pair.source.core_start, end: pair.source.core_end };
      const hereT = { start: pair.target.core_start, end: pair.target.core_end };
      const result = semantic.results.find(r => r.segmentKey === key && r.region.source.start === pair.source.core_start && r.region.target.start === pair.target.core_start) ?? null;
      const term = semantic.terms.find(r => r.segmentKey === key && r.region.source.start === pair.source.core_start && r.region.target.start === pair.target.core_start) ?? null;
      const edited = !result && semantic.results.some(r => overlaps(r.region.source, here) || overlaps(r.region.target, hereT));
      const termEdited = !term && semantic.terms.some(r => overlaps(r.region.source, here) || overlaps(r.region.target, hereT));
      return { pair, sCore, tCore, key, itemKey: `${key}#${ordinal}`, result, term, edited, termEdited };
    });
  }, [pairs, sourceChars, targetChars, direction, semantic.results, semantic.terms]);
  const ready = views.filter(v => v.pair.status === 'ready');
  const runActive = run.phase === 'running' || run.phase === 'waiting' || (run.phase === 'paused' && run.items.some(i => i.status === 'sending'));
  useEffect(() => { onRunActive(runActive || pairTranslating !== null); }, [runActive, pairTranslating, onRunActive]);

  // ---- run engine ----
  // Import, clear or a received draft replaces the manuscript: stop sending.
  const [resetSeen, setResetSeen] = useState(resetSignal);
  if (resetSeen !== resetSignal) {
    setResetSeen(resetSignal);
    dispatch({ type: 'reset' }); setActiveId(null); setSelectedSegment(null); setSplitOpen(null); setLastAction(null);
  }
  useEffect(() => {
    runGeneration.current += 1; runAbort.current?.abort(); runAbort.current = null; inflight.current = null; translateRun.current = null;
  }, [resetSignal]);
  useEffect(() => () => { runAbort.current?.abort(); }, []);
  useEffect(() => {
    if (run.phase !== 'waiting' || run.waitUntil === null) return;
    const tick = () => {
      setNow(Date.now());
      if (Date.now() >= (run.waitUntil ?? 0)) dispatch({ type: 'resume' });
    };
    // Refresh at once so the countdown starts from the server's stated wait.
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 1000);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [run.phase, run.waitUntil]);

  // A failure may start a wait; the countdown is measured from the failure itself.
  function failRun(event: Record<string, unknown> & { now: number }) { setNow(event.now); dispatch(event); }
  const viewsFor = () => {
    const { draft: d } = work.current;
    const list = safePairs(d.source, d.target, d.alignments);
    const sc = chars(d.source); const tc = chars(d.target);
    const seen = new Map<string, number>();
    return { draft: d, pairs: list, items: list.map(pair => {
      const sCore = slice(sc, pair.source.core_start, pair.source.core_end);
      const tCore = slice(tc, pair.target.core_start, pair.target.core_end);
      const key = segmentKey(d.direction, sCore, tCore) as string;
      const ordinal = seen.get(key) ?? 0; seen.set(key, ordinal + 1);
      return { pair, sCore, tCore, key, itemKey: `${key}#${ordinal}` };
    }) };
  };

  const precedentItems = (d: Draft, state: SemanticState) => {
    const items: { span: Span; choice: string; rendering: string | null }[] = [];
    for (const c of choices) {
      const span = recoverSpan(c.source, c.source_span, d.source) as Span | null;
      if (!span) continue;
      items.push({ span, choice: c.choice, rendering: c.choice === 'not_a_term' ? null : c.candidate ? (d.direction === 'en' ? c.candidate.en : c.candidate.zh) : null });
    }
    for (const p of state.placed) {
      const decided = decisionFor(state, p) as Decision | null;
      if (!decided || decided.decision === 'ignored' || !p.live.source_span || !decided.applied_text) continue;
      items.push({ span: p.live.source_span, choice: 'user_rendering', rendering: decided.applied_text });
    }
    return items;
  };

  const place = async (sentDoc: Draft, pair: Pair, sentSource: string, sentTarget: string, report: SemanticReport, key: string, imported = false) => {
    const [sourceRevision, targetRevision] = await Promise.all([revisionOf(sentDoc.source), revisionOf(sentDoc.target)]);
    const current = work.current.draft;
    // A report is only about the direction it was asked in.
    if (current.direction !== sentDoc.direction) return false;
    const ss = diffSplice(sentDoc.source, current.source); const ts = diffSplice(sentDoc.target, current.target);
    const region = {
      source: ss ? mapRegion({ start: pair.source.core_start, end: pair.source.core_end }, ss) : { start: pair.source.core_start, end: pair.source.core_end },
      target: ts ? mapRegion({ start: pair.target.core_start, end: pair.target.core_end }, ts) : { start: pair.target.core_start, end: pair.target.core_end },
    };
    if (slice(chars(current.source), region.source.start, region.source.end) !== sentSource
      || slice(chars(current.target), region.target.start, region.target.end) !== sentTarget) return false;
    const result: SegResult = { id: uid(), segmentKey: key, index: pair.index, sentSource, sentTarget, report, imported,
      doc: { source: sentDoc.source, target: sentDoc.target, sourceRevision, targetRevision }, region };
    const follow = (span: Span | null, splice: ReturnType<typeof diffSplice>, text: string) => span === null ? null : splice ? mapSpan(span, splice, text) as Span | null : span;
    const placed: Placed[] = (placeSegmentIssues({ report, pair }) as Issue[]).map(issue => {
      const live = {
        source_span: follow(issue.source_span, ss, current.source),
        target_span: follow(issue.target_span, ts, current.target),
        suggestion_span: follow(issue.suggestion?.target_span ?? null, ts, current.target),
      };
      const stale = (issue.source_span !== null && live.source_span === null) || (issue.target_span !== null && live.target_span === null)
        || (issue.suggestion !== null && live.suggestion_span === null);
      return { id: `${result.id}:${issue.id}`, resultId: result.id, issue, occurrence: placedOccurrence(result, issue) as string, live, stale };
    });
    setSemantic(state => addSegmentResult(state, result, placed, [
      { revision: sourceRevision, text: sentDoc.source }, { revision: targetRevision, text: sentDoc.target },
    ]) as SemanticState);
    return true;
  };

  const sendSemantic = async (item: RunItem, signal: AbortSignal, generation: number) => {
    const live = () => runGeneration.current === generation;
    const { draft: d, pairs: list, items } = viewsFor();
    const found = items.find(v => v.itemKey === item.key && v.pair.status === 'ready');
    if (!found) { dispatch({ type: 'skip', key: item.key }); return; }
    const precedents = usePrecedents ? selectPrecedents({ items: precedentItems(d, work.current.semantic), source: d.source, pairs: list, segmentIndex: found.pair.index }) : [];
    const before = contextBefore({ pairs: list, segmentIndex: found.pair.index, source: d.source, target: d.target });
    const fitted = fitRequestBody({
      source: found.sCore, target: found.tCore, direction: d.direction, review_version: SEMANTIC_REVIEW_VERSION, explain_language: lang,
      ...(before ? { context: { before } } : {}), ...(precedents.length ? { precedents } : {}),
    });
    if (!fitted.fits) { failRun({ type: 'failed', key: item.key, code: 'bodyTooLarge', classification: { action: 'segment_failed' }, now: Date.now() }); return; }
    try {
      const response = await fetch(workbenchPath('/api/semantic-reviews'), { method: 'POST', headers: { 'content-type': 'application/json' }, cache: 'no-store', body: JSON.stringify(fitted.body), signal });
      const body = await responseBody(response);
      if (!live()) return;
      requestPoolRefresh();
      if (!response.ok) { failRun({ type: 'failed', key: item.key, ...failureOf(response, body), now: Date.now() }); return; }
      if (!validSemanticReviewResponse(body, found.sCore, found.tCore) || !await verifySemanticReviewIdentity(body, found.sCore, found.tCore)) {
        if (live()) failRun({ type: 'failed', key: item.key, code: 'responseInvalid', classification: { action: 'segment_failed' }, now: Date.now() });
        return;
      }
      const report = body as unknown as SemanticReport;
      if (report.status === 'not_reviewed') { failRun({ type: 'failed', key: item.key, code: 'not_reviewed', classification: { action: 'segment_failed' }, now: Date.now() }); return; }
      const ok = await place(d, found.pair, found.sCore, found.tCore, report, found.key);
      if (!live()) return;
      dispatch(ok ? { type: 'done', key: item.key } : { type: 'skip', key: item.key });
    } catch {
      if (live() && !signal.aborted) failRun({ type: 'failed', key: item.key, code: 'requestFailed', classification: { action: 'segment_failed' }, now: Date.now() });
    }
  };

  const sendTerm = async (item: RunItem, signal: AbortSignal, generation: number) => {
    const live = () => runGeneration.current === generation;
    const { draft: d, items } = viewsFor();
    const found = items.find(v => v.itemKey === item.key && v.pair.status === 'ready');
    if (!found) { dispatch({ type: 'skip', key: item.key }); return; }
    try {
      const response = await fetch(workbenchPath('/api/reviews'), { method: 'POST', headers: { 'content-type': 'application/json' }, cache: 'no-store', signal,
        body: JSON.stringify({ source: found.sCore, target: found.tCore, direction: d.direction, review_version: 'review-v2' }) });
      const body = await responseBody(response);
      if (!live()) return;
      requestPoolRefresh();
      if (!response.ok) { failRun({ type: 'failed', key: item.key, ...failureOf(response, body), now: Date.now() }); return; }
      if (!validReport(body, found.sCore, found.tCore) || body?.rule_version !== 'review-v2'
        || body?.source_revision !== await revisionOf(found.sCore) || body?.target_revision !== await revisionOf(found.tCore)) {
        if (live()) failRun({ type: 'failed', key: item.key, code: 'responseInvalid', classification: { action: 'segment_failed' }, now: Date.now() });
        return;
      }
      const current = work.current.draft;
      if (current.direction !== d.direction) { dispatch({ type: 'skip', key: item.key }); return; }
      const ss = diffSplice(d.source, current.source); const ts = diffSplice(d.target, current.target);
      const region = {
        source: ss ? mapRegion({ start: found.pair.source.core_start, end: found.pair.source.core_end }, ss) : { start: found.pair.source.core_start, end: found.pair.source.core_end },
        target: ts ? mapRegion({ start: found.pair.target.core_start, end: found.pair.target.core_end }, ts) : { start: found.pair.target.core_start, end: found.pair.target.core_end },
      };
      if (slice(chars(current.source), region.source.start, region.source.end) !== found.sCore || slice(chars(current.target), region.target.start, region.target.end) !== found.tCore) {
        dispatch({ type: 'skip', key: item.key }); return;
      }
      const result: TermResult = { id: uid(), segmentKey: found.key, report: body as unknown as TermResult['report'], sourceOffset: found.pair.source.core_start, targetOffset: found.pair.target.core_start, region };
      setSemantic(state => addTermResult(state, result) as SemanticState);
      dispatch({ type: 'done', key: item.key });
    } catch {
      if (live() && !signal.aborted) failRun({ type: 'failed', key: item.key, code: 'requestFailed', classification: { action: 'segment_failed' }, now: Date.now() });
    }
  };

  // The translation is assembled in order, so a failed segment is never skipped:
  // anything but a wait or a quota pause stops the run with that segment queued,
  // and continuing sends it first.
  const inOrder = (failure: ReturnType<typeof failureOf>) => (['wait', 'pause_quota'].includes((failure.classification as { action: string }).action)
    ? failure : { ...failure, classification: { action: 'stop' } });
  const sendTranslate = async (item: RunItem, signal: AbortSignal, generation: number) => {
    const live = () => runGeneration.current === generation;
    const plan = translateRun.current;
    const d = work.current.draft;
    // The run translates one source in one direction; any change stops it before sending.
    if (!plan || d.source !== plan.source || d.direction !== plan.direction || d.target !== plan.base + plan.pieces.join('')) {
      failRun({ type: 'failed', key: item.key, code: 'translateTargetChanged', classification: { action: 'stop' }, now: Date.now() });
      commit({ semantic: x => x, notice: 'sem:translateTargetChanged', remember: false });
      return;
    }
    const segment = plan.segments[item.index];
    const sc = chars(d.source);
    const core = slice(sc, segment.core_start, segment.core_end);
    const prev = item.index > 0 ? plan.segments[item.index - 1] : null;
    const previousPiece = item.index > 0 ? plan.pieces[item.index - 1] : '';
    const before = prev ? { source: chars(slice(sc, prev.core_start, prev.core_end)).slice(-400).join(''), target: chars(previousPiece.trim()).slice(-400).join('') } : null;
    const fitted = fitRequestBody({ text: core, to: plan.direction, ...(contextOn && before ? { context: { before } } : {}) });
    if (!fitted.fits) { failRun({ type: 'failed', key: item.key, code: 'bodyTooLarge', classification: { action: 'stop' }, now: Date.now() }); return; }
    try {
      const response = await fetch(workbenchPath('/api/translations'), { method: 'POST', headers: { 'content-type': 'application/json' }, cache: 'no-store', body: JSON.stringify(fitted.body), signal });
      const body = await responseBody(response);
      if (!live()) return;
      requestPoolRefresh();
      if (!response.ok || typeof body?.text !== 'string') {
        failRun({ type: 'failed', key: item.key, ...(response.ok ? { code: 'responseInvalid', classification: { action: 'stop' } } : inOrder(failureOf(response, body))), now: Date.now() });
        return;
      }
      const latest = work.current.draft;
      if (latest.source !== plan.source || latest.direction !== plan.direction || latest.target !== plan.base + plan.pieces.join('')) {
        failRun({ type: 'failed', key: item.key, code: 'translateTargetChanged', classification: { action: 'stop' }, now: Date.now() });
        commit({ semantic: x => x, notice: 'sem:translateTargetChanged', remember: false });
        return;
      }
      const piece = slice(sc, segment.start, segment.core_start) + body.text + slice(sc, segment.core_end, segment.end);
      plan.pieces[item.index] = piece;
      const done = plan.pieces.filter(p => p !== undefined).length === plan.segments.length;
      commit({ draft: { ...latest, target: plan.base + plan.pieces.join(''), alignments: latest.alignments === null ? null : [] }, remember: false, notice: done ? 'sem:translateRunDone' : null });
      dispatch({ type: 'done', key: item.key });
    } catch {
      if (live() && !signal.aborted) failRun({ type: 'failed', key: item.key, code: 'requestFailed', classification: { action: 'stop' }, now: Date.now() });
    }
  };

  const runners = useRef({ term: sendTerm, translate: sendTranslate, semantic: sendSemantic });
  useLayoutEffect(() => { runners.current = { term: sendTerm, translate: sendTranslate, semantic: sendSemantic }; });
  useEffect(() => {
    const item = nextQueued(run) as RunItem | null;
    if (!item || inflight.current) return;
    inflight.current = item.key;
    dispatch({ type: 'sent', key: item.key });
    const abort = new AbortController(); runAbort.current = abort;
    const generation = runGeneration.current;
    const runner = runners.current[run.kind ?? 'semantic'];
    void runner(item, abort.signal, generation).catch(() => {
      // A runner that throws must not leave its item sending forever.
      if (runGeneration.current === generation) failRun({ type: 'failed', key: item.key, code: 'requestFailed', classification: { action: 'stop' }, now: Date.now() });
    }).finally(() => {
      if (runGeneration.current === generation) inflight.current = null;
      if (runAbort.current === abort) runAbort.current = null;
    });
  }, [run]);

  function startRun(kind: 'term' | 'semantic', only?: PairView[]) {
    runGeneration.current += 1; runAbort.current?.abort(); inflight.current = null;
    const list = only ?? ready.filter(v => (kind === 'semantic' ? !v.result : !v.term));
    setSelectedSegment(null);
    dispatch({ type: 'start', kind, items: list.map(v => ({ key: v.itemKey, index: v.pair.index })) });
  }
  function startTranslateRun() {
    const d = work.current.draft;
    if (!d.source.trim() || d.target.trim()) return;
    const segments = segmentText(d.source) as { start: number; end: number; core_start: number; core_end: number }[];
    runGeneration.current += 1; runAbort.current?.abort(); inflight.current = null;
    translateRun.current = { source: d.source, direction: d.direction, segments, pieces: [], base: '' };
    // One undo step for the whole generated translation: the blank target before it.
    commit({ draft: { ...d, target: '' }, remember: true, notice: null });
    dispatch({ type: 'start', kind: 'translate', items: segments.map((_, index) => ({ key: `tr#${index}`, index })) });
  }

  async function translatePair(view: PairView) {
    if (pairTranslating !== null || !view.sCore.trim()) return;
    const d = work.current.draft;
    const list = safePairs(d.source, d.target, d.alignments);
    const before = contextBefore({ pairs: list, segmentIndex: view.pair.index, source: d.source, target: d.target });
    const precedents = usePrecedents ? selectPrecedents({ items: precedentItems(d, work.current.semantic), source: d.source, pairs: list, segmentIndex: view.pair.index }) : [];
    const context = contextOn && (before || precedents.length) ? { context: { ...(before ? { before } : {}), ...(precedents.length ? { precedents } : {}) } } : {};
    const fitted = fitRequestBody({ text: view.sCore, to: d.direction, ...context });
    if (!fitted.fits) return;
    setPairTranslating(view.pair.index);
    try {
      const response = await fetch(workbenchPath('/api/translations'), { method: 'POST', headers: { 'content-type': 'application/json' }, cache: 'no-store', body: JSON.stringify(fitted.body) });
      const body = await responseBody(response);
      requestPoolRefresh();
      if (!response.ok || typeof body?.text !== 'string') { commit({ semantic: x => x, notice: `t:${typeof body?.reason === 'string' ? body.reason : 'fallback'}`, remember: false }); return; }
      const latest = work.current.draft;
      const tc = chars(latest.target);
      const region = view.pair.target;
      if (latest.source !== d.source || latest.target !== d.target || latest.direction !== d.direction) { commit({ semantic: x => x, notice: 'sem:segmentChanged', remember: false }); return; }
      const head = slice(tc, 0, region.start); const ws = slice(tc, region.start, region.end); const tail = slice(tc, region.end, tc.length);
      const lead = head && !/\n[ \t\r]*\n[ \t\r]*$/u.test(head + ws) ? '\n\n' : '';
      const trail = tail && !/^[ \t\r]*\n[ \t\r]*\n/u.test(tail) ? '\n\n' : '';
      commit({ draft: { ...latest, target: head + ws + lead + body.text + trail + tail, alignments: latest.alignments === null ? null : [] }, notice: 'sem:translated' });
    } catch {
      commit({ semantic: x => x, notice: 't:fallback', remember: false });
    } finally { setPairTranslating(null); }
  }

  // ---- re-review merge for older decisions ----
  useEffect(() => {
    let cancelled = false;
    const snapshot = work.current;
    if (snapshot.semantic.decisions.length === 0 || snapshot.semantic.placed.length === 0) return;
    void (async () => {
      const next = await reconcileState(snapshot.semantic, { source: snapshot.draft.source, target: snapshot.draft.target }) as SemanticState;
      if (cancelled || work.current.semantic !== snapshot.semantic || work.current.draft !== snapshot.draft) return;
      if (JSON.stringify(next.decisions) === JSON.stringify(snapshot.semantic.decisions) && JSON.stringify(next.outcomes) === JSON.stringify(snapshot.semantic.outcomes)) return;
      setSemantic(() => next);
    })();
    return () => { cancelled = true; };
  }, [semantic.results, semantic.decisions, setSemantic, work]);

  // ---- issue list ----
  const segmentOfPlaced = (p: Placed) => {
    const span = p.live.source_span ?? p.live.target_span;
    const found = span ? views.find(v => (p.live.source_span ? v.pair.source.core_start <= span.start && span.end <= v.pair.source.core_end : v.pair.target.core_start <= span.start && span.end <= v.pair.target.core_end)) : null;
    if (found) return found;
    const result = semantic.results.find(r => r.id === p.resultId);
    return result ? views.find(v => overlaps(result.region.source, { start: v.pair.source.core_start, end: v.pair.source.core_end })) ?? null : null;
  };
  const rows = semantic.placed.map(p => {
    const info = issueStatus(semantic, p) as { status: string; decision: Decision | null; reference: Decision | null };
    const view = segmentOfPlaced(p);
    const position = p.live.source_span?.start ?? p.live.target_span?.start ?? semantic.results.find(r => r.id === p.resultId)?.region.source.start ?? 0;
    return { placed: p, ...info, segment: view ? view.pair.index : null, position, imported: !!semantic.results.find(r => r.id === p.resultId)?.imported };
  }).sort((a, b) => a.position - b.position || a.placed.id.localeCompare(b.placed.id));
  const statusMatch = (status: string, filter: typeof statusFilter) => filter === 'all'
    || (filter === 'handled' ? isHandled(status) : filter === 'reconfirm' ? status === 'needs_reconfirmation' || status === 'previously_applied' : !isHandled(status));
  const visible = rows.filter(r => statusMatch(r.status, statusFilter)
    && (categoryFilter === 'all' || r.placed.issue.category === categoryFilter)
    && (segmentFilter === 'all' || r.segment === segmentFilter));
  const counts = {
    pending: rows.filter(r => statusMatch(r.status, 'pending')).length,
    handled: rows.filter(r => statusMatch(r.status, 'handled')).length,
    reconfirm: rows.filter(r => statusMatch(r.status, 'reconfirm')).length,
    all: rows.length,
  };
  const activeIndex = visible.findIndex(r => r.placed.id === activeId);
  const active = activeIndex >= 0 ? visible[activeIndex] : visible[0] ?? null;
  const activeView = active ? segmentOfPlaced(active.placed) : null;
  // A displayed fallback is the real selection (as in the term list).
  if (active && active.placed.id !== activeId) setActiveId(active.placed.id);
  const choice = active && choiceState.id === active.placed.id ? choiceState.value : 'suggestion';
  const setChoice = (value: 'suggestion' | 'alternative') => setChoiceState({ id: active?.placed.id ?? null, value });
  useEffect(() => { activeMark.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [active?.placed.id, activeView?.pair.index]);

  const move = (step: number) => {
    if (!visible.length) return;
    const from = activeIndex < 0 ? 0 : activeIndex;
    const next = visible[Math.min(visible.length - 1, Math.max(0, from + step))];
    if (next) { setActiveId(next.placed.id); document.querySelector(`[data-semantic-id="${CSS.escape(next.placed.id)}"]`)?.scrollIntoView({ block: 'nearest' }); }
  };
  const locateActive = () => {
    if (!active) return;
    if (active.placed.live.target_span) locate('target', active.placed.live.target_span);
    else if (active.placed.live.source_span) locate('source', active.placed.live.source_span);
  };
  const keyHandler = useRef<(event: KeyboardEvent) => void>(() => {});
  function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
      const el = event.target as HTMLElement | null;
      // Letters never reach a text field; Enter keeps its meaning on buttons and links.
      const typing = !!el && (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
        || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button'].includes((el as HTMLInputElement).type)));
      if (typing || document.querySelector('dialog[open]') || !rows.length) return;
      const key = event.key.toLowerCase();
      if (key === 'j') { event.preventDefault(); move(1); }
      else if (key === 'k') { event.preventDefault(); move(-1); }
      else if (event.key === 'Enter' && !(el && ['BUTTON', 'A', 'SUMMARY', 'INPUT'].includes(el.tagName))) { event.preventDefault(); locateActive(); }
  }
  useLayoutEffect(() => { keyHandler.current = onKey; });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keyHandler.current(event);
    document.addEventListener('keydown', listener);
    return () => document.removeEventListener('keydown', listener);
  }, []);

  /** After handling, the next item that still needs work, after the current one. */
  function advanceFrom(placedId: string, nextState: SemanticState) {
    const order = rows.map(r => r.placed.id);
    const at = order.indexOf(placedId);
    const rotated = [...order.slice(at + 1), ...order.slice(0, Math.max(0, at))];
    const nextId = rotated.find(id => {
      const p = nextState.placed.find(x => x.id === id);
      return p && !isHandled((issueStatus(nextState, p) as { status: string }).status) && !p.stale;
    }) ?? null;
    setActiveId(nextId);
    if (!nextId) commit({ notice: 'sem:allHandled', remember: false });
    if (nextId && statusFilter !== 'pending' && statusFilter !== 'all') setStatusFilter('pending');
  }

  async function decide(row: (typeof rows)[number], kind: 'accepted' | 'adjusted' | 'ignored', text?: string) {
    const p = row.placed;
    const result = semantic.results.find(r => r.id === p.resultId);
    if (!result) return;
    const startDraft = work.current.draft;
    let nextTarget: string | null = null;
    let applied: string | null = null;
    if (kind === 'accepted') {
      if (!p.issue.suggestion || p.issue.suggestion_withheld !== null || !p.live.suggestion_span) return;
      const replacement = choice === 'alternative' && p.issue.alternatives[0] ? p.issue.alternatives[0].replacement : p.issue.suggestion.replacement;
      const applied0 = applySemanticSuggestion({ target: startDraft.target, issue: { suggestion: { ...p.issue.suggestion, target_span: p.live.suggestion_span }, suggestion_withheld: null }, offset: 0, replacement });
      if (applied0.error || applied0.target === undefined) { commit({ semantic: x => x, notice: 'sem:needsReconfirm', remember: false }); return; }
      nextTarget = applied0.target; applied = replacement;
    } else if (kind === 'adjusted') {
      const range = p.live.suggestion_span ?? p.live.target_span;
      if (!range || text === undefined || !text.trim() || chars(text).length > 2000 || !sliceEquals(startDraft.target, range)) { commit({ semantic: x => x, notice: 'sem:needsReconfirm', remember: false }); return; }
      const tc = chars(startDraft.target);
      nextTarget = slice(tc, 0, range.start) + text + slice(tc, range.end, tc.length); applied = text;
    }
    const decision = await makeSemanticDecision({ issue: p.issue, segmentIndex: p.issue.segment_index, source: result.doc.source, target: result.doc.target, termBasis: result.report.term_basis, decision: kind, appliedText: applied }) as Decision;
    if (work.current.draft !== startDraft) { commit({ semantic: x => x, notice: 'sem:needsReconfirm', remember: false }); return; }
    const probe = upsertDecision(work.current.semantic, decision, p.id);
    if (!probe) { commit({ semantic: x => x, notice: 'sem:decisionLimit', remember: false }); return; }
    const nextDraft = nextTarget === null ? undefined : { ...startDraft, target: nextTarget, alignments: startDraft.alignments === null ? null : [] };
    const holder: { state: SemanticState | null } = { state: null };
    const serial = commit({ draft: nextDraft, semantic: state => (holder.state = (upsertDecision(state, decision, p.id) as SemanticState) ?? state), notice: `sem:${kind}` });
    setLastAction(serial === null ? null : { placedId: p.id, marker: serial, kind });
    setAdjusting(null);
    if (holder.state) advanceFrom(p.id, holder.state);
  }
  function undoDecision(row: (typeof rows)[number]) {
    if (!row.decision) return;
    if (row.decision.decision === 'ignored') {
      commit({ semantic: state => removeDecision(state, occurrenceKey(row.decision!)) as SemanticState, notice: 'sem:undone' });
      setActiveId(row.placed.id); setLastAction(null);
      return;
    }
    if (lastAction?.placedId === row.placed.id && props.canUndoLast(lastAction.marker)) { props.undo(); setActiveId(row.placed.id); setLastAction(null); }
  }

  // ---- manual split: explicit, one-click text edits, each its own undo step ----
  function splitAt(side: 'source' | 'target', offset: number, paired: boolean, label: string) {
    const d = work.current.draft;
    // Equal paragraph counts: a one-sided blank line would unpair the whole text,
    // so the first click is held until the matching place on the other side is chosen.
    if (paired && (!pendingCut || pendingCut.side === side)) {
      setPendingCut(pendingCut?.side === side && pendingCut.offset === offset ? null : { side, offset, label });
      return;
    }
    let next = { ...d };
    const first = insertParagraphBreak(d[side], offset);
    if (!first) return;
    next = { ...next, [side]: first.text };
    if (paired && pendingCut) {
      const other = insertParagraphBreak(d[pendingCut.side], pendingCut.offset);
      if (!other) { setPendingCut(null); return; }
      next = { ...next, [pendingCut.side]: other.text };
    }
    setPendingCut(null);
    commit({ draft: { ...next, alignments: d.alignments === null ? null : [] }, notice: 'sem:split' });
  }
  function splitPendingOnly() {
    if (!pendingCut) return;
    const d = work.current.draft;
    const r = insertParagraphBreak(d[pendingCut.side], pendingCut.offset);
    setPendingCut(null);
    if (r) commit({ draft: { ...d, [pendingCut.side]: r.text, alignments: d.alignments === null ? null : [] }, notice: 'sem:split' });
  }
  function linesEverywhere() {
    const d = work.current.draft;
    const s1 = linesToParagraphs(d.source); const t1 = linesToParagraphs(d.target);
    if (!s1 && !t1) return;
    setPendingCut(null);
    commit({ draft: { ...d, source: s1?.text ?? d.source, target: t1?.text ?? d.target, alignments: d.alignments === null ? null : [] }, notice: 'sem:lines' });
  }
  function merge(side: 'source' | 'target', gapStart: number, gapEnd: number) {
    const d = work.current.draft;
    const r = mergeParagraphs(d[side], gapStart, gapEnd);
    if (!r) return;
    setPendingCut(null);
    commit({ draft: { ...d, [side]: r.text, alignments: d.alignments === null ? null : [] }, notice: 'sem:merged' });
  }
  function linesAsParagraphs(side: 'source' | 'target', region: Region) {
    const d = work.current.draft;
    const r = linesToParagraphs(d[side], region);
    if (!r) return;
    setPendingCut(null);
    commit({ draft: { ...d, [side]: r.text, alignments: d.alignments === null ? null : [] }, notice: 'sem:lines' });
  }

  // ---- derived view state ----
  const progress = runProgress(run) as { done: number; failed: number; skipped: number; total: number };
  const reviewedCount = ready.filter(v => v.result).length;
  const termReviewed = ready.filter(v => v.term).length;
  const sendingItem = run.items.find(i => i.status === 'sending') ?? null;
  const waitSeconds = run.waitUntil ? Math.max(0, Math.ceil((run.waitUntil - now) / 1000)) : 0;
  const poolData = pool.kind === 'success' ? pool.data : null;
  const pendingViews = ready.filter(v => !v.result);
  const estimateChars = pendingViews.reduce((n, v) => n + Math.max(chars(v.sCore).length, chars(v.tCore).length), 0);
  const runItemFor = (view: PairView) => run.kind && run.kind !== 'translate' ? run.items.find(i => i.key === view.itemKey) ?? null : null;
  const stopText = (code: string | null) => {
    if (!code) return s.stopGeneric;
    if (['llm_unavailable', 'semantic_review_unavailable', 'site_not_configured'].includes(code)) return s.stopUnavailable;
    if (code === 'translateTargetChanged') return s.notices.translateTargetChanged;
    if (run.kind === 'translate') return `${(m.tMsg as Record<string, string>)[code] ?? s.stopGeneric} ${s.translateStopped}`;
    if (['upstream_rate_limited', 'rate_limited'].includes(code)) return `${(m.tMsg as Record<string, string>)[code] ?? s.stopGeneric} ${s.chargedNoResend}`;
    if ((classifyFailure({ reason: code }) as { action: string }).action === 'stop') return (m.tMsg as Record<string, string>)[code] ?? (m.rMsg as Record<string, string>)[code] ?? s.stopGeneric;
    // Anything else stopped the run by failing twice in a row.
    return code === 'upstream_timeout' ? `${s.stopRepeated} ${s.phaseTimeout}` : s.stopRepeated;
  };
  const translateBlankLong = !!source.trim() && !target.trim() && sourceChars.length > 2000;
  const showSegments = pairs.length > 1 || long || semantic.results.length > 0 || pairs.some(p => p.status !== 'ready') || run.kind !== null;
  const translationClosed = !!poolData && (!poolData.translation_enabled || poolData.translations.remaining === 0 || poolData.characters.remaining === 0);
  const reviewsClosed = !!poolData && poolData.reviews.remaining === 0;
  const runPhaseLine = (() => {
    if (run.kind === null || run.phase === 'idle') return null;
    const done = progress.done; const total = progress.total;
    if (run.phase === 'running') return fill(s.phaseRunning, { i: (sendingItem?.index ?? 0) + 1 });
    if (run.phase === 'waiting') return fill(s.phaseWaiting, { s: waitSeconds });
    if (run.phase === 'paused') return run.stopCode ? fill(s.phaseQuota, { done, total }) : fill(s.phasePaused, { done, total });
    if (run.phase === 'stopped') return fill(s.phaseStopped, { reason: stopText(run.stopCode) });
    return s.phaseDone;
  })();
  const issueRegion = activeView ?? null;

  // Long manuscripts: per-segment term findings, read-only, in document coordinates.
  const termRows = views.flatMap(v => (v.term ? v.term.report.findings.map(f => ({
    view: v, finding: f,
    source_span: { start: f.source_span.start + v.pair.source.core_start, end: f.source_span.end + v.pair.source.core_start, text: f.source_span.text },
    target_span: f.target_span ? { start: f.target_span.start + v.pair.target.core_start, end: f.target_span.end + v.pair.target.core_start, text: f.target_span.text } : null,
  })) : []));

  const segmentLabel = (view: PairView) => {
    const item = runItemFor(view);
    if (view.pair.status === 'needs_manual_split') return s.segManual;
    if (view.pair.status === 'untranslated') return s.segUntranslated;
    if (view.pair.status === 'unpaired_target') return s.segUnpaired;
    if (item?.status === 'sending') return s.segSending;
    if (item?.status === 'queued' && run.phase !== 'idle') return s.segQueued;
    if (item?.status === 'failed') return s.segFailed;
    if (item?.status === 'skipped') return s.segSkipped;
    if (!semanticOn) return view.term ? s.segTermChecked : view.termEdited ? s.termSegmentStale : s.segTermPending;
    if (view.result) return view.result.imported ? s.segImported : s.segReviewed;
    if (view.edited) return s.segEdited;
    return s.segPending;
  };

  const shape = (view: PairView) => pairShape(source, target, view.pair) as { sourceParagraphs: number; targetParagraphs: number; sourceSentences: number; targetSentences: number; sourceLength: number; targetLength: number };
  // The helper follows the manual pair the user opened; after an edit re-pairs the
  // text it moves to the nearest pair that still needs a manual split.
  const manualViews = views.filter(v => v.pair.status === 'needs_manual_split');
  const splitView = splitOpen === null ? null : manualViews.find(v => v.pair.index === splitOpen) ?? manualViews.find(v => v.pair.index >= splitOpen) ?? manualViews.at(-1) ?? null;

  return <>
    {long && <div className="long-tools" role="group" aria-label={s.segmentsTitle}>
      {translateBlankLong && <div className="long-translate">
        <p>{s.translateLongHint}</p>
        <div className="actions">
          <button type="button" className="secondary-button" disabled={runActive || translationClosed} onClick={startTranslateRun}>{s.translateLong}</button>
        </div>
      </div>}
      {!translateBlankLong && <div className="long-terms">
        <p>{s.runTermHint}</p>
        <div className="actions">
          <button type="button" className="secondary-button" disabled={runActive || reviewsClosed || !ready.some(v => !v.term)} onClick={() => startRun('term')}>{s.runTerm}</button>
        </div>
      </div>}
    </div>}

    {showSegments && <section className="segment-panel" aria-label={s.segmentsAria}>
      <div className="segment-head">
        <h3>{s.segmentsTitle}</h3>
        {run.kind === 'translate'
          ? <p>{fill(s.translateProgress, { done: progress.done, total: progress.total })}</p>
          : <p>{semanticOn ? fill(s.progress, { done: reviewedCount, total: ready.length }) : fill(s.termProgress, { done: termReviewed, total: ready.length })}{progress.failed ? fill(s.progressFailed, { n: progress.failed }) : ''}{progress.skipped ? fill(s.progressSkipped, { n: progress.skipped }) : ''}{semanticOn && long && termReviewed ? ` · ${fill(s.termProgress, { done: termReviewed, total: ready.length })}` : ''}</p>}
      </div>
      {run.kind !== null && run.phase !== 'idle' && <progress max={Math.max(1, progress.total)} value={progress.done} aria-label={runPhaseLine ?? ''} />}
      {runPhaseLine && <p className="run-phase" role="status" aria-live="polite">{runPhaseLine}</p>}
      {(semanticOn || contextOn) && <label className="inline-check"><input type="checkbox" checked={usePrecedents} onChange={e => setUsePrecedents(e.target.checked)} />{s.precedents}</label>}
      <div className="actions">
        {(run.phase === 'running' || run.phase === 'waiting') && <button type="button" className="secondary-button" onClick={() => dispatch({ type: 'pause' })}>{s.pause}</button>}
        {(run.phase === 'paused' || run.phase === 'stopped') && run.items.some(i => i.status === 'queued') && <button type="button" className="secondary-button" onClick={() => dispatch({ type: 'resume' })}>{s.resume}</button>}
        {progress.failed > 0 && !runActive && <button type="button" className="secondary-button" onClick={() => run.items.filter(i => i.status === 'failed').forEach(i => dispatch({ type: 'retry', key: i.key }))}>{s.retryFailed}</button>}
      </div>
      {manualViews.length > 0 && (singleBreaks(source) > 0 || singleBreaks(target) > 0) && <div className="split-lines">
        <p>{fill(s.linesEverywhereHint, { n: manualViews.length, s: singleBreaks(source), t: singleBreaks(target) })}</p>
        <button type="button" className="secondary-button" onClick={linesEverywhere}>{s.linesEverywhere}</button>
      </div>}
      <ol className="segment-chips" role="list">
        {views.map(view => {
          const label = segmentLabel(view);
          const item = runItemFor(view);
          return <li key={view.itemKey + view.pair.index} className="segment-chip" data-status={view.pair.status} data-current={selectedSegment === view.pair.index ? 'true' : undefined}>
            <button type="button" className="text-button" aria-pressed={selectedSegment === view.pair.index} onClick={() => { setSelectedSegment(selectedSegment === view.pair.index ? null : view.pair.index); setSegmentFilter(selectedSegment === view.pair.index ? 'all' : view.pair.index); }}>
              {fill(s.segmentLabel, { n: view.pair.index + 1 })} · {label}{view.pair.hard_cut ? ` · ${s.segHardCut}` : ''}
            </button>
            {item?.status === 'failed' && !runActive && <button type="button" className="text-button" onClick={() => dispatch({ type: 'retry', key: item.key })}>{s.segRetry}</button>}
            {semanticOn && view.pair.status === 'ready' && !runActive && (view.edited || (!view.result && item?.status !== 'failed')) && !translationClosed
              && <button type="button" className="text-button" onClick={() => startRun('semantic', [view])}>{s.segReview}</button>}
            {view.pair.status === 'untranslated' && <button type="button" className="text-button" disabled={pairTranslating !== null || runActive || translationClosed || chars(view.sCore).length > SEGMENT_LIMIT} onClick={() => void translatePair(view)}>{s.segTranslate}</button>}
            {view.pair.status === 'needs_manual_split' && <button type="button" className="text-button" aria-expanded={splitOpen === view.pair.index} onClick={() => setSplitOpen(splitOpen === view.pair.index ? null : view.pair.index)}>{splitOpen === view.pair.index ? s.manualClose : s.manualOpen}</button>}
            {view.pair.hard_cut && <p className="segment-hint">{s.hardCutHint}</p>}
            {view.pair.status === 'untranslated' && <p className="segment-hint">{s.untranslatedHint}</p>}
            {view.pair.status === 'unpaired_target' && <p className="segment-hint">{s.unpairedHint}</p>}
            {view.pair.status === 'needs_manual_split' && (() => { const sh = shape(view); return <p className="segment-hint">{fill(s.manualHint, { sp: sh.sourceParagraphs, ss: sh.sourceSentences, sl: sh.sourceLength.toLocaleString(locale), tp: sh.targetParagraphs, ts: sh.targetSentences, tl: sh.targetLength.toLocaleString(locale) })}</p>; })()}
            {semanticOn && long && view.termEdited && <p className="segment-hint">{s.termSegmentStale}</p>}
          </li>;
        })}
      </ol>
      {splitOpen !== null && (splitView
        ? <SplitHelper s={s} locale={locale} source={source} target={target} view={splitView} splitAt={splitAt} merge={merge} linesAsParagraphs={linesAsParagraphs}
          pending={pendingCut} cancelPending={() => setPendingCut(null)} splitPendingOnly={splitPendingOnly} />
        : <p className="split-helper" role="status">{s.splitResolved} <button type="button" className="text-button" onClick={() => setSplitOpen(null)}>{s.manualClose}</button></p>)}
    </section>}

    {props.termTrack}

    {long && termRows.length > 0 && <section className="term-track long-terms-list" aria-labelledby="long-terms-title">
      <h3 id="long-terms-title">{s.termTrackTitle}</h3>
      <p className="track-note">{s.longTermReadOnly}</p>
      {termRows.filter(r => selectedSegment === null || r.view.pair.index === selectedSegment).map(r => <article className="term-result" key={`${r.view.itemKey}:${r.finding.id}`}>
        <p className="result-summary"><span className={`verdict-badge verdict-${r.finding.verdict}`}>{(m.review.verdicts as Record<string, string>)[r.finding.verdict]}</span> · {fill(s.segmentLabel, { n: r.view.pair.index + 1 })} · {r.source_span.text}</p>
        <div className="excerpt-labeled"><span className="excerpt-tag">{m.review.excerptSourceLabel}</span><Snippet text={source} span={r.source_span} missing={s.sourceMissing} /></div>
        <div className="excerpt-labeled"><span className="excerpt-tag">{m.review.excerptTargetLabel}</span><Snippet text={target} span={r.target_span} missing={m.review.excerptMissingTarget} /></div>
        {r.finding.candidates.map(c => <p className="term-pair" key={c.candidate_id}><strong>{c.zh}</strong><span>{c.en}</span></p>)}
        <div className="finding-jumps">
          <button type="button" className="text-button" onClick={() => locate('source', r.source_span)}>{m.review.jumpSource}</button>
          <button type="button" className="text-button" disabled={!r.target_span} onClick={() => { if (r.target_span) locate('target', r.target_span); }}>{m.review.jumpTarget}</button>
        </div>
      </article>)}
    </section>}

    {semanticOn && <section className="semantic-track" aria-labelledby="semantic-title" ref={sectionRef}>
      <div className="track-head">
        <h3 id="semantic-title">{s.semanticTrackTitle} <span className="tag experimental-tag">{s.experimental}</span></h3>
        <p className="track-note">{s.semanticTrackNote}</p>
      </div>
      {<>
        {pendingViews.length > 0 && !runActive && <p className="run-estimate">{fill(s.estimate, { n: pendingViews.length, chars: estimateChars.toLocaleString(locale) })}
          {poolData ? ` ${fill(s.estimateRemaining, { n: poolData.translations.remaining.toLocaleString(locale), chars: poolData.characters.remaining.toLocaleString(locale) })}` : ''}
          {poolData && (poolData.translations.remaining < pendingViews.length || poolData.characters.remaining < estimateChars) ? ` ${s.estimateShort}` : ''}</p>}
        <div className="actions">
          <button type="button" disabled={runActive || pendingViews.length === 0 || translationClosed} onClick={() => startRun('semantic')}>{semantic.results.length ? s.startPending : s.start}</button>
        </div>
      </>}
      {lastAction && props.canUndoLast(lastAction.marker) && (() => {
        const row = rows.find(r => r.placed.id === lastAction.placedId);
        return row && row.decision ? <p className="semantic-last" role="status">{s.statuses[row.decision.decision]} · {s.categories[row.placed.issue.category]}
          <button type="button" className="text-button" onClick={() => undoDecision(row)}>{s.undoDecision}</button></p> : null;
      })()}
      {rows.length > 0 && <div className="semantic-body">
        <div className={`semantic-list${drawerOpen ? ' open' : ''}`}>
          <button type="button" className="drawer-toggle secondary-button" aria-expanded={drawerOpen} onClick={() => setDrawerOpen(!drawerOpen)}>{drawerOpen ? s.listClose : fill(s.listToggle, { n: counts.pending })}</button>
          <div className="semantic-filters" role="group" aria-label={s.filterAria}>
            {(['pending', 'reconfirm', 'handled', 'all'] as const).map(id => <button key={id} type="button" className="secondary-button" aria-pressed={statusFilter === id} onClick={() => setStatusFilter(id)}>
              {{ pending: s.statusPending, reconfirm: s.statusReconfirm, handled: s.statusHandled, all: s.statusAll }[id]} {counts[id]}</button>)}
            <label>{s.filterCategory}<select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}>
              <option value="all">{s.categoryAll}</option>
              {SEMANTIC_CATEGORIES.map((c: string) => <option key={c} value={c}>{s.categories[c]}</option>)}
            </select></label>
            <label>{s.filterSegment}<select value={segmentFilter === 'all' ? 'all' : String(segmentFilter)} onChange={e => setSegmentFilter(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
              <option value="all">{s.segmentAll}</option>
              {views.filter(v => v.pair.status === 'ready').map(v => <option key={v.pair.index} value={v.pair.index}>{fill(s.segmentLabel, { n: v.pair.index + 1 })}</option>)}
            </select></label>
          </div>
          <ol className="semantic-items" role="list" aria-label={s.semanticTrackTitle}>
            {visible.map(r => <li key={r.placed.id}>
              <button type="button" className="semantic-item" data-semantic-id={r.placed.id} aria-current={active?.placed.id === r.placed.id ? 'true' : undefined} onClick={() => { setActiveId(r.placed.id); setDrawerOpen(false); }}>
                <span className="semantic-category">{s.categories[r.placed.issue.category]}</span>
                <span className="semantic-where">{r.segment === null ? '' : fill(s.segmentLabel, { n: r.segment + 1 })}</span>
                <span className="semantic-quote">{r.placed.issue.target_excerpt ?? r.placed.issue.source_excerpt}</span>
                <span className="semantic-state" data-status={r.status}>{s.statuses[r.status]}</span>
              </button>
            </li>)}
          </ol>
          {visible.length === 0 && <p>{s.emptyFiltered}</p>}
        </div>
        {active && <IssueCard s={s} m={m} row={active} source={source} target={target} view={issueRegion} rows={rows} choice={choice} setChoice={setChoice}
          adjusting={adjusting} setAdjusting={setAdjusting} decide={(kind, text) => void decide(active, kind, text)} undo={() => undoDecision(active)}
          canUndo={!!active.decision && (active.decision.decision === 'ignored' || (lastAction?.placedId === active.placed.id && props.canUndoLast(lastAction.marker)))}
          position={fill(s.position, { i: activeIndex < 0 ? 1 : activeIndex + 1, n: visible.length })} prev={() => move(-1)} next={() => move(1)} locate={locateActive}
          locateSide={locate} activeMark={activeMark} onReview={activeView && activeView.pair.status === 'ready' && semanticOn && !runActive ? () => startRun('semantic', [activeView]) : null} />}
      </div>}
      {rows.length === 0 && semantic.results.length > 0 && <p>{s.emptyAll}</p>}
    </section>}
  </>;
}

function SplitHelper({ s, locale, source, target, view, splitAt, merge, linesAsParagraphs, pending, cancelPending, splitPendingOnly }: {
  s: SemanticMessages; locale: string; source: string; target: string; view: PairView;
  splitAt: (side: 'source' | 'target', offset: number, paired: boolean, label: string) => void; merge: (side: 'source' | 'target', a: number, b: number) => void;
  linesAsParagraphs: (side: 'source' | 'target', region: Region) => void;
  pending: { side: 'source' | 'target'; offset: number; label: string } | null; cancelPending: () => void; splitPendingOnly: () => void;
}) {
  const sc = chars(source); const tc = chars(target);
  type Para = { start: number; end: number; coreStart: number; coreEnd: number; length: number; sentences: { start: number; end: number }[] };
  const layout = { source: splitLayout(source, view.pair.source), target: splitLayout(target, view.pair.target) } as Record<'source' | 'target', Para[]>;
  const rows = Math.max(layout.source.length, layout.target.length);
  const sideName = { source: s.splitSource, target: s.splitTarget };
  const paired = layout.source.length === layout.target.length;
  const breaks = { source: singleBreaks(source, view.pair.source), target: singleBreaks(target, view.pair.target) };
  // A length ratio far from the document's usual ratio is shown as a fact, never used to pair.
  const ratios = Array.from({ length: Math.min(layout.source.length, layout.target.length) }, (_, i) => layout.target[i].length / Math.max(1, layout.source[i].length)).sort((a, b) => a - b);
  const median = ratios.length ? ratios[Math.floor(ratios.length / 2)] : 1;
  const unusual = (i: number) => {
    const a = layout.source[i]; const b = layout.target[i];
    if (!a || !b || Math.max(a.length, b.length) < 24) return false;
    const r = b.length / Math.max(1, a.length);
    return r > median * 2.5 || r < median / 2.5;
  };
  const column = (side: 'source' | 'target', i: number) => {
    const para = layout[side][i];
    const list = side === 'source' ? sc : tc;
    if (!para) return <div className="split-cell split-missing">{s.splitMissing}</div>;
    const next = layout[side][i + 1];
    return <div className="split-cell" data-unusual={unusual(i) ? 'true' : undefined}>
      <p className="split-meta">{fill(s.splitRow, { n: i + 1, len: para.length.toLocaleString(locale) })}{unusual(i) ? ` · ${s.splitUnusual}` : ''}</p>
      {para.sentences.map((sentence, j) => <span key={sentence.start} className="split-sentence">
        <span>{slice(list, sentence.start, sentence.end)}</span>
        {j < para.sentences.length - 1 && (() => {
          const label = fill(s.splitInsertAria, { side: sideName[side], n: i + 1, i: j + 1 });
          return <button type="button" className="split-cut" aria-label={label} title={s.splitInsert}
            aria-pressed={pending?.side === side && pending.offset === sentence.end}
            onClick={() => splitAt(side, sentence.end, paired, label)}>↵</button>;
        })()}
      </span>)}
      {next && <button type="button" className="text-button split-merge" aria-label={fill(s.splitMergeAria, { side: sideName[side], n: i + 1 })} onClick={() => merge(side, para.coreEnd, next.coreStart)}>{s.splitMerge}</button>}
    </div>;
  };
  return <div className="split-helper" role="region" aria-label={s.splitTitle}>
    <h4>{s.splitTitle}</h4>
    <p>{s.splitIntro}</p>
    {(['source', 'target'] as const).filter(side => breaks[side] > 0).map(side => <p key={side} className="split-lines">
      {fill(s.splitLinesHint, { side: sideName[side], n: breaks[side] })}
      <button type="button" className="secondary-button" onClick={() => linesAsParagraphs(side, view.pair[side])}>{fill(s.splitLines, { side: sideName[side] })}</button>
    </p>)}
    {paired && <p className="track-note">{s.splitPairedHint}</p>}
    {pending && <p className="split-pending" role="status">{fill(s.splitPending, { where: pending.label })}
      <button type="button" className="text-button" onClick={splitPendingOnly}>{fill(s.splitOneSide, { side: sideName[pending.side] })}</button>
      <button type="button" className="text-button" onClick={cancelPending}>{s.adjustCancel}</button></p>}
    <div className="split-grid">
      <p className="split-col-head">{s.splitSource} · {fill(s.splitCount, { n: layout.source.length })}</p>
      <p className="split-col-head">{s.splitTarget} · {fill(s.splitCount, { n: layout.target.length })}</p>
      {Array.from({ length: rows }, (_, i) => <div className="split-row" key={i}>{column('source', i)}{column('target', i)}</div>)}
    </div>
  </div>;
}

type Row = { placed: Placed; status: string; decision: Decision | null; reference: Decision | null; segment: number | null; imported: boolean };
function IssueCard({ s, m, row, source, target, view, rows, choice, setChoice, adjusting, setAdjusting, decide, undo, canUndo, position, prev, next, locate, locateSide, activeMark, onReview }: {
  s: SemanticMessages; m: ReturnType<typeof msg>; row: Row; source: string; target: string; view: PairView | null; rows: Row[];
  choice: 'suggestion' | 'alternative'; setChoice: (c: 'suggestion' | 'alternative') => void;
  adjusting: { placedId: string; text: string } | null; setAdjusting: (a: { placedId: string; text: string } | null) => void;
  decide: (kind: 'accepted' | 'adjusted' | 'ignored', text?: string) => void; undo: () => void; canUndo: boolean;
  position: string; prev: () => void; next: () => void; locate: () => void; locateSide: (side: 'source' | 'target', span: Span) => void;
  activeMark: MutableRefObject<HTMLElement | null>; onReview: (() => void) | null;
}) {
  const { placed } = row;
  const issue = placed.issue;
  const handled = isHandled(row.status);
  const withheld = issue.suggestion_withheld !== null;
  const suggestionLive = !!issue.suggestion && !withheld && !!placed.live.suggestion_span;
  const alternative = issue.alternatives[0] ?? null;
  const replacement = choice === 'alternative' && alternative ? alternative.replacement : issue.suggestion?.replacement ?? '';
  const effect = choice === 'alternative' && alternative ? alternative.term_effect : issue.suggestion?.term_effect ?? 'none';
  const range = placed.live.suggestion_span ?? placed.live.target_span;
  const editing = adjusting?.placedId === placed.id ? adjusting : null;
  const others = view ? rows.filter(r => r.placed.id !== placed.id && !isHandled(r.status) && r.segment === view.pair.index) : [];
  const marks = (side: 'source' | 'target') => [
    ...(placed.live[side === 'source' ? 'source_span' : 'target_span'] ? [{ span: placed.live[side === 'source' ? 'source_span' : 'target_span']!, active: true }] : []),
    ...others.flatMap(r => r.placed.live[side === 'source' ? 'source_span' : 'target_span'] ? [{ span: r.placed.live[side === 'source' ? 'source_span' : 'target_span']!, active: false }] : []),
  ];
  const sc = chars(source); const tc = chars(target);
  return <article className="semantic-card" aria-labelledby="semantic-card-title">
    <div className="finding-nav">
      <button type="button" className="secondary-button" onClick={prev}>{s.navPrev}</button>
      <button type="button" className="secondary-button" onClick={next}>{s.navNext}</button>
      <button type="button" className="secondary-button" onClick={locate}>{s.locate}</button>
      <p className="finding-position">{position}</p>
    </div>
    <h4 id="semantic-card-title"><span className="semantic-category">{s.categories[issue.category]}</span>{row.segment === null ? '' : ` · ${fill(s.segmentLabel, { n: row.segment + 1 })}`}</h4>
    <p className="semantic-meta">{fill(s.confidence, { c: (s.confidences as Record<string, string>)[issue.confidence] ?? issue.confidence })} · <span className="semantic-state" data-status={row.status}>{s.statuses[row.status]}</span>{row.imported ? ` · ${s.importedBadge}` : ''}</p>
    {row.reference && <p className="semantic-reference">{fill(s.reference, { d: s.statuses[row.reference.decision] })}{row.reference.applied_text ? `：${row.reference.applied_text}` : ''}</p>}
    <div className="excerpt-labeled"><span className="excerpt-tag">{s.sourceLabel}</span><Snippet text={source} span={placed.live.source_span} missing={issue.source_span ? s.statuses.stale : s.sourceMissing} /></div>
    <div className="excerpt-labeled"><span className="excerpt-tag">{s.targetLabel}</span><Snippet text={target} span={placed.live.target_span} missing={issue.target_span ? s.statuses.stale : s.targetMissing} /></div>
    <p className="semantic-rationale"><strong>{s.rationale}</strong> {issue.rationale}</p>
    {withheld ? <p className="semantic-withheld">{s.withheld}</p>
      : issue.suggestion ? <div className="semantic-suggestion">
        {alternative && <div className="suggestion-choice" role="radiogroup" aria-label={s.suggestionChoiceAria}>
          <label><input type="radio" name={`choice-${placed.id}`} checked={choice === 'suggestion'} onChange={() => setChoice('suggestion')} />{s.suggestion}</label>
          <label><input type="radio" name={`choice-${placed.id}`} checked={choice === 'alternative'} onChange={() => setChoice('alternative')} />{s.alternative}</label>
        </div>}
        <p className="review-excerpt"><strong>{choice === 'alternative' && alternative ? s.alternative : s.suggestion}</strong> {placed.live.suggestion_span ? <><del>{placed.live.suggestion_span.text}</del> → </> : null}<ins>{replacement}</ins></p>
        {s.termEffects[effect] && <p className="term-effect">{s.termEffects[effect]}</p>}
      </div> : <p className="semantic-withheld">{s.noSuggestion}</p>}
    {editing && range && <div className="semantic-adjust">
      <p><strong>{s.adjustRange}</strong> <span className="review-excerpt">{range.text}</span></p>
      <label htmlFor={`adjust-${placed.id}`}>{s.adjustText}</label>
      <textarea id={`adjust-${placed.id}`} rows={3} value={editing.text} onChange={e => setAdjusting({ placedId: placed.id, text: e.target.value })} />
      <p className="review-excerpt">{s.adjustPreview}：<del>{range.text}</del> → <ins>{editing.text}</ins></p>
      <div className="actions">
        <button type="button" disabled={!editing.text.trim() || editing.text === range.text} onClick={() => decide('adjusted', editing.text)}>{s.adjustApply}</button>
        <button type="button" className="secondary-button" onClick={() => setAdjusting(null)}>{s.adjustCancel}</button>
      </div>
    </div>}
    <div className="finding-actions semantic-actions">
      {!handled && <>
        {!withheld && issue.suggestion && <button type="button" disabled={!suggestionLive || placed.stale} onClick={() => decide('accepted')}>{s.accept}</button>}
        <button type="button" className="secondary-button" disabled={!range || placed.stale} onClick={() => setAdjusting({ placedId: placed.id, text: suggestionLive && !withheld ? replacement : range?.text ?? '' })}>{s.adjust}</button>
        <button type="button" className="secondary-button" onClick={() => decide('ignored')}>{s.ignore}</button>
      </>}
      {handled && <button type="button" className="secondary-button" disabled={!canUndo} title={canUndo ? undefined : s.undoBlocked} onClick={undo}>{s.undoDecision}</button>}
      {placed.stale && onReview && <button type="button" className="secondary-button" onClick={onReview}>{s.segReview}</button>}
      {placed.live.source_span && <button type="button" className="text-button" onClick={() => locateSide('source', placed.live.source_span!)}>{m.review.jumpSource}</button>}
      {placed.live.target_span && <button type="button" className="text-button" onClick={() => locateSide('target', placed.live.target_span!)}>{m.review.jumpTarget}</button>}
    </div>
    {handled && !canUndo && <p className="track-note">{s.undoBlocked}</p>}
    {view && <div className="compare-view" role="group" aria-label={s.compareAria}>
      <p className="compare-title">{fill(s.compareTitle, { n: view.pair.index + 1 })}</p>
      <div className="compare-columns">
        <div className="compare-side"><span className="excerpt-tag">{s.sourceLabel}</span>
          <Marked text={slice(sc, view.pair.source.core_start, view.pair.source.core_end)} offset={view.pair.source.core_start} marks={marks('source')} activeRef={activeMark} /></div>
        <div className="compare-side"><span className="excerpt-tag">{s.targetLabel}</span>
          <Marked text={slice(tc, view.pair.target.core_start, view.pair.target.core_end)} offset={view.pair.target.core_start} marks={marks('target')} activeRef={activeMark} /></div>
      </div>
    </div>}
  </article>;
}

// ---- manuscript and export helpers (used by the review workbench) ----

type HistorySnap = { source: string; target: string; direction: 'en' | 'zh'; segments: { segment_index: number; source_start: number; source_end: number; target_start: number; target_end: number; report: SemanticReport }[] };
type WorkfileV2 = { source: string; target: string; direction: 'en' | 'zh'; semantic_decisions: Decision[]; semantic_texts: { revision: string; text: string }[]; semantic_history: HistorySnap[] };

/**
 * Semantic state from an imported v2 manuscript. Decisions and verified old
 * texts are kept as they are; the newest history snapshot, when it was taken
 * of exactly these texts, comes back as untrusted reference results.
 */
export async function semanticFromWorkfile(parsed: WorkfileV2): Promise<SemanticState> {
  const texts: { revision: string; text: string }[] = [];
  for (const entry of parsed.semantic_texts) if (await revisionOf(entry.text) === entry.revision) texts.push({ revision: entry.revision, text: entry.text });
  let state: SemanticState = { ...(emptySemantic() as SemanticState), decisions: [...parsed.semantic_decisions], texts, history: [...parsed.semantic_history] };
  const last = parsed.semantic_history.at(-1);
  if (!last || last.source !== parsed.source || last.target !== parsed.target || last.direction !== parsed.direction) return state;
  const [sourceRevision, targetRevision] = await Promise.all([revisionOf(last.source), revisionOf(last.target)]);
  const sc = chars(last.source); const tc = chars(last.target);
  for (const seg of last.segments) {
    const sentSource = slice(sc, seg.source_start, seg.source_end); const sentTarget = slice(tc, seg.target_start, seg.target_end);
    const pair: Pair = { index: seg.segment_index, status: 'ready', hard_cut: false,
      source: { start: seg.source_start, end: seg.source_end, core_start: seg.source_start, core_end: seg.source_end },
      target: { start: seg.target_start, end: seg.target_end, core_start: seg.target_start, core_end: seg.target_end } };
    const result: SegResult = { id: uid(), segmentKey: segmentKey(parsed.direction, sentSource, sentTarget) as string, index: seg.segment_index, sentSource, sentTarget,
      report: seg.report, imported: true, doc: { source: last.source, target: last.target, sourceRevision, targetRevision },
      region: { source: { start: seg.source_start, end: seg.source_end }, target: { start: seg.target_start, end: seg.target_end } } };
    const placed: Placed[] = (placeSegmentIssues({ report: seg.report, pair }) as Issue[]).map(issue => ({
      id: `${result.id}:${issue.id}`, resultId: result.id, issue, occurrence: placedOccurrence(result, issue) as string, stale: false,
      live: { source_span: issue.source_span, target_span: issue.target_span, suggestion_span: issue.suggestion?.target_span ?? null },
    }));
    state = addSegmentResult(state, result, placed, []) as SemanticState;
  }
  return state;
}

/** The v2 parts of a manuscript body; the body is returned unchanged when there is no semantic data (written as v1). */
export function semanticWorkfileParts<T extends { source: string; target: string; direction: 'en' | 'zh' }>(base: T, semantic: SemanticState): T {
  const snapshot = historySnapshot({ source: base.source, target: base.target, direction: base.direction, segments: semantic.results.map(r => ({
    segment_index: r.index, sentSource: r.sentSource, sentTarget: r.sentTarget, report: r.report, sourceRegion: r.region.source, targetRegion: r.region.target,
  })) });
  const seen = new Set<string>();
  const history = [...semantic.history, ...(snapshot ? [snapshot] : [])].filter(h => { const k = JSON.stringify(h); return !seen.has(k) && !!seen.add(k); }).slice(-2);
  if (!semantic.decisions.length && !history.length) return base;
  const payload = { ...base, semantic_decisions: semantic.decisions, semantic_texts: [] as { revision: string; text: string }[], semantic_history: history };
  try {
    const { texts } = semanticTextsWithinBudget({ payload, candidates: semantic.texts, currentTexts: { source: base.source, target: base.target } }) as { texts: { revision: string; text: string }[] };
    return { ...payload, semantic_texts: texts };
  } catch { return payload; }
}

/** Per-segment term reports of a long manuscript in whole-text positions; `stale` when the segment changed since. */
export function segmentTermsOf(draft: Draft, semantic: SemanticState) {
  if (!semantic.terms.length) return [];
  const sc = chars(draft.source); const tc = chars(draft.target);
  return [...semantic.terms].sort((a, b) => a.region.source.start - b.region.source.start).map((t, index) => {
    const stale = segmentKey(draft.direction, slice(sc, t.region.source.start, t.region.source.end), slice(tc, t.region.target.start, t.region.target.end)) !== t.segmentKey;
    const shift = (span: Span | null, offset: number) => span === null ? null : { start: span.start + offset, end: span.end + offset, text: span.text };
    return {
      index, stale,
      source_start: t.region.source.start, source_end: t.region.source.end, target_start: t.region.target.start, target_end: t.region.target.end,
      report: t.report,
      findings: t.report.findings.map(f => ({ verdict: f.verdict, source_span: shift(f.source_span, t.region.source.start)!, target_span: shift(f.target_span, t.region.target.start), candidates: f.candidates.map(c => ({ zh: c.zh, en: c.en })) })),
    };
  });
}

/** Export parts: issue rows with their handling status; never a sentence-meaning certification. */
export function semanticExport(draft: Draft, semantic: SemanticState) {
  const segments = segmentTermsOf(draft, semantic);
  const terms = segments.length ? {
    segment_term_reports: segments.map(({ index, stale, source_start, source_end, target_start, target_end, report }) => ({ segment: index + 1, stale, source_start, source_end, target_start, target_end, report })),
  } : {};
  const markdownTerms = segments.length ? segments.map(({ index, stale, findings }) => ({ index, stale, findings })) : null;
  if (!semantic.placed.length && !semantic.decisions.length) return { result: terms, markdown: null, segmentTerms: markdownTerms };
  const statuses = new Map<string, string>();
  const issues = semantic.placed.map(p => { statuses.set(p.issue.id, (issueStatus(semantic, p) as { status: string }).status); return { ...p.issue, stale: p.stale }; });
  const items = semanticExportItems({ issues, statuses });
  const resolved = semanticIssuesResolved(statuses) as number;
  const readyPairs = safePairs(draft.source, draft.target, draft.alignments).filter(p => p.status === 'ready');
  const reviewed = readyPairs.filter(p => semantic.results.some(r => r.region.source.start === p.source.core_start && r.region.target.start === p.target.core_start
    && r.region.source.end === p.source.core_end && r.region.target.end === p.target.core_end)).length;
  return {
    result: { ...terms, semantic_review: { review_version: SEMANTIC_REVIEW_VERSION, origin: 'model', items }, semantic_issues_resolved: resolved },
    markdown: { items, resolved, segments: { total: readyPairs.length, reviewed } },
    segmentTerms: markdownTerms,
  };
}
