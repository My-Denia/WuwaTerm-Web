'use client';

import { FormEvent, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  FILTERS, filterFindings, findingVerdictCounts, reconcileActiveId, compactScalarContext,
} from '../../lib/review-navigation.js';
import { highlightSegments, summarizeReviewParts } from '../../lib/review-report.js';
import {
  basisOf, compareReports, leaveGuardActive, manuscriptSaveView,
  reconcileChoices, sameBasis,
} from '../../lib/manuscript.js';
import { spliceOccurrence, fragmentOccurrences } from '../../lib/target-revision.js';
import { categoryLabel, labelJoiner } from '../../lib/dictionary-labels';
import { failureDetails, fill, msg, summarySentence } from '../../lib/messages';
import { downloadFile } from '../../lib/download-file';
import { isAmbiguousMention, isLong, sessionReviewFeatures, termSegments } from '../../lib/long-review';
import { judgedReport, layerTwoCounts, layerTwoRows, structureSummary, structureViews } from '../../lib/structure-layer';
import { CAPABILITY_STRUCTURE_CHECK } from '../../lib/structure-check.js';
import { useRuntime, useRuntimeStore } from '../../lib/runtime-provider';
import { DICTIONARY_FRESH_TTL_MS, META_FRESH_TTL_MS } from '../../lib/runtime-store';
import { numberLocale } from '../../lib/ui-language';
import { isSelfHosted, workbenchPath } from '../../lib/ui-runtime';
import {
  isDictionaryFresh,
  isMetaFresh,
  sanitizeGameVersion,
  tmAutoReuseBasis,
  tmConfirmBasis,
  tmDisplayMatchBasis,
} from '../../lib/tm-live-provenance';
import { describeTmSegmentAlignment, resolveActiveSegment, type TmSegmentCursor } from '../../lib/tm-segment';
import { semanticSegmentViews } from '../../lib/semantic-state.js';
import { semanticMsg } from '../../lib/semantic-messages';
import {
  inferDirection, promoteTermbaseEntry,
  type TermbaseDirection, type TermbaseEntry, type TermbaseKind,
} from '../../lib/termbase';
import { findMatchingTermbaseEntry } from '../../lib/termbase';
import { TranslationMemoryError, type TmConfirmCandidate, type TmConfirmResult, type TmEntry, type TmErrorCode, type TmFile } from '../../lib/translation-memory';
import { createCanonicalComputer, type CanonicalComputer } from '../../lib/canonical-worker-client';
import {
  createWorkbenchController, documentSignature, isRunActive, workPresent,
} from '../../lib/workbench-controller';
import { scalarOffset, type Candidate, type Choice, type Draft, type Finding, type PairView, type PendingWorkfile, type SemanticState, type SessionBasis, type Snapshot, type Span } from '../../lib/workbench-model';
import { EditorSurfaceAdapter, type EditorEdit, type EditorHighlight, type EditorSurfaceHandle } from './editor-surface';
import { MyMemory, type TmDictionaryStatusView, type TmPersistenceAdapter } from './my-memory';
import { INITIAL_MY_TERMS_PERSISTED, MyTerms, type MyTermsPersisted, type TermbaseDraftSeed, type TermbaseExternalFeedback } from './my-terms';
import { QuickTermLookup, type QuickTermLookupPersisted, type QuickTermLookupRequestManager } from './quick-term-lookup';
import { RequestId } from './request-feedback';
import { RuntimeStatus } from './runtime-status';
import { useUiLanguage } from './ui-language-context';
import { SemanticWorkbench, ambiguousAdoptLabel } from './semantic-workbench';
import { StructureLayer, StyleLayer } from './review-layers';

type RevisionIntent = {
  snapshot: Snapshot;
  generation: number;
  draft: Draft;
  choices: Choice[];
  imported: Choice[];
  finding: Finding;
  candidate: Candidate;
  trigger: HTMLButtonElement;
  fragment: string;
  selected: Span | null;
};
type PendingReplacement = { kind: 'text'; text: string } | { kind: 'query'; text: string } | { kind: 'workfile'; workfile: PendingWorkfile };

function Excerpt({ text, span, missing }: { text: string; span: Span | null; missing: string }) {
  const { lang } = useUiLanguage();
  const located = span ? highlightSegments(text, span) : null;
  const compact = located && span ? compactScalarContext(text, span) : null;
  if (!located || !compact) return <p className="review-excerpt">{missing}</p>;
  return <>
    <p className="review-excerpt">{compact.clippedBefore ? '…' : null}{compact.before}<mark>{compact.hit}</mark>{compact.after}{compact.clippedAfter ? '…' : null}</p>
    {(compact.clippedBefore || compact.clippedAfter) && <details className="review-context"><summary>{msg(lang).review.viewFullContext}</summary>
      <p className="review-excerpt">{located.before}<mark>{located.hit}</mark>{located.after}</p>
    </details>}
  </>;
}

function unloadUrl(anchor: HTMLAnchorElement): string | null {
  if (anchor.hasAttribute('download') || anchor.target === '_blank') return null;
  const raw = anchor.getAttribute('href');
  if (!raw || raw.startsWith('#')) return null;
  let url: URL;
  try { url = new URL(anchor.href, window.location.href); } catch { return null; }
  if (url.origin === window.location.origin && url.pathname === window.location.pathname && url.search === window.location.search) return null;
  return url.href;
}

/**
 * The one document workspace. A single controller holds the draft, history, reports and semantic state; quick translation
 * and manuscript review are two layouts of that same document. The editors stay mounted across a mode switch, so moving to
 * manuscript mode (a long text, an imported manuscript, or the user's choice) keeps the texts, history, caret and IME state.
 */
