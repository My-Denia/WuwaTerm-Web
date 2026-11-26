// Standalone, React-free document controller for the WuwaTerm review workbench.
// Owns canonical manuscript state, request orchestration, abort/generation/epoch
// guards, serial run scheduling, waiting timers, and persistence/export shaping.
import { SEGMENT_LIMIT, core, paragraphRanges, segmentText } from './segmentation.ts';
import { contextBefore, diffSplice, fitRequestBody, initialRun, nextToSend, runReducer, selectPrecedents } from './semantic-run.js';
import {
  applyResult, chooseTerm, isLong, longFromWorkfile, recheckPlan, reconfirmChoice, recordView,
  removeChoice, removeHistoryEntry, restorableHistory, restoreHistoryEntry, reviseSegmentTarget,
  sameV3Basis, segmentInputs, segmentRequest, sessionReviewFeatures, setCurrent, setFinished, spliceTargetSpan,
  termPlan, termSegmentKey, workfileParts,
} from './long-review.ts';
import {
  CAPABILITY_TRANSLATION_CONTEXT, SEMANTIC_REVIEW_VERSION,
  applySemanticSuggestion, validSemanticReviewResponse, verifySemanticReviewIdentity,
} from './semantic-review.js';
import { makeSemanticDecision } from './semantic-decisions.js';
import {
  addSegmentResult, decisionFor, emptySemantic, freshSemantic, isHandled, issueStatus,
  longHoldsWork, mapSemanticEdit, occurrenceKey, placeSemanticResult, reconcileState,
  removeDecision, semanticSegmentViews, upsertDecision,
} from './semantic-state.js';
import { insertParagraphBreak, linesToParagraphs, mergeParagraphs } from './manual-split.ts';
import {
  MAX_V3_WORKFILE_BYTES, MAX_WORKFILE_BYTES, MAX_V4_CHOICES, REPORT_V4, REPORT_V5, REVIEW_FEATURE_AMBIGUOUS_MENTION,
  canonicalManuscript, compareReports, leaveGuardActive, makeChoice, manuscriptSaveView,
  mentionId, parseWorkfile, reconcileChoices, recoverableWorkPresent, recoverSpan,
  remapForFreeEdit, remapForSplice, remapForTargetFill, sanitizeDuplicateChoices,
  serializeWorkfile, validAlignments, validReport, validSpan,
  WORKFILE_FORMAT_V2, WORKFILE_FORMAT_V3, WORKFILE_FORMAT_V4, WORKFILE_FORMAT_V5,
  type AlignmentRemap, type InvalidatedAlignment,
} from './manuscript.js';
import { highlightSegments, revisionOf } from './review-report.js';
import { spliceOccurrence } from './target-revision.js';
import { isMarkdownReportExport, renderMarkdownReport, type MarkdownCurrency } from './markdown-report.ts';
import { msg } from './messages.ts';
import { semanticExport, semanticFromWorkfile, semanticWorkfileParts } from './workbench-persistence.ts';
import { emptyStructure, structurePlan, type StructureFinding, type StructureState } from './structure-layer.ts';
import { CAPABILITY_STRUCTURE_CHECK, validStructureCheckResponse } from './structure-check.js';
import { postWorkbench, REVIEW_REQUEST_LIMIT, runFailure } from './workbench-transport.ts';
import type { UiLanguage } from './ui-language.ts';
import { scalarOffset } from './workbench-model.ts';
import type {
  Candidate, Choice, Decision, DocumentCheckpoint, DocumentPhase, Draft, DraftEditSplices, ErrorState, ExportArtifact,
  Finding, ImportFileLike, ImportOutcome, LongCtx, LongState, NoticeState, Pair, PairView,
  ParagraphCut, PendingWorkfile, Region, Report, Resolution, RunItem, RunKind, RunState,
  SegmentInput, SemanticActionRecord, SemanticDecisionCommand, SemanticDecisionResult,
  SemanticReport, SemanticState, SessionBasis, Snapshot, Span, TargetRevisionCommand,
  TargetRevisionResult, TermCandidateRef, TermFindingRef, TermOccurrenceAction, Undo,
} from './workbench-model.ts';

export const MAX_CHOICES = MAX_V4_CHOICES;
export const MAX_UNDO = 50;
export const TYPING_COALESCE_MS = 1200;
export const EMPTY_DRAFT: Draft = { source: '', target: '', direction: 'en', alignments: null };

/**
 * Precedents are sent by default only because the Core evaluation's M′ gates
 * (same-sense reuse and led-astray) were met for them; re-read the C2 receipt
 * when the backend pin moves and turn this off if they are not.
 */
export const PRECEDENTS_DEFAULT_ON = true;

const chars = (text: string) => Array.from(text);
const slice = (list: string[], start: number, end: number) => list.slice(start, end).join('');
const sliceEquals = (text: string, span: Span | null) => !!span && slice(chars(text), span.start, span.end) === span.text;
/**
 * The notice of an edit transaction that touched explicit alignments: `editedAlignments` when it left none of them,
 * `editedAlignmentsPartial` when it invalidated only some, else null (kept, shifted, resized or emptied-target entries only).
 */
const alignmentNotice = (prev: Draft['alignments'], remap: AlignmentRemap): 'editedAlignments' | 'editedAlignmentsPartial' | null =>
  prev === null || prev.length === 0 ? null
    : remap.alignments !== null && remap.alignments.length === 0 ? 'editedAlignments'
      : remap.invalidated.length > 0 ? 'editedAlignmentsPartial' : null;
/** The session list of invalidated alignments keeps the latest entries, at most the 64 an alignment list can hold. */
const MAX_SESSION_INVALIDATIONS = 64;
const appendInvalidations = (list: readonly InvalidatedAlignment[], added: readonly InvalidatedAlignment[]): InvalidatedAlignment[] =>
  (added.length ? [...list, ...added].slice(-MAX_SESSION_INVALIDATIONS) : [...list]);
/**
 * One undo or redo step: the workbench state before (undo) or after (redo) one edit transaction, with the session list of
 * alignments that edits invalidated, so stepping back restores every entry a transaction took out. `checkpoint` is the protected
 * document checkpoint an undo of a document replacement cleared, restored when that replacement is redone.
 */
type UndoEntry = Undo & { invalidations?: InvalidatedAlignment[]; checkpoint?: DocumentCheckpoint };
const invalidationsOf = (entry: Undo): InvalidatedAlignment[] => (entry as UndoEntry).invalidations ?? [];
const inputsOf = segmentInputs;
const viewOf = recordView;
const defaultUid = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

export type WorkbenchPost = (
  path: string,
  body: object,
  options?: { signal?: AbortSignal; reviewFeatures?: boolean | readonly string[]; allowInvalidJson?: boolean },
) => Promise<{ response: Response; value: unknown }>;

export type WorkbenchFetchCapabilities = (signal: AbortSignal) => Promise<string[]>;

/**
 * How the one document workspace is laid out. `quick`: a short source and its translation side by side; `manuscript`: the
 * same document with alignments, term and semantic review, save and export. Both modes edit the same draft, history and
 * reports; a long document, an imported manuscript or the user's explicit switch moves to `manuscript`, never back on its own.
 */
export type WorkspaceMode = 'quick' | 'manuscript';

/** What the last whole-text translation returned, for the quick view; it describes the draft only while both texts match. */
export type QuickTranslation = {
  source: string;
  text: string;
  kind: 'noop' | 'exact' | 'fuzzy' | 'llm' | null;
  direction: 'en' | 'zh';
  dictionaryMiss: boolean;
  requestId: string | null;
};

export type WorkbenchClock = {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (id: unknown) => void;
};

export type WorkbenchControllerOptions = {
  post?: WorkbenchPost;
  fetchCapabilities?: WorkbenchFetchCapabilities;
  clock?: WorkbenchClock;
  onPoolRefresh?: () => void;
  uid?: () => string;
  initialCapabilities?: string[] | null;
  initialLang?: UiLanguage;
  initialMode?: WorkspaceMode;
};

export type WorkbenchSnapshot = {
  draft: Draft;
  choices: Choice[];
  imported: Choice[];
  reports: Snapshot[];
  history: UndoEntry[];
  documentCheckpoint: DocumentCheckpoint | null;
  /**
   * Alignments that edit transactions took out of the list this session (reason and the entry before the edit). Session state
   * only: undo entries and the document checkpoint carry it, a saved manuscript never does, and nothing writes it to browser storage.
   */
  alignmentInvalidations: InvalidatedAlignment[];
  semantic: SemanticState;
  basis: SessionBasis;
  capabilities: string[] | null;
  phase: DocumentPhase;
  translating: boolean;
  sourceDirtyForTranslation: boolean;
  notice: NoticeState;
  error: ErrorState;
  pairTranslating: number | null;
  importedCanonical: string | null;
  downloadedCanonical: string | null;
  run: RunState;
  now: number;
  resetSignal: number;
  documentEpoch: number;
  generation: number;
  inFlight: boolean;
  lang: UiLanguage;
  usePrecedents: boolean;
  lastSemanticAction: SemanticActionRecord | null;
  workspaceMode: WorkspaceMode;
  /** Quick mode only: translate without a target language and take the direction the service detected. */
  autoDirection: boolean;
  lastTranslation: QuickTranslation | null;
  /** How many undone steps redo can bring back; kept in the snapshot so a view re-renders when it changes. */
  redoCount: number;
  /**
   * Layer 1 structure checks (Core ADR 0022): session state only. Undo entries, the document checkpoint and every manuscript
   * format leave it out, and nothing writes it to browser storage; a result shows only while its segment's texts are unchanged.
   */
  structure: StructureState;
};

type TranslateRunStep =
  | { kind: 'blank'; segment: { start: number; end: number; core_start: number; core_end: number } }
  | { kind: 'pair'; sourceCoreStart: number; sourceCoreEnd: number }
  | { kind: 'partial_tail'; segment: { start: number; end: number; core_start: number; core_end: number } };

type TranslateRunPlan = {
  kind: 'blank' | 'untranslated_pairs' | 'partial_prefix';
  source: string;
  direction: 'en' | 'zh';
  steps: TranslateRunStep[];
  pieces: string[];
  base: string;
  expectedTarget: string;
  appendPrefix: string;
  tailStart: number;
  initialBefore: { source: string; target: string } | null;
};

const defaultClock: WorkbenchClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: id => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: id => globalThis.clearInterval(id as ReturnType<typeof setInterval>),
};

export function documentSignature(draft: Draft, resolutions: object[]): string {
  return JSON.stringify({ ...draft, resolutions });
}

export function cleanSnapshot(snapshot: Snapshot) {
  const { source, target, direction, alignments, report } = snapshot;
  return { source, target, direction, alignments, report, ...(snapshot.resolutions === null ? {} : { resolutions: snapshot.resolutions }) };
}

/**
 * The manuscript payload: the v1/v2 parts and, for long-mode term review, the v3 parts (manuscript-v3 SPEC "Writing").
 * `basis` is the session basis, so a record whose result another live response superseded is written stale.
 * Throws long_state_out_of_sync when the long state does not line up with the segments.
 */
export function manuscriptBody(nextDraft: Draft, nextChoices: Choice[], nextReports: Snapshot[], semantic: SemanticState, basis: SessionBasis) {
  const parts = workfileParts(semantic.long, nextDraft, { basis });
  const base = { ...nextDraft, choices: nextChoices, history: nextReports.map(cleanSnapshot), ...parts };
  return semanticWorkfileParts(base, semantic);
}

/**
 * Whether the workbench holds work that replacing the manuscript would lose: the texts, alignments, choices and reports,
 * semantic decisions and results, and the long-mode records, choices and choice history. One predicate for the save
 * state, clearing and a received draft, so they cannot disagree.
 */
export function workPresent(draft: Draft, choices: Choice[], reports: Snapshot[], semantic: SemanticState): boolean {
  return recoverableWorkPresent({ ...draft, choices, reports })
    || semantic.decisions.length > 0
    || semantic.results.length > 0
    || longHoldsWork(semantic.long);
}

export function canonicalOf(nextDraft: Draft, nextChoices: Choice[], nextReports: Snapshot[], semantic: SemanticState, basis: SessionBasis): string | null {
  try { return canonicalManuscript(manuscriptBody(nextDraft, nextChoices, nextReports, semantic, basis)); } catch { return null; }
}

export function isRunActive(run: RunState, pairTranslating: number | null = null): boolean {
  return run.phase === 'running'
    || run.phase === 'waiting'
    || (run.phase === 'paused' && run.items.some(i => i.status === 'sending'))
    || pairTranslating !== null;
}

function failureFields(response: Response, value: unknown): { requestId?: string; retryAfter?: number } {
  const body = value && typeof value === 'object' ? value as { request_id?: unknown; retry_after_seconds?: unknown } : {};
  const header = Number(response.headers.get('retry-after'));
  const retryAfter = typeof body.retry_after_seconds === 'number'
    ? body.retry_after_seconds
    : Number.isFinite(header) && header > 0 ? header : undefined;
  return {
    ...(typeof body.request_id === 'string' && body.request_id ? { requestId: body.request_id } : {}),
    ...(retryAfter !== undefined ? { retryAfter } : {}),
  };
}

function errorFrom(cause: unknown, fallbackKey: string): ErrorState {
  const code = cause instanceof Error && 'code' in cause ? String((cause as Error & { code?: unknown }).code) : '';
  const errors = msg('zh').errors as Record<string, string>;
  return code && Object.hasOwn(errors, code) ? { code } : { code: fallbackKey };
}

function detailOf(cause: unknown): { requestId?: string; retryAfter?: number } {
  return cause && typeof cause === 'object' && 'gahDetail' in cause
    ? (cause as { gahDetail: { requestId?: string; retryAfter?: number } }).gahDetail
    : {};
}

export class WorkbenchController {
  private readonly post: WorkbenchPost;
  private readonly fetchCapabilities: WorkbenchFetchCapabilities;
  private readonly clock: WorkbenchClock;
  private readonly onPoolRefresh: () => void;
  private readonly uid: () => string;

