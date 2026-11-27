// Shared store types, constants, pure manuscript helpers, and internal host
// contract for the WuwaTerm workbench controller submodules. Zero React imports.
import { workfileParts } from './long-review.ts';
import {
  MAX_V4_CHOICES,
  canonicalManuscript,
  recoverableWorkPresent,
  type AlignmentRemap,
  type InvalidatedAlignment,
} from './manuscript.js';
import { msg } from './messages.ts';
import { longHoldsWork } from './semantic-state.js';
import type { StructureState } from './structure-layer.ts';
import type { TmServiceBasis } from './tm-live-provenance.ts';
import type { TmEntry } from './translation-memory.ts';
import type { UiLanguage } from './ui-language.ts';
import { semanticWorkfileParts } from './workbench-persistence.ts';
import type {
  Choice, DocumentCheckpoint, DocumentPhase, Draft, DraftEditSplices, ErrorState,
  LongCtx, LongState, NoticeState, Pair, PairView, RunItem, RunKind, RunState,
  SemanticActionRecord, SemanticState, SessionBasis, Snapshot, Span, TmRunReceipt, Undo,
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

export const chars = (text: string) => Array.from(text);
export const slice = (list: string[], start: number, end: number) => list.slice(start, end).join('');
export const sliceEquals = (text: string, span: Span | null) => !!span && slice(chars(text), span.start, span.end) === span.text;

/**
 * The notice of an edit transaction that touched explicit alignments: `editedAlignments` when it left none of them,
 * `editedAlignmentsPartial` when it invalidated only some, else null (kept, shifted, resized or emptied-target entries only).
 */
export const alignmentNotice = (prev: Draft['alignments'], remap: AlignmentRemap): 'editedAlignments' | 'editedAlignmentsPartial' | null =>
  prev === null || prev.length === 0 ? null
    : remap.alignments !== null && remap.alignments.length === 0 ? 'editedAlignments'
      : remap.invalidated.length > 0 ? 'editedAlignmentsPartial' : null;

/** The session list of invalidated alignments keeps the latest entries, at most the 64 an alignment list can hold. */
export const MAX_SESSION_INVALIDATIONS = 64;
export const appendInvalidations = (list: readonly InvalidatedAlignment[], added: readonly InvalidatedAlignment[]): InvalidatedAlignment[] =>
  (added.length ? [...list, ...added].slice(-MAX_SESSION_INVALIDATIONS) : [...list]);

/**
 * One undo or redo step: the workbench state before (undo) or after (redo) one edit transaction, with the session list of
 * alignments that edits invalidated, so stepping back restores every entry a transaction took out. `checkpoint` is the protected
 * document checkpoint an undo of a document replacement cleared, restored when that replacement is redone.
 */
export type UndoEntry = Undo & { invalidations?: InvalidatedAlignment[]; checkpoint?: DocumentCheckpoint };
export const invalidationsOf = (entry: Undo): InvalidatedAlignment[] => (entry as UndoEntry).invalidations ?? [];
export const defaultUid = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

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
  /** Current confirmed TM entries held by the workspace (page memory or self-hosted SQLite). */
  getTmEntries?: () => readonly TmEntry[];
  /** Freshly resolves live server dictionary identity before batch TM auto-reuse; must fail closed when unavailable. */
  resolveTmAutoReuseBasis?: (latest: Snapshot | null) => Promise<TmServiceBasis>;
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
  /**
   * Non-text TM incremental reuse receipt for the most recent multi-segment translation run (ADR 0023):
   * counts and provenance only, never segment text, never written to manuscripts or browser storage.
   */
  tmReceipt: TmRunReceipt | null;
  /** True while an incremental TM run is resolving dictionary identity or Layer 1 structure checks before batch translation. */
  tmPreparing: boolean;
};

export type TranslateRunStep =
  | { kind: 'blank'; segment: { start: number; end: number; core_start: number; core_end: number } }
  | { kind: 'pair'; sourceCoreStart: number; sourceCoreEnd: number }
  | { kind: 'partial_tail'; segment: { start: number; end: number; core_start: number; core_end: number } };

export type TranslateRunPlan = {
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
  trackTmModelCalls?: boolean;
  /**
   * Deferred commit for `sourceDirtyForTranslation` incremental updates: keeps the user's
   * existing target untouched in the editor until the first untranslated segment succeeds.
   */
  staged?: {
    draft: Draft;
    structure: StructureState;
    tmReceipt: TmRunReceipt;
    baseAlignmentsJson: string;
  };
};

export type CompositionState = {
  side: 'source' | 'target';
  base: Draft;
  invalidations: InvalidatedAlignment[];
  semantic: SemanticState;
  mapped: SemanticState | null;
};

