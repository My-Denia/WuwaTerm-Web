// Standalone, React-free document controller facade for the WuwaTerm review workbench.
// Orchestrates state store, document ops, long-manuscript ops, serial batch runner,
// incremental TM translation, and workfile I/O via orthogonal submodules.
import { isLong, sessionReviewFeatures } from './long-review.ts';
import { initialRun } from './semantic-run.js';
import { emptySemantic, mapSemanticEdit, reconcileState, semanticSegmentViews } from './semantic-state.js';
import { emptyStructure } from './structure-layer.ts';
import type { TmServiceBasis } from './tm-live-provenance.ts';
import type { TmEntry } from './translation-memory.ts';
import type { TmApplySegmentResult } from './tm-segment.ts';
import type { UiLanguage } from './ui-language.ts';
import {
  clearWaitTimers,
  dispatchRun as runDispatch,
  failRun as runFail,
  precedentItems as buildPrecedentItems,
  resetRun as runReset,
  retryFailedRunItems as runRetryFailed,
  sendSemantic,
  sendTerm,
  startBatch as runStartBatch,
  startSemanticRun as runStartSemantic,
  startTermRun as runStartTerm,
  syncWaitTimer,
} from './workbench-batch-runner.ts';
import {
  applyMemorySuggestion as docApplyMemorySuggestion,
  applyTargetRevision as docApplyTargetRevision,
  canConfirmChoice as docCanConfirmChoice,
  checkDocument,
  chooseFinding,
  clearAlignments as docClearAlignments,
  clearDraft as docClearDraft,
  confirmChoice as docConfirmChoice,
  editDraft,
  editText as docEditText,
  isRevisionEligible as docIsRevisionEligible,
  recordAlignment as docRecordAlignment,
  redoStep,
  removeAlignment as docRemoveAlignment,
  removeChoice as docRemoveChoice,
  replaceTerm as docReplaceTerm,
  replaceWithText as docReplaceWithText,
  replaceWithWorkfile as docReplaceWithWorkfile,
  resetAlignments as docResetAlignments,
  restoreDocumentCheckpoint as docRestoreDocumentCheckpoint,
  setDirection as docSetDirection,
  translateInReviewDocument,
  undoStep,
} from './workbench-document-ops.ts';
import {
  applySemanticDecision as longApplySemanticDecision,
  applyTermOccurrenceAction as longApplyTermOccurrenceAction,
  canUndoSemanticDecision as longCanUndoSemanticDecision,
  chooseLong as longChooseLong,
  convertLinesToParagraphs as longConvertLinesToParagraphs,
  mergeParagraphsAt as longMergeParagraphsAt,
  removeTermHistoryEntry as longRemoveTermHistoryEntry,
  restoreTermHistoryEntry as longRestoreTermHistoryEntry,
  reviseSegmentText as longReviseSegmentText,
  runStructureChecks as longRunStructureChecks,
  segmentTargetCore as longSegmentTargetCore,
  selectLongSegment as longSelectLongSegment,
  splitParagraphs as longSplitParagraphs,
  toggleSegmentFinished as longToggleSegmentFinished,
  undoSemanticDecision as longUndoSemanticDecision,
} from './workbench-long-ops.ts';
import type {
  Candidate, DocumentCheckpoint, Draft, ErrorState, ExportArtifact, Finding,
  ImportFileLike, ImportOutcome, LongCtx, LongState, NoticeState, Pair, PairView,
  ParagraphCut, PendingWorkfile, Region, RunItem, RunKind, RunState,
  SemanticDecisionCommand, SemanticDecisionResult, SemanticState, SessionBasis,
  Snapshot, Span, TargetRevisionCommand, TargetRevisionResult, TermCandidateRef,
  TermFindingRef, TermOccurrenceAction,
} from './workbench-model.ts';
import {
  EMPTY_DRAFT,
  MAX_CHOICES,
  MAX_UNDO,
  PRECEDENTS_DEFAULT_ON,
  TYPING_COALESCE_MS,
  appendInvalidations,
  canonicalOf,
  cleanSnapshot,
  defaultClock,
  defaultUid,
  documentSignature,
  isRunActive,
  manuscriptBody,
  workPresent,
  type CommitInput,
  type QuickTranslation,
  type UndoEntry,
  type WorkbenchClock,
  type WorkbenchControllerOptions,
  type WorkbenchFetchCapabilities,
  type WorkbenchHost,
  type WorkbenchPost,
  type WorkbenchRuntimeState,
  type WorkbenchSnapshot,
  type WorkspaceMode,
} from './workbench-store.ts';
import {
  hasResumableTranslate as tmHasResumableTranslate,
  sendTranslate,
  startIncrementalTmTranslateRun as tmStartIncrementalRun,
  startTranslateRun as tmStartTranslateRun,
  translatePair as tmTranslatePair,
} from './workbench-tm-translate.ts';
import { postWorkbench } from './workbench-transport.ts';
import {
  exportMarkdown as ioExportMarkdown,
  exportProseTxt as ioExportProseTxt,
  exportResult as ioExportResult,
  exportTxt as ioExportTxt,
  importFile as ioImportFile,
  resolveConflictingChoicesAndSave as ioResolveConflictsAndSave,
  saveWorkfile as ioSaveWorkfile,
  shouldConfirmImport as ioShouldConfirmImport,
} from './workbench-workfile-io.ts';