  private state: WorkbenchSnapshot;
  private readonly listeners = new Set<() => void>();

  private disposed = false;
  private docAbort: AbortController | null = null;
  private docGeneration = 0;
  private importAttempt = 0;
  private historySerial = 0;
  /** The typing step a one-scalar edit on the same side within TYPING_COALESCE_MS may join: its side, time and undo serial. */
  private activeTypingTx: { side: 'source' | 'target'; at: number; serial: number } | null = null;
  /** Redo steps, newest last; any new edit clears them. */
  private future: UndoEntry[] = [];
  /**
   * An IME composition in progress: its side, the draft, session invalidations and semantic state before it (one undo step),
   * and the semantic state its last update produced. While nothing else changed the semantic state, every update maps it from
   * the base, so a composition that ends where it began leaves live spans and regions exactly as they were.
   */
  private composition: {
    side: 'source' | 'target'; base: Draft; invalidations: InvalidatedAlignment[]; semantic: SemanticState; mapped: SemanticState | null;
  } | null = null;
  private documentEpoch = 0;
  private reconcileGeneration = 0;

  private capabilitiesAbort: AbortController | null = null;
  private capabilitiesPromise: Promise<string[]> | null = null;
  private structureAbort: AbortController | null = null;

  private runGeneration = 0;
  private runAbort: AbortController | null = null;
  private inflight: { key: string; attempt: number } | null = null;
  private translateRun: TranslateRunPlan | null = null;
  private pairAbort: AbortController | null = null;
  private waitTimeout: unknown = null;
  private waitInterval: unknown = null;
  private waitTarget: number | null = null;
  private pumping = false;

  constructor(options: WorkbenchControllerOptions = {}) {
    this.post = options.post ?? postWorkbench;
    // The page's runtime provider is the one source of capabilities and the pool; a controller without it reads neither.
    this.fetchCapabilities = options.fetchCapabilities ?? (async () => []);
    this.clock = options.clock ?? defaultClock;
    this.onPoolRefresh = options.onPoolRefresh ?? (() => {});
    this.uid = options.uid ?? defaultUid;
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
    this.disposed = false;
  }

  /** Abort all in-flight requests, clear timers, and prevent any late async commits. */
  dispose(): void {
    this.disposed = true;
    this.clearWaitTimers();
    this.docGeneration += 1;
    this.runGeneration += 1;
    this.documentEpoch += 1;
    this.importAttempt += 1;
    this.reconcileGeneration += 1;
    this.docAbort?.abort();
    this.docAbort = null;
    this.runAbort?.abort();
    this.runAbort = null;
    this.pairAbort?.abort();
    this.pairAbort = null;
    this.capabilitiesAbort?.abort();
    this.capabilitiesAbort = null;
    this.capabilitiesPromise = null;
    this.structureAbort?.abort();
    this.structureAbort = null;
    this.inflight = null;
    this.translateRun = null;
  }

  private setState(update: Partial<WorkbenchSnapshot>): void {
    if (this.disposed) return;
    const prev = this.state;
    // A document past the one-request limit is only edited in manuscript mode: the switch happens with the edit itself, in
    // place, so the texts, history and caret stay where they are. Nothing switches back to quick on its own.
    const patch: Partial<WorkbenchSnapshot> = { ...update, redoCount: this.future.length };
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
    this.reconcileGeneration += 1;
    const gen = this.reconcileGeneration;
    const snapshotSemantic = this.state.semantic;
    const snapshotDraft = this.state.draft;
    if (snapshotSemantic.decisions.length === 0 || snapshotSemantic.placed.length === 0) {
      if (snapshotSemantic.outcomes.length > 0) {
        this.setState({ semantic: { ...snapshotSemantic, outcomes: [] } });
      }
      return;
    }
    void reconcileState(snapshotSemantic, { source: snapshotDraft.source, target: snapshotDraft.target }).then(next => {
      if (this.disposed || this.reconcileGeneration !== gen) return;
      if (this.state.semantic !== snapshotSemantic || this.state.draft !== snapshotDraft) return;
      const merged = next as SemanticState;
      if (JSON.stringify(merged.decisions) === JSON.stringify(snapshotSemantic.decisions)
        && JSON.stringify(merged.outcomes) === JSON.stringify(snapshotSemantic.outcomes)) return;
      this.setState({ semantic: merged });
    }).catch(() => {});
  }

  // ---- Environment & configuration ----

  setLang(lang: UiLanguage): void {
    this.setState({ lang });
  }

  setUsePrecedents(usePrecedents: boolean): void {
    this.setState({ usePrecedents });
  }

  toggleUsePrecedents(): void {
    this.setState({ usePrecedents: !this.state.usePrecedents });
  }

  setNotice(notice: NoticeState): void {
    this.setState({ notice });
  }

  setError(error: ErrorState): void {
    this.setState({ error });
  }

  setCapabilities(capabilities: string[] | null): void {
    this.setState({ capabilities });
  }

  /** The review features this session asks Core for (manuscript-v5 SPEC "Review features"); null while capabilities are unknown. */
  reviewFeatures(): string[] | null {
    return sessionReviewFeatures(this.state.capabilities);
  }

  /** The long-mode context of the current draft under a session basis (default: the current one) and the session's features. */
  private longCtx(basis: SessionBasis = this.state.basis): LongCtx {
    return { draft: this.state.draft, basis, features: this.reviewFeatures() };
  }

  /** The session's review features for a request: the capabilities, awaited when they are still loading; none without a source. */
  private async requestFeatures(): Promise<string[]> {
    if (this.state.capabilities === null && this.capabilitiesPromise) await this.capabilitiesPromise.catch(() => []);
    return this.reviewFeatures() ?? [];
  }

  /**
   * Layer 1: send every ready or untranslated segment of the draft to `/api/structure-checks`, in batches of at most 64 segments
   * and 60 KiB, one after another (each batch counts as one review). The results replace the previous ones and are kept by the
   * content hashes of the cores sent. Only when the service lists structure-check-v1; started by the user, never on its own.
   */
  async runStructureChecks(): Promise<void> {
    if (!this.state.capabilities?.includes(CAPABILITY_STRUCTURE_CHECK) || this.state.structure.phase === 'running') return;
    const { items, batches, skipped } = structurePlan(this.state.draft);
    if (!batches.length) {
      this.setState({ structure: { ...emptyStructure(), phase: 'done', skipped: skipped.length } });
      return;
    }
    this.structureAbort?.abort();
    const abort = new AbortController();
    this.structureAbort = abort;
    const epoch = this.documentEpoch;
    const live = () => !this.disposed && !abort.signal.aborted && this.documentEpoch === epoch && this.structureAbort === abort;
    const keyOf = new Map(items.map(item => [item.id, item.key]));
    const results: StructureState['results'] = {};
    let checks: string[] = [];
    this.setState({ structure: { ...this.state.structure, phase: 'running', error: null } });
    try {
      for (const batch of batches) {
        const { response, value } = await this.post('/api/structure-checks', batch, { signal: abort.signal, allowInvalidJson: true });
        if (!live()) return;
        this.onPoolRefresh();
        const body = value && typeof value === 'object' ? value as Record<string, unknown> : null;
        if (!response.ok) {
          const failure = runFailure(response, body);
          this.setState({ structure: { phase: 'failed', results, skipped: skipped.length, checks, error: { reason: failure.code, ...(failure.requestId ? { requestId: failure.requestId } : {}) } } });
          return;
        }
        if (!validStructureCheckResponse(body, batch)) {
          this.setState({ structure: { phase: 'failed', results, skipped: skipped.length, checks, error: { reason: 'responseInvalid' } } });
          return;
        }
        const answer = body as { checks: string[]; segments: { segment_id: string; findings: StructureFinding[]; omitted_findings: number; layout: StructureState['results'][string]['layout'] }[] };
        checks = answer.checks;
        for (const segment of answer.segments) {
          const key = keyOf.get(segment.segment_id);
          if (key) results[key] = { findings: segment.findings, omitted: segment.omitted_findings, layout: segment.layout };
        }
      }
      this.setState({ structure: { phase: 'done', results, skipped: skipped.length, checks, error: null } });
    } catch {
      if (live()) this.setState({ structure: { phase: 'failed', results, skipped: skipped.length, checks, error: { reason: 'requestFailed' } } });
    } finally {
      if (this.structureAbort === abort) this.structureAbort = null;
    }
  }

  /**
   * Switch the workspace layout. The document, history and reports are the same in both modes; quick is refused while the
   * document is past the one-request limit, since quick translation could not send it.
   */
  setWorkspaceMode(mode: WorkspaceMode): boolean {
    if (mode === this.state.workspaceMode) return true;
    if (mode === 'quick' && isLong(this.state.draft)) return false;
    this.setState({ workspaceMode: mode });
    return true;
  }

  /** The quick direction control: `auto` lets the service detect it; a language is the document's target language. */
  setQuickDirection(choice: 'auto' | 'en' | 'zh'): void {
    if (choice === 'auto') {
      this.setState({ autoDirection: true });
      return;
    }
    this.setState({ autoDirection: false });
    if (choice !== this.state.draft.direction) this.setDirection(choice);
  }

  loadCapabilities(): Promise<string[]> {
    this.capabilitiesAbort?.abort();
    const abort = new AbortController();
    this.capabilitiesAbort = abort;
    const promise = (async () => {
      try {
        const list = await this.fetchCapabilities(abort.signal);
        if (!this.disposed && !abort.signal.aborted && this.capabilitiesAbort === abort) {
          this.setState({ capabilities: list });
        }
        return list;
      } catch {
        if (!this.disposed && !abort.signal.aborted && this.capabilitiesAbort === abort) {
          this.setState({ capabilities: [] });
        }
        return [];
      } finally {
        if (this.capabilitiesAbort === abort) this.capabilitiesAbort = null;
      }
    })();
    this.capabilitiesPromise = promise;
    return promise;
  }

  // ---- Request / document lifecycle guards ----

  discardInFlight(): void {
    this.activeTypingTx = null;
    this.docAbort?.abort();
    this.docAbort = null;
    this.docGeneration += 1;
    this.setState({
      phase: 'idle',
      translating: false,
      error: null,
      generation: this.docGeneration,
      inFlight: false,
    });
  }

  cancelWait(): void {
    this.discardInFlight();
    this.setState({ phase: 'cancelled', notice: 'cancelledWait' });
    this.onPoolRefresh();
  }

  private abortRunInternal(): void {
    this.clearWaitTimers();
    this.runGeneration += 1;
    this.runAbort?.abort();
    this.runAbort = null;
    this.inflight = null;
    this.translateRun = null;
  }

  private replaceDocumentState(nextPatch: Partial<WorkbenchSnapshot>, nextSemantic: SemanticState): void {
    this.activeTypingTx = null;
    this.composition = null;
    this.docAbort?.abort();
    this.docAbort = null;
    this.docGeneration += 1;
    this.abortRunInternal();
    this.documentEpoch += 1;
    this.setState({
      alignmentInvalidations: [],
      ...nextPatch,
      phase: 'idle',
      translating: false,
      error: null,
      generation: this.docGeneration,
      inFlight: false,
      semantic: nextSemantic,
      basis: null,
      pairTranslating: null,
      run: initialRun() as RunState,
      documentEpoch: this.documentEpoch,
      resetSignal: this.state.resetSignal + 1,
      lastSemanticAction: null,
      structure: emptyStructure(),
    });
    this.structureAbort?.abort();
    this.structureAbort = null;
  }

  // Every new undo step starts a new transaction: it ends typing coalescing and an IME composition, and clears the redo steps.
  private pushUndo(): { history: UndoEntry[]; serial: number } {
    this.activeTypingTx = null;
    this.composition = null;
    this.future = [];
    const serial = ++this.historySerial;
    const { draft, choices, imported, semantic, history, alignmentInvalidations: invalidations } = this.state;
    return {
      serial,
      history: [...history.slice(-(MAX_UNDO - 1)), { draft, choices, imported, semantic, serial, invalidations }],
    };
  }

  private pushDocumentUndo(kind?: DocumentCheckpoint['kind']): { history: UndoEntry[]; checkpoint: DocumentCheckpoint | null } {
    this.activeTypingTx = null;
    this.composition = null;
    this.future = [];
    const serial = ++this.historySerial;
    const { draft, choices, imported, reports, semantic, history, documentCheckpoint, alignmentInvalidations: invalidations } = this.state;
    const saved: UndoEntry = { draft, choices, imported, reports, semantic, serial, replacedDocument: true, invalidations };
    const nextHistory = [...history.slice(-(MAX_UNDO - 1)), saved];
    const checkpoint = kind && workPresent(draft, choices, reports, semantic)
      ? { entry: saved, kind, createdAt: this.clock.now() }
      : documentCheckpoint;
    return { history: nextHistory, checkpoint };
  }

  canUndoLast(serial: number): boolean {
    return this.state.history.at(-1)?.serial === serial;
  }

  /** Whether an undone step can be redone (any new edit clears the redo steps). */
  canRedo(): boolean {
    return this.future.length > 0;
  }

  /** How many undone steps can be redone (at most MAX_UNDO). */
  redoDepth(): number {
    return this.future.length;
  }

  // ---- Document edits & choices ----

  private applySemantic(update: (state: SemanticState) => SemanticState): void {
    const next = update(this.state.semantic);
    this.setState({ semantic: next });
  }

  // An explicit alignment or direction change: the session list of invalidated alignments starts over (undo restores it).
  edit(next: Draft, message: NoticeState = ''): void {
    const before = this.state.draft;
    const { history } = this.pushUndo();
    this.docAbort?.abort();
    this.docAbort = null;
    this.docGeneration += 1;
    const nextSemantic = mapSemanticEdit(this.state.semantic, before, next) as SemanticState;
    this.setState({
      history,
      phase: 'idle',
      translating: false,
      error: null,
      generation: this.docGeneration,
      inFlight: false,
      draft: next,
      semantic: nextSemantic,
      alignmentInvalidations: [],
      notice: message,
    });
  }