export function DocumentWorkspace() {
  const { lang } = useUiLanguage();
  const runtime = useRuntimeStore();
  const { pool, meta, dictionary, capabilities: runtimeCapabilities } = useRuntime();
  const selfHosted = isSelfHosted();
  const [tmEntries, setTmEntries] = useState<TmEntry[]>([]);
  const [doc] = useState(() => createWorkbenchController({
    initialLang: lang,
    fetchCapabilities: () => runtime.capabilities(),
    onPoolRefresh: () => runtime.refreshPool(),
    resolveTmAutoReuseBasis: async (liveLatest) => {
      await runtime.loadDictionary();
      const afterDict = runtime.getSnapshot();
      if (afterDict.dictionary.kind === 'unsupported') {
        await runtime.loadMeta();
      }
      const liveSnap = runtime.getSnapshot();
      return tmAutoReuseBasis(liveSnap.dictionary, liveSnap.meta, liveLatest);
    },
  }));
  const snapshot = useSyncExternalStore(doc.subscribe, doc.getSnapshot, doc.getSnapshot);
  const {
    draft, choices, imported, reports, history, documentCheckpoint, semantic, basis, capabilities,
    phase, translating, sourceDirtyForTranslation, notice, error,
    importedCanonical, downloadedCanonical, run, pairTranslating, generation, inFlight,
    workspaceMode, autoDirection, lastTranslation, redoCount,
  } = snapshot;
  const { source, target, direction, alignments } = draft;
  const quick = workspaceMode === 'quick';

  const [pendingImport, setPendingImport] = useState<PendingReplacement | null>(null);
  const [styleOn, setStyleOn] = useState(false);
  // How long the sentence translation in flight has waited, so a model that does not answer shows a growing wait.
  const [waitTick, setWaitTick] = useState<{ since: number; now: number } | null>(null);
  useEffect(() => {
    if (!translating) return;
    const since = Date.now();
    const timer = setInterval(() => setWaitTick({ since, now: Date.now() }), 1000);
    return () => { clearInterval(timer); setWaitTick(null); };
  }, [translating]);
  const waitedSeconds = translating && waitTick ? Math.floor((waitTick.now - waitTick.since) / 1000) : 0;
  const importDialog = useRef<HTMLDialogElement>(null);
  const keepImportButton = useRef<HTMLButtonElement>(null);
  const [pendingLeaveUrl, setPendingLeaveUrl] = useState<string | null>(null);
  const [verdictFilter, setVerdictFilter] = useState<(typeof FILTERS)[number]['id']>('actionable');
  const [canonicalFindingId, setCanonicalFindingId] = useState<string | null>(null);
  const [copied, setCopied] = useState<'done' | 'failed' | null>(null);
  const [syncScroll, setSyncScroll] = useState(true);
  const [markdownPreview, setMarkdownPreview] = useState(false);
  const [editorLayout, setEditorLayout] = useState<'split' | 'stacked'>('split');
  const [inspectorTab, setInspectorTab] = useState<'review' | 'terms' | 'memory'>('review');
  const [activeSemanticId, setActiveSemanticId] = useState<string | null>(null);
  const [lookupPersisted, setLookupPersisted] = useState<QuickTermLookupPersisted>({ query: '', terms: { kind: 'idle' }, seeded: false });
  const lookupControllerRef = useRef<AbortController | null>(null);
  const lookupRequestManager = useMemo<QuickTermLookupRequestManager>(() => ({
    set(next) {
      lookupControllerRef.current?.abort();
      lookupControllerRef.current = next;
    },
    isCurrent(controller) {
      return lookupControllerRef.current === controller;
    },
    clearIfCurrent(controller) {
      if (lookupControllerRef.current === controller) lookupControllerRef.current = null;
    },
  }), []);
  const [myTermsPersisted, setMyTermsPersisted] = useState<MyTermsPersisted>(INITIAL_MY_TERMS_PERSISTED);
  useEffect(() => () => {
    lookupControllerRef.current?.abort();
    lookupControllerRef.current = null;
  }, []);
  const syncSuspended = useRef(false);
  const syncSuspendRaf = useRef<number | null>(null);
  const [termbaseEntries, setTermbaseEntries] = useState<TermbaseEntry[]>([]);
  const [termbaseOpen, setTermbaseOpen] = useState(false);
  const [termbaseDraftSeed, setTermbaseDraftSeed] = useState<TermbaseDraftSeed | null>(null);
  const [termbaseFeedback, setTermbaseFeedback] = useState<TermbaseExternalFeedback | null>(null);
  const termbaseSeq = useRef(0);
  const [tmStorageState, setTmStorageState] = useState<'idle' | 'loading' | 'ready' | 'error'>(selfHosted ? 'loading' : 'ready');
  const tmStorageVersionRef = useRef<string | null>(null);
  const [tmOpen, setTmOpen] = useState(false);
  const [tmCursor, setTmCursor] = useState<TmSegmentCursor | null>(null);
  const [revision, setRevision] = useState<RevisionIntent | null>(null);
  const revisionRef = useRef<RevisionIntent | null>(null);
  const revisionDialog = useRef<HTMLDialogElement>(null);
  const fragmentBox = useRef<HTMLTextAreaElement>(null);
  const sourceEditor = useRef<EditorSurfaceHandle>(null);
  const targetEditor = useRef<EditorSurfaceHandle>(null);
  const fileBox = useRef<HTMLInputElement>(null);
  const leaveDialog = useRef<HTMLDialogElement>(null);
  const stayLeaveButton = useRef<HTMLButtonElement>(null);
  const leaveBypass = useRef(false);

  useEffect(() => {
    doc.activate();
    void doc.loadCapabilities();
    return () => doc.dispose();
  }, [doc]);
  useEffect(() => {
    doc.setLang(lang);
  }, [doc, lang]);
  useEffect(() => {
    if (runtimeCapabilities !== null) {
      doc.setCapabilities(runtimeCapabilities);
    }
  }, [doc, runtimeCapabilities]);

  const latest = reports.at(-1) ?? null;
  const previous = reports.at(-2) ?? null;
  const activeTmSegment = useMemo(() => resolveActiveSegment(source, target, tmCursor, alignments), [source, target, tmCursor, alignments]);
  const tmAlignmentStatus = useMemo(
    () => describeTmSegmentAlignment(source, target, activeTmSegment, alignments),
    [source, target, activeTmSegment, alignments],
  );
  const [, setTmTtlVersion] = useState(0);
  // Self-hosted instances load persisted confirmed TM entries from private `/api/tm` on mount;
  // public Cloudflare Web stays strictly in React page memory and never calls `/api/tm`.
  useEffect(() => {
    doc.setTmEntries(tmEntries);
  }, [doc, tmEntries]);

  const loadSelfhostTm = useCallback(async () => {
    if (!selfHosted) return;
    setTmStorageState('loading');
    try {
      const response = await fetch(workbenchPath('/api/tm'), { cache: 'no-store' });
      if (!response.ok) {
        setTmStorageState('error');
        return;
      }
      const value = await response.json() as { entries?: unknown; storageVersion?: unknown };
      if (Array.isArray(value?.entries)) {
        tmStorageVersionRef.current = typeof value.storageVersion === 'string' ? value.storageVersion : null;
        setTmEntries(value.entries as TmEntry[]);
        setTmStorageState('ready');
      } else {
        setTmStorageState('error');
      }
    } catch {
      setTmStorageState('error');
    }
  }, [selfHosted]);

  useEffect(() => {
    if (!selfHosted) return;
    let active = true;
    void (async () => {
      try {
        const response = await fetch(workbenchPath('/api/tm'), { cache: 'no-store' });
        if (!active) return;
        if (!response.ok) {
          setTmStorageState('error');
          return;
        }
        const value = await response.json() as { entries?: unknown; storageVersion?: unknown };
        if (!active) return;
        if (Array.isArray(value?.entries)) {
          tmStorageVersionRef.current = typeof value.storageVersion === 'string' ? value.storageVersion : null;
          setTmEntries(value.entries as TmEntry[]);
          setTmStorageState('ready');
        } else {
          setTmStorageState('error');
        }
      } catch {
        if (active) setTmStorageState('error');
      }
    })();
    return () => { active = false; };
  }, [selfHosted]);

  useEffect(() => {
    if (!tmOpen) return;
    void (async () => {
      await runtime.loadDictionary();
      if (runtime.getSnapshot().dictionary.kind === 'unsupported') {
        await runtime.loadMeta();
      }
    })();
  }, [runtime, tmOpen]);

  useEffect(() => {
    if (!tmOpen) return;
    let remaining = -1;
    if (dictionary.kind === 'success') {
      remaining = dictionary.fetchedAt + DICTIONARY_FRESH_TTL_MS - Date.now();
    } else if (dictionary.kind === 'unsupported' && meta.kind === 'success') {
      remaining = meta.fetchedAt + META_FRESH_TTL_MS - Date.now();
    }
    if (remaining <= 0) return;
    const timer = setTimeout(() => {
      setTmTtlVersion(v => v + 1);
    }, remaining + 1);
    return () => clearTimeout(timer);
  }, [tmOpen, dictionary, meta]);
  const [tmResetSeen, setTmResetSeen] = useState(snapshot.resetSignal);
  if (tmResetSeen !== snapshot.resetSignal) {
    setTmResetSeen(snapshot.resetSignal);
    setTmCursor(null);
  }
  const reviewFeatures = useMemo(() => sessionReviewFeatures(capabilities), [capabilities]);
  const layer1 = useMemo(() => structureViews(draft, snapshot.structure), [draft, snapshot.structure]);
  const layer1Summary = structureSummary(layer1);
  const layer2 = useMemo(() => {
    const views = (semanticSegmentViews(draft, { results: semantic.results, long: semantic.long }, basis, reviewFeatures) as { items: PairView[] }).items;
    return layerTwoCounts(layerTwoRows(semantic, views, layer1));
  }, [draft, semantic, basis, reviewFeatures, layer1]);
  // Ambiguous one-character names (ambiguous-mention-v1) are listed apart, folded, and never counted with the judged findings.
  const judged = useMemo(() => (latest ? judgedReport(latest.report) : null), [latest]);
  // Tier 1 / 2 display basis: fresh `/api/dictionary` when supported, else legacy `/api/meta` + trusted live review.
  const tmDisplayBasis = tmDisplayMatchBasis(dictionary, meta, latest);
  const tmDictionaryStatus: TmDictionaryStatusView = (() => {
    if (dictionary.kind === 'loading') return { kind: 'loading', revision: null, gameVersion: null };
    if (isDictionaryFresh(dictionary)) {
      return {
        kind: 'verified',
        revision: dictionary.data.revision,
        gameVersion: sanitizeGameVersion(dictionary.data.game_version),
      };
    }
    if (dictionary.kind === 'error') return { kind: 'error', revision: null, gameVersion: null };
    if (dictionary.kind === 'unsupported') {
      if (meta.kind === 'loading') return { kind: 'loading', revision: null, gameVersion: null };
      if (meta.kind === 'error') return { kind: 'error', revision: null, gameVersion: null };
      if (tmDisplayBasis.currentTermsDbRevision) {
        return {
          kind: 'legacy',
          revision: tmDisplayBasis.currentTermsDbRevision,
          gameVersion: tmDisplayBasis.currentGameVersion,
        };
      }
      return { kind: 'unverified', revision: null, gameVersion: null };
    }
    return { kind: 'unverified', revision: null, gameVersion: null };
  })();
  const visibleFindings = judged ? filterFindings(judged.report.findings, verdictFilter) : [];
  const findingCounts = findingVerdictCounts(judged?.report.findings ?? []);
  const activeFindingId = reconcileActiveId(canonicalFindingId, visibleFindings);
  if (activeFindingId !== null && activeFindingId !== canonicalFindingId) {
    setCanonicalFindingId(activeFindingId);
  }
  const activeVisibleIndex = visibleFindings.findIndex(finding => finding.id === activeFindingId);
  const reconciled = reconcileChoices(choices, draft, latest, imported);
  const ready = reconciled.flatMap(item => (item.resolution ? [item.resolution] : []));
  const current = !!latest?.trusted && latest.signature === documentSignature(draft, ready) && phase === 'success';
  const sourceLength = Array.from(source).length;
  const targetLength = Array.from(target).length;
  const validInput = !!source.trim() && !!target.trim() && sourceLength <= 2000 && targetLength <= 2000;
  const reviewsClosed = pool.kind === 'success' && pool.data.reviews.remaining === 0;
  const longDocument = isLong(draft);
  // The last whole-text translation describes the editors only while both texts are still the ones it produced.
  const quickResult = lastTranslation && lastTranslation.source === source && lastTranslation.text === target ? lastTranslation : null;
  const translationClosed = pool.kind === 'success' && (!pool.data.translation_enabled || pool.data.translations.remaining === 0 || pool.data.characters.remaining === 0);
  const sourceCompatible = !!latest?.trusted && latest.source === source && latest.direction === direction;
  const comparison = latest && previous ? compareReports(previous, latest) : null;
  const basisChanged = !!latest?.trusted && choices.some(choice => !sameBasis(choice.basis, basisOf(latest.report)));
  const canonicalComputerRef = useRef<CanonicalComputer | null>(null);
  const canonicalGenRef = useRef(0);
  const canonicalPendingRef = useRef(false);
  const prevSavedMarkersRef = useRef({ importedCanonical, downloadedCanonical, resetSignal: snapshot.resetSignal });
  const [canonicalState, setCanonicalState] = useState<{
    value: string | null;
    computed: boolean;
    forDraft: Draft | null;
    forChoices: Choice[] | null;
    forReports: Snapshot[] | null;
    forSemantic: SemanticState | null;
    forBasis: SessionBasis | null;
  }>({
    value: null,
    computed: false,
    forDraft: null,
    forChoices: null,
    forReports: null,
    forSemantic: null,
    forBasis: null,
  });

  useEffect(() => {
    const computer = createCanonicalComputer();
    canonicalComputerRef.current = computer;
    return () => {
      computer.dispose();
      canonicalComputerRef.current = null;
    };
  }, []);

  const holdsWork = workPresent(draft, choices, reports, semantic);

  // Offload expensive canonicalOf() serialization/validation to a debounced Web Worker
  // (small drafts stay on a microtask with zero Worker network overhead) and bind
  // each result strictly to its exact manuscript snapshot.
  useEffect(() => {
    if (!holdsWork) {
      canonicalGenRef.current += 1;
      canonicalPendingRef.current = false;
      const timer = setTimeout(() => {
        setCanonicalState(prev => (!prev.computed && prev.value === null ? prev : {
          value: null,
          computed: false,
          forDraft: null,
          forChoices: null,
          forReports: null,
          forSemantic: null,
          forBasis: null,
        }));
      }, 0);
      return () => clearTimeout(timer);
    }
    const gen = ++canonicalGenRef.current;
    canonicalPendingRef.current = true;
    const markersChanged =
      prevSavedMarkersRef.current.importedCanonical !== importedCanonical
      || prevSavedMarkersRef.current.downloadedCanonical !== downloadedCanonical
      || prevSavedMarkersRef.current.resetSignal !== snapshot.resetSignal;
    prevSavedMarkersRef.current = { importedCanonical, downloadedCanonical, resetSignal: snapshot.resetSignal };
    const delayMs = markersChanged ? 0 : 120;
    const inputSnap = { draft, choices, reports, semantic, basis };
    const timer = setTimeout(() => {
      const computer = canonicalComputerRef.current ?? createCanonicalComputer({ disableWorker: true });
      void computer.compute(inputSnap).then(result => {
        if (canonicalGenRef.current !== gen) return;
        canonicalPendingRef.current = false;
        setCanonicalState({
          value: result,
          computed: true,
          forDraft: inputSnap.draft,
          forChoices: inputSnap.choices,
          forReports: inputSnap.reports,
          forSemantic: inputSnap.semantic,
          forBasis: inputSnap.basis,
        });
      });
    }, delayMs);
    return () => clearTimeout(timer);
  }, [holdsWork, draft, choices, reports, semantic, basis, importedCanonical, downloadedCanonical, snapshot.resetSignal]);

  const canonicalMatchesCurrent = canonicalState.computed
    && canonicalState.forDraft === draft
    && canonicalState.forChoices === choices
    && canonicalState.forReports === reports
    && canonicalState.forSemantic === semantic
    && canonicalState.forBasis === basis;
  const canonical = canonicalMatchesCurrent ? canonicalState.value : null;
  const saveView = !holdsWork
    ? 'empty'
    : !canonicalMatchesCurrent
      ? (importedCanonical !== null || downloadedCanonical !== null ? 'diverged' : 'page-only')
      : manuscriptSaveView({ holdsWork, canonical, importedCanonical, downloadedCanonical });
  const semanticRunActive = isRunActive(run, pairTranslating);
  const checkInFlight = phase === 'loading' || translating || semanticRunActive;
  const guard = leaveGuardActive({ view: saveView, checkInFlight });
  const liveLeaveGuardRef = useRef(() => guard);
  useEffect(() => {
    liveLeaveGuardRef.current = () => {
      if (!holdsWork) return checkInFlight;
      const latestCanonical = !canonicalMatchesCurrent || canonicalPendingRef.current
        ? (canonicalComputerRef.current ?? createCanonicalComputer({ disableWorker: true })).computeSync({ draft, choices, reports, semantic, basis })
        : canonicalState.value;
      const liveView = manuscriptSaveView({ holdsWork, canonical: latestCanonical, importedCanonical, downloadedCanonical });
      return leaveGuardActive({ view: liveView, checkInFlight });
    };
  });
  const m = msg(lang);
  const w = m.workspace;
  const saveStateText = {
    empty: m.review.saveStateEmpty,
    'page-only': m.review.saveStatePageOnly,
    'matches-import': m.review.saveStateMatchesImport,
    'matches-download': m.review.saveStateMatchesDownload,
    diverged: m.review.saveStateDiverged,
    'not-serializable': m.review.saveStateNotSerializable,
  }[saveView];
  const locale = numberLocale(lang);
  const reasonText = (item: { reason: string; code?: string }) =>
    ((m.choiceReasons as Record<string, string>)[item.code ?? ''] ?? item.reason);
  const sm = semanticMsg(lang);
  const translationNotice = (value: string) => {
    const at = value.indexOf('#');
    const reason = at < 0 ? value : value.slice(0, at);
    const requestId = at < 0 ? null : value.slice(at + 1);
    return [(m.tMsg as Record<string, string>)[reason] ?? m.rMsg.fallback, ...failureDetails(lang, { kind: 'translation', reason, requestId })].join(' ');
  };
  const noticeText = !notice ? ''
    : notice.startsWith('sem:') ? (sm.notices[notice.slice(4)] ?? '')
    : notice.startsWith('t:') ? translationNotice(notice.slice(2))
    : ((m.notices as Record<string, string>)[notice] ?? '');
  const errorTextValue = !error ? ''
    : error.saveConflict ? m.review.saveConflictBody
    : error.reason !== undefined && error.reason !== null ? ((m.rMsg as Record<string, string>)[error.reason] ?? (m.tMsg as Record<string, string>)[error.reason] ?? m.rMsg.fallback)
    : error.code && (m.errors as Record<string, string>)[error.code] ? (m.errors as Record<string, string>)[error.code]!
    : error.text ?? '';
  const errorDetails = error?.kind ? failureDetails(lang, { kind: error.kind, reason: error.reason, requestId: error.requestId, retryAfter: error.retryAfter, waitedSeconds: error.waitedSeconds, textLength: sourceLength }) : [];

  const cancelRevision = useCallback((message = '') => {
    const intent = revisionRef.current;
    revisionRef.current = null; setRevision(null); revisionDialog.current?.close();
    if (intent?.trigger.isConnected) intent.trigger.focus({ preventScroll: true });
    if (message) doc.setNotice(message);
  }, [doc]);
  function updateRevision(intent: RevisionIntent) { revisionRef.current = intent; setRevision(intent); }
  useEffect(() => {
    const intent = revisionRef.current;
    if (intent && (draft !== intent.draft || choices !== intent.choices || imported !== intent.imported
      || reports.at(-1) !== intent.snapshot || generation !== intent.generation || inFlight)) {
      cancelRevision('revisionStale');
    }
  }, [draft, choices, imported, reports, generation, inFlight, cancelRevision]);
  useEffect(() => {
    if (revision) {
      if (!revisionDialog.current?.open) { revisionDialog.current?.showModal(); fragmentBox.current?.focus(); }
    } else revisionDialog.current?.close();
  }, [revision]);
  const occurrences: Span[] = revision ? fragmentOccurrences(target, revision.fragment) : [];
  const revisionReplacement = revision ? (direction === 'en' ? revision.candidate.en : revision.candidate.zh) : '';
  const revisionPreview = revision?.selected ? spliceOccurrence(target, revision.fragment, revision.selected, revisionReplacement) : null;
  function openRevision(finding: Finding, candidate: Candidate, trigger: HTMLButtonElement) {
    const now = doc.getSnapshot();
    const latestSnap = now.reports.at(-1) ?? null;
    if (now.inFlight || now.phase === 'loading' || !doc.isRevisionEligible(finding, candidate) || !latestSnap) return;
    updateRevision({
      snapshot: latestSnap, generation: now.generation, draft: now.draft,
      choices: now.choices, imported: now.imported, finding, candidate, trigger, fragment: '', selected: null,
    });
  }
  useEffect(() => () => {
    if (syncSuspendRaf.current !== null) cancelAnimationFrame(syncSuspendRaf.current);
  }, []);

  const suspendScrollSync = useCallback(() => {
    syncSuspended.current = true;
    if (syncSuspendRaf.current !== null) cancelAnimationFrame(syncSuspendRaf.current);
    syncSuspendRaf.current = requestAnimationFrame(() => {
      syncSuspendRaf.current = requestAnimationFrame(() => {
        syncSuspended.current = false;
        syncSuspendRaf.current = null;
      });
    });
  }, []);

  const handleEditorScroll = useCallback((origin: 'source' | 'target', ratio: number) => {
    if (!syncScroll || syncSuspended.current) return;
    (origin === 'source' ? targetEditor : sourceEditor).current?.setScrollRatio(ratio);
  }, [syncScroll]);

  function toggleMarkdownPreview() {
    const sourceRatio = sourceEditor.current?.scrollRatio() ?? null;
    const targetRatio = targetEditor.current?.scrollRatio() ?? null;
    setMarkdownPreview(prev => !prev);
    requestAnimationFrame(() => {
      if (sourceRatio !== null) sourceEditor.current?.setScrollRatio(sourceRatio);
      if (targetRatio !== null) targetEditor.current?.setScrollRatio(targetRatio);
    });
  }

  const effectiveTermbaseDirection: TermbaseDirection = quick && autoDirection ? inferDirection(source) : direction;

  function emitTermbaseFeedback(kind: 'notice' | 'error', text: string) {
    termbaseSeq.current += 1;
    setTermbaseFeedback({ key: termbaseSeq.current, kind, text });
  }

  function promoteToTermbase(candidate: { source: string; target: string; direction?: TermbaseDirection; kind?: TermbaseKind; note?: string }) {
    const targetDirection = candidate.direction ?? effectiveTermbaseDirection;
    const outcome = promoteTermbaseEntry(termbaseEntries, {
      source: candidate.source,
      target: candidate.target,
      direction: targetDirection,
      kind: candidate.kind ?? 'preferred_term',
      note: candidate.note,
    });
    if (outcome.status === 'added') {
      setTermbaseEntries(outcome.entries);
      emitTermbaseFeedback('notice', fill(m.termbase.notices.promoted, { source: outcome.entry.source, target: outcome.entry.target }));
      return;
    }
    if (outcome.status === 'duplicate') {
      emitTermbaseFeedback('notice', fill(m.termbase.notices.alreadyPresent, { source: outcome.entry.source, target: outcome.entry.target }));
      return;
    }
    if (outcome.status === 'incomplete') {
      termbaseSeq.current += 1;
      const seedKey = termbaseSeq.current;
      setTermbaseOpen(true);
      if (!quick) setInspectorTab('terms');
      setTermbaseDraftSeed({
        key: seedKey,
        source: outcome.source,
        target: outcome.target,
        direction: outcome.direction,
        kind: outcome.kind,
        note: candidate.note ?? '',
      });
      emitTermbaseFeedback('notice', outcome.source || outcome.target ? m.termbase.notices.prefilled : m.termbase.notices.selectHint);
      return;
    }
    const fieldName = outcome.field === 'target' ? m.termbase.fieldTarget
      : outcome.field === 'note' ? m.termbase.fieldNote : m.termbase.fieldSource;
    if (outcome.error === 'list_full') emitTermbaseFeedback('error', m.termbase.errors.listFull);
    else if (outcome.error === 'list_too_large') emitTermbaseFeedback('error', m.termbase.errors.listTooLarge);
    else if (outcome.error === 'field_too_long') emitTermbaseFeedback('error', fill(m.termbase.errors.fieldTooLong, { field: fieldName, max: outcome.max ?? 0 }));
    else emitTermbaseFeedback('error', fill(m.termbase.errors.fieldInvalid, { field: fieldName }));
  }

  function applyMemorySuggestion(suggestionText: string) {
    const outcome = doc.applyMemorySuggestion(activeTmSegment.index, suggestionText);
    if (!outcome.applied) return outcome;
    setTmCursor({ kind: 'index', index: activeTmSegment.index });
    targetEditor.current?.focus();
    return outcome;
  }

  const getDisplayTmBasis = useCallback(() => {
    const live = runtime.getSnapshot();
    const liveLatest = doc.getSnapshot().reports.at(-1) ?? null;
    if (
      (live.dictionary.kind === 'success' && !isDictionaryFresh(live.dictionary))
      || (live.dictionary.kind === 'unsupported' && live.meta.kind === 'success' && !isMetaFresh(live.meta))
    ) {
      setTmTtlVersion(v => v + 1);
    }
    return tmDisplayMatchBasis(live.dictionary, live.meta, liveLatest);
  }, [runtime, doc]);

  const getConfirmTmBasis = useCallback(() => {
    const live = runtime.getSnapshot();
    const liveLatest = doc.getSnapshot().reports.at(-1) ?? null;
    if (
      (live.dictionary.kind === 'success' && !isDictionaryFresh(live.dictionary))
      || (live.dictionary.kind === 'unsupported' && live.meta.kind === 'success' && !isMetaFresh(live.meta))
    ) {
      setTmTtlVersion(v => v + 1);
    }
    return tmConfirmBasis(live.dictionary, live.meta, liveLatest);
  }, [runtime, doc]);

  const tmPersistence = useMemo<TmPersistenceAdapter | undefined>(() => {
    if (!selfHosted) return undefined;
    const postTm = async (payload: object) => fetch(workbenchPath('/api/tm'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify(payload),
    });
    const toTmError = (value: unknown) => {
      if (value && typeof value === 'object' && typeof (value as { code?: unknown }).code === 'string') {
        const v = value as { code: TmErrorCode; detail?: string };
        return new TranslationMemoryError(v.code, typeof v.detail === 'string' ? v.detail : '');
      }
      return undefined;
    };
    return {
      async confirm(candidate: TmConfirmCandidate): Promise<TmConfirmResult | { status: 'error' }> {
        try {
          const response = await postTm({ action: 'confirm', candidate });
          const value = await response.json() as Record<string, unknown>;
          if (response.ok && (value.status === 'added' || value.status === 'updated') && Array.isArray(value.entries)) {
            if (typeof value.storageVersion === 'string') tmStorageVersionRef.current = value.storageVersion;
            setTmStorageState('ready');
            return {
              status: value.status,
              entry: value.entry as TmEntry,
              entries: value.entries as TmEntry[],
            };
          }
          if (value.status === 'invalid' && typeof value.error === 'string') {
            return value as unknown as TmConfirmResult;
          }
          return { status: 'error' };
        } catch {
          return { status: 'error' };
        }
      },
      async replace(file: TmFile, options?: { force?: boolean }) {
        try {
          const response = await postTm({
            action: 'replace',
            file,
            forceReplace: options?.force === true,
            expectedVersion: tmStorageVersionRef.current,
          });
          const value = await response.json() as Record<string, unknown>;
          if (response.ok && Array.isArray(value.entries)) {
            if (typeof value.storageVersion === 'string') tmStorageVersionRef.current = value.storageVersion;
            setTmStorageState('ready');
            return { ok: true as const, entries: value.entries as TmEntry[] };
          }
          if (response.status === 409 && Array.isArray(value.entries)) {
            if (typeof value.storageVersion === 'string') tmStorageVersionRef.current = value.storageVersion;
            setTmStorageState('ready');
            return { ok: false as const, conflict: true as const, entries: value.entries as TmEntry[] };
          }
          return { ok: false as const, error: toTmError(value) };
        } catch {
          return { ok: false as const };
        }
      },
      async merge(file: TmFile) {
        try {
          const response = await postTm({ action: 'merge', file });
          const value = await response.json() as Record<string, unknown>;
          if (response.ok && Array.isArray(value.entries)) {
            if (typeof value.storageVersion === 'string') tmStorageVersionRef.current = value.storageVersion;
            setTmStorageState('ready');
            return { ok: true as const, entries: value.entries as TmEntry[] };
          }
          return { ok: false as const, error: toTmError(value) };
        } catch {
          return { ok: false as const };
        }
      },
      async remove(entry: TmEntry) {
        try {
          const response = await postTm({
            action: 'delete',
            entry: {
              direction: entry.direction,
              source_text: entry.source_text,
              target_text: entry.target_text,
              prev_source_hash: entry.prev_source_hash,
              next_source_hash: entry.next_source_hash,
            },
          });
          const value = await response.json() as Record<string, unknown>;
          if (response.ok && Array.isArray(value.entries)) {
            if (typeof value.storageVersion === 'string') tmStorageVersionRef.current = value.storageVersion;
            setTmStorageState('ready');
            return { ok: true as const, entries: value.entries as TmEntry[] };
          }
          return { ok: false as const };
        } catch {
          return { ok: false as const };
        }
      },
    };
  }, [selfHosted]);

  function promoteSelectionToTermbase() {
    const selectedSource = sourceEditor.current?.selection()?.text.trim() ?? '';
    const selectedTarget = targetEditor.current?.selection()?.text.trim() ?? '';
    promoteToTermbase({
      source: selectedSource,
      target: selectedTarget,
      direction: effectiveTermbaseDirection,
      kind: 'preferred_term',
    });
  }

  function confirmRevision() {
    const intent = revisionRef.current;
    if (!intent) return;
    const outcome = doc.applyTargetRevision(intent);
    if (outcome.status === 'stale') { cancelRevision(); return; }
    if (outcome.status !== 'applied') return;
    cancelRevision();
    requestAnimationFrame(() => {
      suspendScrollSync();
      targetEditor.current?.reveal(outcome.span);
    });
  }

  useEffect(() => {
    if (!activeFindingId) return;
    document.querySelector(`[data-mention-id="${CSS.escape(activeFindingId)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeFindingId]);

  useEffect(() => {
    if (pendingImport !== null) {
      if (!importDialog.current?.open) importDialog.current?.showModal();
      keepImportButton.current?.focus();
    } else importDialog.current?.close();
  }, [pendingImport]);

  useEffect(() => {
    if (pendingLeaveUrl) {
      if (!leaveDialog.current?.open) leaveDialog.current?.showModal();
      stayLeaveButton.current?.focus();
    } else leaveDialog.current?.close();
  }, [pendingLeaveUrl]);

  useEffect(() => {
    function onClick(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (!(event.target instanceof Element)) return;
      const anchor = event.target.closest('a');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const url = unloadUrl(anchor);
      if (!url) return;
      if (!liveLeaveGuardRef.current()) return;
      event.preventDefault();
      event.stopPropagation();
      setPendingLeaveUrl(url);
    }
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  useEffect(() => {
    function onPageShow() { leaveBypass.current = false; setPendingLeaveUrl(null); }
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

  useEffect(() => {
    function onBeforeUnload(event: BeforeUnloadEvent) {
      if (leaveBypass.current) return;
      if (!liveLeaveGuardRef.current()) return;
      event.preventDefault();
      event.returnValue = '1';
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  async function check(withChoices = true) {
    await doc.check(withChoices, { reviewsClosed });
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    await check();
  }
  async function translateInReview() {
    setCopied(null);
    await doc.translateInReview({ translationClosed });
  }
  function translateQuick(event: FormEvent) {
    event.preventDefault();
    void translateInReview();
  }
  function jumpTo(side: 'source' | 'target', span: Span) {
    setTmCursor({ kind: 'offset', side, offset: span.start });
    suspendScrollSync();
    if (markdownPreview) {
      setMarkdownPreview(false);
      requestAnimationFrame(() => {
        suspendScrollSync();
        (side === 'source' ? sourceEditor : targetEditor).current?.reveal(span);
      });
      return;
    }
    (side === 'source' ? sourceEditor : targetEditor).current?.reveal(span);
  }
  function editSide(side: 'source' | 'target') {
    return (value: string, edit: EditorEdit) => doc.editText(side, value, edit.composing ? { composing: true } : {});
  }
  function addAlignment(omit = false, whole = false) {
    const a = whole ? null : sourceEditor.current?.selection() ?? null;
    const b = omit || whole ? null : targetEditor.current?.selection() ?? null;
    doc.recordAlignment(a, b, omit, whole);
  }
  function insertTerm(text: string) {
    const current = doc.getSnapshot().draft.source;
    doc.editText('source', current ? current + ' ' + text : text);
    sourceEditor.current?.focus();
  }
  function moveQueryToSource(text: string) {
    if (!text.trim()) return;
    if (doc.replacementNeedsConfirm()) { setPendingImport({ kind: 'query', text }); return; }
    doc.replaceWithText(text, 'movedQuery');
    sourceEditor.current?.focus();
  }
  function replaceWithText(text: string, notice?: string) {
    importDialog.current?.close();
    setPendingImport(null);
    doc.replaceWithText(text, notice);
  }
  async function copyTranslation() {
    try { await navigator.clipboard.writeText(target); setCopied('done'); }
    catch { setCopied('failed'); }
  }
  function replaceWithWorkfile(workfile: PendingWorkfile) {
    importDialog.current?.close();
    setPendingImport(null);
    doc.replaceWithWorkfile(workfile);
  }
  async function importFile(file?: File) {
    const outcome = await doc.importFile(file);
    if (outcome.status === 'needs_confirm_text') setPendingImport({ kind: 'text', text: outcome.pendingText });
    else if (outcome.status === 'needs_confirm_workfile') setPendingImport({ kind: 'workfile', workfile: outcome.pendingWorkfile });
  }
  function clearDraft() {
    if (doc.clearDraft()) sourceEditor.current?.focus();
  }
  function save() {
    const out = doc.save();
    if (out) downloadFile(out.filename, out.content, out.mimeType);
  }
  function resolveConflictsAndSave() {
    const out = doc.resolveConflictingChoicesAndSave();
    if (out) downloadFile(out.filename, out.content, out.mimeType);
  }
  function exportProseTxt() {
    const out = doc.exportProseTxt();
    downloadFile(out.filename, out.content, out.mimeType);
  }
  function exportTxt() {
    const out = doc.exportTxt();
    downloadFile(out.filename, out.content, out.mimeType);
  }
  function exportResult() {
    const out = doc.exportResult();
    downloadFile(out.filename, out.content, out.mimeType);
  }
  function exportMarkdown() {
    const out = doc.exportMarkdown(lang);
    downloadFile(out.filename, out.content, out.mimeType);
  }

  const summaryParts = judged ? summarizeReviewParts(judged.report) : null;
  const comparisonGroups = ([['new', m.review.comparisonNew], ['resolved', m.review.comparisonResolved], ['pending', m.review.comparisonPending], ['incomparable', m.review.comparisonIncomparable]] as const)
    .map(([key, label]) => ({ key, label, items: comparison ? comparison[key] : [] }));
  // The review overview reads every layer from the same derivations the layers render from.
  const structureOn = !!capabilities?.includes(CAPABILITY_STRUCTURE_CHECK);
  const semanticOn = !!capabilities?.includes('semantic-review-v1');
  const ambiguousTotal = (judged?.ambiguous.length ?? 0)
    + semantic.long.records.reduce((n, r) => n + (r.result?.findings.filter(isAmbiguousMention).length ?? 0), 0);
  const scrollTo = (selector: string) => document.querySelector(selector)?.scrollIntoView({ block: 'start' });
  const termTotal = (judged?.report.findings.length ?? 0)
    + semantic.long.records.reduce((n, r) => n + (r.result?.findings.filter(f => !isAmbiguousMention(f)).length ?? 0), 0);
  const translatePrimary = !!source.trim() && !target.trim();
  // Over 2,000 characters the whole-text check and translation are disabled; the segment panel's run buttons are the main action.
  const longInput = sourceLength > 2000 || targetLength > 2000;

  // Inline CodeMirror 6 highlight ranges built from one atomic deferred snapshot and
  // verified against the current text so stale ranges never land on edited characters.
  const highlightInput = useMemo(() => ({
    source,
    target,
    draft,
    basis,
    reviewFeatures,
    judged,
    latest,
    longDocument,
    long: semantic.long,
    layer1,
    placed: semantic.placed,
    activeSemanticId,
  }), [source, target, draft, basis, reviewFeatures, judged, latest, longDocument, semantic.long, layer1, semantic.placed, activeSemanticId]);
  const deferredHighlightInput = useDeferredValue(highlightInput);
  const { sourceHighlights, targetHighlights } = useMemo(() => {
    if (quick) return { sourceHighlights: [] as EditorHighlight[], targetHighlights: [] as EditorHighlight[] };
    const snap = deferredHighlightInput;
    // Never paint deferred highlights computed for a previous text onto freshly edited text.
    if (snap.source !== source || snap.target !== target) {
      return { sourceHighlights: [] as EditorHighlight[], targetHighlights: [] as EditorHighlight[] };
    }
    const CAP = 400;
    const src: EditorHighlight[] = [];
    const tgt: EditorHighlight[] = [];
    const pushSrc = (h: EditorHighlight) => {
      if (src.length >= CAP) return;
      if (h.expectedText !== undefined && !highlightSegments(snap.source, { start: h.start, end: h.end, text: h.expectedText })) return;
      src.push(h);
    };
    const pushTgt = (h: EditorHighlight) => {
      if (tgt.length >= CAP) return;
      if (h.expectedText !== undefined && !highlightSegments(snap.target, { start: h.start, end: h.end, text: h.expectedText })) return;
      tgt.push(h);
    };

    if (snap.judged && snap.latest && snap.latest.source === snap.source) {
      const targetOk = snap.latest.target === snap.target;
      for (const f of snap.judged.report.findings) {
        const kind = f.verdict === 'confirmed_conflict' ? 'term-conflict'
          : f.verdict === 'verified_constraint' ? 'term-verified' : 'term-review';
        pushSrc({ start: f.source_span.start, end: f.source_span.end, kind, title: f.source_span.text, expectedText: f.source_span.text });
        if (targetOk && f.target_span) {
          pushTgt({ start: f.target_span.start, end: f.target_span.end, kind, title: f.target_span.text, expectedText: f.target_span.text });
        }
      }
    } else if (snap.longDocument) {
      const segs = termSegments(snap.long, { draft: snap.draft, basis: snap.basis, features: snap.reviewFeatures });
      for (const seg of segs) {
        if (seg.state !== 'current' && seg.state !== 'saved') continue;
        for (const f of seg.report.findings) {
          if (isAmbiguousMention(f)) continue;
          const resolvedKind = f.verdict === 'confirmed_conflict' ? 'term-conflict'
            : f.verdict === 'verified_constraint' ? 'term-verified' : 'term-review';
          pushSrc({
            start: scalarOffset(seg.source_start + f.source_span.start),
            end: scalarOffset(seg.source_start + f.source_span.end),
            kind: resolvedKind,
            title: f.source_span.text,
            expectedText: f.source_span.text,
          });
          if (f.target_span) {
            pushTgt({
              start: scalarOffset(seg.target_start + f.target_span.start),
              end: scalarOffset(seg.target_start + f.target_span.end),
              kind: resolvedKind,
              title: f.target_span.text,
              expectedText: f.target_span.text,
            });
          }
        }
      }
    }

    for (const view of snap.layer1) {
      if (!view.result || !view.checkable) continue;
      for (const f of view.result.findings) {
        const label = sm.layers.rules[f.rule_id] ?? f.rule_id;
        if (f.source_span) {
          pushSrc({ start: f.source_span.start, end: f.source_span.end, kind: 'structure', title: label, expectedText: f.source_span.text });
        }
        if (f.target_span) {
          pushTgt({ start: f.target_span.start, end: f.target_span.end, kind: 'structure', title: label, expectedText: f.target_span.text });
        }
      }
    }

    for (const p of snap.placed) {
      if (p.stale) continue;
      const kind = p.id === snap.activeSemanticId ? 'semantic-active' : 'semantic';
      const title = sm.categories[p.issue.category] ?? p.issue.category;
      if (p.live.source_span) {
        pushSrc({ start: p.live.source_span.start, end: p.live.source_span.end, kind, title, expectedText: p.live.source_span.text });
      }
      if (p.live.target_span) {
        pushTgt({ start: p.live.target_span.start, end: p.live.target_span.end, kind, title, expectedText: p.live.target_span.text });
      }
    }

    return { sourceHighlights: src, targetHighlights: tgt };
  }, [quick, deferredHighlightInput, source, target, sm.layers.rules, sm.categories]);

  const reviewBadgeCount = (layer1Summary.findings + layer1Summary.omitted)
    + (longDocument ? termTotal : findingCounts.actionable)
    + layer2.pending;

  const selectInspectorTab = (tab: 'review' | 'terms' | 'memory') => {
    setInspectorTab(tab);
    if (tab === 'terms') setTermbaseOpen(true);
    if (tab === 'memory') setTmOpen(true);
  };

  const termTrack = (longTerms: ReactNode): ReactNode => <section className="term-track" aria-labelledby="term-track-title">
    <h3 id="term-track-title">{sm.termTrackTitle}</h3>
    <p className="track-note">{sm.termTrackNote}</p>
    {latest ? <>
      <div className="review-summary" aria-live="polite">
        {summaryParts ? <p>{summarySentence(summaryParts, lang)}</p> : <p>{m.summary.detailMissing}</p>}
        {current ? <p className="review-current">{m.review.summaryCurrent}</p> : <p className="review-stale">{latest.trusted ? m.review.summaryStale : m.review.summaryImported}</p>}
        <p>{fill(m.review.ruleLine, { rule: latest.report.rule_version, commit: latest.report.dictionary.source_commit?.slice(0, 12) ?? m.review.dictUnknown })}</p>
        {latest.report.truncated && <p className="review-stale review-truncated-note">{m.review.truncatedNote}</p>}
      </div>
      {comparison && <details className="report-changes" open><summary>{m.review.comparisonTitle}{current ? '' : m.review.comparisonSuffix}</summary>
        {comparisonGroups.map(group => <div key={group.key}><h4>{group.label} · {group.items.length}</h4>{group.items.map((item: { label: string; reason: string; code?: string; mention: { text: string; start: number; historical: boolean } }, i: number) => <p key={i}>{fill(item.mention.historical ? m.review.comparisonMentionHistorical : m.review.comparisonMention, { text: item.mention.text, n: item.mention.start + 1 })}：{((m.comparisonReasons as Record<string, string>)[item.code ?? ''] ?? item.reason)}</p>)}</div>)}
        <p>{m.review.comparisonNote}</p>
      </details>}
      <div className="finding-nav" role="group" aria-label={m.review.filterAria}>
        {FILTERS.map(item => <button key={item.id} type="button" className="secondary-button" aria-pressed={verdictFilter === item.id} onClick={() => setVerdictFilter(item.id)}>{(m.review.filters as Record<string, string>)[item.id] ?? item.label} {findingCounts[item.id as keyof typeof findingCounts]}</button>)}
      </div>
      <div className="finding-nav" role="group" aria-label={m.review.navAria}>
        <button type="button" className="secondary-button" disabled={activeVisibleIndex <= 0} onClick={() => { const previousFinding = visibleFindings[activeVisibleIndex - 1]; if (previousFinding) setCanonicalFindingId(previousFinding.id); }}>{m.review.navPrev}</button>
        <button type="button" className="secondary-button" disabled={activeVisibleIndex < 0 || activeVisibleIndex >= visibleFindings.length - 1} onClick={() => { const nextFinding = visibleFindings[activeVisibleIndex + 1]; if (nextFinding) setCanonicalFindingId(nextFinding.id); }}>{m.review.navNext}</button>
        <p className="finding-position">{fill(m.review.position, { i: activeVisibleIndex < 0 ? 0 : activeVisibleIndex + 1, n: visibleFindings.length })}</p>
      </div>
      <div className="review-findings">{judged!.report.findings.length === 0 && <p>{m.review.noFindings}</p>}
        {verdictFilter === 'actionable' && findingCounts.verified_constraint > 0 && (
          <div className="hidden-confirmed-bar" role="status" data-hidden-confirmed={findingCounts.verified_constraint}>
            <span>{fill(visibleFindings.length === 0 ? m.review.hiddenConfirmedAll : m.review.hiddenConfirmedNotice, { n: findingCounts.verified_constraint })}</span>
            <button type="button" className="text-button" onClick={() => setVerdictFilter('all')}>{m.review.showAllConfirmed}</button>
          </div>
        )}
        {visibleFindings.length === 0 && judged!.report.findings.length > 0 && !(verdictFilter === 'actionable' && findingCounts.verified_constraint > 0) && <p>{m.review.noFindingsFiltered}</p>}
        {visibleFindings.map((finding: Finding) => {
          const active = finding.id === activeFindingId;
          const sourceLocated = latest.source === source && highlightSegments(source, finding.source_span) !== null;
          const targetLocated = finding.target_span !== null && latest.target === target && highlightSegments(target, finding.target_span) !== null;
          return <article className="term-result" key={finding.id} data-mention-id={finding.id} data-active={active ? 'true' : 'false'} aria-current={active ? 'true' : undefined}><p className="result-summary">{active ? m.review.currentMark : ''}<span className={`verdict-badge verdict-${finding.verdict}`}>{(m.review.verdicts as Record<string, string>)[finding.verdict]}</span>{finding.candidates_truncated ? m.review.truncatedMark : ''}</p>
            {finding.reason && <p className="finding-reason" data-reason={finding.reason}>{fill(m.review.reasonLabel, { reason: (m.review.reasons as Record<string, string>)[finding.reason] ?? finding.reason })}</p>}
            <div className="excerpt-labeled">
              <span className="excerpt-tag">{m.review.excerptSourceLabel}</span>
              <Excerpt text={source} span={sourceLocated ? finding.source_span : null} missing={fill(m.review.excerptMissingSource, { text: finding.source_span.text })} />
            </div>
            <div className="excerpt-labeled">
              <span className="excerpt-tag">{m.review.excerptTargetLabel}</span>
              <Excerpt text={target} span={targetLocated ? finding.target_span : null} missing={m.review.excerptMissingTarget} />
            </div>
            <div className="finding-jumps">
              <button className="text-button" type="button" disabled={!sourceLocated} onClick={() => jumpTo('source', finding.source_span)}>{m.review.jumpSource}</button>
              <button className="text-button" type="button" disabled={!targetLocated} onClick={() => { if (finding.target_span) jumpTo('target', finding.target_span); }}>{m.review.jumpTarget}</button>
            </div>
            {finding.candidates.map((candidate: Candidate) => {
              const pairSource = direction === 'en' ? candidate.zh : candidate.en;
              const pairTarget = direction === 'en' ? candidate.en : candidate.zh;
              const inTermbase = !!findMatchingTermbaseEntry(termbaseEntries, { source: pairSource, target: pairTarget, direction });
              return <div className="term-pair" key={candidate.candidate_id}><strong>{candidate.zh}</strong><span>{candidate.en}</span><small>{m.terms.category}{labelJoiner(lang)}{categoryLabel(lang, candidate.category)}</small>
                <div className="finding-actions">
                  <button className="text-button" type="button" disabled={!sourceCompatible || phase === 'loading' || latest.report.truncated} onClick={() => doc.choose(finding, candidate)}>{m.review.adopt}</button>
                  {targetLocated && <button className="text-button" type="button" disabled={!sourceCompatible || phase === 'loading'} onClick={() => doc.replaceTerm(finding, candidate)}>{m.review.replace}</button>}
                  {finding.target_span === null && <button className="text-button" type="button" disabled={phase === 'loading' || !doc.isRevisionEligible(finding, candidate)} onClick={event => openRevision(finding, candidate, event.currentTarget)}>{m.review.revisionOpen}</button>}
                  <button className="text-button" type="button" onClick={() => promoteToTermbase({ source: pairSource, target: pairTarget, direction })}>{inTermbase ? m.termbase.alreadyInTermbase : m.termbase.promoteButton}</button>
                </div>
                <details className="candidate-sources"><summary>{m.review.viewSources}</summary>
                  <ul>{candidate.sources.map(item => <li key={`${item.source_file}\u0000${item.source_id}`}><span>{item.source_file}</span><span>{item.source_id}</span></li>)}</ul>
                </details>
              </div>;
            })}
            <details className="finding-basis"><summary>{m.review.findingBasis}</summary><p>{fill(m.review.spanRange, { start: finding.source_span.start + 1, end: finding.source_span.end })}</p><p>{finding.rule_id} · {finding.id}</p></details>
            <button className="text-button" type="button" disabled={!sourceCompatible || phase === 'loading'} onClick={() => doc.choose(finding, null)}>{m.review.notTerm}</button>
          </article>;
        })}
      </div>
      {judged && judged.ambiguous.length > 0 && <details className="ambiguous-mentions" data-count={judged.ambiguous.length}>
        <summary>{fill(sm.ambiguous.title, { n: judged.ambiguous.length })}</summary>
        <p className="track-note">{sm.ambiguous.note}</p>
        {judged.ambiguous.map((finding: Finding) => {
          const sourceLocated = latest.source === source && highlightSegments(source, finding.source_span) !== null;
          return <article className="term-result ambiguous-mention" key={finding.id} data-mention-id={finding.id}>
            <p className="result-summary"><span className="verdict-badge verdict-not_evaluated">{(m.review.verdicts as Record<string, string>).not_evaluated}</span> · {fill(sm.ambiguous.itemDocument, { text: finding.source_span.text, start: finding.source_span.start + 1, end: finding.source_span.end })}</p>
            <div className="excerpt-labeled">
              <span className="excerpt-tag">{m.review.excerptSourceLabel}</span>
              <Excerpt text={source} span={sourceLocated ? finding.source_span : null} missing={fill(m.review.excerptMissingSource, { text: finding.source_span.text })} />
            </div>
            <div className="finding-actions">
              {finding.candidates.map((candidate: Candidate) => <button key={candidate.candidate_id} className="text-button" type="button" disabled={!sourceCompatible || phase === 'loading' || latest.report.truncated} onClick={() => doc.choose(finding, candidate)}>{ambiguousAdoptLabel(lang, candidate, finding.candidates)}</button>)}
              <button className="text-button" type="button" disabled={!sourceCompatible || phase === 'loading'} onClick={() => doc.choose(finding, null)}>{sm.ambiguous.ignore}</button>
              <button className="text-button" type="button" disabled={!sourceLocated} onClick={() => jumpTo('source', finding.source_span)}>{m.review.jumpSource}</button>
            </div>
          </article>;
        })}
      </details>}
    </> : sourceLength > 2000 || targetLength > 2000 ? null : <p className="translation-placeholder">{m.review.placeholder}</p>}
    {longTerms}
  </section>;

  const kindLabel = quickResult?.kind
    ? ({ exact: m.translation.kindExact, fuzzy: m.translation.kindFuzzy, noop: m.translation.kindNoop, llm: m.translation.kindLlm })[quickResult.kind]
    : null;

  return <section className="document-workspace" data-mode={workspaceMode} aria-labelledby="workspace-title">
    <dialog className="handoff-dialog revision-dialog" ref={revisionDialog} aria-labelledby="revision-title" aria-describedby="revision-description" onCancel={() => cancelRevision()}>
      <h3 id="revision-title">{m.review.revisionTitle}</h3>
      <p id="revision-description">{m.review.revisionDescription}</p>
      {revision && <>
        <p>{fill(m.review.spanRange, { start: revision.finding.source_span.start + 1, end: revision.finding.source_span.end })}</p>
        <Excerpt text={revision.draft.source} span={revision.finding.source_span} missing={m.review.excerptMissingTarget} />
        <p className="revision-pair">{revision.candidate.zh} ↔ {revision.candidate.en}<br />{m.review.revisionReplacement}: <strong>{revisionReplacement}</strong></p>
        <p>{m.review.revisionAlignments}</p>
        <label htmlFor="revision-fragment">{m.review.revisionFragment}</label>
        <textarea id="revision-fragment" ref={fragmentBox} rows={2} value={revision.fragment} onChange={event => updateRevision({ ...revision, fragment: event.target.value, selected: null })} />
        <details><summary>{m.review.revisionFullTarget}</summary><p className="review-excerpt">{target}</p></details>
        <p role="status" aria-live="polite">{!revision.fragment.trim() ? m.review.revisionEnter : occurrences.length ? fill(m.review.revisionMatches, { n: occurrences.length }) : m.review.revisionNoMatches}</p>
        <fieldset className="revision-occurrences"><legend>{m.review.revisionOccurrences}</legend>
          {occurrences.map((span, index) => <label className="revision-occurrence" key={`${span.start}:${span.end}`}>
            <input type="radio" name="revision-occurrence" value={`${span.start}:${span.end}`} checked={revision.selected?.start === span.start && revision.selected?.end === span.end} onChange={() => updateRevision({ ...revision, selected: span })} />
            <span>{fill(m.review.revisionPosition, { i: index + 1, start: span.start + 1, end: span.end })}<Excerpt text={target} span={span} missing={m.review.excerptMissingTarget} /></span>
          </label>)}
        </fieldset>
        {revision.selected && <div className="revision-preview"><p>{m.review.revisionPreview}</p><p className="review-excerpt"><del>{revision.selected.text}</del> → <ins>{revisionReplacement}</ins></p></div>}
        {revisionPreview?.error && <p role="alert">{(m.review as Record<string, unknown>)[revisionPreview.error] as string}</p>}
        <div className="actions">
          <button type="button" className="secondary-button" onClick={() => cancelRevision()}>{m.review.revisionCancel}</button>
          <button type="button" className="primary-button" disabled={!revisionPreview || !!revisionPreview.error} onClick={confirmRevision}>{m.review.revisionConfirm}</button>
        </div>
      </>}
    </dialog>
    <dialog className="handoff-dialog" ref={leaveDialog} aria-labelledby="leave-title" aria-describedby="leave-description" onCancel={() => setPendingLeaveUrl(null)}>
      <h3 id="leave-title">{m.review.leaveTitle}</h3>
      <div id="leave-description">
        {(phase === 'loading' || translating) && <p>{m.review.leaveInFlight}</p>}
        <p>{saveView === 'matches-download' ? m.review.leaveDownload : m.review.leaveUnsaved}</p>
      </div>
      {error && <p role="alert">{errorTextValue}</p>}
      {error?.saveConflict && <div className="actions save-conflict-actions"><button type="button" className="secondary-button" onClick={resolveConflictsAndSave}>{m.review.resolveConflictsAndSave}</button><button type="button" className="secondary-button" onClick={exportProseTxt}>{m.review.exportProseTxt}</button></div>}
      <div className="actions">
        <button ref={stayLeaveButton} type="button" className="primary-button" onClick={() => setPendingLeaveUrl(null)}>{m.review.leaveStay}</button>
        <button type="button" className="secondary-button" onClick={save}>{m.review.leaveSaveStay}</button>
        <button type="button" className="secondary-button" onClick={() => { const url = pendingLeaveUrl; if (!url) { setPendingLeaveUrl(null); return; } leaveBypass.current = true; window.location.assign(url); }}>{m.review.leaveAnyway}</button>
      </div>
    </dialog>
    <dialog className="handoff-dialog" ref={importDialog} aria-labelledby="import-replace-title" aria-describedby="import-replace-description" onCancel={() => setPendingImport(null)}>
      <h3 id="import-replace-title">{pendingImport?.kind === 'workfile' ? m.review.workfileReplaceTitle : pendingImport?.kind === 'query' ? w.queryReplaceTitle : m.review.importReplaceTitle}</h3>
      <p id="import-replace-description">{pendingImport?.kind === 'workfile' ? m.review.workfileReplaceBody : pendingImport?.kind === 'query' ? w.queryReplaceBody : m.review.importReplaceBody}</p>
      <div className="actions">
        <button ref={keepImportButton} type="button" className="secondary-button" onClick={() => setPendingImport(null)}>{m.review.dialogKeep}</button>
        <button type="button" className="secondary-button" onClick={() => {
          if (pendingImport?.kind === 'text') replaceWithText(pendingImport.text);
          else if (pendingImport?.kind === 'query') { replaceWithText(pendingImport.text, 'movedQuery'); sourceEditor.current?.focus(); }
          else if (pendingImport?.kind === 'workfile') replaceWithWorkfile(pendingImport.workfile);
        }}>{pendingImport?.kind === 'query' ? w.queryReplaceConfirm : m.review.importReplaceConfirm}</button>
      </div>
    </dialog>
    <header className="workspace-head">
      <div className="workspace-heading">
        <h1 id="workspace-title" tabIndex={-1}>{m.hero.title}<span>{m.hero.titleAccent}</span></h1>
        <p>{m.hero.subtitle}</p>
      </div>
      <div className="mode-switch" role="group" aria-label={w.modeAria}>
        <button type="button" aria-pressed={quick} disabled={!quick && longDocument} title={!quick && longDocument ? w.modeQuickLocked : undefined} onClick={() => doc.setWorkspaceMode('quick')}>{w.modeQuick}</button>
        <button type="button" aria-pressed={!quick} onClick={() => doc.setWorkspaceMode('manuscript')}>{w.modeManuscript}</button>
      </div>
    </header>
    <div className="workspace-grid">
      <div className="manuscript-workspace">
        <div className="manuscript-editor-pane">
          {!quick && !latest && !source.trim() && !target.trim() && choices.length === 0 && (
            <ol className="guide-steps" aria-label={m.review.guideAria} role="list">
              {m.review.guide.map((step, i) => <li key={i}><strong>{step.title}</strong><span>{step.body}</span></li>)}
            </ol>
          )}
          <form onSubmit={quick ? translateQuick : submit}>
            <div className="editor-toolbar" role="group" aria-label={w.editorToolbarAria}>
              {!quick && (
                <button
                  type="button"
                  className="secondary-button toolbar-toggle layout-toggle"
                  aria-pressed={editorLayout === 'split'}
                  data-editor-layout={editorLayout}
                  onClick={() => setEditorLayout(prev => (prev === 'split' ? 'stacked' : 'split'))}
                >
                  {editorLayout === 'split' ? w.layoutSplit : w.layoutStacked}
                </button>
              )}
              <button
                type="button"
                className="secondary-button toolbar-toggle"
                aria-pressed={syncScroll}
                data-sync-scroll={syncScroll ? 'on' : 'off'}
                onClick={() => setSyncScroll(value => !value)}
              >
                {w.syncScroll}
              </button>
              <button
                type="button"
                className="secondary-button toolbar-toggle"
                aria-pressed={markdownPreview}
                data-markdown-preview={markdownPreview ? 'on' : 'off'}
                onClick={toggleMarkdownPreview}
              >
                {w.markdownPreview}
              </button>
              <button
                type="button"
                className="secondary-button toolbar-toggle"
                onClick={promoteSelectionToTermbase}
              >
                {m.termbase.promoteSelection}
              </button>
              {!quick && activeTmSegment.total > 1 && (
                <span className="toolbar-segment-pill" data-testid="editor-segment-indicator">
                  {fill(w.segmentIndicator, { i: activeTmSegment.index + 1, n: activeTmSegment.total })}
                </span>
              )}
            </div>
            {!quick && (sourceHighlights.length > 0 || targetHighlights.length > 0) && (
              <div className="highlight-legend" role="note" aria-label={w.highlightLegendAria}>
                <span className="legend-dot legend-term">{w.highlightLegendTerm}</span>
                <span className="legend-dot legend-conflict">{w.highlightLegendConflict}</span>
                <span className="legend-dot legend-structure">{w.highlightLegendStructure}</span>
                <span className="legend-dot legend-semantic">{w.highlightLegendSemantic}</span>
              </div>
            )}
            <div className="editor-panes" data-layout={quick ? 'split' : editorLayout}>
              <div className="editor-pane">
                <div className="label-row">
                  <label id="review-source-label" htmlFor="review-source">{m.review.sourceLabel}</label>
                  <select aria-label={quick ? m.translation.directionAria : m.review.directionAria} value={quick && autoDirection ? 'auto' : direction} onChange={e => {
                    const value = e.target.value as 'auto' | 'en' | 'zh';
                    if (quick) doc.setQuickDirection(value);
                    else if (value !== 'auto') doc.setDirection(value);
                  }}>
                    {quick && <option value="auto">{m.translation.directionAuto}</option>}
                    <option value="en">{quick ? m.translation.directionToEn : m.review.directionEn}</option>
                    <option value="zh">{quick ? m.translation.directionToZh : m.review.directionZh}</option>
                  </select>
                </div>
                <EditorSurfaceAdapter
                  ref={sourceEditor}
                  id="review-source"
                  labelledBy="review-source-label"
                  value={source}
                  rows={6}
                  placeholder={quick ? m.translation.placeholder : m.review.sourcePlaceholder}
                  enhanced={!quick}
                  highlights={sourceHighlights}
                  preview={markdownPreview}
                  previewEmptyText={w.markdownPreviewEmpty}
                  previewAriaLabel={w.markdownSourcePreviewAria}
                  onScrollRatio={ratio => handleEditorScroll('source', ratio)}
                  onCursorChange={offset => setTmCursor(prev => (prev?.kind === 'offset' && prev.side === 'source' && prev.offset === offset ? prev : { kind: 'offset', side: 'source', offset }))}
                  onEdit={editSide('source')}
                  onUndo={() => doc.undo()}
                  onRedo={() => doc.redo()}
                />
              </div>
              <div className="editor-pane">
                <div className="label-row">
                  <label id="review-target-label" htmlFor="review-target">{quick ? w.targetLabel : m.review.targetLabel}</label>
                  {quick && !!target && <button type="button" className="text-button" onClick={() => void copyTranslation()}>{copied === 'done' ? m.translation.copied : m.translation.copy}</button>}
                </div>
                <EditorSurfaceAdapter
                  ref={targetEditor}
                  id="review-target"
                  labelledBy="review-target-label"
                  value={target}
                  rows={6}
                  placeholder={quick ? m.translation.idlePlaceholder : m.review.targetPlaceholder}
                  enhanced={!quick}
                  highlights={targetHighlights}
                  preview={markdownPreview}
                  previewEmptyText={w.markdownPreviewEmpty}
                  previewAriaLabel={w.markdownTargetPreviewAria}
                  onScrollRatio={ratio => handleEditorScroll('target', ratio)}
                  onCursorChange={offset => setTmCursor(prev => (prev?.kind === 'offset' && prev.side === 'target' && prev.offset === offset ? prev : { kind: 'offset', side: 'target', offset }))}
                  onEdit={editSide('target')}
                  onUndo={() => doc.undo()}
                  onRedo={() => doc.redo()}
                />
              </div>
            </div>
            <div className="field-hint">
              <span>{m.review.hintSafety}{!quick && <span className="shortcut-hint"> · {w.shortcutBar}</span>}</span>
              <span aria-live="polite">{quick ? fill(m.translation.charCount, { n: sourceLength.toLocaleString(locale) }) : fill(m.review.charCounts, { s: sourceLength.toLocaleString(locale), t: targetLength.toLocaleString(locale) })}</span>
            </div>
            {!quick && (sourceLength > 2000 || targetLength > 2000) && <p role="status">{m.review.longManuscript}</p>}
            {quick && translationClosed && <p className="notice-state">{pool.kind === 'success' && !pool.data.translation_enabled ? m.tMsg.translation_disabled : m.tMsg.translation_pool_exhausted}</p>}
            {!quick && <details className="alignment-panel"><summary>{alignments === null ? m.review.alignmentSummaryNone : fill(m.review.alignmentSummaryCount, { n: alignments.length })}</summary>
              <p>{m.review.alignmentIntro}</p>
              <div className="actions">
                <button type="button" className="secondary-button" onClick={() => addAlignment()}>{m.review.alignmentConfirm}</button>
                <button type="button" className="secondary-button" onClick={() => addAlignment(true)}>{m.review.alignmentOmit}</button>
                <button type="button" className="secondary-button" disabled={!validInput} onClick={() => addAlignment(false, true)}>{m.review.alignmentWhole}</button>
                <button type="button" className="secondary-button" onClick={() => doc.clearAlignments()}>{m.review.alignmentClear}</button>
                <button type="button" className="secondary-button" onClick={() => doc.resetAlignments()}>{m.review.alignmentReset}</button>
              </div>
              {alignments?.map((a, i) => <div className="alignment-row" key={i}><p>{fill(m.review.alignmentRowSource, { start: a.source.start + 1, end: a.source.end, text: a.source.text })}</p><p>{a.target ? fill(m.review.alignmentRowTarget, { start: a.target.start + 1, end: a.target.end, text: a.target.text }) : m.review.alignmentRowOmit}</p><button type="button" className="text-button" onClick={() => doc.removeAlignment(i)}>{m.review.alignmentRemove}</button></div>)}
            </details>}
            {!quick && <div className="review-quota">
              {pool.kind === 'success' ? <>
                <p>{fill(m.review.quotaSnapshot, { n: pool.data.reviews.remaining, limit: pool.data.reviews.limit })}</p>
                {reviewsClosed && <p>{m.rMsg.reviews_pool_exhausted}</p>}
              </> : <p>{pool.kind === 'error' ? m.pool.unavailable : m.pool.loading}</p>}
            </div>}
            <div className="actions">
              {quick ? <>
                <button type="submit" disabled={!source.trim() || sourceLength > 2000 || phase === 'loading' || translating || translationClosed}>{translating ? m.translation.submitLoading : m.translation.submitIdle}</button>
                {translating && <button className="secondary-button" type="button" onClick={() => doc.cancelWait()}>{m.translation.cancelWait}</button>}
                <button className="secondary-button" type="button" onClick={() => fileBox.current?.click()}>{m.translation.importFile}</button>
                <button className="secondary-button" type="button" onClick={() => doc.setWorkspaceMode('manuscript')}>{w.openManuscript}</button>
              </> : <>
                <button type="submit" className={translatePrimary || longInput ? 'secondary-button' : undefined} disabled={!validInput || phase === 'loading' || translating || reviewsClosed}>{phase === 'loading' ? m.review.checkLoading : m.review.checkIdle}</button>
                <button className="secondary-button" type="button" disabled={!validInput || phase === 'loading' || translating || reviewsClosed} onClick={() => void check(false)}>{m.review.freshBasis}</button>
                {((!!source.trim() && (!target.trim() || sourceDirtyForTranslation)) || translating) && <button className={translatePrimary && !longInput ? undefined : 'secondary-button'} type="button" disabled={!source.trim() || sourceLength > 2000 || phase === 'loading' || translating || semanticRunActive || snapshot.tmPreparing || translationClosed} onClick={() => void translateInReview()}>{translating || snapshot.tmPreparing ? m.review.translateLoading : target.trim() ? m.review.translateUpdate : m.review.translateIdle}</button>}
                {(phase === 'loading' || translating) && <button className="secondary-button" type="button" onClick={() => doc.cancelWait()}>{m.review.cancelWait}</button>}
              </>}
              <button className="secondary-button" type="button" onClick={() => doc.undo()} disabled={!history.length}>{m.review.undo}</button>
              <button className="secondary-button" type="button" onClick={() => doc.redo()} disabled={redoCount === 0}>{w.redo}</button>
            </div>
          </form>
          {/* One hidden file input for both modes, opened by the visible import buttons and kept out of the tab order. */}
          <input ref={fileBox} className="visually-hidden" type="file" tabIndex={-1} accept=".json,.txt,.md,application/json,text/plain,text/markdown" aria-label={m.review.importFileAria} onChange={e => {
            const file = e.target.files?.[0];
            e.target.value = '';
            void importFile(file);
          }} />
          {quick && translating && <p className="notice-state" role="status">{m.translation.loadingStatus}</p>}
          {quick && translating && waitedSeconds >= 2 && <p className="notice-state wait-elapsed" data-waited={waitedSeconds}>{fill(m.translation.loadingElapsed, { n: waitedSeconds })}</p>}
          {quick && quickResult && <div className="translation-result" aria-live="polite">
            <div className="result-meta">{kindLabel && <span>{kindLabel}</span>}<span>{quickResult.direction === 'en' ? m.translation.directionEn : m.translation.directionZh}</span></div>
            {quickResult.dictionaryMiss && <p className="field-hint">{m.translation.dictionaryMiss}</p>}
            {copied === 'failed' && <p role="status">{m.translation.copyFailed}</p>}
            {quickResult.requestId && <RequestId value={quickResult.requestId} />}
          </div>}
          {!quick && <>
            <p className="manuscript-save-state" role="status">{saveStateText}{guard ? ` ${m.review.saveStateLeaveNote}` : ''}</p>
            <div className="actions draft-actions">
              <div className="draft-primary-actions">
                <button type="button" className="secondary-button" onClick={clearDraft} disabled={!holdsWork}>{m.review.clearDraft}</button>
                <button type="button" className="secondary-button" onClick={save}>{m.review.save}</button>
                <button type="button" className="secondary-button" onClick={() => fileBox.current?.click()}>{m.review.import}</button>
                {documentCheckpoint && <button type="button" className="secondary-button" onClick={() => doc.restoreDocumentCheckpoint()}>{m.review.restoreCheckpoint}</button>}
              </div>
              <div className="export-actions">
                <button type="button" className="secondary-button" onClick={exportTxt}>{m.review.exportTxt}</button>
                <button type="button" className="secondary-button" onClick={exportResult}>{m.review.exportResult}</button>
                <button type="button" className="secondary-button" onClick={exportMarkdown}>{m.review.exportMarkdown}</button>
              </div>
            </div>
          </>}
          {termbaseFeedback && <p className={termbaseFeedback.kind === 'error' ? 'termbase-promote-status termbase-promote-error' : 'termbase-promote-status'} role={termbaseFeedback.kind === 'error' ? 'alert' : 'status'}>{termbaseFeedback.text}</p>}
          {notice && <p className="notice-state" role="status">{noticeText}</p>}
          {!quick && alignments !== null && alignments.length === 0 && <div className="alignment-recovery" role="region" aria-label={m.review.alignmentRecoveryAria}>
            <p>{m.review.alignmentEmptyPrompt}</p>
            <div className="actions">
              <button type="button" className="secondary-button" disabled={!validInput || phase === 'loading'} onClick={() => addAlignment(false, true)}>{m.review.alignmentReconfirmWhole}</button>
              <button type="button" className="secondary-button" disabled={phase === 'loading'} onClick={() => doc.resetAlignments()}>{m.review.alignmentFallbackReset}</button>
            </div>
          </div>}
          {error && <div className="error-panel" role="alert"><p>{errorTextValue}</p>{errorDetails.map(line => <p key={line} className="error-detail">{line}</p>)}{error.saveConflict && <div className="actions save-conflict-actions"><button type="button" className="secondary-button" onClick={resolveConflictsAndSave}>{m.review.resolveConflictsAndSave}</button><button type="button" className="secondary-button" onClick={exportProseTxt}>{m.review.exportProseTxt}</button></div>}</div>}
          {!quick && phase === 'loading' && <p role="status">{m.review.loadingStatus}</p>}
          {!quick && basisChanged && <p className="review-stale">{m.review.staleBasis}</p>}
        </div>
        {!quick && <aside className="manuscript-review-pane workspace-inspector" aria-label={w.inspectorAria}>
          <div className="inspector-tabs" role="tablist" aria-label={w.inspectorAria} data-testid="inspector-tabs">
            <button
              type="button"
              role="tab"
              id="inspector-tab-review"
              aria-selected={inspectorTab === 'review'}
              aria-controls="inspector-panel-review"
              data-inspector-tab="review"
              onClick={() => selectInspectorTab('review')}
            >
              <span>{w.inspectorReview}</span>
              {reviewBadgeCount > 0 && <span className="inspector-badge">{reviewBadgeCount}</span>}
            </button>
            <button
              type="button"
              role="tab"
              id="inspector-tab-terms"
              aria-selected={inspectorTab === 'terms'}
              aria-controls="inspector-panel-terms"
              data-inspector-tab="terms"
              onClick={() => selectInspectorTab('terms')}
            >
              <span>{w.inspectorTerms}</span>
              {termbaseEntries.length > 0 && <span className="inspector-badge">{termbaseEntries.length}</span>}
            </button>
            <button
              type="button"
              role="tab"
              id="inspector-tab-memory"
              aria-selected={inspectorTab === 'memory'}
              aria-controls="inspector-panel-memory"
              data-inspector-tab="memory"
              onClick={() => selectInspectorTab('memory')}
            >
              <span>{w.inspectorMemory}</span>
              {tmEntries.length > 0 && <span className="inspector-badge">{tmEntries.length}</span>}
            </button>
          </div>
          <div
            id="inspector-panel-review"
            role="tabpanel"
            aria-labelledby="inspector-tab-review"
            className="inspector-panel"
            hidden={inspectorTab !== 'review'}
          >
            {choices.length > 0 && <div className="choice-records"><h3>{fill(m.review.choiceHeader, { ready: ready.length, pending: choices.length - ready.length })}</h3>
              {choices.map((choice, i) => {
                const canConfirm = reconciled[i].status === 'pending' && reconciled[i].code !== 'duplicate_position' && doc.canConfirmChoice(i);
                return <div className="choice-record" key={i}><p>{choice.candidate ? fill(m.review.choicePair, { span: choice.source_span.text, zh: choice.candidate.zh, en: choice.candidate.en }) : fill(m.review.choiceNotTerm, { span: choice.source_span.text })} — {reconciled[i].status === 'applicable' ? m.review.choiceApplicable : m.review.choicePending}</p><p>{reasonText(reconciled[i])}</p><div className="finding-actions">{canConfirm && <button type="button" className="text-button" disabled={phase === 'loading'} onClick={() => doc.confirmChoice(i)}>{m.review.choiceConfirm}</button>}<button type="button" className="text-button" onClick={() => doc.removeChoice(i)}>{m.review.choiceRemove}</button></div></div>;
              })}
            </div>}
            {(semanticOn || structureOn) && <div className="issue-overview layer-overview" role="group" aria-label={sm.overviewAria}>
              {structureOn && <button type="button" className="secondary-button" data-layer="1" onClick={() => scrollTo('#layer1-title')}>
                {layer1Summary.checked ? fill(sm.layers.ovL1, { n: layer1Summary.findings + layer1Summary.omitted }) : sm.layers.ovL1None}</button>}
              <button type="button" className="secondary-button" onClick={() => scrollTo('#term-track-title')}>{fill(sm.overviewTerms, { n: termTotal })}</button>
              {ambiguousTotal > 0 && <button type="button" className="secondary-button" data-ambiguous={ambiguousTotal} onClick={() => scrollTo('details.ambiguous-mentions')}>{fill(sm.layers.ovAmbiguous, { n: ambiguousTotal })}</button>}
              {semanticOn && <button type="button" className="secondary-button" data-layer="2" onClick={() => scrollTo('#semantic-title')}>{layer2.listed + layer2.covered || semantic.results.length ? fill(sm.overviewSemantic, { n: layer2.listed, pending: layer2.pending }) : sm.overviewSemanticNone}</button>}
              {semanticOn && layer2.high + layer2.medium > 0 && <span className="overview-note" data-buckets={`${layer2.high}:${layer2.medium}`}>{fill(sm.layers.ovBuckets, { high: layer2.high, medium: layer2.medium })}</span>}
              {semanticOn && layer2.low > 0 && <span className="overview-note" data-low={layer2.low}>{fill(sm.layers.ovLow, { n: layer2.low })}</span>}
              {semanticOn && layer2.covered > 0 && <span className="overview-note" data-covered={layer2.covered}>{fill(sm.layers.ovCovered, { n: layer2.covered })}</span>}
              <button type="button" className="secondary-button" data-layer="3" data-on={styleOn ? 'true' : 'false'} onClick={() => scrollTo('#layer3-title')}>{styleOn ? sm.layers.ovL3On : sm.layers.ovL3Off}</button>
            </div>}
            <StructureLayer doc={doc} snapshot={snapshot} lang={lang} pool={pool} locate={(side, span) => jumpTo(side, span)} />
            <SemanticWorkbench
              doc={doc}
              snapshot={snapshot}
              lang={lang}
              pool={pool}
              locate={(side, span) => jumpTo(side, span)}
              termTrack={termTrack}
              termbaseEntries={termbaseEntries}
              onPromoteToTermbase={promoteToTermbase}
              onActiveSemanticChange={setActiveSemanticId}
            />
            <StyleLayer lang={lang} on={styleOn} setOn={setStyleOn} />
          </div>
          <div
            id="inspector-panel-terms"
            role="tabpanel"
            aria-labelledby="inspector-tab-terms"
            className="inspector-panel inspector-stack"
            hidden={inspectorTab !== 'terms'}
          >
            <QuickTermLookup quick={false} embedded persisted={lookupPersisted} onPersistedChange={setLookupPersisted} requestManager={lookupRequestManager} onInsert={insertTerm} onUseQuery={moveQueryToSource} />
            <MyTerms
              source={source}
              direction={effectiveTermbaseDirection}
              entries={termbaseEntries}
              setEntries={setTermbaseEntries}
              open={termbaseOpen}
              onOpenChange={setTermbaseOpen}
              draftSeed={termbaseDraftSeed}
              externalFeedback={termbaseFeedback}
              persisted={myTermsPersisted}
              onPersistedChange={setMyTermsPersisted}
            />
          </div>
          <div
            id="inspector-panel-memory"
            role="tabpanel"
            aria-labelledby="inspector-tab-memory"
            className="inspector-panel inspector-stack"
            hidden={inspectorTab !== 'memory'}
          >
            <MyMemory
              sourceText={activeTmSegment.sourceText}
              targetText={activeTmSegment.targetText}
              prevSource={activeTmSegment.prevSource}
              nextSource={activeTmSegment.nextSource}
              segmentIndex={activeTmSegment.index}
              segmentTotal={activeTmSegment.total}
              alignmentStatus={tmAlignmentStatus}
              direction={effectiveTermbaseDirection}
              currentTermsDbRevision={tmDisplayBasis.currentTermsDbRevision}
              currentGameVersion={tmDisplayBasis.currentGameVersion}
              getDisplayBasis={getDisplayTmBasis}
              getConfirmBasis={getConfirmTmBasis}
              dictionaryStatus={tmDictionaryStatus}
              storageMode={selfHosted ? 'selfhost_sqlite' : 'public_memory'}
              storageState={tmStorageState}
              onRetryLoad={selfHosted ? () => void loadSelfhostTm() : undefined}
              persistence={tmPersistence}
              entries={tmEntries}
              setEntries={setTmEntries}
              onApplySuggestion={applyMemorySuggestion}
              onSelectSegment={index => setTmCursor({ kind: 'index', index })}
              open={tmOpen}
              onOpenChange={setTmOpen}
            />
          </div>
        </aside>}
      </div>
      {quick && <div className="workspace-side">
        <QuickTermLookup quick={quick} persisted={lookupPersisted} onPersistedChange={setLookupPersisted} requestManager={lookupRequestManager} onInsert={insertTerm} onUseQuery={moveQueryToSource} />
        <MyTerms
          source={source}
          direction={effectiveTermbaseDirection}
          entries={termbaseEntries}
          setEntries={setTermbaseEntries}
          open={termbaseOpen}
          onOpenChange={setTermbaseOpen}
          draftSeed={termbaseDraftSeed}
          externalFeedback={termbaseFeedback}
          persisted={myTermsPersisted}
          onPersistedChange={setMyTermsPersisted}
        />
        <MyMemory
          sourceText={activeTmSegment.sourceText}
          targetText={activeTmSegment.targetText}
          prevSource={activeTmSegment.prevSource}
          nextSource={activeTmSegment.nextSource}
          segmentIndex={activeTmSegment.index}
          segmentTotal={activeTmSegment.total}
          alignmentStatus={tmAlignmentStatus}
          direction={effectiveTermbaseDirection}
          currentTermsDbRevision={tmDisplayBasis.currentTermsDbRevision}
          currentGameVersion={tmDisplayBasis.currentGameVersion}
          getDisplayBasis={getDisplayTmBasis}
          getConfirmBasis={getConfirmTmBasis}
          dictionaryStatus={tmDictionaryStatus}
          storageMode={selfHosted ? 'selfhost_sqlite' : 'public_memory'}
          storageState={tmStorageState}
          onRetryLoad={selfHosted ? () => void loadSelfhostTm() : undefined}
          persistence={tmPersistence}
          entries={tmEntries}
          setEntries={setTmEntries}
          onApplySuggestion={applyMemorySuggestion}
          onSelectSegment={index => setTmCursor({ kind: 'index', index })}
          open={tmOpen}
          onOpenChange={setTmOpen}
        />
      </div>}
    </div>
    <RuntimeStatus saveView={saveView} reportCommit={latest?.report.dictionary.source_commit ?? null} />
  </section>;
}
