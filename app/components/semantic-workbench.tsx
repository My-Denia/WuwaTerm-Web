'use client';

// Semantic review, segmented runs and manual splitting for the review workbench (W2).
// The parent owns the draft and undo history. Request and run coordination live in their hooks.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { SEGMENT_LIMIT } from '../../lib/segmentation.js';
import {
  classifyFailure, itemDisplayState, runDisplayState, runProgress,
} from '../../lib/semantic-run.js';
import {
  TERM_GROUP_FILTERS, chooseTerm, filterTermGroups, groupTermOccurrences, reconfirmChoice,
  removeChoice, removeHistoryEntry, restorableHistory, restoreHistoryEntry, reviseSegmentTarget, segmentInputs, setCurrent,
  setFinished, spliceTargetSpan, summarizeTermCandidates, termGroupCounts, termPlan, termSegments, uncheckedTermSegments,
} from '../../lib/long-review.js';
import {
  CAPABILITY_SEMANTIC_REVIEW, CAPABILITY_TRANSLATION_CONTEXT, SEMANTIC_CATEGORIES,
  applySemanticSuggestion,
} from '../../lib/semantic-review.js';
import { makeSemanticDecision } from '../../lib/semantic-decisions.js';
import {
  isHandled, issueStatus, occurrenceKey,
  reconcileState, removeDecision, semanticSegmentViews, upsertDecision,
} from '../../lib/semantic-state.js';
import { insertParagraphBreak, linesToParagraphs, mergeParagraphs, pairShape, singleBreaks, splitLayout } from '../../lib/manual-split.js';
import { categoryLabel, labelJoiner } from '../../lib/dictionary-labels';
import { highlightSegments } from '../../lib/review-report.js';
import { compactScalarContext } from '../../lib/review-navigation.js';
import { failureDetails, fill, msg } from '../../lib/messages';
import { semanticMsg, type SemanticMessages } from '../../lib/semantic-messages';
import type { Pool } from '../../lib/pool-snapshot';
import { numberLocale, type UiLanguage } from '../../lib/ui-language';
import { useSemanticRequests } from './use-semantic-requests';
import { longExportRows as rowsOf } from '../../lib/workbench-persistence';
import type { ChoiceLike, Commit, Decision, Draft, LongCtx, LongState, Pair, PairView, Placed, RecordView, Region, SegmentInput, SemanticState, SessionBasis, Span, WorkRef } from '../../lib/workbench-model';
export type { Commit, Draft, LongState, SemanticState, SessionBasis } from '../../lib/workbench-model';

/**
 * Precedents are sent by default only because the Core evaluation's M′ gates
 * (same-sense reuse and led-astray) were met for them; re-read the C2 receipt
 * when the backend pin moves and turn this off if they are not.
 */
export const PRECEDENTS_DEFAULT_ON = true;

/** Longest list of segment numbers a banner spells out. */
const NUMBERS_SHOWN = 8;
type GroupFilter = import('../../lib/long-review.js').TermGroupFilter;
// Long-manuscript term review (lib/long-review.js; contracts/manuscript-v3/SPEC.md).
type TermCandidate = { candidate_id: string; zh: string; en: string; category: string };
type TermFinding = { id: string; verdict: string; source_span: Span; target_span: Span | null; candidates: TermCandidate[]; candidates_truncated: boolean; reason?: string };
type TermGroup = import('../../lib/long-review.js').TermGroup;
type Occurrence = import('../../lib/long-review.js').Occurrence;
type ContextSnippet = import('../../lib/long-review.js').Snippet;
const inputsOf = (draft: Draft) => segmentInputs(draft) as { long: boolean; items: SegmentInput[] };
type PoolView = { kind: 'loading' } | { kind: 'success'; data: Pool } | { kind: 'error' };
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
  documentEpoch: MutableRefObject<number>;
  canUndoLast: (serial: number) => boolean;
  undo: () => void;
  locate: (side: 'source' | 'target', span: Span) => void;
  onRunActive: (active: boolean) => void;
  /** The term section; long-mode term findings, choices and history are rendered into it. */
  termTrack: (longTerms: ReactNode) => ReactNode;
  basis: SessionBasis;
  basisRef: MutableRefObject<SessionBasis>;
  setBasis: (basis: SessionBasis) => void;
  /** The workbench's own alignment reset (alignments null, undoable). */
  resetAlignments: () => void;
};

const chars = (text: string) => Array.from(text);
const slice = (list: string[], start: number, end: number) => list.slice(start, end).join('');
const sliceEquals = (text: string, span: Span | null) => !!span && slice(chars(text), span.start, span.end) === span.text;
const overlaps = (a: Region, b: Region) => a.start < b.end && b.start < a.end;

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

/** A context snippet of the term view: the hit marked, with a hint where text was cut. */
function ContextLine({ context, missing }: { context: ContextSnippet | null; missing: string }) {
  if (!context) return <p className="review-excerpt">{missing}</p>;
  return <p className="review-excerpt">{context.clippedBefore ? '…' : null}{context.before}<mark>{context.hit}</mark>{context.after}{context.clippedAfter ? '…' : null}</p>;
}

function Snippet({ text, span, missing }: { text: string; span: Span | null; missing: string }) {
  const compact = span && highlightSegments(text, span) ? compactScalarContext(text, span) : null;
  if (!compact) return <p className="review-excerpt">{missing}</p>;
  return <p className="review-excerpt">{compact.clippedBefore ? '…' : null}{compact.before}<mark>{compact.hit}</mark>{compact.after}{compact.clippedAfter ? '…' : null}</p>;
}