export {
  EMPTY_DRAFT,
  MAX_CHOICES,
  MAX_UNDO,
  PRECEDENTS_DEFAULT_ON,
  TYPING_COALESCE_MS,
  canonicalOf,
  cleanSnapshot,
  documentSignature,
  isRunActive,
  manuscriptBody,
  workPresent,
};
export type {
  QuickTranslation,
  WorkbenchClock,
  WorkbenchControllerOptions,
  WorkbenchFetchCapabilities,
  WorkbenchPost,
  WorkbenchSnapshot,
  WorkspaceMode,
};

export class WorkbenchController {
  private readonly post: WorkbenchPost;
  private readonly fetchCapabilities: WorkbenchFetchCapabilities;
  private readonly clock: WorkbenchClock;
  private readonly onPoolRefresh: () => void;
  private readonly uid: () => string;
  private readonly getTmEntriesOption?: () => readonly TmEntry[];
  private readonly resolveTmAutoReuseBasis: (latest: Snapshot | null) => Promise<TmServiceBasis>;
  private tmEntries: readonly TmEntry[] = [];

  private state: WorkbenchSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly rt: WorkbenchRuntimeState;
  private readonly host: WorkbenchHost;

  constructor(options: WorkbenchControllerOptions = {}) {
    this.post = options.post ?? postWorkbench;
    this.fetchCapabilities = options.fetchCapabilities ?? (async () => []);
    this.clock = options.clock ?? defaultClock;
    this.onPoolRefresh = options.onPoolRefresh ?? (() => {});
    this.uid = options.uid ?? defaultUid;
    this.getTmEntriesOption = options.getTmEntries;
    this.resolveTmAutoReuseBasis = options.resolveTmAutoReuseBasis ?? (async () => ({ currentTermsDbRevision: null, currentGameVersion: null }));
    this.rt = {
      disposed: false,
      docAbort: null,
      docGeneration: 0,
      importAttempt: 0,
      historySerial: 0,
      activeTypingTx: null,
      future: [],
      composition: null,
      documentEpoch: 0,
      reconcileGeneration: 0,
      capabilitiesAbort: null,
      capabilitiesPromise: null,
      structureAbort: null,
      tmPrepareAbort: null,
      tmPrepareGeneration: 0,
      runGeneration: 0,
      runAbort: null,
      inflight: null,
      translateRun: null,
      pairAbort: null,
      waitTimeout: null,
      waitInterval: null,
      waitTarget: null,
      pumping: false,
    };
    this.state = {
      draft: EMPTY_DRAFT,
      choices: [],
      imported: [],
      reports: [],
      history: [],
      documentCheckpoint: null,
      alignmentInvalidations: [],
      semantic: emptySemantic() as SemanticState,
      basis: null,
      capabilities: options.initialCapabilities ?? null,
      phase: 'idle',
      translating: false,
      sourceDirtyForTranslation: false,
      notice: null,
      error: null,
      pairTranslating: null,
      importedCanonical: null,
      downloadedCanonical: null,
      run: initialRun() as RunState,
      now: this.clock.now(),
      resetSignal: 0,
      documentEpoch: 0,
      generation: 0,
      inFlight: false,
      lang: options.initialLang ?? 'zh',
      usePrecedents: PRECEDENTS_DEFAULT_ON,
      lastSemanticAction: null,
      workspaceMode: options.initialMode ?? 'quick',
      autoDirection: true,
      lastTranslation: null,
      redoCount: 0,
      structure: emptyStructure(),
      tmReceipt: null,
      tmPreparing: false,
    };

    this.host = {
      post: this.post,
      fetchCapabilities: this.fetchCapabilities,
      clock: this.clock,
      onPoolRefresh: this.onPoolRefresh,
      uid: this.uid,
      resolveTmAutoReuseBasis: this.resolveTmAutoReuseBasis,
      rt: this.rt,
      getState: () => this.state,
      setState: update => this.setState(update),
      currentTmEntries: () => (this.getTmEntriesOption ? this.getTmEntriesOption() : this.tmEntries),
      reviewFeatures: () => this.reviewFeatures(),
      longCtx: basis => this.longCtx(basis),
      requestFeatures: () => this.requestFeatures(),
      discardInFlight: () => this.discardInFlight(),
      abortRunInternal: () => this.abortRunInternal(),
      replaceDocumentState: (nextPatch, nextSemantic) => this.replaceDocumentState(nextPatch, nextSemantic),
      pushUndo: () => this.pushUndo(),
      pushDocumentUndo: kind => this.pushDocumentUndo(kind),
      canUndoLast: serial => this.canUndoLast(serial),
      applySemantic: update => this.applySemantic(update),
      commit: input => this.commit(input),
      commitLong: (update, notice) => this.commitLong(update, notice),
      viewsFor: () => this.viewsFor(),
      precedentItems: (d, st) => buildPrecedentItems(this.host, d, st),
      clearWaitTimers: () => clearWaitTimers(this.host),
      syncWaitTimer: () => syncWaitTimer(this.host),
      dispatchRun: event => this.dispatchRun(event),
      failRun: event => runFail(this.host, event),
      startBatch: (kind, items) => runStartBatch(this.host, kind, items),
      resetRun: () => this.resetRun(),
      undo: () => this.undo(),
      executeRunItem: (kind, item, signal, generation, epoch) => this.executeRunItem(kind, item, signal, generation, epoch),
      startTranslateRun: () => this.startTranslateRun(),
      startIncrementalTmTranslateRun: (startDraft, entries, isBlankMode, opts) =>
        tmStartIncrementalRun(this.host, startDraft, entries, isBlankMode, opts),
    };
  }

