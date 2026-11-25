'use client';

// Semantic review, segmented runs and manual splitting for the review workbench (W2).
// Thin React view layer over lib/workbench-controller.ts.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { SEGMENT_LIMIT } from '../../lib/segmentation.ts';
import {
  classifyFailure, itemDisplayState, runDisplayState, runProgress,
} from '../../lib/semantic-run.js';
import {
  TERM_GROUP_FILTERS, filterTermGroups, groupTermOccurrences, restorableHistory,
  summarizeTermCandidates, termGroupCounts, termPlan, termSegments, uncheckedTermSegments,
} from '../../lib/long-review.ts';
import {
  CAPABILITY_SEMANTIC_REVIEW, CAPABILITY_TRANSLATION_CONTEXT, SEMANTIC_CATEGORIES,
} from '../../lib/semantic-review.js';
import { isHandled, issueStatus, semanticSegmentViews } from '../../lib/semantic-state.js';
import { pairShape, singleBreaks, splitLayout } from '../../lib/manual-split.ts';
import { categoryLabel, labelJoiner } from '../../lib/dictionary-labels';
import { highlightSegments } from '../../lib/review-report.js';
import { compactScalarContext } from '../../lib/review-navigation.js';
import { failureDetails, fill, msg } from '../../lib/messages';
import { semanticMsg, type SemanticMessages } from '../../lib/semantic-messages';
import type { PoolView } from '../../lib/runtime-store';
import { numberLocale, type UiLanguage } from '../../lib/ui-language';
import { longExportRows as rowsOf } from '../../lib/workbench-persistence';
import { isRunActive, PRECEDENTS_DEFAULT_ON, type WorkbenchController, type WorkbenchSnapshot } from '../../lib/workbench-controller';
import type { Decision, LongCtx, Pair, PairView, Placed, RecordView, Region, SemanticDecisionKind, SemanticState, Span } from '../../lib/workbench-model';
export { PRECEDENTS_DEFAULT_ON };
export type { Commit, Draft, LongState, SemanticState, SessionBasis } from '../../lib/workbench-model';

/** Longest list of segment numbers a banner spells out. */
const NUMBERS_SHOWN = 8;
type GroupFilter = import('../../lib/long-review.ts').TermGroupFilter;
type TermCandidate = { candidate_id: string; zh: string; en: string; category: string };
type TermFinding = { id: string; verdict: string; source_span: Span; target_span: Span | null; candidates: TermCandidate[]; candidates_truncated: boolean; reason?: string };
type TermGroup = import('../../lib/long-review.ts').TermGroup;
type Occurrence = import('../../lib/long-review.ts').Occurrence;
type ContextSnippet = import('../../lib/long-review.ts').Snippet;
type Props = {
  doc: WorkbenchController;
  snapshot: WorkbenchSnapshot;
  lang: UiLanguage;
  pool: PoolView;
  locate: (side: 'source' | 'target', span: Span) => void;
  /** The term section; long-mode term findings, choices and history are rendered into it. */
  termTrack: (longTerms: ReactNode) => ReactNode;
};