export function SemanticWorkbench(props: Props) {
  const { lang, draft, semantic, setSemantic, commit, work, choices, pool, capabilities, resetSignal, documentEpoch, locate, onRunActive, basis, basisRef, setBasis } = props;
  const { source, target, direction } = draft;
  const s = semanticMsg(lang);
  const m = msg(lang);
  const locale = numberLocale(lang);
  const [usePrecedents, setUsePrecedents] = useState(PRECEDENTS_DEFAULT_ON);
  const [statusFilter, setStatusFilter] = useState<'pending' | 'handled' | 'reconfirm' | 'all'>('pending');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [segmentFilter, setSegmentFilter] = useState<number | 'all'>('all');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [choiceState, setChoiceState] = useState<{ id: string | null; value: 'suggestion' | 'alternative' }>({ id: null, value: 'suggestion' });
  const [adjusting, setAdjusting] = useState<{ placedId: string; text: string } | null>(null);
  const [localSegment, setLocalSegment] = useState<number | null>(null);
  const [splitOpen, setSplitOpen] = useState<number | null>(null);
  const [pendingCut, setPendingCut] = useState<{ side: 'source' | 'target'; offset: number; label: string } | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [lastAction, setLastAction] = useState<{ placedId: string; marker: number; kind: string } | null>(null);
  // The term view of a long manuscript: grouped by term (default) or in segment order, filtered by group status; the segment whose
  // translation is being revised (the occurrence that opened it, the translation it started from, the text typed).
  const [termView, setTermView] = useState<'groups' | 'segments'>('groups');
  const [groupFilter, setGroupFilterState] = useState<GroupFilter>('all');
  // The groups whose other places (the ones the filter is not about) are opened; a filter change closes them again.
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set());
  const setGroupFilter = (id: GroupFilter) => { setGroupFilterState(id); setOpenGroups(new Set()); };
  const toggleGroup = (key: string) => setOpenGroups(prev => { const next = new Set(prev); if (!next.delete(key)) next.add(key); return next; });
  const [revising, setRevising] = useState<{ key: string; index: number; base: string; text: string } | null>(null);
  // The split helper, which the banner's jump scrolls to and focuses.
  const splitRef = useRef<HTMLDivElement | null>(null);
  const activeMark = useRef<HTMLElement | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);

  const semanticOn = !!capabilities?.includes(CAPABILITY_SEMANTIC_REVIEW);
  const contextOn = !!capabilities?.includes(CAPABILITY_TRANSLATION_CONTEXT);
  const sourceChars = useMemo(() => chars(source), [source]);
  // One pairing for the views, the records, the requests and the writer (lib/long-review.js corePairs), cached per draft.
  const projection = useMemo(() => semanticSegmentViews(draft, { results: semantic.results, long: semantic.long }, basis) as { long: boolean; pairs: Pair[]; items: PairView[] }, [draft, semantic.results, semantic.long, basis]);
  const { long, pairs, items: views } = projection;
  const longCtx: LongCtx = useMemo(() => ({ draft, basis }), [draft, basis]);
  // In long mode the selected segment is the manuscript's current position (progress.current), saved with it.
  const selectedSegment = long ? semantic.long.progress.current : localSegment;
  const selectSegment = (index: number | null) => {
    if (long) commit({ semantic: state => ({ ...state, long: setCurrent(state.long, index) as LongState }), remember: false });
    else setLocalSegment(index);
  };
  const ready = views.filter(v => v.pair.status === 'ready');
  const { run, dispatch, now, pairTranslating, startRun, startTermRun, startTranslateRun, translatePair } = useSemanticRequests({
    lang, work, choices, basisRef, documentEpoch, setSemantic, commit, setBasis, resetSignal, usePrecedents, contextOn, ready, onStart: () => setLocalSegment(null),
  });
  const runActive = run.phase === 'running' || run.phase === 'waiting' || (run.phase === 'paused' && run.items.some(i => i.status === 'sending'));
  useEffect(() => { onRunActive(runActive || pairTranslating !== null); }, [runActive, pairTranslating, onRunActive]);

  // ---- run engine ----
  // Import, clear or a received draft replaces the manuscript: stop sending.
  const [resetSeen, setResetSeen] = useState(resetSignal);
  if (resetSeen !== resetSignal) {
    setResetSeen(resetSignal);
    dispatch({ type: 'reset' }); setActiveId(null); setLocalSegment(null); setSplitOpen(null); setLastAction(null); setRevising(null);
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
  const termCounts = { current: 0, saved: 0, stale: 0, finished: 0 };
  for (const v of ready) {
    if (!v.record) continue;
    if (v.record.state === 'current') termCounts.current += 1;
    else if (v.record.state === 'saved') termCounts.saved += 1;
    else if (v.record.state === 'stale') termCounts.stale += 1;
    if (v.record.finished) termCounts.finished += 1;
  }
  const plan = useMemo(() => (long ? termPlan(semantic.long, longCtx) : null), [long, semantic.long, longCtx]);
  const sendingItem = run.items.find(i => i.status === 'sending') ?? null;
  const runState = runDisplayState(run) as 'idle' | 'running' | 'retrying' | 'waiting' | 'paused' | 'failed' | 'done';
  const waitSeconds = run.waitUntil ? Math.max(0, Math.ceil((run.waitUntil - now) / 1000)) : 0;
  const poolData = pool.kind === 'success' ? pool.data : null;
  const pendingViews = ready.filter(v => !v.result);
  const estimateChars = pendingViews.reduce((n, v) => n + Math.max(chars(v.sCore).length, chars(v.tCore).length), 0);
  const runItemFor = (view: PairView) => (run.kind === 'term' ? run.items.find(i => i.key === view.termKey) ?? null
    : run.kind === 'semantic' ? run.items.find(i => i.key === view.itemKey) ?? null : null);
  const stopText = (code: string | null) => {
    if (!code) return s.stopGeneric;
    if (['llm_unavailable', 'semantic_review_unavailable', 'site_not_configured'].includes(code)) return run.kind === 'semantic' ? s.stopUnavailable : (m.rMsg as Record<string, string>)[code] ?? s.stopGeneric;
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
  // Waiting, paused, failed and retrying each have their own words (and data-run-state) for every kind of run.
  const needsRecheck = long ? ready.filter(v => v.record?.needsCheck).length : 0;
  const runPhaseLine = (() => {
    if (runState === 'idle') return null;
    const done = progress.done; const total = progress.total;
    const i = (sendingItem?.index ?? 0) + 1;
    if (runState === 'running') return fill(run.kind === 'term' ? s.phaseTermRunning : run.kind === 'translate' ? s.phaseTranslateRunning : s.phaseRunning, { i });
    if (runState === 'retrying') {
      const waited = sendingItem?.waited;
      return waited ? fill(s.phaseRetryingAfterWait, { i, a: sendingItem?.attempt ?? 2, w: waited }) : fill(s.phaseRetrying, { i, a: sendingItem?.attempt ?? 2 });
    }
    if (runState === 'waiting') return fill(s.phaseWaiting, { s: waitSeconds });
    if (runState === 'paused') return run.stopCode ? fill(run.kind === 'term' ? s.phaseTermQuota : s.phaseQuota, { done, total }) : fill(s.phasePaused, { done, total });
    if (runState === 'failed') {
      if (run.phase !== 'stopped') return fill(s.phaseDoneFailed, { n: progress.failed });
      // The cause class, what to do and the request id of the response that stopped the run.
      const details = failureDetails(lang, { kind: run.kind === 'translate' ? 'translation' : 'review', reason: run.stopCode, requestId: run.stopRequestId });
      return [fill(s.phaseStopped, { reason: stopText(run.stopCode) }), ...details].join(' ');
    }
    // A term run that ended says so only while every ready segment has a current result: after an edit the segment is to be checked again.
    if (run.kind === 'term') return needsRecheck > 0 ? fill(s.phaseTermDoneRecheck, { n: needsRecheck }) : s.phaseTermDone;
    return run.kind === 'translate' ? s.phaseTranslateDone : s.phaseDone;
  })();
  const issueRegion = activeView ?? null;

  // ---- long manuscripts: term findings, choices and history per segment (SPEC "Segment choice", "Runtime") ----
  const termRows = useMemo(() => (long ? rowsOf(semantic.long, longCtx) : []), [long, semantic.long, longCtx]);
  const restorable = useMemo(() => (long && semantic.long.history.length ? restorableHistory(semantic.long, longCtx) as (number | null)[] : []), [long, semantic.long, longCtx]);
  // A user action on the long state: one undo step, nothing when the library refuses it (too_many_choices gets its notice).
  const commitLong = (update: (state: LongState) => { long: LongState; error?: string | null } | LongState, notice: string | null = null) => {
    const unwrap = (out: ReturnType<typeof update>) => ('records' in out ? { long: out, error: null } : { long: out.long, error: out.error ?? null });
    const probe = unwrap(update(work.current.semantic.long));
    if (probe.error) { if (probe.error === 'too_many_choices') commit({ notice: 'choiceLimit', remember: false }); return; }
    if (probe.long === work.current.semantic.long) return;
    commit({ semantic: state => { const out = unwrap(update(state.long)); return out.error || out.long === state.long ? state : { ...state, long: out.long }; }, notice });
  };
  const chooseLong = (index: number, finding: TermFinding, candidate: TermCandidate | null) =>
    commitLong(state => chooseTerm(state, { index, finding, candidate }, { draft: work.current.draft, basis: basisRef.current }) as { long: LongState; error: string | null }, 'sem:longChoiceRecorded');
  const choiceAt = (view: PairView | undefined, span: Span) => view?.record?.choices.find(c => c.source_span.start === span.start && c.source_span.end === span.end) ?? null;
  const choiceViewText = (v: 'applies' | 'needs_reconfirmation' | 'waiting') => ({ applies: s.choiceApplies, needs_reconfirmation: s.choiceNeedsReconfirm, waiting: s.choiceWaiting }[v]);
  const termStateText = (record: RecordView) => {
    const base = { pending: s.segTermPending, saved: s.segTermSaved, current: s.segTermChecked, stale: s.segTermStale }[record.state];
    if (!record.finished) return base;
    return record.state === 'current' ? s.segFinished : record.state === 'stale' ? s.segFinishedRecheck : `${s.segFinished} · ${base}`;
  };
  const LONG_ROWS = 100;
  const targetChars = useMemo(() => chars(target), [target]);
  // Every segment's findings grouped by term (lib/long-review.js groupTermOccurrences), each place with its context.
  // The ready segments that have no result (never checked, or edited since) are passed too: a term they hold is not yet confirmed.
  const termGroups = useMemo(() => (long ? groupTermOccurrences(termSegments(semantic.long, longCtx), source, target, direction, uncheckedTermSegments(semantic.long, longCtx)) as TermGroup[] : []),
    [long, semantic.long, longCtx, source, target, direction]);
  // One rule decides what a filter button counts and what it shows (lib/long-review.js filterTermGroups): the selected segment's places
  // when one is selected (a group keeps the traits of all its places), the groups that hold a place of the filter's kind, and in each
  // the places the filter is about, the rest on request.
  const groupCounts = useMemo(() => termGroupCounts(termGroups, selectedSegment), [termGroups, selectedSegment]);
  const filteredGroups = useMemo(() => filterTermGroups(termGroups, groupFilter, { segment: selectedSegment, expanded: openGroups }), [termGroups, groupFilter, selectedSegment, openGroups]);
  const placeCount = filteredGroups.reduce((n, g) => n + g.occurrences.length, 0);
  const collapsedCount = filteredGroups.reduce((n, g) => n + (openGroups.has(g.key) ? 0 : g.hidden), 0);
  // At most LONG_ROWS places on screen at once, as before; selecting a segment shows its places in full.
  let budget = selectedSegment === null ? LONG_ROWS : Infinity;
  const shownGroups = filteredGroups.flatMap(g => {
    if (budget <= 0) return [];
    const part = g.occurrences.slice(0, budget);
    budget -= part.length;
    return [{ ...g, occurrences: part }];
  });
  const shownFlat = shownGroups.flatMap(g => g.occurrences);
  const orderedFlat = termView === 'segments'
    ? filteredGroups.flatMap(g => g.occurrences).sort((a, b) => a.segmentIndex - b.segmentIndex || a.docSource.start - b.docSource.start).slice(0, selectedSegment === null ? LONG_ROWS : undefined)
    : [];
  // Ready segments without a result (never checked, or edited since): their terms are not in the groups.
  const uncheckedSegments = ready.filter(v => v.record?.state === 'pending').length;
  const truncatedRows = termRows.filter(r => r.report.truncated && (selectedSegment === null || r.index === selectedSegment));
  const longChoices = long ? views.flatMap((v, index) => (v.record?.choices ?? []).map(c => ({ index, view: v, choice: c }))) : [];

  const segmentLabel = (view: PairView) => {
    const item = runItemFor(view);
    if (view.pair.status === 'needs_manual_split') return s.segManual;
    if (view.pair.status === 'untranslated') return s.segUntranslated;
    if (view.pair.status === 'unpaired_target') return s.segUnpaired;
    const itemState = item ? itemDisplayState(run, item) as string : null;
    const runText = itemState === null || itemState === 'done' ? null
      : { queued: s.segQueued, sending: run.kind === 'term' ? s.segTermSending : s.segSending, retrying: s.segRetrying, waiting: s.segWaiting, paused: s.segPaused, failed: s.segFailed, skipped: s.segSkipped }[itemState] ?? null;
    // A long-mode segment keeps showing its term state beside the run state (e.g. queued · finished · re-check pending).
    const term = view.record ? termStateText(view.record) : null;
    if (runText) return term ? `${runText} · ${term}` : runText;
    if (!semanticOn) return term ?? s.segTermPending;
    const semanticText = view.result ? (view.result.imported ? s.segImported : s.segReviewed) : view.edited ? s.segEdited : s.segPending;
    return term ? `${semanticText} · ${term}` : semanticText;
  };

  const shape = (view: PairView) => pairShape(source, target, view.pair) as { sourceParagraphs: number; targetParagraphs: number; sourceSentences: number; targetSentences: number; sourceLength: number; targetLength: number };
  // The helper follows the manual pair the user opened; after an edit re-pairs the
  // text it moves to the nearest pair that still needs a manual split.
  const manualViews = views.filter(v => v.pair.status === 'needs_manual_split');
  const splitView = splitOpen === null ? null : manualViews.find(v => v.pair.index === splitOpen) ?? manualViews.find(v => v.pair.index >= splitOpen) ?? manualViews.at(-1) ?? null;
  // The banner's jump: the first pair that needs a manual split is selected, the segment filters follow it and the helper opens and
  // takes focus. It does not edit anything.
  function jumpToManual() {
    const first = manualViews[0];
    if (!first) return;
    selectSegment(first.pair.index);
    setSegmentFilter(first.pair.index);
    setSplitOpen(first.pair.index);
    // After the render that opens the helper (it may already be open at this pair).
    requestAnimationFrame(() => {
      splitRef.current?.scrollIntoView({ block: 'start' });
      splitRef.current?.focus({ preventScroll: true });
    });
  }
  const runTermLabel = !plan ? '' : plan.probe !== null && plan.saved > 0
    ? (plan.due > 0 ? fill(s.runTermConfirmAnd, { n: plan.cost }) : s.runTermConfirm)
    : fill(s.runTerm, { n: plan.cost });

  // ---- per-place edits in the term view: one place at a time, each its own undo step ----
  const rendering = (candidate: TermCandidate) => (direction === 'en' ? candidate.en : candidate.zh);
  /** Replace only this place's translation with the candidate's rendering; never every place the same word stands. */
  function replaceOccurrence(occ: Occurrence, candidate: TermCandidate) {
    const d = work.current.draft;
    if (!occ.docTarget) return;
    const out = spliceTargetSpan(d.target, occ.docTarget, rendering(candidate)) as { target?: string; error?: string };
    if (out.error === 'span_mismatch') { commit({ semantic: x => x, notice: 'sem:longReplaceStale', remember: false }); return; }
    if (out.target === undefined) return;
    commit({ draft: { ...d, target: out.target, alignments: d.alignments === null ? null : [] }, notice: 'sem:longTargetReplaced' });
  }
  function openRevise(occ: Occurrence) {
    const item = inputsOf(work.current.draft).items[occ.segmentIndex];
    if (item) setRevising({ key: occ.key, index: occ.segmentIndex, base: item.targetCore, text: item.targetCore });
  }
  /** The segment's translation core becomes the typed text; the rest of the translation stays. */
  function applyRevise() {
    if (!revising) return;
    const d = work.current.draft;
    const item = inputsOf(d).items[revising.index];
    const out = (item ? reviseSegmentTarget(d.target, { start: item.range.target_start, end: item.range.target_end }, revising.base, revising.text) : { error: 'core_mismatch' }) as { target?: string; error?: string };
    if (out.target === undefined) { if (out.error !== 'noop') commit({ semantic: x => x, notice: 'sem:longReviseInvalid', remember: false }); return; }
    setRevising(null);
    commit({ draft: { ...d, target: out.target, alignments: d.alignments === null ? null : [] }, notice: 'sem:longSegmentRevised' });
  }
  const numberList = (numbers: number[]) => numbers.slice(0, NUMBERS_SHOWN).join(lang === 'en' ? ', ' : '、') + (numbers.length > NUMBERS_SHOWN ? '…' : '');
  const renderOccurrence = (occ: Occurrence) => {
    const finding = occ.finding as TermFinding;
    const view = views[occ.segmentIndex];
    const chosen = choiceAt(view, finding.source_span);
    // A one-click replacement only where the translation still reads what the finding saw.
    const live = occ.docTarget !== null && slice(targetChars, occ.docTarget.start, occ.docTarget.end) === occ.docTarget.text;
    const at = { index: occ.segmentIndex, start: finding.source_span.start, end: finding.source_span.end };
    const editing = revising?.key === occ.key ? revising : null;
    const stateText = { saved: s.segTermSaved, current: s.segTermChecked, stale: s.segTermStale }[occ.freshness];
    return <article className="term-result long-term" key={occ.key} data-segment={occ.segmentIndex} data-mention-id={finding.id} data-term-state={occ.freshness} data-verdict={occ.verdict} data-attention={occ.attention}>
      <p className="result-summary"><span className={`verdict-badge verdict-${occ.verdict}`}>{(m.review.verdicts as Record<string, string>)[occ.verdict]}</span> · {fill(s.segmentLabel, { n: occ.segmentNumber })} · {finding.source_span.text}{occ.freshness !== 'current' ? ` · ${stateText}` : ''}{finding.candidates_truncated ? m.review.truncatedMark : ''}</p>
      {occ.reason && <p className="finding-reason" data-reason={occ.reason}>{fill(m.review.reasonLabel, { reason: (m.review.reasons as Record<string, string>)[occ.reason] ?? occ.reason })}</p>}
      <p className="occurrence-position">{fill(m.review.spanRange, { start: occ.docSource.start + 1, end: occ.docSource.end })}</p>
      <div className="excerpt-labeled"><span className="excerpt-tag">{m.review.excerptSourceLabel}</span><ContextLine context={occ.sourceContext} missing={s.sourceMissing} /></div>
      <div className="excerpt-labeled"><span className="excerpt-tag">{m.review.excerptTargetLabel}</span>
        {occ.targetContext ? <ContextLine context={occ.targetContext} missing={m.review.excerptMissingTarget} />
          : occ.targetExcerpt ? <><p className="review-excerpt target-excerpt">{occ.targetExcerpt.text}{occ.targetExcerpt.clipped ? '…' : ''}</p><p className="track-note">{s.occurrenceExcerpt}</p></>
            : <p className="review-excerpt">{m.review.excerptMissingTarget}</p>}
      </div>
      {/* A place Core did not evaluate is not a missed translation (香椿 is not 椿): no "no matching word" line, the reason above says why. */}
      {(occ.translation !== null || occ.verdict !== 'not_evaluated') && <p className="occurrence-translation" data-hit={occ.translation === null ? 'false' : 'true'}>{occ.translation === null ? s.occurrenceNoHit : fill(s.occurrenceTranslation, { text: occ.translation })}</p>}
      {occ.candidates.map(c => <div className="term-pair" key={c.candidate_id}><strong>{c.zh}</strong><span>{c.en}</span><small>{m.terms.category}{labelJoiner(lang)}{categoryLabel(lang, c.category)}</small>
        <div className="finding-actions">
          <button type="button" className="text-button" onClick={() => chooseLong(occ.segmentIndex, finding, c)}>{m.review.adopt}</button>
          {live && rendering(c) !== occ.translation && <button type="button" className="text-button" title={fill(s.occReplaceAria, { n: occ.segmentNumber, term: rendering(c) })} onClick={() => replaceOccurrence(occ, c)}>{fill(s.occReplace, { term: rendering(c) })}</button>}
        </div>
      </div>)}
      <div className="finding-actions">
        <button type="button" className="text-button" onClick={() => chooseLong(occ.segmentIndex, finding, null)}>{m.review.notTerm}</button>
        <button type="button" className="text-button" onClick={() => locate('source', occ.docSource)}>{m.review.jumpSource}</button>
        <button type="button" className="text-button" disabled={!occ.docTarget} onClick={() => { if (occ.docTarget) locate('target', occ.docTarget); }}>{m.review.jumpTarget}</button>
        {!occ.docTarget && <button type="button" className="text-button" aria-expanded={!!editing} onClick={() => (editing ? setRevising(null) : openRevise(occ))}>{s.occRevise}</button>}
      </div>
      {chosen && <p className="long-choice-state" data-choice-view={chosen.view}>{chosen.candidate ? fill(m.review.choicePair, { span: chosen.source_span.text, zh: chosen.candidate.zh, en: chosen.candidate.en }) : fill(m.review.choiceNotTerm, { span: chosen.source_span.text })} — {choiceViewText(chosen.view)}
        {chosen.view === 'needs_reconfirmation' && view?.record?.state !== 'pending' && <> <button type="button" className="text-button" onClick={() => commitLong(state => reconfirmChoice(state, at) as { long: LongState; error: string | null }, 'sem:longChoiceRecorded')}>{s.choiceReconfirm}</button></>}</p>}
      {editing && <div className="term-revise" role="group" aria-label={fill(s.reviseTitle, { n: occ.segmentNumber })}>
        <h5>{fill(s.reviseTitle, { n: occ.segmentNumber })}</h5>
        <p className="track-note">{s.reviseHint}</p>
        <label htmlFor={`revise-${occ.key}`}>{fill(s.reviseLabel, { n: occ.segmentNumber })}</label>
        <textarea id={`revise-${occ.key}`} rows={Math.min(14, Math.max(4, Math.ceil(chars(editing.text).length / 60)))} value={editing.text} onChange={e => setRevising({ ...editing, text: e.target.value })} />
        <div className="actions">
          <button type="button" disabled={!editing.text.trim() || editing.text === editing.base} onClick={applyRevise}>{s.reviseApply}</button>
          <button type="button" className="secondary-button" onClick={() => setRevising(null)}>{s.reviseCancel}</button>
        </div>
      </div>}
    </article>;
  };

  // Shown in long mode, and in document mode while the choice history holds entries (leaving long mode moves every
  // choice there; the user can remove them, SPEC "Leaving long mode").
  const longTerms: ReactNode = long || semantic.long.history.length > 0 ? <div className="long-term-list" role="region" aria-label={s.longTermsTitle}>
    <h4>{s.longTermsTitle}</h4>
    {long && <p className="track-note">{s.longTermsNote}</p>}
    {long && termRows.length === 0 && <p>{s.longTermsNone}</p>}
    {long && selectedSegment !== null && <p className="track-note">{fill(s.longTermsFiltered, { n: selectedSegment + 1 })}</p>}
    {long && termGroups.length > 0 && <div className="term-view-bar">
      <div className="term-view-toggle" role="group" aria-label={s.termViewAria}>
        {(['groups', 'segments'] as const).map(id => <button key={id} type="button" className="secondary-button" aria-pressed={termView === id} onClick={() => setTermView(id)}>{id === 'groups' ? s.termViewGroups : s.termViewSegments}</button>)}
      </div>
      <div className="semantic-filters term-group-filters" role="group" aria-label={s.groupFilterAria}>
        {TERM_GROUP_FILTERS.map(id => <button key={id} type="button" className="secondary-button" aria-pressed={groupFilter === id} data-group-filter={id} data-group-count={groupCounts[id]}
          aria-label={fill(s.groupFilterPill, { label: s.groupFilters[id], n: groupCounts[id] })} onClick={() => setGroupFilter(id)}>{s.groupFilters[id]} {groupCounts[id]}</button>)}
      </div>
    </div>}
    {long && termGroups.length > 0 && <p className="track-note group-filter-summary" role="status" aria-live="polite" data-groups={filteredGroups.length} data-places={placeCount} data-collapsed={collapsedCount}>
      {fill(s.groupFilterSummary, { label: s.groupFilters[groupFilter], groups: filteredGroups.length, places: placeCount })}{collapsedCount > 0 ? fill(termView === 'groups' ? s.groupHiddenInGroups : s.groupHiddenInSegments, { n: collapsedCount }) : ''}</p>}
    {long && truncatedRows.map(r => <p key={`${r.index}:truncated`} className="track-note long-term-truncated" data-segment={r.index}>{fill(s.longTermsTruncated, { n: r.index + 1, k: r.report.findings.length })}</p>)}
    {long && termGroups.length > 0 && uncheckedSegments > 0 && <p className="track-note groups-unchecked" role="status">{fill(s.groupsUnchecked, { n: uncheckedSegments })}</p>}
    {long && termGroups.length > 0 && filteredGroups.length === 0 && <p className="track-note">{s.groupsNone}</p>}
    {long && termView === 'groups' && shownGroups.map(g => <section className="term-group" key={g.key} data-group-status={g.status} data-group-key={g.key} data-group-surface={g.surface} data-group-saved={g.savedCount} aria-label={g.surface}>
      <header className="term-group-head">
        <h5 className="term-group-title"><span className="term-surface">{g.surface}</span>{g.surfaces.length > 1 && <span className="term-variants">（{g.surfaces.slice(1).join('、')}）</span>} <span className={`group-status group-status-${g.status}`}>{s.groupStatuses[g.status]}</span></h5>
        <p className="term-group-meta">{fill(s.groupHead, { n: g.occurrenceCount, segments: numberList(g.segments) })}</p>
        <p className="term-group-tally" data-pending={g.pendingCount} data-not-evaluated={g.notEvaluatedCount} data-confirmed={g.confirmedCount}>{[
          g.pendingCount > 0 && fill(s.groupTallyPending, { n: g.pendingCount }), g.notEvaluatedCount > 0 && fill(s.groupTallyNotEvaluated, { n: g.notEvaluatedCount }),
          g.confirmedCount > 0 && fill(s.groupTallyConfirmed, { n: g.confirmedCount }),
        ].filter(Boolean).join(' · ')}</p>
        {g.unverifiedSegments.length > 0 && <p className="term-group-unverified"><span className="group-status group-status-pending" data-unverified={g.unverifiedSegments.join(',')}>{fill(s.groupUnverified, { list: numberList(g.unverifiedSegments) })}</span></p>}
        {g.savedCount > 0 && <p className="term-group-saved" data-saved={g.savedCount}><span className="group-status group-status-pending">{s.groupSaved}</span></p>}
        <p className="term-group-renderings">{fill(s.groupRenderings, { items: g.renderings.map(r => fill(s.renderingItem, { text: r.kind === 'not_evaluated' ? s.renderingNotEvaluated : r.text ?? s.renderingNone, n: r.count })).join(' · ') })}</p>
        {g.candidates.length > 0 && <p className="term-group-candidates">{fill(s.groupCandidates, { items: summarizeTermCandidates(g.candidates).map(c => {
          const categories = c.categories.map((category: string) => categoryLabel(lang, category)).join(lang === 'en' ? ', ' : '、');
          return `${c.zh} / ${c.en}${c.categories.length > 1 ? ` (${categories})` : ''}`;
        }).join(lang === 'en' ? '; ' : '；') })}</p>}
        {g.hidden > 0 && <button type="button" className="text-button group-rest-toggle" aria-expanded={openGroups.has(g.key)} onClick={() => toggleGroup(g.key)}>{fill(openGroups.has(g.key) ? s.groupHideRest : s.groupShowRest, { n: g.hidden })}</button>}
      </header>
      {g.occurrences.map(renderOccurrence)}
    </section>)}
    {long && termView === 'segments' && orderedFlat.map(renderOccurrence)}
    {long && selectedSegment === null && placeCount > (termView === 'groups' ? shownFlat.length : orderedFlat.length) && <p className="track-note">{fill(s.longTermsMore, { n: placeCount - (termView === 'groups' ? shownFlat.length : orderedFlat.length) })}</p>}
    {longChoices.length > 0 && <div className="choice-records long-choices"><h4>{fill(s.longChoicesTitle, { n: longChoices.length })}</h4>
      {longChoices.map(({ index, view, choice: c }) => {
        const at = { index, start: c.source_span.start, end: c.source_span.end };
        return <div className="choice-record" key={`${index}:${c.source_span.start}:${c.source_span.end}`} data-segment={index} data-choice-view={c.view}>
          <p>{fill(s.segmentLabel, { n: index + 1 })} · {c.candidate ? fill(m.review.choicePair, { span: c.source_span.text, zh: c.candidate.zh, en: c.candidate.en }) : fill(m.review.choiceNotTerm, { span: c.source_span.text })} — {choiceViewText(c.view)}</p>
          <div className="finding-actions">
            {c.view === 'needs_reconfirmation' && view.record?.state !== 'pending' && <button type="button" className="text-button" onClick={() => commitLong(state => reconfirmChoice(state, at) as { long: LongState; error: string | null }, 'sem:longChoiceRecorded')}>{s.choiceReconfirm}</button>}
            <button type="button" className="text-button" onClick={() => commitLong(state => removeChoice(state, at) as LongState)}>{m.review.choiceRemove}</button>
          </div>
        </div>;
      })}
    </div>}
    {semantic.long.history.length > 0 && <details className="long-history"><summary>{fill(s.historyTitle, { n: semantic.long.history.length })}</summary>
      <p className="track-note">{s.historyNote}</p>
      {semantic.long.history.map((entry, position) => <div className="choice-record" key={`${position}:${entry.source_hash}:${entry.source_span.start}`}>
        <p>{entry.candidate ? fill(m.review.choicePair, { span: entry.source_span.text, zh: entry.candidate.zh, en: entry.candidate.en }) : fill(m.review.choiceNotTerm, { span: entry.source_span.text })}</p>
        <div className="finding-actions">
          {restorable[position] !== null && restorable[position] !== undefined && <button type="button" className="text-button" onClick={() => commitLong(state => restoreHistoryEntry(state, position, restorable[position]!, { draft: work.current.draft, basis: basisRef.current }) as { long: LongState; error: string | null })}>{fill(s.historyRestore, { n: (restorable[position] ?? 0) + 1 })}</button>}
          <button type="button" className="text-button" onClick={() => commitLong(state => removeHistoryEntry(state, position) as LongState)}>{s.historyRemove}</button>
        </div>
      </div>)}
    </details>}
  </div> : null;

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
          <button type="button" className={`secondary-button${needsRecheck > 0 && termRows.length > 0 && !runActive ? ' recheck-prominent' : ''}`} data-recheck={needsRecheck > 0 && termRows.length > 0 ? 'true' : undefined} disabled={runActive || reviewsClosed || !plan?.cost} onClick={startTermRun}>{runTermLabel}</button>
        </div>
      </div>}
      {draft.alignments !== null && <div className="actions">
        <button type="button" className="secondary-button" disabled={runActive} onClick={props.resetAlignments}>{s.useAutoAlignment}</button>
      </div>}
    </div>}

    {showSegments && <section className="segment-panel" aria-label={s.segmentsAria}>
      <div className="segment-head">
        <h3>{s.segmentsTitle}</h3>
        {run.kind === 'translate'
          ? <p>{fill(s.translateProgress, { done: progress.done, total: progress.total })}</p>
          : <p>{semanticOn ? fill(s.progress, { done: reviewedCount, total: ready.length }) : fill(s.termProgress, { done: termCounts.current, total: ready.length })}{progress.failed ? fill(s.progressFailed, { n: progress.failed }) : ''}{progress.skipped ? fill(s.progressSkipped, { n: progress.skipped }) : ''}{semanticOn && long ? ` · ${fill(s.termProgress, { done: termCounts.current, total: ready.length })}` : ''}{long && termCounts.saved ? fill(s.termProgressSaved, { n: termCounts.saved }) : ''}{long && termCounts.stale ? fill(s.termProgressStale, { n: termCounts.stale }) : ''}{long && termCounts.finished ? fill(s.termProgressFinished, { n: termCounts.finished }) : ''}</p>}
      </div>
      {runState !== 'idle' && <progress max={Math.max(1, progress.total)} value={progress.done} aria-label={runPhaseLine ?? ''} />}
      {runPhaseLine && <p className="run-phase" role="status" aria-live="polite" data-run-state={runState} data-run-kind={run.kind ?? undefined}>{runPhaseLine}</p>}
      {manualViews.length > 0 && <div className="mismatch-banner" role="status" aria-live="polite" data-mismatch-count={manualViews.length}>
        <p className="mismatch-title"><strong>{fill(s.mismatchTitle, { n: manualViews.length })}</strong></p>
        <p>{s.mismatchBody}</p>
        <p className="track-note">{fill(s.mismatchList, { list: numberList(manualViews.map(v => v.pair.index + 1)) })}</p>
        <button type="button" className="secondary-button" onClick={jumpToManual}>{s.mismatchJump}</button>
      </div>}
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
          const record = view.record;
          return <li key={view.itemKey + view.pair.index} className="segment-chip" data-status={view.pair.status} data-current={selectedSegment === view.pair.index ? 'true' : undefined}
            data-run-state={item ? itemDisplayState(run, item) as string : undefined} data-term-state={record?.state} data-finished={record?.finished ? 'true' : undefined}>
            <button type="button" className="text-button" aria-pressed={selectedSegment === view.pair.index} onClick={() => { selectSegment(selectedSegment === view.pair.index ? null : view.pair.index); setSegmentFilter(selectedSegment === view.pair.index ? 'all' : view.pair.index); }}>
              {fill(s.segmentLabel, { n: view.pair.index + 1 })} · {label}{view.pair.hard_cut ? ` · ${s.segHardCut}` : ''}
            </button>
            {item?.status === 'failed' && !runActive && <button type="button" className="text-button" onClick={() => dispatch({ type: 'retry', key: item.key })}>{s.segRetry}</button>}
            {record && (record.finished || record.state !== 'pending') && <button type="button" className="text-button" aria-pressed={record.finished}
              onClick={() => commitLong(state => setFinished(state, view.pair.index, !record.finished) as LongState)}>{record.finished ? s.segUnmarkFinished : s.segMarkFinished}</button>}
            {semanticOn && view.pair.status === 'ready' && !runActive && (view.edited || (!view.result && item?.status !== 'failed')) && !translationClosed
              && <button type="button" className="text-button" onClick={() => startRun('semantic', [view])}>{s.segReview}</button>}
            {view.pair.status === 'untranslated' && <button type="button" className="text-button" disabled={pairTranslating !== null || runActive || translationClosed || chars(view.sCore).length > SEGMENT_LIMIT} onClick={() => void translatePair(view)}>{s.segTranslate}</button>}
            {view.pair.status === 'needs_manual_split' && <button type="button" className="text-button" aria-expanded={splitOpen === view.pair.index} onClick={() => setSplitOpen(splitOpen === view.pair.index ? null : view.pair.index)}>{splitOpen === view.pair.index ? s.manualClose : s.manualOpen}</button>}
            {view.pair.hard_cut && <p className="segment-hint">{s.hardCutHint}</p>}
            {view.pair.status === 'untranslated' && <p className="segment-hint">{s.untranslatedHint}</p>}
            {view.pair.status === 'unpaired_target' && <p className="segment-hint">{s.unpairedHint}</p>}
            {view.pair.status === 'needs_manual_split' && (() => { const sh = shape(view); return <p className="segment-hint">{fill(s.manualHint, { sp: sh.sourceParagraphs, ss: sh.sourceSentences, sl: sh.sourceLength.toLocaleString(locale), tp: sh.targetParagraphs, ts: sh.targetSentences, tl: sh.targetLength.toLocaleString(locale) })}</p>; })()}
          </li>;
        })}
      </ol>
      {splitOpen !== null && (splitView
        ? <SplitHelper s={s} locale={locale} source={source} target={target} view={splitView} splitAt={splitAt} merge={merge} linesAsParagraphs={linesAsParagraphs}
          pending={pendingCut} cancelPending={() => setPendingCut(null)} splitPendingOnly={splitPendingOnly} innerRef={splitRef} />
        : <p className="split-helper" role="status">{s.splitResolved} <button type="button" className="text-button" onClick={() => setSplitOpen(null)}>{s.manualClose}</button></p>)}
    </section>}

    {props.termTrack(longTerms)}

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

function SplitHelper({ s, locale, source, target, view, splitAt, merge, linesAsParagraphs, pending, cancelPending, splitPendingOnly, innerRef }: {
  s: SemanticMessages; locale: string; source: string; target: string; view: PairView;
  splitAt: (side: 'source' | 'target', offset: number, paired: boolean, label: string) => void; merge: (side: 'source' | 'target', a: number, b: number) => void;
  linesAsParagraphs: (side: 'source' | 'target', region: Region) => void;
  pending: { side: 'source' | 'target'; offset: number; label: string } | null; cancelPending: () => void; splitPendingOnly: () => void;
  innerRef: MutableRefObject<HTMLDivElement | null>;
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
  return <div className="split-helper" role="region" aria-label={s.splitTitle} tabIndex={-1} ref={innerRef}>
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
