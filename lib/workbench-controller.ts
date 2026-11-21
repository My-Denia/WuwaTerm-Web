// Standalone, React-free document controller for the WuwaTerm review workbench.
// Owns canonical manuscript state, request orchestration, abort/generation/epoch
// guards, serial run scheduling, waiting timers, and persistence/export shaping.
import { segmentText } from './segmentation.js';
import { contextBefore, fitRequestBody, initialRun, nextToSend, runReducer, selectPrecedents } from './semantic-run.js';
import {
  applyResult, chooseTerm, longFromWorkfile, recheckPlan, recordView, sameV3Basis,
  segmentInputs, segmentRequest, setCurrent, termPlan, termSegmentKey, workfileParts,
} from './long-review.js';
import {
  CAPABILITY_TRANSLATION_CONTEXT, SEMANTIC_REVIEW_VERSION,
  validSemanticReviewResponse, verifySemanticReviewIdentity,
} from './semantic-review.js';
import {
  addSegmentResult, decisionFor, emptySemantic, freshSemantic, longHoldsWork,
  mapSemanticEdit, placeSemanticResult, reconcileState, semanticSegmentViews,
} from './semantic-state.js';
import {
  MAX_V3_WORKFILE_BYTES, MAX_V4_CHOICES, MAX_WORKFILE_BYTES, REPORT_V4,
  canonicalManuscript, compareReports, leaveGuardActive, makeChoice, manuscriptSaveView,
  mentionId, parseWorkfile, reconcileChoices, recoverableWorkPresent, recoverSpan,
  serializeWorkfile, validAlignments, validReport,
  WORKFILE_FORMAT_V2, WORKFILE_FORMAT_V3, WORKFILE_FORMAT_V4,
} from './manuscript.js';
import { highlightSegments, revisionOf } from './review-report.js';
import { spliceOccurrence } from './target-revision.js';
import { isMarkdownReportExport, renderMarkdownReport, type MarkdownCurrency } from './markdown-report.ts';
import { msg } from './messages.ts';
import { requestPoolRefresh } from './pool-snapshot.ts';
import { workbenchPath } from './ui-runtime.ts';
import { semanticExport, semanticFromWorkfile, semanticWorkfileParts } from './workbench-persistence.ts';
import { postWorkbench, REVIEW_REQUEST_LIMIT, runFailure } from './workbench-transport.ts';
import type { UiLanguage } from './ui-language.ts';
import type {
  Candidate, Choice, Commit, Decision, DocumentPhase, Draft, ErrorState, ExportArtifact,
  Finding, ImportFileLike, ImportOutcome, LongCtx, LongState, NoticeState, Pair, PairView,
  RecordView, Report, Resolution, RunItem, RunKind, RunState, SegmentInput, SemanticReport,
  SemanticState, SessionBasis, Snapshot, Span, Undo,
} from './workbench-model.ts';

export const MAX_CHOICES = MAX_V4_CHOICES;
export const EMPTY_DRAFT: Draft = { source: '', target: '', direction: 'en', alignments: null };

/**
 * Precedents are sent by default only because the Core evaluation's M′ gates
 * (same-sense reuse and led-astray) were met for them; re-read the C2 receipt
 * when the backend pin moves and turn this off if they are not.
 */
export const PRECEDENTS_DEFAULT_ON = true;

const chars = (text: string) => Array.from(text);
const slice = (list: string[], start: number, end: number) => list.slice(start, end).join('');
const inputsOf = (draft: Draft) => segmentInputs(draft) as { long: boolean; items: SegmentInput[] };
const viewOf = (long: LongState, index: number, ctx: LongCtx) => recordView(long, index, ctx) as RecordView | null;
const defaultUid = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

export type WorkbenchPost = (
  path: string,
  body: object,
  options?: { signal?: AbortSignal; reviewFeatures?: boolean; allowInvalidJson?: boolean },
) => Promise<{ response: Response; value: unknown }>;

export type WorkbenchFetchCapabilities = (signal: AbortSignal) => Promise<string[]>;

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
};

export type WorkbenchSnapshot = {
  draft: Draft;
  choices: Choice[];
  imported: Choice[];
  reports: Snapshot[];
  history: Undo[];
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
};

