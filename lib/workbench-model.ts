import type {
  ChoiceKind,
  Direction,
  ReasonValueV5,
  RecordStatus,
  SemanticCategory,
  SemanticConfidence,
  SemanticDecisionKind,
  SemanticOrigin,
  SemanticResponseStatus,
  SuggestionWithheldReason,
  TermEffect,
  TruncatedReason,
  Verdict,
} from './generated/manuscript-contract.ts';

export type ScalarOffset = number & { readonly __coordinate?: 'scalar' };
export type Utf16Offset = number & { readonly __coordinate?: 'utf16' };
export type SegmentIndex = number & { readonly __coordinate?: 'segment-index' };

export const scalarOffset = (value: number): ScalarOffset => value as ScalarOffset;
export const utf16Offset = (value: number): Utf16Offset => value as Utf16Offset;
export const segmentIndex = (value: number): SegmentIndex => value as SegmentIndex;

/** Every reason the runtime handles: the v4 five and `ambiguous_mention`; a file label decides which of them it may hold. */
export type ReasonValue = ReasonValueV5;
export type {
  ChoiceKind,
  Direction,
  RecordStatus,
  SemanticCategory,
  SemanticConfidence,
  SemanticDecisionKind,
  SemanticOrigin,
  SemanticResponseStatus,
  SuggestionWithheldReason,
  TermEffect,
  TruncatedReason,
  Verdict,
};
export type PairStatus = 'ready' | 'needs_manual_split' | 'untranslated' | 'unpaired_target';
export type RecordState = 'pending' | 'saved' | 'current' | 'stale';
export type ChoiceView = 'applies' | 'needs_reconfirmation' | 'waiting';
export type RunPhase = 'idle' | 'running' | 'waiting' | 'paused' | 'stopped' | 'done';
export type RunItemStatus = 'queued' | 'sending' | 'done' | 'failed' | 'skipped';
export type PrecedentChoice = 'official_pair' | 'not_a_term' | 'user_rendering';
export type IssueStatusKind =
  | 'accepted'
  | 'adjusted'
  | 'ignored'
  | 'previously_applied'
  | 'needs_reconfirmation'
  | 'stale'
  | 'pending';

export type Span = { start: ScalarOffset; end: ScalarOffset; text: string };
export type Splice = { start: ScalarOffset; oldEnd: ScalarOffset; newEnd: ScalarOffset };
export type DraftEditSplices = { readonly source?: Splice | null; readonly target?: Splice | null };
export type Alignment = { source: Span; target: Span | null };
export type Region = { start: ScalarOffset; end: ScalarOffset };
export type PairRegion = { start: ScalarOffset; end: ScalarOffset; core_start: ScalarOffset; core_end: ScalarOffset };
export type Pair = { index: SegmentIndex; status: PairStatus; hard_cut: boolean; source: PairRegion; target: PairRegion };
export type Draft = { source: string; target: string; direction: Direction; alignments: Alignment[] | null };
export type Candidate = { candidate_id: string; zh: string; en: string; category: string; sources: { source_file: string; source_id: string }[] };
export type Finding = { id: string; rule_id: string; verdict: Verdict; source_span: Span; target_span: Span | null; candidates: Candidate[]; candidates_truncated: boolean; reason?: ReasonValue };
export type Report = {
  request_id: string; source_revision: string; target_revision: string; rule_version: string; matcher_revision?: string;
  dictionary: { schema_version: string | null; source_commit: string | null; term_count: number; revision: string };
  coverage: { evaluated: number; not_evaluated: number; rules: string[] };
  findings: Finding[]; truncated: boolean;
};
export type ChoiceBasis = {
  rule_version: string;
  dictionary: { schema_version: string | null; source_commit: string | null; term_count: number; revision: string };
  matcher_revision?: string | null;
};
export type Choice = {
  source: string; direction: Direction; source_span: Span; scope: string; choice: ChoiceKind;
  candidate: Pick<Candidate, 'candidate_id' | 'zh' | 'en' | 'category'> | null;
  basis: ChoiceBasis;
};
export type Resolution = { mention_id: string; choice: ChoiceKind; candidate_id?: string };
export type Snapshot = Draft & { report: Report; trusted: boolean; signature: string; resolutions: Resolution[] | null };
export type Undo = { draft: Draft; choices: Choice[]; imported: Choice[]; reports?: Snapshot[]; semantic: SemanticState; serial?: number; replacedDocument?: boolean };
export type DocumentCheckpoint = { entry: Undo; kind: 'import' | 'replace' | 'clear'; createdAt: number };
export type NoticeState = string | null;
export type ErrorState = { reason?: string; code?: string; text?: string; kind?: 'translation' | 'review'; requestId?: string; retryAfter?: number; waitedSeconds?: number; saveConflict?: boolean } | null;
export type DocumentPhase = 'idle' | 'loading' | 'success' | 'error' | 'cancelled';