  // ---- External store contract (compatible with React useSyncExternalStore) ----

  readonly getSnapshot = (): WorkbenchSnapshot => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** Re-enable after a prior dispose() (used by React StrictMode double-effects). */
  activate(): void {
    this.rt.disposed = false;
  }

  /** Abort all in-flight requests, clear timers, and prevent any late async commits. */
  dispose(): void {
    this.rt.disposed = true;
    clearWaitTimers(this.host);
    this.rt.docGeneration += 1;
    this.rt.runGeneration += 1;
    this.rt.documentEpoch += 1;
    this.rt.importAttempt += 1;
    this.rt.reconcileGeneration += 1;
    this.rt.docAbort?.abort();
    this.rt.docAbort = null;
    this.rt.runAbort?.abort();
    this.rt.runAbort = null;
    this.rt.pairAbort?.abort();
    this.rt.pairAbort = null;
    this.rt.capabilitiesAbort?.abort();
    this.rt.capabilitiesAbort = null;
    this.rt.capabilitiesPromise = null;
    this.rt.structureAbort?.abort();
    this.rt.structureAbort = null;
    this.rt.tmPrepareAbort?.abort();
    this.rt.tmPrepareAbort = null;
    this.rt.tmPrepareGeneration += 1;
    this.rt.inflight = null;
    this.rt.translateRun = null;
  }