export type CommitInput = {
  draft?: Draft;
  splices?: DraftEditSplices;
  semantic?: (state: SemanticState) => SemanticState;
  notice?: string | null;
  remember?: boolean;
  invalidated?: readonly InvalidatedAlignment[];
  extraPatch?: (nextSemantic: SemanticState, serial: number | null) => Partial<WorkbenchSnapshot>;
};

export type WorkbenchRuntimeState = {
  disposed: boolean;
  docAbort: AbortController | null;
  docGeneration: number;
  importAttempt: number;
  historySerial: number;
  activeTypingTx: { side: 'source' | 'target'; at: number; serial: number } | null;
  future: UndoEntry[];
  composition: CompositionState | null;
  documentEpoch: number;
  reconcileGeneration: number;
  capabilitiesAbort: AbortController | null;
  capabilitiesPromise: Promise<string[]> | null;
  structureAbort: AbortController | null;
  tmPrepareAbort: AbortController | null;
  tmPrepareGeneration: number;
  runGeneration: number;
  runAbort: AbortController | null;
  inflight: { key: string; attempt: number } | null;
  translateRun: TranslateRunPlan | null;
  pairAbort: AbortController | null;
  waitTimeout: unknown;
  waitInterval: unknown;
  waitTarget: number | null;
  pumping: boolean;
};

/** Internal narrow host interface shared by controller submodules. */
export type WorkbenchHost = {
  readonly post: WorkbenchPost;
  readonly fetchCapabilities: WorkbenchFetchCapabilities;
  readonly clock: WorkbenchClock;
  readonly onPoolRefresh: () => void;
  readonly uid: () => string;
  readonly resolveTmAutoReuseBasis: (latest: Snapshot | null) => Promise<TmServiceBasis>;
  readonly rt: WorkbenchRuntimeState;
  getState(): WorkbenchSnapshot;
  setState(update: Partial<WorkbenchSnapshot>): void;
  currentTmEntries(): readonly TmEntry[];
  reviewFeatures(): string[] | null;
  longCtx(basis?: SessionBasis): LongCtx;
  requestFeatures(): Promise<string[]>;
  discardInFlight(): void;
  abortRunInternal(): void;
  replaceDocumentState(nextPatch: Partial<WorkbenchSnapshot>, nextSemantic: SemanticState): void;
  pushUndo(): { history: UndoEntry[]; serial: number };
  pushDocumentUndo(kind?: DocumentCheckpoint['kind']): { history: UndoEntry[]; checkpoint: DocumentCheckpoint | null };
  canUndoLast(serial: number): boolean;
  applySemantic(update: (state: SemanticState) => SemanticState): void;
  commit(input: CommitInput): number | null;
  commitLong(update: (state: LongState) => { long: LongState; error?: string | null } | LongState, notice?: string | null): boolean;
  viewsFor(): { draft: Draft; long: boolean; pairs: Pair[]; items: PairView[] };
  precedentItems(d: Draft, state: SemanticState): { span: Span; choice: string; rendering: string | null }[];
  clearWaitTimers(): void;
  syncWaitTimer(): void;
  dispatchRun(event: Record<string, unknown>): void;
  failRun(event: Record<string, unknown> & { now: number }): void;
  startBatch(kind: RunKind, items: { key: string; index: number }[]): void;
  resetRun(): void;
  undo(): void;
  executeRunItem(kind: RunKind, item: RunItem, signal: AbortSignal, generation: number, epoch: number): Promise<void>;
  startTranslateRun(): Promise<void>;
  startIncrementalTmTranslateRun(
    startDraft: Draft,
    tmEntries: readonly TmEntry[],
    isBlankMode: boolean,
    options?: { requireReuse?: boolean; stageUntilFirstSuccess?: boolean },
  ): Promise<boolean>;
};

export const defaultClock: WorkbenchClock = {
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

export function failureFields(response: Response, value: unknown): { requestId?: string; retryAfter?: number } {
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

export function errorFrom(cause: unknown, fallbackKey: string): ErrorState {
  const code = cause instanceof Error && 'code' in cause ? String((cause as Error & { code?: unknown }).code) : '';
  const errors = msg('zh').errors as Record<string, string>;
  return code && Object.hasOwn(errors, code) ? { code } : { code: fallbackKey };
}

export function detailOf(cause: unknown): { requestId?: string; retryAfter?: number } {
  return cause && typeof cause === 'object' && 'gahDetail' in cause
    ? (cause as { gahDetail: { requestId?: string; retryAfter?: number } }).gahDetail
    : {};
}