type Suggestion = { target_span: Span; replacement: string; term_effect: TermEffect };
export type Issue = {
  id: string; fingerprint: string; category: SemanticCategory; origin: SemanticOrigin; confidence: SemanticConfidence;
  source_span: Span | null; target_span: Span | null; source_excerpt: string | null; target_excerpt: string | null;
  rationale: string; suggestion: Suggestion | null; suggestion_withheld: SuggestionWithheldReason | null;
  alternatives: { replacement: string; term_effect: TermEffect }[]; segment_index: SegmentIndex;
};
export type SemanticReport = { term_basis: { dictionary_revision: string; matcher_revision: string }; issues: Issue[]; status: SemanticResponseStatus; truncated: boolean; omitted_issues: number; dropped_unanchored: number } & Record<string, unknown>;
export type SegResult = {
  id: string; segmentKey: string; index: SegmentIndex; sentSource: string; sentTarget: string; report: SemanticReport;
  doc: { source: string; target: string; sourceRevision: string; targetRevision: string };
  region: { source: Region; target: Region }; imported: boolean;
};
export type Placed = {
  id: string; resultId: string; issue: Issue; occurrence: string; stale: boolean;
  live: { source_span: Span | null; target_span: Span | null; suggestion_span: Span | null };
};
export type Basis = { rule_version: string; dictionary: { schema_version: string; source_commit: string; term_count: number; revision: string }; matcher_revision: string };
export type SessionBasis = Basis | null | false;
export type LongState = import('./long-review.ts').LongState;
export type SegmentRange = { source_start: ScalarOffset; source_end: ScalarOffset; target_start: ScalarOffset; target_end: ScalarOffset };
export type SegmentInput = { pair: Pair; range: SegmentRange; sourceCore: string; targetCore: string; sourceHash: string; targetHash: string; alignments: Alignment[] | null; alignmentInput: string };
export type RecordView = { state: RecordState; ready: boolean; needsCheck: boolean; finished: boolean; choices: (import('./long-review.ts').Choice & { view: ChoiceView })[] };
export type LongCtx = { draft: Draft; basis: SessionBasis; features?: readonly string[] | null };
export type Decision = {
  issue_id: string; fingerprint: string; category: SemanticCategory; segment_index: SegmentIndex; source_revision: string; target_revision: string;
  source_span: Span | null; target_span: Span | null; decision: SemanticDecisionKind; applied_text: string | null;
  basis: { review_version: string; term_basis: { dictionary_revision: string; matcher_revision: string } };
};
type Outcome = { placedId: string; resultId: string; status: 'carried' | 'previously_applied' | 'needs_reconfirmation'; code: string; decision: Decision };
export type SemanticState = {
  results: SegResult[]; placed: Placed[]; decisions: Decision[]; texts: { revision: string; text: string }[];
  outcomes: Outcome[]; history: unknown[]; long: LongState;
};
export type ChoiceLike = { source: string; source_span: Span; choice: string; candidate: { zh: string; en: string } | null };
export type Commit = (next: {
  draft?: Draft;
  splices?: DraftEditSplices;
  semantic?: (state: SemanticState) => SemanticState;
  notice?: string | null;
  remember?: boolean;
}) => number | null;
export type PairView = {
  pair: Pair; sCore: string; tCore: string; key: string; itemKey: string; termKey: string;
  result: SegResult | null; edited: boolean; record: RecordView | null;
};