  /**
   * One free edit of `side` as an edit transaction (contracts/workbench-state/edit-transactions.json): alignments outside the
   * edit are kept or shifted, one holding it is resized, and only the entries it crosses or empties leave the list; an emptied
   * target keeps its source anchor as `target: null`. Undo: a one-scalar edit on the same side within TYPING_COALESCE_MS joins
   * the typing step, unless it invalidates or empties an alignment, which is a step of its own so one undo restores the entries.
   * `composing`: an IME composition update. The first one opens the step, later ones join it, and alignments are judged against
   * the text before the composition; the next edit of that side without `composing` (the composition end, even with the same
   * text) closes it.
   */
  editText(side: 'source' | 'target', value: string, options: { composing?: boolean; coalesce?: boolean } = {}): void {
    const composing = options.composing === true;
    const allowCoalesce = options.coalesce !== false;
    if (this.composition && this.composition.side !== side) this.composition = null;
    const open = this.composition;
    if (open && !composing && value === this.state.draft[side]) {
      this.composition = null;
      this.activeTypingTx = null;
      return;
    }
    // An editor may report the same text again (a composition end with nothing open, a repeated input event): no step.
    if (!open && value === this.state.draft[side]) return;
    const { draft, reports } = this.state;
    const latest = reports.at(-1) ?? null;
    const sourceDirtyForTranslation = side === 'source' ? Boolean(value.trim() && draft.target.trim()) : false;
    const before = this.state.draft;
    const base = open ? open.base : before;
    const baseInvalidations = open ? open.invalidations : this.state.alignmentInvalidations;
    const nextSource = side === 'source' ? value : draft.source;
    const nextTarget = side === 'target' ? value : draft.target;
    const remap = remapForFreeEdit(base.alignments, side, base.source, base.target, nextSource, nextTarget);
    const next: Draft = { ...draft, [side]: value, alignments: remap.alignments };
    const touched = remap.invalidated.length > 0 || remap.emptiedTargets.length > 0 || remap.fallbackAll;
    const message = alignmentNotice(base.alignments, remap) ?? (latest ? 'editedText' : '');
    const now = this.clock.now();
    const splice = diffSplice(before[side], value);
    const deltaLen = splice ? Math.max(splice.oldEnd - splice.start, splice.newEnd - splice.start) : 0;
    const top = this.state.history.at(-1);
    const typing = this.activeTypingTx;
    const canCoalesce = allowCoalesce && !open && !composing && !touched
      && typing !== null
      && typing.side === side
      && now - typing.at <= TYPING_COALESCE_MS
      && deltaLen <= 1
      && top !== undefined
      && top.serial === typing.serial
      && !top.replacedDocument;
    let history = this.state.history;
    let serial = typing?.serial ?? 0;
    if (!open && !canCoalesce) {
      const pushed = this.pushUndo();
      history = pushed.history;
      serial = pushed.serial;
    }
    this.future = [];
    this.activeTypingTx = allowCoalesce && !composing && !open && !touched && deltaLen <= 1 ? { side, at: now, serial } : null;
    this.docAbort?.abort();
    this.docAbort = null;
    this.docGeneration += 1;
    // Within a composition the semantic state maps from the base in one splice, unless something else replaced it meanwhile.
    const fromBase = open !== null && open.mapped === this.state.semantic;
    const semanticBefore = fromBase ? open.base : before;
    const semanticSplice = fromBase ? diffSplice(open.base[side], value) : splice;
    const splices = {
      source: side === 'source' ? semanticSplice : null,
      target: side === 'target' ? semanticSplice : null,
    };
    const nextSemantic = mapSemanticEdit(fromBase ? open.semantic : this.state.semantic, semanticBefore, next, splices) as SemanticState;
    this.composition = composing
      ? (open ? { ...open, mapped: nextSemantic } : { side, base: before, invalidations: baseInvalidations, semantic: this.state.semantic, mapped: nextSemantic })
      : null;
    this.setState({
      history,
      phase: 'idle',
      translating: false,
      error: null,
      generation: this.docGeneration,
      inFlight: false,
      draft: next,
      semantic: nextSemantic,
      alignmentInvalidations: appendInvalidations(baseInvalidations, remap.invalidated),
      sourceDirtyForTranslation,
      notice: message,
    });
  }

  setDirection(direction: 'en' | 'zh'): void {
    const { draft } = this.state;
    this.edit({ ...draft, direction, alignments: draft.alignments === null ? null : [] }, 'directionChanged');
  }

  recordAlignment(sourceSpan: Span | null, targetSpan: Span | null, omit = false, whole = false): boolean {
    const { draft } = this.state;
    const a = whole ? { start: 0, end: chars(draft.source).length, text: draft.source } : sourceSpan;
    const b = omit ? null : whole ? { start: 0, end: chars(draft.target).length, text: draft.target } : targetSpan;
    if (!a || (!omit && !b)) {
      this.setState({ notice: 'alignmentHint' });
      return false;
    }
    const next = [...(whole ? [] : draft.alignments ?? []), { source: a, target: b }]
      .sort((x, y) => x.source.start - y.source.start);
    if (!validAlignments(next, draft.source, draft.target)) {
      this.setState({ notice: 'alignmentInvalid' });
      return false;
    }
    this.edit({ ...draft, alignments: next }, 'alignmentRecorded');
    return true;
  }

  clearAlignments(): void {
    this.edit({ ...this.state.draft, alignments: [] }, 'alignmentsCleared');
  }

  resetAlignments(): void {
    this.edit({ ...this.state.draft, alignments: null }, 'alignmentsReset');
  }

  removeAlignment(index: number): void {
    const { draft } = this.state;
    if (!draft.alignments) return;
    this.edit({ ...draft, alignments: draft.alignments.filter((_, j) => index !== j) }, 'alignmentRemoved');
  }