type TranslateRunPlan = {
  source: string;
  direction: 'en' | 'zh';
  segments: { start: number; end: number; core_start: number; core_end: number }[];
  pieces: string[];
  base: string;
};

const defaultClock: WorkbenchClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: id => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: id => globalThis.clearInterval(id as ReturnType<typeof setInterval>),
};

async function defaultFetchCapabilities(signal: AbortSignal): Promise<string[]> {
  try {
    const response = await fetch(workbenchPath('/api/capabilities'), { cache: 'no-store', signal });
    let value: unknown = null;
    try { value = await response.json(); } catch { value = null; }
    const obj = value as { capabilities?: unknown } | null;
    return response.ok && Array.isArray(obj?.capabilities)
      ? obj.capabilities.filter((x): x is string => typeof x === 'string')
      : [];
  } catch {
    return [];
  }
}

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
  private documentEpoch = 0;
  private reconcileGeneration = 0;

  private capabilitiesAbort: AbortController | null = null;
  private capabilitiesPromise: Promise<string[]> | null = null;

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
    this.fetchCapabilities = options.fetchCapabilities ?? defaultFetchCapabilities;
    this.clock = options.clock ?? defaultClock;
    this.onPoolRefresh = options.onPoolRefresh ?? requestPoolRefresh;
    this.uid = options.uid ?? defaultUid;
    this.state = {
      draft: EMPTY_DRAFT,
      choices: [],
      imported: [],
      reports: [],
      history: [],
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
    this.inflight = null;
    this.translateRun = null;
  }

  private setState(patch: Partial<WorkbenchSnapshot>): void {
    if (this.disposed) return;
    const prev = this.state;
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
    if (snapshotSemantic.decisions.length === 0 || snapshotSemantic.placed.length === 0) return;
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

  setNotice(notice: NoticeState): void {
    this.setState({ notice });
  }

  setError(error: ErrorState): void {
    this.setState({ error });
  }

  setCapabilities(capabilities: string[] | null): void {
    this.setState({ capabilities });
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
    this.docAbort?.abort();
    this.docAbort = null;
    this.docGeneration += 1;
    this.abortRunInternal();
    this.documentEpoch += 1;
    this.setState({
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
    });
  }

  private pushUndo(): { history: Undo[]; serial: number } {
    const serial = ++this.historySerial;
    const { draft, choices, imported, semantic, history } = this.state;
    return {
      serial,
      history: [...history.slice(-19), { draft, choices, imported, semantic, serial }],
    };
  }

  private pushDocumentUndo(): Undo[] {
    const { draft, choices, imported, reports, semantic, history } = this.state;
    const saved: Undo = { draft, choices, imported, reports, semantic, replacedDocument: true };
    return [...history.slice(-19), saved];
  }

  canUndoLast(serial: number): boolean {
    return this.state.history.at(-1)?.serial === serial;
  }

  // ---- Document edits & choices ----

  applySemantic(update: (state: SemanticState) => SemanticState): void {
    const next = update(this.state.semantic);
    this.setState({ semantic: next });
  }

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
      notice: message,
    });
  }

  editText(side: 'source' | 'target', value: string): void {
    const { draft, reports } = this.state;
    const latest = reports.at(-1) ?? null;
    const sourceDirtyForTranslation = side === 'source' ? Boolean(value.trim() && draft.target.trim()) : false;
    const next: Draft = { ...draft, [side]: value, alignments: draft.alignments === null ? null : [] };
    const message = draft.alignments !== null ? 'editedAlignments' : latest ? 'editedText' : '';
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

  readonly commit: Commit = ({ draft: next, semantic: update, notice: code, remember: push = true }) => {
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
      nextSemantic = mapSemanticEdit(nextSemantic, before.draft, next) as SemanticState;
      nextDraft = next;
      sourceDirtyForTranslation = false;
    }
    if (update) {
      nextSemantic = update(nextSemantic);
    }
    this.setState({
      history,
      draft: nextDraft,
      semantic: nextSemantic,
      sourceDirtyForTranslation,
      phase,
      translating,
      error,
      generation,
      inFlight,
      ...(code !== undefined && code !== null ? { notice: code } : {}),
    });
    return serial;
  };

  commitLong(update: (state: LongState) => { long: LongState; error?: string | null } | LongState, notice: string | null = null): void {
    const unwrap = (out: { long: LongState; error?: string | null } | LongState) =>
      ('records' in out ? { long: out, error: null } : { long: out.long, error: out.error ?? null });
    const probe = unwrap(update(this.state.semantic.long));
    if (probe.error) {
      if (probe.error === 'too_many_choices') this.commit({ notice: 'choiceLimit', remember: false });
      return;
    }
    if (probe.long === this.state.semantic.long) return;
    this.commit({
      semantic: state => {
        const out = unwrap(update(state.long));
        return out.error || out.long === state.long ? state : { ...state, long: out.long };
      },
      notice,
    });
  }

  chooseLong(index: number, finding: { source?: number[]; source_span?: Span }, candidate: { candidate_id: string; zh: string; en: string; category: string } | null): void {
    this.commitLong(
      state => chooseTerm(state, { index, finding, candidate }, { draft: this.state.draft, basis: this.state.basis }) as { long: LongState; error: string | null },
      'sem:longChoiceRecorded',
    );
  }

  selectLongSegment(index: number | null): void {
    this.commit({
      semantic: state => ({ ...state, long: setCurrent(state.long, index) as LongState }),
      remember: false,
    });
  }

  choose(finding: Finding, candidate: Candidate | null): void {
    const { draft, choices, imported, reports } = this.state;
    const latest = reports.at(-1) ?? null;
    const sourceCompatible = !!latest?.trusted && latest.source === draft.source && latest.direction === draft.direction;
    if (!sourceCompatible || !latest) return;
    const span = recoverSpan(latest.source, finding.source_span, draft.source) as Span | null;
    if (!span) return;
    const selected = makeChoice({
      source: draft.source, direction: draft.direction, alignments: draft.alignments,
      report: latest.report, finding: { ...finding, source_span: span }, candidate,
    }) as Choice;
    const existing = choices.findIndex(c => {
      const recovered = recoverSpan(c.source, c.source_span, draft.source) as Span | null;
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

  replaceTerm(finding: Finding, candidate: Candidate): void {
    const { draft, reports } = this.state;
    const latest = reports.at(-1) ?? null;
    const sourceCompatible = !!latest?.trusted && latest.source === draft.source && latest.direction === draft.direction;
    if (!latest || latest.target !== draft.target || !sourceCompatible || !finding.target_span) return;
    const parts = highlightSegments(draft.target, finding.target_span);
    const forms = finding.candidates.flatMap(c => [c.zh, c.en]);
    if (!parts || !forms.includes(finding.target_span.text)) return;
    const result = spliceOccurrence(draft.target, finding.target_span.text, finding.target_span, draft.direction === 'en' ? candidate.en : candidate.zh);
    if (result.error === 'revisionTooLong') this.setState({ notice: 'revisionTooLong' });
    if (result.target !== undefined) this.editText('target', result.target);
  }

  undo(): void {
    const last = this.state.history.at(-1);
    if (!last) return;
    const nextHistory = this.state.history.slice(0, -1);
    const notice = last.reports ? 'undoWithReports' : 'undoLocal';
    const basePatch: Partial<WorkbenchSnapshot> = {
      draft: last.draft,
      choices: last.choices,
      imported: last.imported,
      history: nextHistory,
      sourceDirtyForTranslation: false,
      ...(last.reports ? { reports: last.reports } : {}),
      notice,
    };
    if (last.replacedDocument) {
      this.replaceDocumentState(basePatch, last.semantic);
    } else {
      this.docAbort?.abort();
      this.docAbort = null;
      this.docGeneration += 1;
      this.setState({
        ...basePatch,
        phase: 'idle',
        translating: false,
        error: null,
        generation: this.docGeneration,
        inFlight: false,
        semantic: last.semantic,
      });
    }
  }

  receiveDraft(next: Draft): boolean {
    const before = this.state.draft;
    if (before.source === next.source && before.target === next.target && before.direction === next.direction) return false;
    const nextHistory = this.pushDocumentUndo();
    this.replaceDocumentState({
      draft: next,
      choices: [],
      imported: [],
      reports: [],
      history: nextHistory,
      sourceDirtyForTranslation: false,
      notice: 'receivedDraft',
    }, freshSemantic(next) as SemanticState);
    return true;
  }

  replaceWithText(text: string): void {
    const nextHistory = this.pushDocumentUndo();
    const textDraft: Draft = { source: text, target: '', direction: this.state.draft.direction, alignments: null };
    this.replaceDocumentState({
      draft: textDraft,
      choices: [],
      imported: [],
      reports: [],
      history: nextHistory,
      importedCanonical: null,
      sourceDirtyForTranslation: false,
      notice: 'importedSourceText',
    }, freshSemantic(textDraft) as SemanticState);
  }

  clearDraft(): boolean {
    const { draft, choices, reports, semantic } = this.state;
    if (!workPresent(draft, choices, reports, semantic)) return false;
    const nextHistory = this.pushDocumentUndo();
    this.replaceDocumentState({
      draft: EMPTY_DRAFT,
      choices: [],
      imported: [],
      reports: [],
      history: nextHistory,
      sourceDirtyForTranslation: false,
      notice: 'clearedDraft',
    }, emptySemantic() as SemanticState);
    return true;
  }

  // ---- Import / Save / Export ----

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
        const canonical = canonicalOf(this.state.draft, this.state.choices, this.state.reports, this.state.semantic, this.state.basis);
        const holdsWork = workPresent(this.state.draft, this.state.choices, this.state.reports, this.state.semantic);
        const saveView = manuscriptSaveView({
          holdsWork,
          canonical,
          importedCanonical: this.state.importedCanonical,
          downloadedCanonical: this.state.downloadedCanonical,
        });
        if (leaveGuardActive({ view: saveView })) {
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
      const nextChoices = value.choices as Choice[];
      const nextReports: Snapshot[] = value.history.map((s: Draft & { report: Report; resolutions?: Resolution[] }) => ({
        ...s, resolutions: s.resolutions ?? null, trusted: false, signature: '',
      }));
      const withSemantic = value.format === WORKFILE_FORMAT_V2 || value.format === WORKFILE_FORMAT_V3 || value.format === WORKFILE_FORMAT_V4;
      const nextSemantic: SemanticState = {
        ...(withSemantic ? await semanticFromWorkfile(value) : emptySemantic() as SemanticState),
        long: longFromWorkfile(value) as LongState,
      };
      if (this.disposed || this.importAttempt !== attempt) return { status: 'ignored' };
      if (this.docGeneration !== mine) {
        this.setState({ notice: 'importChangedDuringRead' });
        return { status: 'ignored' };
      }
      const importedBody = canonicalOf(nextDraft, nextChoices, nextReports, nextSemantic, null);
      const nextHistory = this.pushDocumentUndo();
      this.replaceDocumentState({
        draft: nextDraft,
        choices: nextChoices,
        imported: nextChoices,
        reports: nextReports,
        history: nextHistory,
        sourceDirtyForTranslation: false,
        ...(importedBody ? { importedCanonical: importedBody } : {}),
        notice: 'imported',
      }, nextSemantic);
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
      this.setState({ downloadedCanonical: content, error: null, notice: 'saved' });
      return { filename: 'wuwaterm-manuscript.json', content, mimeType: 'application/json' };
    } catch (cause) {
      this.setState({ error: errorFrom(cause, 'saveFailed') });
      return null;
    }
  }

  exportTxt(): ExportArtifact {
    this.setState({ notice: 'exportTxt' });
    return { filename: 'wuwaterm-translation.txt', content: this.state.draft.target, mimeType: 'text/plain;charset=utf-8' };
  }

  private longResultsCurrent(): boolean {
    const { draft, semantic, basis } = this.state;
    const ctx = { draft, basis };
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
      ...semanticExport(draft, semantic, basis).result,
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
    const parts = semanticExport(draft, semantic, basis);
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
      const { response, value } = await this.post('/api/reviews', body, { signal: abort.signal, reviewFeatures: true });
      if (this.disposed || abort.signal.aborted || this.docGeneration !== mine) return;
      if (!response.ok) {
        const reason = value && typeof value === 'object' && 'reason' in value && typeof value.reason === 'string' ? value.reason : '';
        throw Object.assign(new Error(), { gahReason: reason, gahDetail: failureFields(response, value) });
      }
      if (!validReport(value, source, target, REPORT_V4)) {
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

    try {
      const known = this.state.capabilities ?? await (this.capabilitiesPromise ?? Promise.resolve([]));
      if (this.disposed || abort.signal.aborted || this.docGeneration !== mine) return;
      const context = known.includes(CAPABILITY_TRANSLATION_CONTEXT) ? { context: {} } : {};
      const { response, value } = await this.post('/api/translations', { text: source, to: direction, ...context }, { signal: abort.signal });
      if (this.disposed || abort.signal.aborted || this.docGeneration !== mine) return;
      if (!response.ok || !value || typeof value !== 'object' || typeof (value as { text?: unknown }).text !== 'string') {
        const reason = value && typeof value === 'object' && 'reason' in value && typeof (value as { reason?: unknown }).reason === 'string'
          ? String((value as { reason: string }).reason) : '';
        throw Object.assign(new Error(), { gahReason: reason, gahDetail: failureFields(response, value) });
      }
      const translated = (value as { text: string }).text;
      const before = this.state.draft;
      const { history } = this.pushUndo();
      const translatedDraft: Draft = { ...before, target: translated, alignments: alignments === null ? null : [] };
      const nextSemantic = mapSemanticEdit(this.state.semantic, before, translatedDraft) as SemanticState;
      this.setState({
        history,
        draft: translatedDraft,
        semantic: nextSemantic,
        translating: false,
        inFlight: false,
        sourceDirtyForTranslation: false,
        notice: alignments !== null ? 'editedAlignments' : 'translatedInReview',
      });
      this.onPoolRefresh();
    } catch (cause) {
      if (!this.disposed && !abort.signal.aborted && this.docGeneration === mine) {
        const nextError: ErrorState = cause instanceof Error && 'gahReason' in cause
          ? { reason: String((cause as Error & { gahReason?: unknown }).gahReason), kind: 'translation', ...detailOf(cause) }
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
      ...(semanticSegmentViews(draft, semantic, basis) as { long: boolean; pairs: Pair[]; items: PairView[] }),
    };
  }

  private precedentItems(d: Draft, state: SemanticState) {
    const items: { span: Span; choice: string; rendering: string | null }[] = [];
    for (const c of this.state.choices) {
      const span = recoverSpan(c.source, c.source_span, d.source) as Span | null;
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
    let at = locateItem();
    let ctx: LongCtx = { draft: this.state.draft, basis: this.state.basis };
    const first = at < 0 ? null : viewOf(this.state.semantic.long, at, ctx);
    if (!first || !first.ready) { this.dispatchRun({ type: 'skip', key: item.key }); return; }
    if (ctx.basis !== null && !first.needsCheck) { this.dispatchRun({ type: 'done', key: item.key }); return; }
    let withResolutions = recheckPlan(this.state.semantic.long, at, ctx) === 'with_resolutions';
    let sent = 0;
    for (;;) {
      const request = segmentRequest(this.state.semantic.long, at, ctx, { withResolutions }) as {
        index: number; body: Record<string, unknown>; alignmentInput: string; sentKey: string;
      } | null;
      if (!request) { this.dispatchRun({ type: 'skip', key: item.key }); return; }
      if (new TextEncoder().encode(JSON.stringify(request.body)).length > REVIEW_REQUEST_LIMIT) {
        fail('bodyTooLarge');
        return;
      }
      sent += 1;
      try {
        const { response, value } = await this.post('/api/reviews', request.body, { signal, reviewFeatures: true, allowInvalidJson: true });
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
        if (!validReport(body, request.body.source, request.body.target, REPORT_V4) || body?.rule_version !== 'review-v2') {
          fail('responseInvalid');
          return;
        }
        const before = this.state.basis;
        const result = applyResult(
          this.state.semantic.long,
          { draft: this.state.draft, basis: before },
          request,
          body,
        ) as { long: LongState; basis: SessionBasis; secondRequest: boolean; error: string | null };
        if (result.error === 'response_invalid') { fail('responseBasisMismatch'); return; }
        const nextSemantic = result.long !== this.state.semantic.long
          ? { ...this.state.semantic, long: result.long }
          : this.state.semantic;
        this.setState({ semantic: nextSemantic, basis: result.basis });
        if (!sameV3Basis(before, result.basis)) {
          const nowCtx = { draft: this.state.draft, basis: result.basis };
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
          ctx = { draft: this.state.draft, basis: result.basis };
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

  private async sendTranslate(item: RunItem, signal: AbortSignal, generation: number, epoch: number): Promise<void> {
    const live = () => !this.disposed && this.runGeneration === generation && this.documentEpoch === epoch && !signal.aborted;
    const inOrder = (failure: ReturnType<typeof runFailure>) => (
      ['wait', 'pause_quota'].includes((failure.classification as { action: string }).action)
        ? failure
        : { ...failure, classification: { action: 'stop' } }
    );
    const plan = this.translateRun;
    const d = this.state.draft;
    if (!plan || d.source !== plan.source || d.direction !== plan.direction || d.target !== plan.base + plan.pieces.join('')) {
      this.failRun({ type: 'failed', key: item.key, code: 'translateTargetChanged', classification: { action: 'stop' }, now: this.clock.now() });
      this.commit({ semantic: x => x, notice: 'sem:translateTargetChanged', remember: false });
      return;
    }
    const segment = plan.segments[item.index];
    const sc = chars(d.source);
    const core = slice(sc, segment.core_start, segment.core_end);
    const prev = item.index > 0 ? plan.segments[item.index - 1] : null;
    const previousPiece = item.index > 0 ? plan.pieces[item.index - 1] : '';
    const before = prev ? {
      source: chars(slice(sc, prev.core_start, prev.core_end)).slice(-400).join(''),
      target: chars(previousPiece.trim()).slice(-400).join(''),
    } : null;
    const contextOn = !!this.state.capabilities?.includes(CAPABILITY_TRANSLATION_CONTEXT);
    const fitted = fitRequestBody({ text: core, to: plan.direction, ...(contextOn ? { context: before ? { before } : {} } : {}) });
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
      if (latest.source !== plan.source || latest.direction !== plan.direction || latest.target !== plan.base + plan.pieces.join('')) {
        this.failRun({ type: 'failed', key: item.key, code: 'translateTargetChanged', classification: { action: 'stop' }, now: this.clock.now() });
        this.commit({ semantic: x => x, notice: 'sem:translateTargetChanged', remember: false });
        return;
      }
      const piece = slice(sc, segment.start, segment.core_start) + body.text + slice(sc, segment.core_end, segment.end);
      plan.pieces[item.index] = piece;
      const done = plan.pieces.filter(p => p !== undefined).length === plan.segments.length;
      this.commit({
        draft: { ...latest, target: plan.base + plan.pieces.join(''), alignments: latest.alignments === null ? null : [] },
        remember: false,
        notice: done ? 'sem:translateRunDone' : null,
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
    const { draft, semantic, basis } = this.state;
    const ctx: LongCtx = { draft, basis };
    const { items } = inputsOf(draft);
    const plan = termPlan(semantic.long, ctx);
    if (!plan.order.length) return;
    this.startBatch('term', plan.order.map((i: number) => ({ key: termSegmentKey(i, items[i]), index: i })));
  }

  startTranslateRun(): void {
    const d = this.state.draft;
    if (!d.source.trim() || d.target.trim()) return;
    const segments = segmentText(d.source) as { start: number; end: number; core_start: number; core_end: number }[];
    this.translateRun = { source: d.source, direction: d.direction, segments, pieces: [], base: '' };
    // One undo step for the whole generated translation: the blank target before it.
    this.commit({ draft: { ...d, target: '' }, remember: true, notice: null });
    this.startBatch('translate', segments.map((_, index) => ({ key: `tr#${index}`, index })));
  }

  async translatePair(viewOrIndex: PairView | number): Promise<void> {
    if (this.disposed || this.state.pairTranslating !== null) return;
    const view = typeof viewOrIndex === 'number'
      ? this.viewsFor().items.find(v => v.pair.index === viewOrIndex) ?? null
      : viewOrIndex;
    if (!view || !view.sCore.trim()) return;
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
      const head = slice(tc, 0, region.start);
      const ws = slice(tc, region.start, region.end);
      const tail = slice(tc, region.end, tc.length);
      const lead = head && !/\n[ \t\r]*\n[ \t\r]*$/u.test(head + ws) ? '\n\n' : '';
      const trail = tail && !/^[ \t\r]*\n[ \t\r]*\n/u.test(tail) ? '\n\n' : '';
      this.commit({
        draft: { ...latest, target: head + ws + lead + body.text + trail + tail, alignments: latest.alignments === null ? null : [] },
        notice: 'sem:translated',
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