export type RunKind = 'term' | 'semantic' | 'translate';
export type RunItem = { key: string; index: SegmentIndex; status: RunItemStatus; code: string | null; attempt?: number; waited?: number | null; requestId?: string | null };
export type RunState = {
  kind: RunKind | null; phase: RunPhase; items: RunItem[]; waitUntil: number | null; stopCode: string | null; stopRequestId?: string | null;
  streak?: { code: string | null; count: number };
};
/** Non-text incremental TM reuse receipt (ADR 0023): counts and provenance only, never segment text. */
export type TmRunReceipt = {
  reused: number;
  referenced: number;
  staleOrUnknown: number;
  retranslated: number;
  pendingRetranslate: number;
  demotedByStructureCheck: number;
  demotedSegmentIndices: number[];
  modelCalls: number;
  baselineRequests: number;
  termsDbRevision: string | null;
  gameVersion: string | null;
  structureCheckStatus: 'skipped' | 'passed' | 'findings' | 'unavailable' | 'failed';
};
export type SemanticActionRecord = { placedId: string; marker: number; kind: SemanticDecisionKind };
export type SemanticDecisionCommand =
  | { placedId: string; kind: 'accepted'; useAlternative?: boolean }
  | { placedId: string; kind: 'adjusted'; text: string }
  | { placedId: string; kind: 'ignored' };
export type SemanticDecisionResult =
  | { applied: true; placedId: string; kind: SemanticDecisionKind; serial: number | null; allHandled: boolean }
  | { applied: false; reason: 'missing' | 'invalid' | 'needs_reconfirm' | 'decision_limit' | 'stale' };

export type TermCandidateRef = Pick<Candidate, 'candidate_id' | 'zh' | 'en' | 'category'>;
export type TermFindingRef = { source?: [ScalarOffset, ScalarOffset] | ScalarOffset[]; source_span?: Span };
export type TermChoiceRef = { index: SegmentIndex; start: ScalarOffset; end: ScalarOffset };
export type TermOccurrenceAction =
  | { type: 'adopt'; segmentIndex: SegmentIndex; finding: TermFindingRef; candidate: TermCandidateRef }
  | { type: 'not_a_term'; segmentIndex: SegmentIndex; finding: TermFindingRef }
  | { type: 'replace'; docTarget: Span | null; candidate: TermCandidateRef }
  | { type: 'reconfirm'; at: TermChoiceRef }
  | { type: 'clear_choice'; at: TermChoiceRef };

export type ParagraphCut = { side: 'source' | 'target'; offset: ScalarOffset };
export type TargetRevisionCommand = {
  snapshot: Snapshot;
  generation: number;
  draft: Draft;
  choices: Choice[];
  imported: Choice[];
  finding: Finding;
  candidate: Candidate;
  fragment: string;
  selected: Span | null;
};
export type TargetRevisionResult =
  | { status: 'applied'; target: string; span: Span }
  | { status: 'stale' }
  | { status: 'invalid'; error?: string };

export type ExportArtifact = { filename: string; content: string; mimeType: string };
export type ImportFileLike = { name: string; size: number; arrayBuffer: () => Promise<ArrayBuffer> };
export type PendingWorkfile = {
  draft: Draft;
  choices: Choice[];
  reports: Snapshot[];
  semantic: SemanticState;
  importedBody: string | null;
};
export type ImportOutcome =
  | { status: 'imported' | 'error' | 'ignored' }
  | { status: 'needs_confirm_text'; pendingText: string }
  | { status: 'needs_confirm_workfile'; pendingWorkfile: PendingWorkfile };