  private setState(update: Partial<WorkbenchSnapshot>): void {
    if (this.rt.disposed) return;
    const prev = this.state;
    const patch: Partial<WorkbenchSnapshot> = { ...update, redoCount: this.rt.future.length };
    if (update.draft && update.draft !== prev.draft && prev.workspaceMode === 'quick' && update.workspaceMode !== 'quick' && isLong(update.draft)) {
      patch.workspaceMode = 'manuscript';
      if (!update.notice) patch.notice = 'switchedToManuscript';
    }
    let changed = false;
    for (const key of Object.keys(patch) as (keyof WorkbenchSnapshot)[]) {
      if (!Object.is(prev[key], patch[key])) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    const next = { ...prev, ...patch };
    this.state = next;
    for (const listener of this.listeners) listener();
    if (next.semantic.results !== prev.semantic.results || next.semantic.decisions !== prev.semantic.decisions) {
      this.scheduleReconcileSemantic();
    }
  }

  private scheduleReconcileSemantic(): void {
    this.rt.reconcileGeneration += 1;
    const gen = this.rt.reconcileGeneration;
    const snapshotSemantic = this.state.semantic;
    const snapshotDraft = this.state.draft;
    if (snapshotSemantic.decisions.length === 0 || snapshotSemantic.placed.length === 0) {
      if (snapshotSemantic.outcomes.length > 0) {
        this.setState({ semantic: { ...snapshotSemantic, outcomes: [] } });
      }
      return;
    }
    void reconcileState(snapshotSemantic, { source: snapshotDraft.source, target: snapshotDraft.target }).then(next => {
      if (this.rt.disposed || this.rt.reconcileGeneration !== gen) return;
      if (this.state.semantic !== snapshotSemantic || this.state.draft !== snapshotDraft) return;
      const merged = next as SemanticState;
      if (JSON.stringify(merged.decisions) === JSON.stringify(snapshotSemantic.decisions)
        && JSON.stringify(merged.outcomes) === JSON.stringify(snapshotSemantic.outcomes)) return;
      this.setState({ semantic: merged });
    }).catch(() => {});
  }

  private longCtx(basis: SessionBasis = this.state.basis): LongCtx {
    return { draft: this.state.draft, basis, features: this.reviewFeatures() };
  }

  private async requestFeatures(): Promise<string[]> {
    if (this.state.capabilities === null && this.rt.capabilitiesPromise) await this.rt.capabilitiesPromise.catch(() => []);
    return this.reviewFeatures() ?? [];
  }

  private abortRunInternal(): void {
    clearWaitTimers(this.host);
    this.rt.runGeneration += 1;
    this.rt.runAbort?.abort();
    this.rt.runAbort = null;
    this.rt.tmPrepareAbort?.abort();
    this.rt.tmPrepareAbort = null;
    this.rt.tmPrepareGeneration += 1;
    this.rt.inflight = null;
    this.rt.translateRun = null;
  }

  private replaceDocumentState(nextPatch: Partial<WorkbenchSnapshot>, nextSemantic: SemanticState): void {
    this.rt.activeTypingTx = null;
    this.rt.composition = null;
    this.rt.docAbort?.abort();
    this.rt.docAbort = null;
    this.rt.docGeneration += 1;
    this.abortRunInternal();
    this.rt.documentEpoch += 1;
    this.setState({
      alignmentInvalidations: [],
      ...nextPatch,
      phase: 'idle',
      translating: false,
      error: null,
      generation: this.rt.docGeneration,
      inFlight: false,
      semantic: nextSemantic,
      basis: null,
      pairTranslating: null,
      run: initialRun() as RunState,
      documentEpoch: this.rt.documentEpoch,
      resetSignal: this.state.resetSignal + 1,
      lastSemanticAction: null,
      structure: emptyStructure(),
      tmReceipt: null,
      tmPreparing: false,
    });
    this.rt.structureAbort?.abort();
    this.rt.structureAbort = null;
  }

  private pushUndo(): { history: UndoEntry[]; serial: number } {
    this.rt.activeTypingTx = null;
    this.rt.composition = null;
    this.rt.future = [];
    const serial = ++this.rt.historySerial;
    const { draft, choices, imported, semantic, history, alignmentInvalidations: invalidations } = this.state;
    return {
      serial,
      history: [...history.slice(-(MAX_UNDO - 1)), { draft, choices, imported, semantic, serial, invalidations }],
    };
  }

  private pushDocumentUndo(kind?: DocumentCheckpoint['kind']): { history: UndoEntry[]; checkpoint: DocumentCheckpoint | null } {
    this.rt.activeTypingTx = null;
    this.rt.composition = null;
    this.rt.future = [];
    const serial = ++this.rt.historySerial;
    const { draft, choices, imported, reports, semantic, history, documentCheckpoint, alignmentInvalidations: invalidations } = this.state;
    const saved: UndoEntry = { draft, choices, imported, reports, semantic, serial, replacedDocument: true, invalidations };
    const nextHistory = [...history.slice(-(MAX_UNDO - 1)), saved];
    const checkpoint = kind && workPresent(draft, choices, reports, semantic)
      ? { entry: saved, kind, createdAt: this.clock.now() }
      : documentCheckpoint;
    return { history: nextHistory, checkpoint };
  }

  private applySemantic(update: (state: SemanticState) => SemanticState): void {
    this.setState({ semantic: update(this.state.semantic) });
  }

  private commit({
    draft: next,
    splices,
    semantic: update,
    notice: code,
    remember: push = true,
    invalidated,
    extraPatch,
  }: CommitInput): number | null {
    const before = this.state;
    let serial: number | null = null;
    let history = before.history;
    if (push) {
      const pushed = this.pushUndo();
      serial = pushed.serial;
      history = pushed.history;
    }
    let nextDraft = before.draft;
    let nextSemantic = before.semantic;
    let sourceDirtyForTranslation = before.sourceDirtyForTranslation;
    let phase = before.phase;
    let translating = before.translating;
    let error = before.error;
    let generation = before.generation;
    let inFlight = before.inFlight;

    if (next && next !== before.draft) {
      this.rt.activeTypingTx = null;
      this.rt.composition = null;
      this.rt.future = [];
      if (push) {
        this.rt.docAbort?.abort();
        this.rt.docAbort = null;
        this.rt.docGeneration += 1;
        phase = 'idle';
        translating = false;
        error = null;
        generation = this.rt.docGeneration;
        inFlight = false;
      }
      nextSemantic = mapSemanticEdit(nextSemantic, before.draft, next, splices) as SemanticState;
      nextDraft = next;
      sourceDirtyForTranslation = false;
    }
    if (update) {
      nextSemantic = update(nextSemantic);
    }
    const extra = extraPatch ? extraPatch(nextSemantic, serial) : {};
    this.setState({
      history,
      draft: nextDraft,
      semantic: nextSemantic,
      ...(invalidated && invalidated.length ? { alignmentInvalidations: appendInvalidations(before.alignmentInvalidations, invalidated) } : {}),
      sourceDirtyForTranslation,
      phase,
      translating,
      error,
      generation,
      inFlight,
      ...(code !== undefined && code !== null ? { notice: code } : {}),
      ...extra,
    });
    return serial;
  }

  private commitLong(
    update: (state: LongState) => { long: LongState; error?: string | null } | LongState,
    notice: string | null = null,
  ): boolean {
    const unwrap = (out: { long: LongState; error?: string | null } | LongState) =>
      ('records' in out ? { long: out, error: null } : { long: out.long, error: out.error ?? null });
    const probe = unwrap(update(this.state.semantic.long));
    if (probe.error) {
      if (probe.error === 'too_many_choices') this.commit({ notice: 'choiceLimit', remember: false });
      return false;
    }
    if (probe.long === this.state.semantic.long) return false;
    this.commit({
      semantic: state => {
        const out = unwrap(update(state.long));
        return out.error || out.long === state.long ? state : { ...state, long: out.long };
      },
      notice,
    });
    return true;
  }

  private viewsFor() {
    const { draft, semantic, basis } = this.state;
    return {
      draft,
      ...(semanticSegmentViews(draft, semantic, basis, this.reviewFeatures()) as { long: boolean; pairs: Pair[]; items: PairView[] }),
    };
  }

  private executeRunItem(kind: RunKind, item: RunItem, signal: AbortSignal, generation: number, epoch: number): Promise<void> {
    if (kind === 'term') return sendTerm(this.host, item, signal, generation, epoch);
    if (kind === 'translate') return sendTranslate(this.host, item, signal, generation, epoch);
    return sendSemantic(this.host, item, signal, generation, epoch);
  }

  // ---- Environment & configuration ----

  setLang(lang: UiLanguage): void { this.setState({ lang }); }
  setUsePrecedents(usePrecedents: boolean): void { this.setState({ usePrecedents }); }
  toggleUsePrecedents(): void { this.setState({ usePrecedents: !this.state.usePrecedents }); }
  setNotice(notice: NoticeState): void { this.setState({ notice }); }
  setError(error: ErrorState): void { this.setState({ error }); }
  setCapabilities(capabilities: string[] | null): void { this.setState({ capabilities }); }
  setTmEntries(entries: readonly TmEntry[]): void { this.tmEntries = entries; }
  reviewFeatures(): string[] | null { return sessionReviewFeatures(this.state.capabilities); }
  runStructureChecks(): Promise<void> { return longRunStructureChecks(this.host); }

  setWorkspaceMode(mode: WorkspaceMode): boolean {
    if (mode === this.state.workspaceMode) return true;
    if (mode === 'quick' && isLong(this.state.draft)) return false;
    this.setState({ workspaceMode: mode });
    return true;
  }

  setQuickDirection(choice: 'auto' | 'en' | 'zh'): void {
    if (choice === 'auto') {
      this.setState({ autoDirection: true });
      return;
    }
    this.setState({ autoDirection: false });
    if (choice !== this.state.draft.direction) this.setDirection(choice);
  }

  loadCapabilities(): Promise<string[]> {
    this.rt.capabilitiesAbort?.abort();
    const abort = new AbortController();
    this.rt.capabilitiesAbort = abort;
    const promise = (async () => {
      try {
        const list = await this.fetchCapabilities(abort.signal);
        if (!this.rt.disposed && !abort.signal.aborted && this.rt.capabilitiesAbort === abort) {
          this.setState({ capabilities: list });
        }
        return list;
      } catch {
        if (!this.rt.disposed && !abort.signal.aborted && this.rt.capabilitiesAbort === abort) {
          this.setState({ capabilities: [] });
        }
        return [];
      } finally {
        if (this.rt.capabilitiesAbort === abort) this.rt.capabilitiesAbort = null;
      }
    })();
    this.rt.capabilitiesPromise = promise;
    return promise;
  }

  // ---- Lifecycle & undo/redo ----

  discardInFlight(): void {
    this.rt.activeTypingTx = null;
    this.rt.docAbort?.abort();
    this.rt.docAbort = null;
    this.rt.docGeneration += 1;
    this.setState({
      phase: 'idle',
      translating: false,
      error: null,
      generation: this.rt.docGeneration,
      inFlight: false,
    });
  }

  cancelWait(): void {
    this.discardInFlight();
    this.setState({ phase: 'cancelled', notice: 'cancelledWait' });
    this.onPoolRefresh();
  }

  canUndoLast(serial: number): boolean { return this.state.history.at(-1)?.serial === serial; }
  canRedo(): boolean { return this.rt.future.length > 0; }
  redoDepth(): number { return this.rt.future.length; }

  // ---- Document edits & choices ----

  edit(next: Draft, message: NoticeState = ''): void { editDraft(this.host, next, message); }
  editText(side: 'source' | 'target', value: string, options: { composing?: boolean; coalesce?: boolean } = {}): void { docEditText(this.host, side, value, options); }
  setDirection(direction: 'en' | 'zh'): void { docSetDirection(this.host, direction); }
  recordAlignment(sourceSpan: Span | null, targetSpan: Span | null, omit = false, whole = false): boolean { return docRecordAlignment(this.host, sourceSpan, targetSpan, omit, whole); }
  clearAlignments(): void { docClearAlignments(this.host); }
  resetAlignments(): void { docResetAlignments(this.host); }
  removeAlignment(index: number): void { docRemoveAlignment(this.host, index); }
  applyMemorySuggestion(activeIndex: number, suggestionText: string): TmApplySegmentResult { return docApplyMemorySuggestion(this.host, activeIndex, suggestionText); }
  choose(finding: Finding, candidate: Candidate | null): void { chooseFinding(this.host, finding, candidate); }
  removeChoice(index: number): void { docRemoveChoice(this.host, index); }
  canConfirmChoice(index: number): boolean { return docCanConfirmChoice(this.host, index); }
  confirmChoice(index: number): boolean { return docConfirmChoice(this.host, index); }
  isRevisionEligible(finding: Finding, candidate: Candidate): boolean { return docIsRevisionEligible(this.host, finding, candidate); }
  applyTargetRevision(input: TargetRevisionCommand): TargetRevisionResult { return docApplyTargetRevision(this.host, input); }
  replaceTerm(finding: Finding, candidate: Candidate): void { docReplaceTerm(this.host, finding, candidate); }
  undo(): void { undoStep(this.host); }
  redo(): boolean { return redoStep(this.host); }
  restoreDocumentCheckpoint(): boolean { return docRestoreDocumentCheckpoint(this.host); }
  replaceWithText(text: string, notice: NoticeState = 'importedSourceText'): void { docReplaceWithText(this.host, text, notice); }
  replaceWithWorkfile(pending: PendingWorkfile): void { docReplaceWithWorkfile(this.host, pending); }
  clearDraft(): boolean { return docClearDraft(this.host); }

  // ---- Semantic decisions, long-manuscript & paragraph commands ----

  applySemanticDecision(command: SemanticDecisionCommand): Promise<SemanticDecisionResult> { return longApplySemanticDecision(this.host, command); }
  canUndoSemanticDecision(placedId: string): boolean { return longCanUndoSemanticDecision(this.host, placedId); }
  undoSemanticDecision(placedId: string): boolean { return longUndoSemanticDecision(this.host, placedId); }
  applyTermOccurrenceAction(action: TermOccurrenceAction): boolean { return longApplyTermOccurrenceAction(this.host, action); }
  chooseLong(index: number, finding: TermFindingRef, candidate: TermCandidateRef | null): boolean { return longChooseLong(this.host, index, finding, candidate); }
  segmentTargetCore(index: number): string | null { return longSegmentTargetCore(this.host, index); }
  reviseSegmentText(index: number, expectedBase: string, nextText: string): { applied: boolean; error?: string } { return longReviseSegmentText(this.host, index, expectedBase, nextText); }
  toggleSegmentFinished(index: number, finished?: boolean): boolean { return longToggleSegmentFinished(this.host, index, finished); }
  restoreTermHistoryEntry(position: number, targetSegmentIndex?: number): boolean { return longRestoreTermHistoryEntry(this.host, position, targetSegmentIndex); }
  removeTermHistoryEntry(position: number): boolean { return longRemoveTermHistoryEntry(this.host, position); }
  selectLongSegment(index: number | null): void { longSelectLongSegment(this.host, index); }
  splitParagraphs(cuts: ParagraphCut[]): boolean { return longSplitParagraphs(this.host, cuts); }
  mergeParagraphsAt(side: 'source' | 'target', gapStart: number, gapEnd: number): boolean { return longMergeParagraphsAt(this.host, side, gapStart, gapEnd); }
  convertLinesToParagraphs(scope?: { side: 'source' | 'target'; region?: Region }): boolean { return longConvertLinesToParagraphs(this.host, scope); }

  // ---- Import / Save / Export ----

  replacementNeedsConfirm(): boolean { return ioShouldConfirmImport(this.host); }
  importFile(file?: ImportFileLike): Promise<ImportOutcome> { return ioImportFile(this.host, file); }
  save(): ExportArtifact | null { return ioSaveWorkfile(this.host); }
  resolveConflictingChoicesAndSave(): ExportArtifact | null { return ioResolveConflictsAndSave(this.host); }
  exportProseTxt(): ExportArtifact { return ioExportProseTxt(this.host); }
  exportTxt(): ExportArtifact { return ioExportTxt(this.host); }
  exportResult(): ExportArtifact { return ioExportResult(this.host); }
  exportMarkdown(lang: UiLanguage = this.state.lang): ExportArtifact { return ioExportMarkdown(this.host, lang); }

  // ---- Document & serial run orchestration ----

  check(withChoices = true, options: { reviewsClosed?: boolean } = {}): Promise<void> { return checkDocument(this.host, withChoices, options); }
  translateInReview(options: { translationClosed?: boolean } = {}): Promise<void> { return translateInReviewDocument(this.host, options); }
  dispatchRun(event: Record<string, unknown>): void { runDispatch(this.host, event); }
  pauseRun(): void { this.dispatchRun({ type: 'pause' }); }
  resumeRun(): void { this.dispatchRun({ type: 'resume' }); }
  retryRunItem(key: string): void { this.dispatchRun({ type: 'retry', key }); }
  retryFailedRunItems(): void { runRetryFailed(this.host); }
  resetRun(): void { runReset(this.host); }
  stopRun(): void { this.resetRun(); }
  hasResumableTranslate(d: Draft = this.state.draft, semanticState: SemanticState = this.state.semantic, basis: SessionBasis = this.state.basis): boolean {
    return tmHasResumableTranslate(this.host, d, semanticState, basis);
  }
  startSemanticRun(only?: PairView[], lang?: UiLanguage): void { runStartSemantic(this.host, only, lang); }
  startTermRun(): void { runStartTerm(this.host); }
  startTranslateRun(): Promise<void> { return tmStartTranslateRun(this.host); }
  translatePair(viewOrIndex: PairView | number): Promise<void> { return tmTranslatePair(this.host, viewOrIndex); }
}

export function createWorkbenchController(options?: WorkbenchControllerOptions): WorkbenchController {
  return new WorkbenchController(options);
}