  private commit({
    draft: next,
    splices,
    semantic: update,
    notice: code,
    remember: push = true,
    invalidated,
    extraPatch,
  }: {
    draft?: Draft;
    splices?: DraftEditSplices;
    semantic?: (state: SemanticState) => SemanticState;
    notice?: string | null;
    remember?: boolean;
    /** Alignments the draft's edit transaction invalidated, added to the session list. */
    invalidated?: readonly InvalidatedAlignment[];
    extraPatch?: (nextSemantic: SemanticState, serial: number | null) => Partial<WorkbenchSnapshot>;
  }): number | null {
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
      // Any other draft change ends typing coalescing and a composition, and makes the redo steps stale.
      this.activeTypingTx = null;
      this.composition = null;
      this.future = [];
      if (push) {
        this.docAbort?.abort();
        this.docAbort = null;
        this.docGeneration += 1;
        phase = 'idle';
        translating = false;
        error = null;
        generation = this.docGeneration;
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

  // ---- Semantic decision & long-manuscript domain commands ----

  async applySemanticDecision(command: SemanticDecisionCommand): Promise<SemanticDecisionResult> {
    const placed = this.state.semantic.placed.find(item => item.id === command.placedId);
    if (!placed) return { applied: false, reason: 'missing' };
    const result = this.state.semantic.results.find(item => item.id === placed.resultId);
    if (!result) return { applied: false, reason: 'missing' };

    const startDraft = this.state.draft;
    const startEpoch = this.documentEpoch;
    let nextTarget: string | null = null;
    let applied: string | null = null;
    let spliceStart = 0;
    let spliceEnd = 0;

    if (command.kind === 'accepted') {
      if (!placed.issue.suggestion || placed.issue.suggestion_withheld !== null || !placed.live.suggestion_span) {
        return { applied: false, reason: 'invalid' };
      }
      const replacement = command.useAlternative && placed.issue.alternatives[0]
        ? placed.issue.alternatives[0].replacement
        : placed.issue.suggestion.replacement;
      const applied0 = applySemanticSuggestion({
        target: startDraft.target,
        issue: { suggestion: { ...placed.issue.suggestion, target_span: placed.live.suggestion_span }, suggestion_withheld: null },
        offset: 0,
        replacement,
      });
      if (applied0.error || applied0.target === undefined) {
        this.commit({ semantic: x => x, notice: 'sem:needsReconfirm', remember: false });
        return { applied: false, reason: 'needs_reconfirm' };
      }
      spliceStart = placed.live.suggestion_span.start;
      spliceEnd = placed.live.suggestion_span.end;
      nextTarget = applied0.target;
      applied = replacement;
    } else if (command.kind === 'adjusted') {
      const range = placed.live.suggestion_span ?? placed.live.target_span;
      if (!range || !command.text.trim() || chars(command.text).length > 2000 || !sliceEquals(startDraft.target, range)) {
        this.commit({ semantic: x => x, notice: 'sem:needsReconfirm', remember: false });
        return { applied: false, reason: 'needs_reconfirm' };
      }
      const tc = chars(startDraft.target);
      spliceStart = range.start;
      spliceEnd = range.end;
      nextTarget = slice(tc, 0, range.start) + command.text + slice(tc, range.end, tc.length);
      applied = command.text;
    }

    const decision = await makeSemanticDecision({
      issue: placed.issue,
      segmentIndex: placed.issue.segment_index,
      source: result.doc.source,
      target: result.doc.target,
      termBasis: result.report.term_basis,
      decision: command.kind,
      appliedText: applied,
    }) as Decision;

    if (this.disposed || this.documentEpoch !== startEpoch) return { applied: false, reason: 'stale' };
    const nowSnap = this.state;
    if (nowSnap.draft !== startDraft) {
      this.commit({ semantic: x => x, notice: 'sem:needsReconfirm', remember: false });
      return { applied: false, reason: 'needs_reconfirm' };
    }
    const probe = upsertDecision(nowSnap.semantic, decision, placed.id);
    if (!probe) {
      this.commit({ semantic: x => x, notice: 'sem:decisionLimit', remember: false });
      return { applied: false, reason: 'decision_limit' };
    }

    const appliedLen = applied === null ? 0 : chars(applied).length;
    const remap = nextTarget === null
      ? null
      : remapForSplice(startDraft.alignments, 'target', startDraft.source, nextTarget, spliceStart, spliceEnd, appliedLen);
    const nextDraft = nextTarget === null || remap === null
      ? undefined
      : { ...startDraft, target: nextTarget, alignments: remap.alignments };
    let allHandled = false;
    const serial = this.commit({
      draft: nextDraft,
      invalidated: remap?.invalidated,
      ...(nextTarget === null
        ? {}
        : {
            splices: {
              target: {
                start: scalarOffset(spliceStart),
                oldEnd: scalarOffset(spliceEnd),
                newEnd: scalarOffset(spliceStart + appliedLen),
              },
            },
          }),
      semantic: state => (upsertDecision(state, decision, placed.id) as SemanticState) ?? state,
      extraPatch: (nextSemantic, committedSerial) => {
        allHandled = !nextSemantic.placed.some(p => !isHandled((issueStatus(nextSemantic, p) as { status: string }).status) && !p.stale);
        return {
          notice: allHandled ? 'sem:allHandled' : `sem:${command.kind}`,
          lastSemanticAction: committedSerial === null ? null : { placedId: placed.id, marker: committedSerial, kind: command.kind },
        };
      },
    });
    return { applied: true, placedId: placed.id, kind: command.kind, serial, allHandled };
  }

  canUndoSemanticDecision(placedId: string): boolean {
    const placed = this.state.semantic.placed.find(item => item.id === placedId);
    if (!placed) return false;
    const info = issueStatus(this.state.semantic, placed) as { status: string; decision: Decision | null; reference: Decision | null };
    if (!info.decision) return false;
    if (info.decision.decision === 'ignored') return true;
    return this.state.lastSemanticAction?.placedId === placedId && this.canUndoLast(this.state.lastSemanticAction.marker);
  }

  undoSemanticDecision(placedId: string): boolean {
    const placed = this.state.semantic.placed.find(item => item.id === placedId);
    if (!placed) return false;
    const info = issueStatus(this.state.semantic, placed) as { status: string; decision: Decision | null; reference: Decision | null };
    if (!info.decision) return false;
    if (info.decision.decision === 'ignored') {
      const key = occurrenceKey(info.decision);
      this.commit({
        semantic: state => {
          const removed = removeDecision(state, key) as SemanticState;
          return {
            ...removed,
            outcomes: removed.outcomes.filter(o => occurrenceKey(o.decision) !== key),
          };
        },
        notice: 'sem:undone',
        extraPatch: () => ({ lastSemanticAction: null }),
      });
      return true;
    }
    if (this.state.lastSemanticAction?.placedId === placedId && this.canUndoLast(this.state.lastSemanticAction.marker)) {
      this.undo();
      return true;
    }
    return false;
  }

  applyTermOccurrenceAction(action: TermOccurrenceAction): boolean {
    switch (action.type) {
      case 'adopt':
        return this.commitLong(
          state => chooseTerm(state, { index: action.segmentIndex, finding: action.finding, candidate: action.candidate }, this.longCtx()),
          'sem:longChoiceRecorded',
        );
      case 'not_a_term':
        return this.commitLong(
          state => chooseTerm(state, { index: action.segmentIndex, finding: action.finding, candidate: null }, this.longCtx()),
          'sem:longChoiceRecorded',
        );
      case 'replace': {
        if (!action.docTarget) return false;
        const d = this.state.draft;
        const replacement = d.direction === 'en' ? action.candidate.en : action.candidate.zh;
        const out = spliceTargetSpan(d.target, action.docTarget, replacement);
        if (out.error === 'span_mismatch') {
          this.commit({ semantic: x => x, notice: 'sem:longReplaceStale', remember: false });
          return false;
        }
        if (out.target === undefined) return false;
        const remap = remapForSplice(d.alignments, 'target', d.source, out.target, action.docTarget.start, action.docTarget.end,
          chars(replacement).length);
        this.commit({
          draft: { ...d, target: out.target, alignments: remap.alignments },
          invalidated: remap.invalidated,
          splices: {
            target: {
              start: action.docTarget.start,
              oldEnd: action.docTarget.end,
              newEnd: out.span.end,
            },
          },
          notice: 'sem:longTargetReplaced',
        });
        return true;
      }
      case 'reconfirm':
        return this.commitLong(
          state => reconfirmChoice(state, action.at),
          'sem:longChoiceRecorded',
        );
      case 'clear_choice':
        return this.commitLong(state => removeChoice(state, action.at));
    }
  }

  chooseLong(index: number, finding: TermFindingRef, candidate: TermCandidateRef | null): boolean {
    return this.applyTermOccurrenceAction(
      candidate
        ? { type: 'adopt', segmentIndex: index, finding, candidate }
        : { type: 'not_a_term', segmentIndex: index, finding },
    );
  }

  segmentTargetCore(index: number): string | null {
    return inputsOf(this.state.draft).items[index]?.targetCore ?? null;
  }

  reviseSegmentText(index: number, expectedBase: string, nextText: string): { applied: boolean; error?: string } {
    const d = this.state.draft;
    const item = inputsOf(d).items[index];
    if (!item) {
      this.commit({ semantic: x => x, notice: 'sem:longReviseInvalid', remember: false });
      return { applied: false, error: 'core_mismatch' };
    }
    const out = reviseSegmentTarget(d.target, { start: item.range.target_start, end: item.range.target_end }, expectedBase, nextText);
    if (out.target === undefined) {
      if (out.error !== 'noop') this.commit({ semantic: x => x, notice: 'sem:longReviseInvalid', remember: false });
      return { applied: false, error: out.error };
    }
    const remap = remapForSplice(d.alignments, 'target', d.source, out.target, item.range.target_start, item.range.target_end,
      chars(nextText).length);
    this.commit({
      draft: { ...d, target: out.target, alignments: remap.alignments },
      invalidated: remap.invalidated,
      splices: {
        target: {
          start: item.range.target_start,
          oldEnd: item.range.target_end,
          newEnd: scalarOffset(item.range.target_start + chars(nextText).length),
        },
      },
      notice: 'sem:longSegmentRevised',
    });
    return { applied: true };
  }

  toggleSegmentFinished(index: number, finished?: boolean): boolean {
    const currentlyFinished = this.state.semantic.long.progress.completed.includes(index);
    const target = finished ?? !currentlyFinished;
    if (target === currentlyFinished) return false;
    return this.commitLong(state => setFinished(state, index, target));
  }

  restoreTermHistoryEntry(position: number, targetSegmentIndex?: number): boolean {
    const targetIndex = targetSegmentIndex ?? restorableHistory(this.state.semantic.long, this.longCtx())[position];
    if (targetIndex === null || targetIndex === undefined) return false;
    return this.commitLong(
      state => restoreHistoryEntry(state, position, targetIndex, this.longCtx()),
    );
  }

  removeTermHistoryEntry(position: number): boolean {
    return this.commitLong(state => removeHistoryEntry(state, position));
  }

  selectLongSegment(index: number | null): void {
    this.commit({
      semantic: state => ({ ...state, long: setCurrent(state.long, index) }),
      remember: false,
    });
  }

  // ---- Manual paragraph repair commands ----

  splitParagraphs(cuts: ParagraphCut[]): boolean {
    if (cuts.length === 0) return false;
    const d = this.state.draft;
    let next: Draft = { ...d };
    let firstSplice = null;
    for (const cut of cuts) {
      const updated = insertParagraphBreak(next[cut.side], cut.offset);
      if (!updated) return false;
      if (cuts.length === 1) firstSplice = updated.splice;
      next = { ...next, [cut.side]: updated.text };
    }
    this.commit({
      draft: { ...next, alignments: d.alignments === null ? null : [] },
      ...(cuts.length === 1 && firstSplice ? { splices: { [cuts[0].side]: firstSplice } } : {}),
      notice: 'sem:split',
    });
    return true;
  }

  mergeParagraphsAt(side: 'source' | 'target', gapStart: number, gapEnd: number): boolean {
    const d = this.state.draft;
    const merged = mergeParagraphs(d[side], gapStart, gapEnd);
    if (!merged) return false;
    this.commit({
      draft: { ...d, [side]: merged.text, alignments: d.alignments === null ? null : [] },
      ...(merged.splice ? { splices: { [side]: merged.splice } } : {}),
      notice: 'sem:merged',
    });
    return true;
  }

  convertLinesToParagraphs(scope?: { side: 'source' | 'target'; region?: Region }): boolean {
    const d = this.state.draft;
    if (!scope) {
      const s1 = linesToParagraphs(d.source);
      const t1 = linesToParagraphs(d.target);
      if (!s1 && !t1) return false;
      this.commit({
        draft: { ...d, source: s1?.text ?? d.source, target: t1?.text ?? d.target, alignments: d.alignments === null ? null : [] },
        notice: 'sem:lines',
      });
      return true;
    }
    const converted = linesToParagraphs(d[scope.side], scope.region ?? null);
    if (!converted) return false;
    this.commit({
      draft: { ...d, [scope.side]: converted.text, alignments: d.alignments === null ? null : [] },
      notice: 'sem:lines',
    });
    return true;
  }

  choose(finding: Finding, candidate: Candidate | null): void {
    const { draft, choices, imported, reports } = this.state;
    const latest = reports.at(-1) ?? null;
    const sourceCompatible = !!latest?.trusted && latest.source === draft.source && latest.direction === draft.direction;
    if (!sourceCompatible || !latest) return;
    const span = recoverSpan(latest.source, finding.source_span, draft.source);
    if (!span) return;
    const selected = makeChoice({
      source: draft.source, direction: draft.direction, alignments: draft.alignments,
      report: latest.report, finding: { ...finding, source_span: span }, candidate,
    });
    const existing = choices.findIndex(c => {
      const recovered = recoverSpan(c.source, c.source_span, draft.source);
      return !!recovered && mentionId(recovered) === mentionId(span);
    });
    if (existing < 0 && choices.length >= MAX_CHOICES) {
      this.setState({ notice: 'choiceLimit' });
      return;
    }
    const { history } = this.pushUndo();
    this.docAbort?.abort();
    this.docAbort = null;
    this.docGeneration += 1;
    const nextChoices = existing < 0 ? [...choices, selected] : choices.map((c, i) => (i === existing ? selected : c));
    const nextImported = existing < 0 ? imported : imported.filter(c => c !== choices[existing]);
    this.setState({
      history,
      phase: 'idle',
      translating: false,
      error: null,
      generation: this.docGeneration,
      inFlight: false,
      choices: nextChoices,
      imported: nextImported,
      notice: 'choiceStaged',
    });
  }

  removeChoice(index: number): void {
    const { choices, imported } = this.state;
    const targetChoice = choices[index];
    if (!targetChoice) return;
    const { history } = this.pushUndo();
    this.docAbort?.abort();
    this.docAbort = null;
    this.docGeneration += 1;
    this.setState({
      history,
      phase: 'idle',
      translating: false,
      error: null,
      generation: this.docGeneration,
      inFlight: false,
      choices: choices.filter((_, j) => index !== j),
      imported: imported.filter(c => c !== targetChoice),
    });
  }

  private confirmableChoiceTarget(index: number): { finding: Finding; candidate: Candidate | null } | null {
    const { draft, choices, reports } = this.state;
    const choice = choices[index];
    const latest = reports.at(-1) ?? null;
    const sourceCompatible = !!latest?.trusted && latest.source === draft.source && latest.direction === draft.direction;
    if (!choice || !sourceCompatible || !latest || latest.report.truncated) return null;
    const span = recoverSpan(choice.source, choice.source_span, draft.source);
    if (!span) return null;
    const finding = latest.report.findings.find(f => f.id === mentionId(span));
    if (!finding) return null;
    if (choice.choice === 'not_a_term') return { finding, candidate: null };
    const candidate = choice.candidate
      ? finding.candidates.find(c => c.candidate_id === choice.candidate!.candidate_id
          && c.zh === choice.candidate!.zh && c.en === choice.candidate!.en && c.category === choice.candidate!.category) ?? null
      : null;
    return candidate ? { finding, candidate } : null;
  }

  canConfirmChoice(index: number): boolean {
    return this.confirmableChoiceTarget(index) !== null;
  }

  confirmChoice(index: number): boolean {
    const target = this.confirmableChoiceTarget(index);
    if (!target) return false;
    this.choose(target.finding, target.candidate);
    return true;
  }

  isRevisionEligible(finding: Finding, candidate: Candidate): boolean {
    const { draft, reports } = this.state;
    const latest = reports.at(-1) ?? null;
    return !!latest?.trusted && latest.report.rule_version === 'review-v2' && !latest.report.truncated
      && latest.source === draft.source && latest.target === draft.target && latest.direction === draft.direction
      && JSON.stringify(latest.alignments) === JSON.stringify(draft.alignments)
      && finding.target_span === null && validSpan(finding.source_span, draft.source)
      && latest.report.findings.includes(finding) && finding.candidates.includes(candidate);
  }

  private commitTargetSplice(nextTarget: string, spliceStart: number, spliceEnd: number, replacementLength: number): void {
    const { draft, reports } = this.state;
    const latest = reports.at(-1) ?? null;
    const remap = remapForSplice(draft.alignments, 'target', draft.source, nextTarget, spliceStart, spliceEnd, replacementLength);
    const next: Draft = { ...draft, target: nextTarget, alignments: remap.alignments };
    const message = alignmentNotice(draft.alignments, remap) ?? (latest ? 'editedText' : '');
    const { history } = this.pushUndo();
    this.docAbort?.abort();
    this.docAbort = null;
    this.docGeneration += 1;
    const nextSemantic = mapSemanticEdit(this.state.semantic, draft, next, {
      target: {
        start: scalarOffset(spliceStart),
        oldEnd: scalarOffset(spliceEnd),
        newEnd: scalarOffset(spliceStart + replacementLength),
      },
    }) as SemanticState;
    this.setState({
      history,
      phase: 'idle',
      translating: false,
      error: null,
      generation: this.docGeneration,
      inFlight: false,
      draft: next,
      semantic: nextSemantic,
      alignmentInvalidations: appendInvalidations(this.state.alignmentInvalidations, remap.invalidated),
      sourceDirtyForTranslation: false,
      notice: message,
    });
  }

  applyTargetRevision(input: TargetRevisionCommand): TargetRevisionResult {
    const latest = this.state.reports.at(-1) ?? null;
    const isCurrent = this.state.generation === input.generation
      && !this.state.inFlight
      && latest === input.snapshot
      && this.state.draft === input.draft
      && this.state.choices === input.choices
      && this.state.imported === input.imported
      && this.isRevisionEligible(input.finding, input.candidate);
    if (!isCurrent) {
      this.setState({ notice: 'revisionStale' });
      return { status: 'stale' };
    }
    const replacement = input.draft.direction === 'en' ? input.candidate.en : input.candidate.zh;
    const result = spliceOccurrence(this.state.draft.target, input.fragment, input.selected, replacement);
    if (result.error || result.target === undefined || !result.span) {
      return { status: 'invalid', error: result.error };
    }
    const selected = input.selected!;
    this.commitTargetSplice(result.target, selected.start, selected.end, chars(replacement).length);
    return { status: 'applied', target: result.target, span: result.span };
  }

  replaceTerm(finding: Finding, candidate: Candidate): void {
    const { draft, reports } = this.state;
    const latest = reports.at(-1) ?? null;
    const sourceCompatible = !!latest?.trusted && latest.source === draft.source && latest.direction === draft.direction;
    if (!latest || latest.target !== draft.target || !sourceCompatible || !finding.target_span) return;
    const parts = highlightSegments(draft.target, finding.target_span);
    const forms = finding.candidates.flatMap(c => [c.zh, c.en]);
    if (!parts || !forms.includes(finding.target_span.text)) return;
    const replacement = draft.direction === 'en' ? candidate.en : candidate.zh;
    const result = spliceOccurrence(draft.target, finding.target_span.text, finding.target_span, replacement);
    if (result.error === 'revisionTooLong') this.setState({ notice: 'revisionTooLong' });
    if (result.target !== undefined) {
      this.commitTargetSplice(result.target, finding.target_span.start, finding.target_span.end, chars(replacement).length);
    }
  }

  /**
   * Step back one transaction: the draft, choices, semantic state and the session list of invalidated alignments as they were
   * before it, so every alignment it invalidated comes back. The state it leaves becomes a redo step.
   */
  undo(): void {
    this.activeTypingTx = null;
    this.composition = null;
    const last = this.state.history.at(-1) as UndoEntry | undefined;
    if (!last) return;
    const nextHistory = this.state.history.slice(0, -1);
    const notice = last.reports ? 'undoWithReports' : 'undoLocal';
    const clearLastSemantic = this.state.lastSemanticAction?.marker === last.serial;
    const cp = this.state.documentCheckpoint;
    const clearCheckpoint = !!(last.replacedDocument && cp && cp.entry.serial !== undefined && cp.entry.serial === last.serial);
    const { draft, choices, imported, reports, semantic, alignmentInvalidations } = this.state;
    const redoStep: UndoEntry = {
      draft, choices, imported, semantic, serial: last.serial, invalidations: alignmentInvalidations,
      ...(last.replacedDocument ? { reports, replacedDocument: true } : {}),
      ...(clearCheckpoint && cp ? { checkpoint: cp } : {}),
    };
    this.future = [...this.future.slice(-(MAX_UNDO - 1)), redoStep];
    const basePatch: Partial<WorkbenchSnapshot> = {
      draft: last.draft,
      choices: last.choices,
      imported: last.imported,
      history: nextHistory,
      alignmentInvalidations: invalidationsOf(last),
      sourceDirtyForTranslation: false,
      ...(clearCheckpoint ? { documentCheckpoint: null } : {}),
      ...(last.reports ? { reports: last.reports } : {}),
      ...(clearLastSemantic ? { lastSemanticAction: null } : {}),
      notice,
    };
    this.applyStep(basePatch, last);
  }

  /** Redo the last undone step; the state before it goes back on the undo history with the same serial. */
  redo(): boolean {
    this.activeTypingTx = null;
    this.composition = null;
    const step = this.future.at(-1);
    if (!step) return false;
    this.future = this.future.slice(0, -1);
    const { draft, choices, imported, reports, semantic, history, alignmentInvalidations } = this.state;
    const back: UndoEntry = {
      draft, choices, imported, semantic, serial: step.serial, invalidations: alignmentInvalidations,
      ...(step.replacedDocument ? { reports, replacedDocument: true } : {}),
    };
    this.applyStep({
      draft: step.draft,
      choices: step.choices,
      imported: step.imported,
      history: [...history.slice(-(MAX_UNDO - 1)), back],
      alignmentInvalidations: invalidationsOf(step),
      sourceDirtyForTranslation: false,
      ...(step.reports ? { reports: step.reports } : {}),
      ...(step.checkpoint ? { documentCheckpoint: { ...step.checkpoint, entry: back } } : {}),
      notice: 'redoLocal',
    }, step);
    return true;
  }

  private applyStep(patch: Partial<WorkbenchSnapshot>, step: UndoEntry): void {
    if (step.replacedDocument) {
      this.replaceDocumentState(patch, step.semantic);
      return;
    }
    this.docAbort?.abort();
    this.docAbort = null;
    this.docGeneration += 1;
    this.setState({
      ...patch,
      phase: 'idle',
      translating: false,
      error: null,
      generation: this.docGeneration,
      inFlight: false,
      semantic: step.semantic,
    });
  }

  restoreDocumentCheckpoint(): boolean {
    const cp = this.state.documentCheckpoint;
    if (!cp) return false;
    const { history } = this.pushDocumentUndo();
    const restored = cp.entry;
    this.replaceDocumentState({
      draft: restored.draft,
      choices: restored.choices,
      imported: restored.imported,
      ...(restored.reports ? { reports: restored.reports } : {}),
      alignmentInvalidations: invalidationsOf(restored),
      history,
      documentCheckpoint: null,
      importedCanonical: null,
      sourceDirtyForTranslation: false,
      notice: 'restoredCheckpoint',
    }, restored.semantic);
    return true;
  }

  replaceWithText(text: string, notice: NoticeState = 'importedSourceText'): void {
    const { history: nextHistory, checkpoint } = this.pushDocumentUndo('replace');
    const textDraft: Draft = { source: text, target: '', direction: this.state.draft.direction, alignments: null };
    this.replaceDocumentState({
      draft: textDraft,
      choices: [],
      imported: [],
      reports: [],
      history: nextHistory,
      documentCheckpoint: checkpoint,
      importedCanonical: null,
      sourceDirtyForTranslation: false,
      notice,
    }, freshSemantic(textDraft) as SemanticState);
  }

  replaceWithWorkfile(pending: PendingWorkfile): void {
    const { history: nextHistory, checkpoint } = this.pushDocumentUndo('import');
    this.replaceDocumentState({
      draft: pending.draft,
      choices: pending.choices,
      imported: pending.choices,
      reports: pending.reports,
      history: nextHistory,
      documentCheckpoint: checkpoint,
      sourceDirtyForTranslation: false,
      importedCanonical: pending.importedBody,
      notice: 'imported',
      workspaceMode: 'manuscript',
    }, pending.semantic);
  }

  clearDraft(): boolean {
    const { draft, choices, reports, semantic } = this.state;
    if (!workPresent(draft, choices, reports, semantic)) return false;
    const { history: nextHistory, checkpoint } = this.pushDocumentUndo('clear');
    this.replaceDocumentState({
      draft: EMPTY_DRAFT,
      choices: [],
      imported: [],
      reports: [],
      history: nextHistory,
      documentCheckpoint: checkpoint,
      sourceDirtyForTranslation: false,
      notice: 'clearedDraft',
    }, emptySemantic() as SemanticState);
    return true;
  }

  // ---- Import / Save / Export ----

  /** Whether replacing the document now would drop work no recoverable manuscript holds (the leave guard's rule). */
  replacementNeedsConfirm(): boolean {
    return this.shouldConfirmImport();
  }

  private shouldConfirmImport(): boolean {
    const { draft, choices, reports, semantic, basis, importedCanonical, downloadedCanonical } = this.state;
    const canonical = canonicalOf(draft, choices, reports, semantic, basis);
    const holdsWork = workPresent(draft, choices, reports, semantic);
    const saveView = manuscriptSaveView({ holdsWork, canonical, importedCanonical, downloadedCanonical });
    return leaveGuardActive({ view: saveView });
  }

  async importFile(file?: ImportFileLike): Promise<ImportOutcome> {
    if (!file) return { status: 'ignored' };
    const attempt = ++this.importAttempt;
    const curr = this.state.error;
    if (curr && (curr.code === 'importInvalid' || curr.code === 'importReportExport' || curr.code?.startsWith('workfile_'))) {
      this.setState({ error: null });
    }
    if (file.size > (/\.(txt|md)$/iu.test(file.name) ? MAX_WORKFILE_BYTES : MAX_V3_WORKFILE_BYTES)) {
      if (!this.disposed && this.importAttempt === attempt) this.setState({ error: { code: 'workfile_too_large' } });
      return { status: 'error' };
    }
    const mine = this.docGeneration;
    try {
      const bytes = await file.arrayBuffer();
      if (this.disposed || this.importAttempt !== attempt) return { status: 'ignored' };
      if (this.docGeneration !== mine) {
        this.setState({ notice: 'importChangedDuringRead' });
        return { status: 'ignored' };
      }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (/\.(txt|md)$/iu.test(file.name)) {
        if (isMarkdownReportExport(text)) {
          this.setState({ error: { code: 'importReportExport' } });
          return { status: 'error' };
        }
        if (this.shouldConfirmImport()) {
          return { status: 'needs_confirm_text', pendingText: text };
        }
        this.replaceWithText(text);
        return { status: 'imported' };
      }
      let value;
      try {
        value = parseWorkfile(text);
      } catch (cause) {
        if ((cause as { code?: unknown } | null)?.code === 'workfile_unsupported_format'
          && /^\s*\{\s*"format"\s*:\s*"wuwaterm-result-v2"/u.test(text.slice(0, 256))) {
          this.setState({ error: { code: 'importReportExport' } });
          return { status: 'error' };
        }
        throw cause;
      }
      const nextDraft: Draft = { source: value.source, target: value.target, direction: value.direction, alignments: value.alignments };
      const nextChoices = value.choices;
      const nextReports: Snapshot[] = value.history.map((s: Draft & { report: Report; resolutions?: Resolution[] }) => ({
        ...s, resolutions: s.resolutions ?? null, trusted: false, signature: '',
      }));
      const withSemantic = value.format === WORKFILE_FORMAT_V2 || value.format === WORKFILE_FORMAT_V3 || value.format === WORKFILE_FORMAT_V4
        || value.format === WORKFILE_FORMAT_V5;
      const nextSemantic: SemanticState = {
        ...(withSemantic ? await semanticFromWorkfile(value) : emptySemantic() as SemanticState),
        long: longFromWorkfile(value),
      };
      if (this.disposed || this.importAttempt !== attempt) return { status: 'ignored' };
      if (this.docGeneration !== mine) {
        this.setState({ notice: 'importChangedDuringRead' });
        return { status: 'ignored' };
      }
      const importedBody = canonicalOf(nextDraft, nextChoices, nextReports, nextSemantic, null);
      const pendingWorkfile: PendingWorkfile = {
        draft: nextDraft,
        choices: nextChoices,
        reports: nextReports,
        semantic: nextSemantic,
        importedBody,
      };
      if (this.shouldConfirmImport()) {
        return { status: 'needs_confirm_workfile', pendingWorkfile };
      }
      this.replaceWithWorkfile(pendingWorkfile);
      return { status: 'imported' };
    } catch (cause) {
      if (!this.disposed && this.importAttempt === attempt && this.docGeneration === mine) {
        this.setState({ error: errorFrom(cause, 'importInvalid') });
      }
      return { status: 'error' };
    }
  }

  save(): ExportArtifact | null {
    const { draft, choices, reports, semantic, basis } = this.state;
    try {
      const content = serializeWorkfile(manuscriptBody(draft, choices, reports, semantic, basis));
      this.activeTypingTx = null;
      this.setState({ downloadedCanonical: content, error: null, notice: 'saved' });
      return { filename: 'wuwaterm-manuscript.json', content, mimeType: 'application/json' };
    } catch (cause) {
      const parsed = errorFrom(cause, 'saveFailed');
      this.setState({
        error: parsed?.code === 'workfile_duplicate_choices' ? { ...parsed, saveConflict: true } : parsed,
      });
      return null;
    }
  }

  resolveConflictingChoicesAndSave(): ExportArtifact | null {
    const { draft, choices, reports, semantic, basis } = this.state;
    const cleaned = sanitizeDuplicateChoices({
      source: draft.source,
      direction: draft.direction,
      choices,
      semantic_decisions: semantic.decisions,
      segments: semantic.long.records,
    });
    if (cleaned.dropped <= 0) {
      return this.save();
    }
    const { history } = this.pushUndo();
    const nextSemantic: SemanticState = {
      ...semantic,
      decisions: cleaned.semantic_decisions,
      long: { ...semantic.long, records: cleaned.segments },
    };
    this.docAbort?.abort();
    this.docAbort = null;
    this.docGeneration += 1;
    try {
      const content = serializeWorkfile(manuscriptBody(draft, cleaned.choices, reports, nextSemantic, basis));
      this.setState({
        history,
        phase: 'idle',
        translating: false,
        inFlight: false,
        generation: this.docGeneration,
        choices: cleaned.choices,
        imported: this.state.imported.filter(c => cleaned.choices.includes(c)),
        semantic: nextSemantic,
        downloadedCanonical: content,
        error: null,
        notice: 'resolvedConflictsSaved',
      });
      return { filename: 'wuwaterm-manuscript.json', content, mimeType: 'application/json' };
    } catch (cause) {
      const parsed = errorFrom(cause, 'saveFailed');
      this.setState({
        history,
        phase: 'idle',
        translating: false,
        inFlight: false,
        generation: this.docGeneration,
        choices: cleaned.choices,
        imported: this.state.imported.filter(c => cleaned.choices.includes(c)),
        semantic: nextSemantic,
        error: parsed?.code === 'workfile_duplicate_choices' ? { ...parsed, saveConflict: true } : parsed,
      });
      return null;
    }
  }

  exportProseTxt(): ExportArtifact {
    const { source, target } = this.state.draft;
    const content = target ? `${source}\n\n---\n\n${target}` : source;
    this.setState({ notice: 'exportProseTxt' });
    return { filename: 'wuwaterm-prose.txt', content, mimeType: 'text/plain;charset=utf-8' };
  }

  exportTxt(): ExportArtifact {
    this.setState({ notice: 'exportTxt' });
    return { filename: 'wuwaterm-translation.txt', content: this.state.draft.target, mimeType: 'text/plain;charset=utf-8' };
  }

  private longResultsCurrent(): boolean {
    const { draft, semantic } = this.state;
    const ctx = this.longCtx();
    const { long, items } = inputsOf(draft);
    return long && items.length > 0 && items.every((item, i) => item.pair.status === 'ready'
      && viewOf(semantic.long, i, ctx)?.state === 'current');
  }

  exportResult(): ExportArtifact {
    const { draft, choices, imported, reports, semantic, basis, phase } = this.state;
    const latest = reports.at(-1) ?? null;
    const previous = reports.at(-2) ?? null;
    const reconciled = reconcileChoices(choices, draft, latest, imported);
    const ready = reconciled.flatMap(item => (item.resolution ? [item.resolution] : []));
    const current = !!latest?.trusted && latest.signature === documentSignature(draft, ready) && phase === 'success';
    const comparison = latest && previous ? compareReports(previous, latest) : null;
    const strip = (items: { label: string; reason: string }[]) => items.map(({ label, reason }) => ({ label, reason }));
    const long = inputsOf(draft).long;
    const resultCurrent = long ? this.longResultsCurrent() : current;
    const content = JSON.stringify({
      format: 'wuwaterm-result-v2',
      ...draft,
      status: resultCurrent ? 'current_terminology_check' : 'requires_recheck',
      sentence_meaning_evaluated: false,
      report: latest && !long ? cleanSnapshot(latest) : null,
      report_is_current: resultCurrent,
      choices: choices.map((choice, i) => ({ ...choice, status: reconciled[i].status, reason: reconciled[i].reason })),
      changes: current && comparison ? {
        new: strip(comparison.new), resolved: strip(comparison.resolved),
        pending: strip(comparison.pending), incomparable: strip(comparison.incomparable),
      } : null,
      verified_stamp: { valid: false },
      ...semanticExport(draft, semantic, basis, this.reviewFeatures()).result,
    }, null, 2);
    this.setState({ notice: resultCurrent ? 'exportCurrent' : 'exportStale' });
    return { filename: 'wuwaterm-result.json', content, mimeType: 'application/json' };
  }

  exportMarkdown(lang: UiLanguage = this.state.lang): ExportArtifact {
    const { draft, choices, imported, reports, semantic, basis, phase } = this.state;
    const latest = reports.at(-1) ?? null;
    const previous = reports.at(-2) ?? null;
    const reconciled = reconcileChoices(choices, draft, latest, imported);
    const ready = reconciled.flatMap(item => (item.resolution ? [item.resolution] : []));
    const current = !!latest?.trusted && latest.signature === documentSignature(draft, ready) && phase === 'success';
    const comparison = latest && previous ? compareReports(previous, latest) : null;
    const long = inputsOf(draft).long;
    const parts = semanticExport(draft, semantic, basis, this.reviewFeatures());
    const currency: MarkdownCurrency = long
      ? (!parts.segmentTerms?.length ? 'none' : this.longResultsCurrent() ? 'current' : 'stale')
      : !latest ? 'none' : current ? 'current' : latest.trusted ? 'stale' : 'imported';
    const strip = (snapshot: Snapshot) => ({
      source: snapshot.source, target: snapshot.target, direction: snapshot.direction,
      report: snapshot.report, resolutions: snapshot.resolutions,
    });
    const content = renderMarkdownReport({
      draft: { source: draft.source, target: draft.target, direction: draft.direction },
      latest: latest && !long ? strip(latest) : null,
      previous: previous && !long ? strip(previous) : null,
      currency,
      choices,
      reconciled,
      comparison: long ? null : comparison,
      semantic: parts.markdown,
      segmentTerms: parts.segmentTerms,
    }, lang);
    this.setState({ notice: 'exportMarkdown' });
    return { filename: 'wuwaterm-report.md', content, mimeType: 'text/markdown;charset=utf-8' };
  }

  // ---- Document-level requests (/api/reviews, /api/translations) ----

  async check(withChoices = true, options: { reviewsClosed?: boolean } = {}): Promise<void> {
    const { draft, choices, imported, reports } = this.state;
    const { source, target, direction, alignments } = draft;
    const validInput = !!source.trim() && !!target.trim() && chars(source).length <= 2000 && chars(target).length <= 2000;
    if (!validInput || options.reviewsClosed) return;

    const latest = reports.at(-1) ?? null;
    const reconciled = reconcileChoices(choices, draft, latest, imported);
    const ready = reconciled.flatMap(item => (item.resolution ? [item.resolution] : []));

    this.discardInFlight();
    const mine = this.docGeneration;
    const abort = new AbortController();
    this.docAbort = abort;
    const resolutions = withChoices ? ready : [];
    const submitted = draft;
    const submittedSignature = documentSignature(submitted, resolutions);
    this.setState({ phase: 'loading', notice: null, inFlight: true });

    const body = {
      source, target, direction, review_version: 'review-v2',
      ...(alignments === null ? {} : { alignments }),
      ...(resolutions.length && latest ? {
        resolutions,
        resolution_context: {
          source_revision: latest.report.source_revision,
          rule_version: latest.report.rule_version,
          dictionary_revision: latest.report.dictionary.revision,
          matcher_revision: latest.report.matcher_revision,
        },
      } : {}),
    };
    if (new TextEncoder().encode(JSON.stringify(body)).length > REVIEW_REQUEST_LIMIT) {
      if (this.docAbort === abort) this.docAbort = null;
      this.setState({ phase: 'error', error: { code: 'bodyTooLarge' }, inFlight: false });
      return;
    }

    try {
      // Capabilities still loading: wait for them, so the review asks for exactly the session's features. Otherwise send now.
      const features = this.state.capabilities === null && this.capabilitiesPromise ? await this.requestFeatures() : this.reviewFeatures() ?? [];
      if (this.disposed || abort.signal.aborted || this.docGeneration !== mine) return;
      const { response, value } = await this.post('/api/reviews', body, { signal: abort.signal, reviewFeatures: features.length ? features : true });
      if (this.disposed || abort.signal.aborted || this.docGeneration !== mine) return;
      if (!response.ok) {
        const reason = value && typeof value === 'object' && 'reason' in value && typeof value.reason === 'string' ? value.reason : '';
        throw Object.assign(new Error(), { gahReason: reason, gahDetail: failureFields(response, value) });
      }
      if (!validReport(value, source, target, features.includes(REVIEW_FEATURE_AMBIGUOUS_MENTION) ? REPORT_V5 : REPORT_V4)) {
        throw Object.assign(new Error(), { gahCode: 'responseInvalid' });
      }
      const report = value as Report;
      if (report.rule_version !== 'review-v2'
        || !/^[0-9a-f]{64}$/u.test(report.matcher_revision ?? '')
        || report.source_revision !== await revisionOf(source)
        || report.target_revision !== await revisionOf(target)) {
        throw Object.assign(new Error(), { gahCode: 'responseBasisMismatch' });
      }
      if (this.disposed || abort.signal.aborted || this.docGeneration !== mine) return;
      const snapshot: Snapshot = { ...submitted, report, trusted: true, signature: submittedSignature, resolutions };
      this.setState({
        reports: [...this.state.reports.slice(-1), snapshot],
        phase: 'success',
        notice: 'checked',
        inFlight: false,
      });
      this.onPoolRefresh();
    } catch (cause) {
      if (!this.disposed && !abort.signal.aborted && this.docGeneration === mine) {
        const nextError: ErrorState = cause instanceof Error && 'gahReason' in cause
          ? { reason: String((cause as Error & { gahReason?: unknown }).gahReason), kind: 'review', ...detailOf(cause) }
          : cause instanceof Error && 'gahCode' in cause
            ? { code: String((cause as Error & { gahCode?: unknown }).gahCode) }
            : { code: 'requestFailed' };
        this.setState({ phase: 'error', error: nextError, inFlight: false });
        this.onPoolRefresh();
      }
    } finally {
      if (this.docAbort === abort) this.docAbort = null;
    }
  }

  async translateInReview(options: { translationClosed?: boolean } = {}): Promise<void> {
    const { draft, phase, translating } = this.state;
    const { source, direction, alignments } = draft;
    if (!source.trim() || chars(source).length > 2000 || phase === 'loading' || translating || options.translationClosed) return;

    this.discardInFlight();
    const mine = this.docGeneration;
    const abort = new AbortController();
    this.docAbort = abort;
    this.setState({ translating: true, notice: null, inFlight: true });
    const startedAt = this.clock.now();

    // Quick mode with automatic direction sends no target language and adopts the direction the service reports.
    const auto = this.state.workspaceMode === 'quick' && this.state.autoDirection;
    try {
      const known = this.state.capabilities ?? await (this.capabilitiesPromise ?? Promise.resolve([]));
      if (this.disposed || abort.signal.aborted || this.docGeneration !== mine) return;
      const context = known.includes(CAPABILITY_TRANSLATION_CONTEXT) ? { context: {} } : {};
      const body = auto ? { text: source, ...context } : { text: source, to: direction, ...context };
      const { response, value } = await this.post('/api/translations', body, { signal: abort.signal });
      if (this.disposed || abort.signal.aborted || this.docGeneration !== mine) return;
      if (!response.ok || !value || typeof value !== 'object' || typeof (value as { text?: unknown }).text !== 'string') {
        const reason = value && typeof value === 'object' && 'reason' in value && typeof (value as { reason?: unknown }).reason === 'string'
          ? String((value as { reason: string }).reason) : '';
        throw Object.assign(new Error(), { gahReason: reason, gahDetail: failureFields(response, value) });
      }
      const reply = value as { text: string; kind?: unknown; direction?: unknown; dictionary_miss?: unknown; request_id?: unknown };
      const translated = reply.text;
      const replied = reply.direction === 'en' || reply.direction === 'zh' ? reply.direction : null;
      const before = this.state.draft;
      const nextDirection = auto && replied ? replied : before.direction;
      const { history } = this.pushUndo();
      // The translation and a detected direction form one undo step; a new target leaves no explicit alignment confirmed.
      const translatedDraft: Draft = { ...before, target: translated, direction: nextDirection, alignments: alignments === null ? null : [] };
      const nextSemantic = mapSemanticEdit(this.state.semantic, before, translatedDraft) as SemanticState;
      const kind = reply.kind === 'noop' || reply.kind === 'exact' || reply.kind === 'fuzzy' || reply.kind === 'llm' ? reply.kind : null;
      this.setState({
        history,
        draft: translatedDraft,
        semantic: nextSemantic,
        translating: false,
        inFlight: false,
        sourceDirtyForTranslation: false,
        // Quick mode shows the translation itself; the review hint belongs to manuscript mode.
        notice: alignments !== null ? 'editedAlignments' : this.state.workspaceMode === 'quick' ? null : 'translatedInReview',
        lastTranslation: {
          source, text: translated, kind, direction: nextDirection,
          dictionaryMiss: reply.dictionary_miss === true,
          requestId: typeof reply.request_id === 'string' && reply.request_id ? reply.request_id : null,
        },
      });
      this.onPoolRefresh();
    } catch (cause) {
      if (!this.disposed && !abort.signal.aborted && this.docGeneration === mine) {
        const nextError: ErrorState = cause instanceof Error && 'gahReason' in cause
          ? { reason: String((cause as Error & { gahReason?: unknown }).gahReason), kind: 'translation', ...detailOf(cause),
            waitedSeconds: Math.max(0, Math.round((this.clock.now() - startedAt) / 1000)) }
          : { code: 'requestFailed' };
        this.setState({ translating: false, inFlight: false, error: nextError });
        this.onPoolRefresh();
      }
    } finally {
      if (this.docAbort === abort) this.docAbort = null;
    }
  }

  // ---- Serial run engine (term, semantic, translate) ----

  private clearWaitTimers(): void {
    if (this.waitTimeout !== null) {
      this.clock.clearTimeout(this.waitTimeout);
      this.waitTimeout = null;
    }
    if (this.waitInterval !== null) {
      this.clock.clearInterval(this.waitInterval);
      this.waitInterval = null;
    }
    this.waitTarget = null;
  }

  private syncWaitTimer(): void {
    const { run } = this.state;
    if (this.disposed || run.phase !== 'waiting' || run.waitUntil === null) {
      this.clearWaitTimers();
      return;
    }
    const target = run.waitUntil;
    if (this.waitTarget === target && (this.waitInterval !== null || this.waitTimeout !== null)) return;
    this.clearWaitTimers();
    this.waitTarget = target;

    const tick = () => {
      if (this.disposed) { this.clearWaitTimers(); return; }
      const currentNow = this.clock.now();
      const currentRun = this.state.run;
      if (currentRun.phase !== 'waiting' || currentRun.waitUntil === null) {
        this.clearWaitTimers();
        return;
      }
      if (currentNow >= currentRun.waitUntil) {
        this.clearWaitTimers();
        this.setState({ now: currentNow });
        this.dispatchRun({ type: 'resume' });
      } else {
        this.setState({ now: currentNow });
      }
    };

    const remaining = target - this.clock.now();
    if (remaining <= 0) {
      this.waitTimeout = this.clock.setTimeout(tick, 0);
      return;
    }
    this.waitInterval = this.clock.setInterval(tick, 1000);
    this.waitTimeout = this.clock.setTimeout(tick, remaining);
  }

  dispatchRun(event: Record<string, unknown>): void {
    if (this.disposed) return;
    if (event.type === 'reset') {
      this.resetRun();
      return;
    }
    const nextRun = runReducer(this.state.run, event) as RunState;
    this.setState({ run: nextRun });
    this.syncWaitTimer();
    this.pumpRun();
  }

  private failRun(event: Record<string, unknown> & { now: number }): void {
    if (this.disposed) return;
    const nextRun = runReducer(this.state.run, event) as RunState;
    this.setState({ now: event.now, run: nextRun });
    this.syncWaitTimer();
    this.pumpRun();
  }

  private startBatch(kind: RunKind, items: { key: string; index: number }[]): void {
    if (this.disposed) return;
    this.clearWaitTimers();
    this.runGeneration += 1;
    this.runAbort?.abort();
    this.runAbort = null;
    this.inflight = null;
    const nextRun = runReducer(this.state.run, { type: 'start', kind, items }) as RunState;
    this.setState({ run: nextRun });
    this.syncWaitTimer();
    this.pumpRun();
  }

  pauseRun(): void {
    this.dispatchRun({ type: 'pause' });
  }

  resumeRun(): void {
    this.dispatchRun({ type: 'resume' });
  }

  retryRunItem(key: string): void {
    this.dispatchRun({ type: 'retry', key });
  }

  retryFailedRunItems(): void {
    const failedKeys = this.state.run.items.filter(i => i.status === 'failed').map(i => i.key);
    for (const key of failedKeys) this.dispatchRun({ type: 'retry', key });
  }

  resetRun(): void {
    this.abortRunInternal();
    this.setState({ run: initialRun() as RunState });
  }

  stopRun(): void {
    this.resetRun();
  }

  private pumpRun(): void {
    if (this.disposed || this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        if (this.disposed) return;
        const item = nextToSend(this.state.run, this.inflight) as RunItem | null;
        if (!item || !this.state.run.kind) return;
        const kind = this.state.run.kind;
        this.inflight = { key: item.key, attempt: (item.attempt ?? 0) + 1 };
        const sentRun = runReducer(this.state.run, { type: 'sent', key: item.key }) as RunState;
        this.setState({ run: sentRun });
        const abortController = new AbortController();
        this.runAbort = abortController;
        const currentGeneration = this.runGeneration;
        const currentEpoch = this.documentEpoch;
        void this.executeRunItem(kind, item, abortController.signal, currentGeneration, currentEpoch)
          .catch(() => {
            if (!this.disposed && this.runGeneration === currentGeneration && this.documentEpoch === currentEpoch) {
              this.failRun({ type: 'failed', key: item.key, code: 'requestFailed', classification: { action: 'stop' }, now: this.clock.now() });
            }
          })
          .finally(() => {
            if (this.runAbort === abortController) this.runAbort = null;
          });
      }
    } finally {
      this.pumping = false;
    }
  }

  private executeRunItem(kind: RunKind, item: RunItem, signal: AbortSignal, generation: number, epoch: number): Promise<void> {
    if (kind === 'term') return this.sendTerm(item, signal, generation, epoch);
    if (kind === 'translate') return this.sendTranslate(item, signal, generation, epoch);
    return this.sendSemantic(item, signal, generation, epoch);
  }

  private viewsFor() {
    const { draft, semantic, basis } = this.state;
    return {
      draft,
      ...(semanticSegmentViews(draft, semantic, basis, this.reviewFeatures()) as { long: boolean; pairs: Pair[]; items: PairView[] }),
    };
  }

  private precedentItems(d: Draft, state: SemanticState) {
    const items: { span: Span; choice: string; rendering: string | null }[] = [];
    for (const c of this.state.choices) {
      const span = recoverSpan(c.source, c.source_span, d.source);
      if (!span) continue;
      items.push({
        span,
        choice: c.choice,
        rendering: c.choice === 'not_a_term' ? null : c.candidate ? (d.direction === 'en' ? c.candidate.en : c.candidate.zh) : null,
      });
    }
    for (const p of state.placed) {
      const decided = decisionFor(state, p) as Decision | null;
      if (!decided || decided.decision === 'ignored' || !p.live.source_span || !decided.applied_text) continue;
      items.push({ span: p.live.source_span, choice: 'user_rendering', rendering: decided.applied_text });
    }
    return items;
  }

  private async placeSemantic(
    sentDoc: Draft, pair: Pair, sentSource: string, sentTarget: string,
    report: SemanticReport, key: string, canApply: () => boolean,
  ): Promise<boolean> {
    const [sourceRevision, targetRevision] = await Promise.all([revisionOf(sentDoc.source), revisionOf(sentDoc.target)]);
    if (!canApply()) return false;
    const current = this.state.draft;
    const placement = placeSemanticResult({
      id: this.uid(), sentDoc, current, pair, sentSource, sentTarget, report, key, sourceRevision, targetRevision,
    });
    if (!placement || !canApply()) return false;
    this.applySemantic(state => addSegmentResult(state, placement.result, placement.placed, [
      { revision: sourceRevision, text: sentDoc.source },
      { revision: targetRevision, text: sentDoc.target },
    ]) as SemanticState);
    return true;
  }

  private async sendSemantic(item: RunItem, signal: AbortSignal, generation: number, epoch: number): Promise<void> {
    const sentBasis = this.state.basis;
    const live = () => !this.disposed && this.runGeneration === generation && this.documentEpoch === epoch && !signal.aborted;
    const { draft: d, pairs: list, items } = this.viewsFor();
    const found = items.find(v => v.itemKey === item.key && v.pair.status === 'ready');
    if (!found) { this.dispatchRun({ type: 'skip', key: item.key }); return; }
    const precedents = this.state.usePrecedents
      ? selectPrecedents({ items: this.precedentItems(d, this.state.semantic), source: d.source, pairs: list, segmentIndex: found.pair.index })
      : [];
    const before = contextBefore({ pairs: list, segmentIndex: found.pair.index, source: d.source, target: d.target });
    const fitted = fitRequestBody({
      source: found.sCore, target: found.tCore, direction: d.direction,
      review_version: SEMANTIC_REVIEW_VERSION, explain_language: this.state.lang,
      ...(before ? { context: { before } } : {}),
      ...(precedents.length ? { precedents } : {}),
    });
    if (!fitted.fits) {
      this.failRun({ type: 'failed', key: item.key, code: 'bodyTooLarge', classification: { action: 'segment_failed' }, now: this.clock.now() });
      return;
    }
    try {
      const { response, value } = await this.post('/api/semantic-reviews', fitted.body, { signal, allowInvalidJson: true });
      const body = value && typeof value === 'object' ? value as Record<string, unknown> : null;
      if (!live()) return;
      this.onPoolRefresh();
      if (!response.ok) {
        this.failRun({ type: 'failed', key: item.key, ...runFailure(response, body), now: this.clock.now() });
        return;
      }
      const valid = validSemanticReviewResponse(body, found.sCore, found.tCore)
        && await verifySemanticReviewIdentity(body, found.sCore, found.tCore);
      if (!live()) return;
      if (!valid) {
        this.failRun({ type: 'failed', key: item.key, code: 'responseInvalid', classification: { action: 'segment_failed' }, now: this.clock.now() });
        return;
      }
      const report = body as unknown as SemanticReport;
      if (report.status === 'not_reviewed') {
        this.failRun({ type: 'failed', key: item.key, code: 'not_reviewed', classification: { action: 'segment_failed' }, now: this.clock.now() });
        return;
      }
      const ok = await this.placeSemantic(
        d, found.pair, found.sCore, found.tCore, report, found.key,
        () => live() && (this.state.basis === sentBasis || sameV3Basis(this.state.basis, sentBasis)),
      );
      if (!live()) return;
      this.dispatchRun(ok ? { type: 'done', key: item.key } : { type: 'skip', key: item.key });
    } catch {
      if (live() && !signal.aborted) {
        this.failRun({ type: 'failed', key: item.key, code: 'requestFailed', classification: { action: 'segment_failed' }, now: this.clock.now() });
      }
    }
  }

  /**
   * Long-mode term check of one segment (SPEC "Runtime", steps 4 to 9).
   * Applies the result directly against controller state, updates session basis
   * atomically, and extends the run with newly due segments when the live basis differs.
   */
  private async sendTerm(item: RunItem, signal: AbortSignal, generation: number, epoch: number): Promise<void> {
    const live = () => !this.disposed && this.runGeneration === generation && this.documentEpoch === epoch && !signal.aborted;
    const fail = (code: string) => this.failRun({ type: 'failed', key: item.key, code, classification: { action: 'segment_failed' }, now: this.clock.now() });
    const [, , sourceHash, targetHash] = item.key.split(':');
    const locateItem = () => {
      const { items } = inputsOf(this.state.draft);
      const same = (x: SegmentInput | undefined) => !!x && x.sourceHash === sourceHash && x.targetHash === targetHash;
      return same(items[item.index]) ? item.index : items.findIndex(same);
    };
    if (this.state.capabilities === null && this.capabilitiesPromise) {
      await this.requestFeatures();
      if (!live()) return;
    }
    let at = locateItem();
    let ctx: LongCtx = this.longCtx();
    const first = at < 0 ? null : viewOf(this.state.semantic.long, at, ctx);
    if (!first || !first.ready) { this.dispatchRun({ type: 'skip', key: item.key }); return; }
    if (ctx.basis !== null && !first.needsCheck) { this.dispatchRun({ type: 'done', key: item.key }); return; }
    let withResolutions = recheckPlan(this.state.semantic.long, at, ctx) === 'with_resolutions';
    let sent = 0;
    for (;;) {
      const request = segmentRequest(this.state.semantic.long, at, ctx, { withResolutions });
      if (!request) { this.dispatchRun({ type: 'skip', key: item.key }); return; }
      if (new TextEncoder().encode(JSON.stringify(request.body)).length > REVIEW_REQUEST_LIMIT) {
        fail('bodyTooLarge');
        return;
      }
      sent += 1;
      try {
        const features = request.features ?? [];
        const { response, value } = await this.post('/api/reviews', request.body, { signal, reviewFeatures: features.length ? features : true, allowInvalidJson: true });
        const body = value && typeof value === 'object' ? value as Record<string, unknown> : null;
        if (!live()) return;
        this.onPoolRefresh();
        if (!response.ok) {
          const failure = runFailure(response, body);
          if (Object.hasOwn(request.body, 'resolutions') && failure.code === 'invalid_request' && sent < 2) {
            withResolutions = false;
            continue;
          }
          this.failRun({ type: 'failed', key: item.key, ...failure, now: this.clock.now() });
          return;
        }
        if (!validReport(body, request.body.source, request.body.target, features.includes(REVIEW_FEATURE_AMBIGUOUS_MENTION) ? REPORT_V5 : REPORT_V4)
          || body?.rule_version !== 'review-v2') {
          fail('responseInvalid');
          return;
        }
        const before = this.state.basis;
        const result = applyResult(
          this.state.semantic.long,
          this.longCtx(before),
          request,
          body,
        );
        if (result.error === 'response_invalid') { fail('responseBasisMismatch'); return; }
        const nextSemantic = result.long !== this.state.semantic.long
          ? { ...this.state.semantic, long: result.long }
          : this.state.semantic;
        this.setState({ semantic: nextSemantic, basis: result.basis });
        if (!sameV3Basis(before, result.basis)) {
          const nowCtx = this.longCtx(result.basis);
          const { items } = inputsOf(nowCtx.draft);
          const due = this.state.semantic.long.records.flatMap((_, i) =>
            (viewOf(this.state.semantic.long, i, nowCtx)?.needsCheck ? [{ key: termSegmentKey(i, items[i]), index: i }] : []),
          );
          if (due.length) this.dispatchRun({ type: 'extend', items: due });
        }
        if (result.error === 'segment_changed') { this.dispatchRun({ type: 'skip', key: item.key }); return; }
        if (result.error) { fail(result.error === 'no_basis' ? 'responseBasisMissing' : 'responseInvalid'); return; }
        if (result.secondRequest && sent < 2) {
          at = locateItem();
          if (at < 0) { this.dispatchRun({ type: 'skip', key: item.key }); return; }
          ctx = this.longCtx(result.basis);
          withResolutions = true;
          continue;
        }
        this.dispatchRun({ type: 'done', key: item.key });
        return;
      } catch {
        if (live() && !signal.aborted) fail('requestFailed');
        return;
      }
    }
  }

  private resumablePartialPrefix(d: Draft) {
    if (d.alignments !== null || !d.source.trim() || !d.target.trim()) return null;
    if (segmentText(d.source).length < 2) return null;
    const sc = chars(d.source);
    const tc = chars(d.target);
    const sParas = paragraphRanges(sc);
    const tParas = paragraphRanges(tc);
    if (!(1 <= tParas.length && tParas.length < sParas.length)) return null;
    const prefixCount = tParas.length;
    const tailStart = sParas[prefixCount][0];
    const tailText = slice(sc, tailStart, sc.length);
    const [sPrevCs, sPrevCe] = core(sc, sParas[prefixCount - 1][0], sParas[prefixCount - 1][1]);
    const [tLastCs, tLastCe] = core(tc, tParas[prefixCount - 1][0], tParas[prefixCount - 1][1]);
    const sep = slice(sc, sPrevCe, tailStart) || '\n\n';
    const existingTrail = slice(tc, tLastCe, tc.length);
    const base = existingTrail === sep ? d.target : slice(tc, 0, tLastCe);
    const appendPrefix = existingTrail === sep ? '' : sep;
    const tailSegments = segmentText(tailText);
    if (!tailSegments.length) return null;
    return {
      base,
      appendPrefix,
      tailStart,
      tailSegments,
      initialBefore: {
        source: chars(slice(sc, sPrevCs, sPrevCe)).slice(-400).join(''),
        target: chars(slice(tc, tLastCs, tLastCe)).slice(-400).join(''),
      },
    };
  }

  private buildTranslatePlan(
    d: Draft,
    semanticState: SemanticState = this.state.semantic,
    basis: SessionBasis = this.state.basis,
  ): { plan: TranslateRunPlan; items: { key: string; index: number }[] } | null {
    if (!d.source.trim()) return null;
    if (!d.target.trim()) {
      const segments = segmentText(d.source);
      if (!segments.length) return null;
      const steps: TranslateRunStep[] = segments.map(segment => ({ kind: 'blank', segment }));
      return {
        plan: {
          kind: 'blank',
          source: d.source,
          direction: d.direction,
          steps,
          pieces: [],
          base: '',
          expectedTarget: '',
          appendPrefix: '',
          tailStart: 0,
          initialBefore: null,
        },
        items: steps.map((_, index) => ({ key: `tr#${index}`, index })),
      };
    }
    const views = semanticSegmentViews(d, semanticState, basis, this.reviewFeatures()) as { items: PairView[] };
    const untranslated = views.items.filter(
      v => v.pair.status === 'untranslated' && !!v.sCore.trim() && chars(v.sCore).length <= SEGMENT_LIMIT,
    );
    if (untranslated.length > 0) {
      const steps: TranslateRunStep[] = untranslated.map(v => ({
        kind: 'pair',
        sourceCoreStart: v.pair.source.core_start,
        sourceCoreEnd: v.pair.source.core_end,
      }));
      return {
        plan: {
          kind: 'untranslated_pairs',
          source: d.source,
          direction: d.direction,
          steps,
          pieces: [],
          base: d.target,
          expectedTarget: d.target,
          appendPrefix: '',
          tailStart: 0,
          initialBefore: null,
        },
        items: steps.map((s, index) => ({
          key: `trp#${s.kind === 'pair' ? s.sourceCoreStart : index}:${index}`,
          index,
        })),
      };
    }
    const partial = this.resumablePartialPrefix(d);
    if (!partial) return null;
    const steps: TranslateRunStep[] = partial.tailSegments.map(segment => ({ kind: 'partial_tail', segment }));
    return {
      plan: {
        kind: 'partial_prefix',
        source: d.source,
        direction: d.direction,
        steps,
        pieces: [],
        base: partial.base,
        expectedTarget: d.target,
        appendPrefix: partial.appendPrefix,
        tailStart: partial.tailStart,
        initialBefore: partial.initialBefore,
      },
      items: steps.map((_, index) => ({ key: `trpfx#${index}`, index })),
    };
  }

  hasResumableTranslate(
    d: Draft = this.state.draft,
    semanticState: SemanticState = this.state.semantic,
    basis: SessionBasis = this.state.basis,
  ): boolean {
    if (!d.source.trim() || !d.target.trim()) return false;
    return this.buildTranslatePlan(d, semanticState, basis) !== null;
  }

  private async sendTranslate(item: RunItem, signal: AbortSignal, generation: number, epoch: number): Promise<void> {
    const live = () => !this.disposed && this.runGeneration === generation && this.documentEpoch === epoch && !signal.aborted;
    const inOrder = (failure: ReturnType<typeof runFailure>) => (
      ['wait', 'pause_quota'].includes((failure.classification as { action: string }).action)
        ? failure
        : { ...failure, classification: { action: 'stop' } }
    );
    const plan = this.translateRun;
    const d = this.state.draft;
    if (!plan || d.source !== plan.source || d.direction !== plan.direction || d.target !== plan.expectedTarget) {
      this.failRun({ type: 'failed', key: item.key, code: 'translateTargetChanged', classification: { action: 'stop' }, now: this.clock.now() });
      this.commit({ semantic: x => x, notice: 'sem:translateTargetChanged', remember: false });
      return;
    }
    const step = plan.steps[item.index];
    if (!step) {
      this.dispatchRun({ type: 'skip', key: item.key });
      return;
    }
    const sc = chars(d.source);
    const contextOn = !!this.state.capabilities?.includes(CAPABILITY_TRANSLATION_CONTEXT);
    let coreText = '';
    let contextPayload: Record<string, unknown> = {};
    if (step.kind === 'blank') {
      coreText = slice(sc, step.segment.core_start, step.segment.core_end);
      const prevStep = item.index > 0 ? plan.steps[item.index - 1] : null;
      const prevSeg = prevStep?.kind === 'blank' ? prevStep.segment : null;
      const previousPiece = item.index > 0 ? plan.pieces[item.index - 1] ?? '' : '';
      const before = prevSeg ? {
        source: chars(slice(sc, prevSeg.core_start, prevSeg.core_end)).slice(-400).join(''),
        target: chars(previousPiece.trim()).slice(-400).join(''),
      } : null;
      if (contextOn) contextPayload = { context: before ? { before } : {} };
    } else if (step.kind === 'partial_tail') {
      const tailSc = chars(slice(sc, plan.tailStart, sc.length));
      coreText = slice(tailSc, step.segment.core_start, step.segment.core_end);
      const prevStep = item.index > 0 ? plan.steps[item.index - 1] : null;
      const prevSeg = prevStep?.kind === 'partial_tail' ? prevStep.segment : null;
      const previousPiece = item.index > 0 ? plan.pieces[item.index - 1] ?? '' : '';
      const before = item.index === 0
        ? plan.initialBefore
        : prevSeg
          ? {
              source: chars(slice(tailSc, prevSeg.core_start, prevSeg.core_end)).slice(-400).join(''),
              target: chars(previousPiece.trim()).slice(-400).join(''),
            }
          : null;
      if (contextOn) contextPayload = { context: before ? { before } : {} };
    } else {
      const pairView = this.viewsFor().items.find(
        v => v.pair.status === 'untranslated'
          && v.pair.source.core_start === step.sourceCoreStart
          && v.pair.source.core_end === step.sourceCoreEnd,
      );
      if (!pairView) {
        this.failRun({ type: 'failed', key: item.key, code: 'translateTargetChanged', classification: { action: 'stop' }, now: this.clock.now() });
        this.commit({ semantic: x => x, notice: 'sem:translateTargetChanged', remember: false });
        return;
      }
      coreText = pairView.sCore;
      if (contextOn) {
        const list = inputsOf(d).items.map(entry => entry.pair);
        const before = contextBefore({ pairs: list, segmentIndex: pairView.pair.index, source: d.source, target: d.target });
        const precedents = this.state.usePrecedents
          ? selectPrecedents({ items: this.precedentItems(d, this.state.semantic), source: d.source, pairs: list, segmentIndex: pairView.pair.index })
          : [];
        contextPayload = { context: { ...(before ? { before } : {}), ...(precedents.length ? { precedents } : {}) } };
      }
    }
    const fitted = fitRequestBody({ text: coreText, to: plan.direction, ...contextPayload });
    if (!fitted.fits) {
      this.failRun({ type: 'failed', key: item.key, code: 'bodyTooLarge', classification: { action: 'stop' }, now: this.clock.now() });
      return;
    }
    try {
      const { response, value } = await this.post('/api/translations', fitted.body, { signal, allowInvalidJson: true });
      const body = value && typeof value === 'object' ? value as Record<string, unknown> : null;
      if (!live()) return;
      this.onPoolRefresh();
      if (!response.ok || typeof body?.text !== 'string') {
        this.failRun({
          type: 'failed',
          key: item.key,
          ...(response.ok ? { code: 'responseInvalid', classification: { action: 'stop' } } : inOrder(runFailure(response, body))),
          now: this.clock.now(),
        });
        return;
      }
      const latest = this.state.draft;
      if (latest.source !== plan.source || latest.direction !== plan.direction || latest.target !== plan.expectedTarget) {
        this.failRun({ type: 'failed', key: item.key, code: 'translateTargetChanged', classification: { action: 'stop' }, now: this.clock.now() });
        this.commit({ semantic: x => x, notice: 'sem:translateTargetChanged', remember: false });
        return;
      }
      let nextTarget = '';
      let nextAlignments: Draft['alignments'] = latest.alignments === null ? null : [];
      let fillRemap: AlignmentRemap | null = null;
      let splices: DraftEditSplices | undefined;
      if (step.kind === 'blank') {
        const piece = slice(sc, step.segment.start, step.segment.core_start) + body.text + slice(sc, step.segment.core_end, step.segment.end);
        plan.pieces[item.index] = piece;
        nextTarget = plan.base + plan.pieces.join('');
      } else if (step.kind === 'partial_tail') {
        const tailSc = chars(slice(sc, plan.tailStart, sc.length));
        const piece = slice(tailSc, step.segment.start, step.segment.core_start) + body.text + slice(tailSc, step.segment.core_end, step.segment.end);
        plan.pieces[item.index] = piece;
        const joined = plan.pieces.join('');
        nextTarget = plan.base + (joined ? plan.appendPrefix + joined : '');
        nextAlignments = null;
      } else {
        const currentView = this.viewsFor().items.find(
          v => v.pair.status === 'untranslated'
            && v.pair.source.core_start === step.sourceCoreStart
            && v.pair.source.core_end === step.sourceCoreEnd,
        );
        if (!currentView) {
          this.failRun({ type: 'failed', key: item.key, code: 'translateTargetChanged', classification: { action: 'stop' }, now: this.clock.now() });
          this.commit({ semantic: x => x, notice: 'sem:translateTargetChanged', remember: false });
          return;
        }
        const tc = chars(latest.target);
        const region = currentView.pair.target;
        const head = slice(tc, 0, region.start);
        const ws = slice(tc, region.start, region.end);
        const tail = slice(tc, region.end, tc.length);
        const lead = head && !/\n[ \t\r]*\n[ \t\r]*$/u.test(head + ws) ? '\n\n' : '';
        const trail = tail && !/^[ \t\r]*\n[ \t\r]*\n/u.test(tail) ? '\n\n' : '';
        nextTarget = head + ws + lead + body.text + trail + tail;
        const insertAt = chars(head + ws).length;
        const coreStart = insertAt + chars(lead).length;
        const coreEnd = coreStart + chars(body.text).length;
        const delta = chars(lead + body.text + trail).length;
        fillRemap = remapForTargetFill(
          latest.alignments,
          latest.source,
          nextTarget,
          currentView.pair.source.start,
          currentView.pair.source.end,
          insertAt,
          coreStart,
          coreEnd,
          delta,
        );
        nextAlignments = fillRemap.alignments;
        splices = {
          target: {
            start: scalarOffset(insertAt),
            oldEnd: scalarOffset(insertAt),
            newEnd: scalarOffset(insertAt + delta),
          },
        };
        plan.pieces[item.index] = body.text;
      }
      plan.expectedTarget = nextTarget;
      const done = plan.pieces.filter(p => p !== undefined).length === plan.steps.length;
      const lostAlignments = fillRemap ? alignmentNotice(latest.alignments, fillRemap) : null;
      this.commit({
        draft: { ...latest, target: nextTarget, alignments: nextAlignments },
        ...(splices ? { splices } : {}),
        ...(fillRemap ? { invalidated: fillRemap.invalidated } : {}),
        remember: false,
        notice: lostAlignments ?? (done ? 'sem:translateRunDone' : null),
      });
      this.dispatchRun({ type: 'done', key: item.key });
    } catch {
      if (live() && !signal.aborted) {
        this.failRun({ type: 'failed', key: item.key, code: 'requestFailed', classification: { action: 'stop' }, now: this.clock.now() });
      }
    }
  }

  startSemanticRun(only?: PairView[], lang?: UiLanguage): void {
    if (lang) this.setState({ lang });
    const list = only ?? this.viewsFor().items.filter(v => v.pair.status === 'ready' && !v.result);
    this.startBatch('semantic', list.map(v => ({ key: v.itemKey, index: v.pair.index })));
  }

  startTermRun(): void {
    const { draft, semantic } = this.state;
    const ctx: LongCtx = this.longCtx();
    const { items } = inputsOf(draft);
    const plan = termPlan(semantic.long, ctx);
    if (!plan.order.length) return;
    this.startBatch('term', plan.order.map((i: number) => ({ key: termSegmentKey(i, items[i]), index: i })));
  }

  startTranslateRun(): void {
    const d = this.state.draft;
    const built = this.buildTranslatePlan(d);
    if (!built) return;
    this.translateRun = built.plan;
    // One undo step for the whole generated translation: the state before the batch.
    if (built.plan.kind === 'blank') {
      this.commit({ draft: { ...d, target: '' }, remember: true, notice: null });
    } else {
      this.commit({ remember: true, notice: null });
    }
    this.startBatch('translate', built.items);
  }

  async translatePair(viewOrIndex: PairView | number): Promise<void> {
    if (this.disposed || this.state.pairTranslating !== null) return;
    const view = typeof viewOrIndex === 'number'
      ? this.viewsFor().items.find(v => v.pair.index === viewOrIndex) ?? null
      : viewOrIndex;
    if (!view || !view.sCore.trim() || chars(view.sCore).length > SEGMENT_LIMIT) return;
    const isRetranslate = view.pair.status === 'ready';
    if (view.pair.status !== 'untranslated' && (!isRetranslate || view.pair.hard_cut)) return;
    const d = this.state.draft;
    const epoch = this.documentEpoch;
    const list = inputsOf(d).items.map(item => item.pair);
    const before = contextBefore({ pairs: list, segmentIndex: view.pair.index, source: d.source, target: d.target });
    const precedents = this.state.usePrecedents
      ? selectPrecedents({ items: this.precedentItems(d, this.state.semantic), source: d.source, pairs: list, segmentIndex: view.pair.index })
      : [];
    const contextOn = !!this.state.capabilities?.includes(CAPABILITY_TRANSLATION_CONTEXT);
    // ADR 0019 decision 5: a negotiated context is always present, even as {} on the first pair.
    const context = contextOn ? { context: { ...(before ? { before } : {}), ...(precedents.length ? { precedents } : {}) } } : {};
    const fitted = fitRequestBody({ text: view.sCore, to: d.direction, ...context });
    if (!fitted.fits) return;

    const abort = new AbortController();
    this.pairAbort = abort;
    this.setState({ pairTranslating: view.pair.index });
    try {
      const { response, value } = await this.post('/api/translations', fitted.body, { signal: abort.signal, allowInvalidJson: true });
      const body = value && typeof value === 'object' ? value as Record<string, unknown> : null;
      if (!this.disposed) this.onPoolRefresh();
      if (this.disposed || this.documentEpoch !== epoch || abort.signal.aborted) return;
      if (!response.ok || typeof body?.text !== 'string') {
        const id = typeof body?.request_id === 'string' && body.request_id ? `#${body.request_id}` : '';
        this.commit({ semantic: x => x, notice: `t:${typeof body?.reason === 'string' ? body.reason : 'fallback'}${id}`, remember: false });
        return;
      }
      const latest = this.state.draft;
      const tc = chars(latest.target);
      const region = view.pair.target;
      if (latest.source !== d.source || latest.target !== d.target || latest.direction !== d.direction
        || JSON.stringify(latest.alignments) !== JSON.stringify(d.alignments)) {
        this.commit({ semantic: x => x, notice: 'sem:segmentChanged', remember: false });
        return;
      }
      if (isRetranslate) {
        const nextTarget = slice(tc, 0, region.core_start) + body.text + slice(tc, region.core_end, tc.length);
        const replacementLen = chars(body.text).length;
        const remap = remapForSplice(latest.alignments, 'target', latest.source, nextTarget, region.core_start, region.core_end, replacementLen);
        this.commit({
          draft: { ...latest, target: nextTarget, alignments: remap.alignments },
          invalidated: remap.invalidated,
          splices: {
            target: {
              start: region.core_start,
              oldEnd: region.core_end,
              newEnd: scalarOffset(region.core_start + replacementLen),
            },
          },
          notice: alignmentNotice(latest.alignments, remap) ?? 'sem:retranslated',
        });
        return;
      }
      const head = slice(tc, 0, region.start);
      const ws = slice(tc, region.start, region.end);
      const tail = slice(tc, region.end, tc.length);
      const lead = head && !/\n[ \t\r]*\n[ \t\r]*$/u.test(head + ws) ? '\n\n' : '';
      const trail = tail && !/^[ \t\r]*\n[ \t\r]*\n/u.test(tail) ? '\n\n' : '';
      const nextTarget = head + ws + lead + body.text + trail + tail;
      const insertAt = chars(head + ws).length;
      const coreStart = insertAt + chars(lead).length;
      const coreEnd = coreStart + chars(body.text).length;
      const delta = chars(lead + body.text + trail).length;
      const remap = remapForTargetFill(
        latest.alignments,
        latest.source,
        nextTarget,
        view.pair.source.start,
        view.pair.source.end,
        insertAt,
        coreStart,
        coreEnd,
        delta,
      );
      this.commit({
        draft: { ...latest, target: nextTarget, alignments: remap.alignments },
        invalidated: remap.invalidated,
        splices: {
          target: {
            start: scalarOffset(insertAt),
            oldEnd: scalarOffset(insertAt),
            newEnd: scalarOffset(insertAt + delta),
          },
        },
        notice: alignmentNotice(latest.alignments, remap) ?? 'sem:translated',
      });
    } catch {
      if (!this.disposed && this.documentEpoch === epoch && !abort.signal.aborted) {
        this.commit({ semantic: x => x, notice: 't:fallback', remember: false });
      }
    } finally {
      if (this.pairAbort === abort) this.pairAbort = null;
      if (!this.disposed && this.documentEpoch === epoch) {
        this.setState({ pairTranslating: null });
      }
    }
  }
}

export function createWorkbenchController(options?: WorkbenchControllerOptions): WorkbenchController {
  return new WorkbenchController(options);
}