const chars = (text: string) => Array.from(text);
const slice = (list: string[], start: number, end: number) => list.slice(start, end).join('');
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
  const { doc, snapshot, lang, pool, locate } = props;
  const { draft, semantic, capabilities, basis, resetSignal, run, now, pairTranslating, usePrecedents, lastSemanticAction } = snapshot;
  const { source, target, direction } = draft;
  const s = semanticMsg(lang);
  const m = msg(lang);
  const locale = numberLocale(lang);
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
  const [termView, setTermView] = useState<'groups' | 'segments'>('groups');
  const [groupFilter, setGroupFilterState] = useState<GroupFilter>('all');
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set());
  const setGroupFilter = (id: GroupFilter) => { setGroupFilterState(id); setOpenGroups(new Set()); };
  const toggleGroup = (key: string) => setOpenGroups(prev => { const next = new Set(prev); if (!next.delete(key)) next.add(key); return next; });
  const [revising, setRevising] = useState<{ key: string; index: number; base: string; text: string } | null>(null);
  const splitRef = useRef<HTMLDivElement | null>(null);
  const activeMark = useRef<HTMLElement | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);

  const semanticOn = !!capabilities?.includes(CAPABILITY_SEMANTIC_REVIEW);
  const contextOn = !!capabilities?.includes(CAPABILITY_TRANSLATION_CONTEXT);
  const sourceChars = useMemo(() => chars(source), [source]);
  const projection = useMemo(() => semanticSegmentViews(draft, { results: semantic.results, long: semantic.long }, basis) as { long: boolean; pairs: Pair[]; items: PairView[] }, [draft, semantic.results, semantic.long, basis]);
  const { long, pairs, items: views } = projection;
  const longCtx: LongCtx = useMemo(() => ({ draft, basis }), [draft, basis]);
  const selectedSegment = long ? semantic.long.progress.current : localSegment;
  const selectSegment = (index: number | null) => {
    if (long) doc.selectLongSegment(index);
    else setLocalSegment(index);
  };
  const ready = views.filter(v => v.pair.status === 'ready');
  const runActive = isRunActive(run);

  // Import, clear or a received draft replaces the manuscript: clear local view selections.
  const [resetSeen, setResetSeen] = useState(resetSignal);
  if (resetSeen !== resetSignal) {
    setResetSeen(resetSignal);
    setActiveId(null); setLocalSegment(null); setSplitOpen(null); setRevising(null);
  }

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

  function startRun(only?: PairView[]) {
    setLocalSegment(null);
    doc.startSemanticRun(only, lang);
  }

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
    if (nextId && statusFilter !== 'pending' && statusFilter !== 'all') setStatusFilter('pending');
  }

  async function decide(row: (typeof rows)[number], kind: SemanticDecisionKind, text?: string) {
    const outcome = await doc.applySemanticDecision(
      kind === 'accepted'
        ? { placedId: row.placed.id, kind, useAlternative: choice === 'alternative' }
        : kind === 'adjusted'
          ? { placedId: row.placed.id, kind, text: text ?? '' }
          : { placedId: row.placed.id, kind },
    );
    if (!outcome.applied) return;
    setAdjusting(null);
    advanceFrom(row.placed.id, doc.getSnapshot().semantic);
  }

  function undoDecision(row: (typeof rows)[number]) {
    if (doc.undoSemanticDecision(row.placed.id)) setActiveId(row.placed.id);
  }

  // ---- manual split: explicit, one-click text edits, each its own undo step ----
  function splitAt(side: 'source' | 'target', offset: number, paired: boolean, label: string) {
    if (paired && (!pendingCut || pendingCut.side === side)) {
      setPendingCut(pendingCut?.side === side && pendingCut.offset === offset ? null : { side, offset, label });
      return;
    }
    const cuts = paired && pendingCut
      ? [{ side, offset }, { side: pendingCut.side, offset: pendingCut.offset }]
      : [{ side, offset }];
    setPendingCut(null);
    doc.splitParagraphs(cuts);
  }
  function splitPendingOnly() {
    if (!pendingCut) return;
    const cut = pendingCut;
    setPendingCut(null);
    doc.splitParagraphs([{ side: cut.side, offset: cut.offset }]);
  }
  function linesEverywhere() {
    if (doc.convertLinesToParagraphs()) setPendingCut(null);
  }
  function merge(side: 'source' | 'target', gapStart: number, gapEnd: number) {
    if (doc.mergeParagraphsAt(side, gapStart, gapEnd)) setPendingCut(null);
  }
  function linesAsParagraphs(side: 'source' | 'target', region: Region) {
    if (doc.convertLinesToParagraphs({ side, region })) setPendingCut(null);
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
    return code === 'upstream_timeout' ? `${s.stopRepeated} ${s.phaseTimeout}` : s.stopRepeated;
  };
  const translateBlankLong = !!source.trim() && !target.trim() && sourceChars.length > 2000;
  const translateResumable = useMemo(
    () => !translateBlankLong && doc.hasResumableTranslate(draft, semantic, basis),
    [translateBlankLong, doc, draft, semantic, basis],
  );
  const showSegments = pairs.length > 1 || long || semantic.results.length > 0 || pairs.some(p => p.status !== 'ready') || run.kind !== null;
  const translationClosed = !!poolData && (!poolData.translation_enabled || poolData.translations.remaining === 0 || poolData.characters.remaining === 0);
  const reviewsClosed = !!poolData && poolData.reviews.remaining === 0;
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
      const details = failureDetails(lang, { kind: run.kind === 'translate' ? 'translation' : 'review', reason: run.stopCode, requestId: run.stopRequestId });
      return [fill(s.phaseStopped, { reason: stopText(run.stopCode) }), ...details].join(' ');
    }
    if (run.kind === 'term') return needsRecheck > 0 ? fill(s.phaseTermDoneRecheck, { n: needsRecheck }) : s.phaseTermDone;
    return run.kind === 'translate' ? s.phaseTranslateDone : s.phaseDone;
  })();
  const issueRegion = activeView ?? null;

  // ---- long manuscripts: term findings, choices and history per segment ----
  const termRows = useMemo(() => (long ? rowsOf(semantic.long, longCtx) : []), [long, semantic.long, longCtx]);
  const restorable = useMemo(() => (long && semantic.long.history.length ? restorableHistory(semantic.long, longCtx) as (number | null)[] : []), [long, semantic.long, longCtx]);
  const choiceAt = (view: PairView | undefined, span: Span) => view?.record?.choices.find(c => c.source_span.start === span.start && c.source_span.end === span.end) ?? null;
  const choiceViewText = (v: 'applies' | 'needs_reconfirmation' | 'waiting') => ({ applies: s.choiceApplies, needs_reconfirmation: s.choiceNeedsReconfirm, waiting: s.choiceWaiting }[v]);
  const termStateText = (record: RecordView) => {
    const base = { pending: s.segTermPending, saved: s.segTermSaved, current: s.segTermChecked, stale: s.segTermStale }[record.state];
    if (!record.finished) return base;
    return record.state === 'current' ? s.segFinished : record.state === 'stale' ? s.segFinishedRecheck : `${s.segFinished} · ${base}`;
  };
  const LONG_ROWS = 100;
  const targetChars = useMemo(() => chars(target), [target]);
  const termGroups = useMemo(() => (long ? groupTermOccurrences(termSegments(semantic.long, longCtx), source, target, direction, uncheckedTermSegments(semantic.long, longCtx)) as TermGroup[] : []),
    [long, semantic.long, longCtx, source, target, direction]);
  const groupCounts = useMemo(() => termGroupCounts(termGroups, selectedSegment), [termGroups, selectedSegment]);
  const filteredGroups = useMemo(() => filterTermGroups(termGroups, groupFilter, { segment: selectedSegment, expanded: openGroups }), [termGroups, groupFilter, selectedSegment, openGroups]);
  const placeCount = filteredGroups.reduce((n, g) => n + g.occurrences.length, 0);
  const collapsedCount = filteredGroups.reduce((n, g) => n + (openGroups.has(g.key) ? 0 : g.hidden), 0);
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
    const term = view.record ? termStateText(view.record) : null;
    if (runText) return term ? `${runText} · ${term}` : runText;
    if (!semanticOn) return term ?? s.segTermPending;
    const semanticText = view.result ? (view.result.imported ? s.segImported : s.segReviewed) : view.edited ? s.segEdited : s.segPending;
    return term ? `${semanticText} · ${term}` : semanticText;
  };

  const shape = (view: PairView) => pairShape(source, target, view.pair);
  const manualViews = views.filter(v => v.pair.status === 'needs_manual_split');
  const splitView = splitOpen === null ? null : manualViews.find(v => v.pair.index === splitOpen) ?? manualViews.find(v => v.pair.index >= splitOpen) ?? manualViews.at(-1) ?? null;
  function jumpToManual() {
    const first = manualViews[0];
    if (!first) return;
    selectSegment(first.pair.index);
    setSegmentFilter(first.pair.index);
    setSplitOpen(first.pair.index);
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
  function openRevise(occ: Occurrence) {
    const base = doc.segmentTargetCore(occ.segmentIndex);
    if (base !== null) setRevising({ key: occ.key, index: occ.segmentIndex, base, text: base });
  }
  function applyRevise() {
    if (!revising) return;
    const outcome = doc.reviseSegmentText(revising.index, revising.base, revising.text);
    if (outcome.applied) setRevising(null);
  }
  const numberList = (numbers: number[]) => numbers.slice(0, NUMBERS_SHOWN).join(lang === 'en' ? ', ' : '、') + (numbers.length > NUMBERS_SHOWN ? '…' : '');
  const renderOccurrence = (occ: Occurrence) => {
    const finding = occ.finding as TermFinding;
    const view = views[occ.segmentIndex];
    const chosen = choiceAt(view, finding.source_span);
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
      {(occ.translation !== null || occ.verdict !== 'not_evaluated') && <p className="occurrence-translation" data-hit={occ.translation === null ? 'false' : 'true'}>{occ.translation === null ? s.occurrenceNoHit : fill(s.occurrenceTranslation, { text: occ.translation })}</p>}
      {occ.candidates.map(c => <div className="term-pair" key={c.candidate_id}><strong>{c.zh}</strong><span>{c.en}</span><small>{m.terms.category}{labelJoiner(lang)}{categoryLabel(lang, c.category)}</small>
        <div className="finding-actions">
          <button type="button" className="text-button" onClick={() => doc.applyTermOccurrenceAction({ type: 'adopt', segmentIndex: occ.segmentIndex, finding, candidate: c })}>{m.review.adopt}</button>
          {live && rendering(c) !== occ.translation && <button type="button" className="text-button" title={fill(s.occReplaceAria, { n: occ.segmentNumber, term: rendering(c) })} onClick={() => doc.applyTermOccurrenceAction({ type: 'replace', docTarget: occ.docTarget, candidate: c })}>{fill(s.occReplace, { term: rendering(c) })}</button>}
        </div>
      </div>)}
      <div className="finding-actions">
        <button type="button" className="text-button" onClick={() => doc.applyTermOccurrenceAction({ type: 'not_a_term', segmentIndex: occ.segmentIndex, finding })}>{m.review.notTerm}</button>
        <button type="button" className="text-button" onClick={() => locate('source', occ.docSource)}>{m.review.jumpSource}</button>
        <button type="button" className="text-button" disabled={!occ.docTarget} onClick={() => { if (occ.docTarget) locate('target', occ.docTarget); }}>{m.review.jumpTarget}</button>
        {!occ.docTarget && <button type="button" className="text-button" aria-expanded={!!editing} onClick={() => (editing ? setRevising(null) : openRevise(occ))}>{s.occRevise}</button>}
      </div>
      {chosen && <p className="long-choice-state" data-choice-view={chosen.view}>{chosen.candidate ? fill(m.review.choicePair, { span: chosen.source_span.text, zh: chosen.candidate.zh, en: chosen.candidate.en }) : fill(m.review.choiceNotTerm, { span: chosen.source_span.text })} — {choiceViewText(chosen.view)}
        {chosen.view === 'needs_reconfirmation' && view?.record?.state !== 'pending' && <> <button type="button" className="text-button" onClick={() => doc.applyTermOccurrenceAction({ type: 'reconfirm', at })}>{s.choiceReconfirm}</button></>}</p>}
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
            {c.view === 'needs_reconfirmation' && view.record?.state !== 'pending' && <button type="button" className="text-button" onClick={() => doc.applyTermOccurrenceAction({ type: 'reconfirm', at })}>{s.choiceReconfirm}</button>}
            <button type="button" className="text-button" onClick={() => doc.applyTermOccurrenceAction({ type: 'clear_choice', at })}>{m.review.choiceRemove}</button>
          </div>
        </div>;
      })}
    </div>}
    {semantic.long.history.length > 0 && <details className="long-history"><summary>{fill(s.historyTitle, { n: semantic.long.history.length })}</summary>
      <p className="track-note">{s.historyNote}</p>
      {semantic.long.history.map((entry, position) => <div className="choice-record" key={`${position}:${entry.source_hash}:${entry.source_span.start}`}>
        <p>{entry.candidate ? fill(m.review.choicePair, { span: entry.source_span.text, zh: entry.candidate.zh, en: entry.candidate.en }) : fill(m.review.choiceNotTerm, { span: entry.source_span.text })}</p>
        <div className="finding-actions">
          {restorable[position] !== null && restorable[position] !== undefined && <button type="button" className="text-button" onClick={() => doc.restoreTermHistoryEntry(position, restorable[position]!)}>{fill(s.historyRestore, { n: (restorable[position] ?? 0) + 1 })}</button>}
          <button type="button" className="text-button" onClick={() => doc.removeTermHistoryEntry(position)}>{s.historyRemove}</button>
        </div>
      </div>)}
    </details>}
  </div> : null;

  return <>
    {long && <div className="long-tools" role="group" aria-label={s.segmentsTitle}>
      {translateBlankLong && <div className="long-translate">
        <p>{s.translateLongHint}</p>
        <div className="actions">
          <button type="button" className="secondary-button" disabled={runActive || translationClosed} onClick={() => doc.startTranslateRun()}>{s.translateLong}</button>
        </div>
      </div>}
      {translateResumable && <div className="long-translate">
        <p>{s.translateResumeHint}</p>
        <div className="actions">
          <button type="button" className="secondary-button" disabled={pairTranslating !== null || runActive || translationClosed} onClick={() => doc.startTranslateRun()}>{s.translateResume}</button>
        </div>
      </div>}
      {!translateBlankLong && <div className="long-terms">
        <p>{s.runTermHint}</p>
        <div className="actions">
          <button type="button" className={`secondary-button${needsRecheck > 0 && termRows.length > 0 && !runActive ? ' recheck-prominent' : ''}`} data-recheck={needsRecheck > 0 && termRows.length > 0 ? 'true' : undefined} disabled={runActive || reviewsClosed || !plan?.cost} onClick={() => doc.startTermRun()}>{runTermLabel}</button>
        </div>
      </div>}
      {draft.alignments !== null && <div className="actions">
        <button type="button" className="secondary-button" disabled={runActive} onClick={() => doc.resetAlignments()}>{s.useAutoAlignment}</button>
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
      {(semanticOn || contextOn) && <label className="inline-check"><input type="checkbox" checked={usePrecedents} onChange={e => doc.setUsePrecedents(e.target.checked)} />{s.precedents}</label>}
      <div className="actions">
        {(run.phase === 'running' || run.phase === 'waiting') && <button type="button" className="secondary-button" onClick={() => doc.pauseRun()}>{s.pause}</button>}
        {(run.phase === 'paused' || run.phase === 'stopped') && run.items.some(i => i.status === 'queued') && <button type="button" className="secondary-button" onClick={() => doc.resumeRun()}>{s.resume}</button>}
        {progress.failed > 0 && !runActive && <button type="button" className="secondary-button" onClick={() => doc.retryFailedRunItems()}>{s.retryFailed}</button>}
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
            {item?.status === 'failed' && !runActive && <button type="button" className="text-button" onClick={() => doc.retryRunItem(item.key)}>{s.segRetry}</button>}
            {record && (record.finished || record.state !== 'pending') && <button type="button" className="text-button" aria-pressed={record.finished}
              onClick={() => doc.toggleSegmentFinished(view.pair.index, !record.finished)}>{record.finished ? s.segUnmarkFinished : s.segMarkFinished}</button>}
            {semanticOn && view.pair.status === 'ready' && !runActive && (view.edited || (!view.result && item?.status !== 'failed')) && !translationClosed
              && <button type="button" className="text-button" onClick={() => startRun([view])}>{s.segReview}</button>}
            {view.pair.status === 'untranslated' && <button type="button" className="text-button" disabled={pairTranslating !== null || runActive || translationClosed || chars(view.sCore).length > SEGMENT_LIMIT} onClick={() => void doc.translatePair(view)}>{s.segTranslate}</button>}
            {view.pair.status === 'ready' && !view.pair.hard_cut && chars(view.sCore).length <= SEGMENT_LIMIT && <button type="button" className="text-button" disabled={pairTranslating !== null || runActive || translationClosed} onClick={() => void doc.translatePair(view)}>{s.segRetranslate}</button>}
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
          <button type="button" disabled={runActive || pendingViews.length === 0 || translationClosed} onClick={() => startRun()}>{semantic.results.length ? s.startPending : s.start}</button>
        </div>
      </>}
      {lastSemanticAction && doc.canUndoLast(lastSemanticAction.marker) && (() => {
        const row = rows.find(r => r.placed.id === lastSemanticAction.placedId);
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
          canUndo={doc.canUndoSemanticDecision(active.placed.id)}
          position={fill(s.position, { i: activeIndex < 0 ? 1 : activeIndex + 1, n: visible.length })} prev={() => move(-1)} next={() => move(1)} locate={locateActive}
          locateSide={locate} activeMark={activeMark} onReview={activeView && activeView.pair.status === 'ready' && semanticOn && !runActive ? () => startRun([activeView]) : null} />}
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
  const layout = { source: splitLayout(source, view.pair.source), target: splitLayout(target, view.pair.target) };
  const rows = Math.max(layout.source.length, layout.target.length);
  const sideName = { source: s.splitSource, target: s.splitTarget };
  const paired = layout.source.length === layout.target.length;
  const breaks = { source: singleBreaks(source, view.pair.source), target: singleBreaks(target, view.pair.target) };
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
