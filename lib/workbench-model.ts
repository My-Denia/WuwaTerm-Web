export type Span = { start: number; end: number; text: string };
export type Alignment = { source: Span; target: Span | null };
export type Region = { start: number; end: number };
type PairRegion = { start: number; end: number; core_start: number; core_end: number };
export type Pair = { index: number; status: 'ready' | 'needs_manual_split' | 'untranslated' | 'unpaired_target'; hard_cut: boolean; source: PairRegion; target: PairRegion };
export type Draft = { source: string; target: string; direction: 'en' | 'zh'; alignments: Alignment[] | null };
export type Candidate = { candidate_id: string; zh: string; en: string; category: string; sources: { source_file: string; source_id: string }[] };
export type Finding = { id: string; rule_id: string; verdict: string; source_span: Span; target_span: Span | null; candidates: Candidate[]; candidates_truncated: boolean; reason?: string };
export type Report = {
  request_id: string; source_revision: string; target_revision: string; rule_version: string; matcher_revision?: string;
  dictionary: { schema_version: string | null; source_commit: string | null; term_count: number; revision: string };
  coverage: { evaluated: number; not_evaluated: number; rules: string[] };
  findings: Finding[]; truncated: boolean;
};
export type ChoiceBasis = {
  rule_version: string;
  dictionary: { schema_version: string | null; source_commit: string | null; term_count: number; revision: string };
  matcher_revision: string | null;
};
export type Choice = {
  source: string; direction: string; source_span: Span; scope: string; choice: string;
  candidate: Pick<Candidate, 'candidate_id' | 'zh' | 'en' | 'category'> | null;
  basis: ChoiceBasis;
};
export type Resolution = { mention_id: string; choice: string; candidate_id?: string };
export type Snapshot = Draft & { report: Report; trusted: boolean; signature: string; resolutions: Resolution[] | null };
export type Undo = { draft: Draft; choices: Choice[]; imported: Choice[]; reports?: Snapshot[]; semantic: SemanticState; serial?: number; replacedDocument?: boolean };
export type NoticeState = string | null;
export type ErrorState = { reason?: string; code?: string; text?: string; kind?: 'translation' | 'review'; requestId?: string; retryAfter?: number } | null;
export type DocumentPhase = 'idle' | 'loading' | 'success' | 'error' | 'cancelled';

type Suggestion = { target_span: Span; replacement: string; term_effect: string };
export type Issue = {
  id: string; fingerprint: string; category: string; origin: string; confidence: string;
  source_span: Span | null; target_span: Span | null; source_excerpt: string | null; target_excerpt: string | null;
  rationale: string; suggestion: Suggestion | null; suggestion_withheld: string | null;
  alternatives: { replacement: string; term_effect: string }[]; segment_index: number;
};
export type SemanticReport = { term_basis: { dictionary_revision: string; matcher_revision: string }; issues: Issue[]; status: string; truncated: boolean; omitted_issues: number; dropped_unanchored: number } & Record<string, unknown>;
export type SegResult = {
  id: string; segmentKey: string; index: number; sentSource: string; sentTarget: string; report: SemanticReport;
  doc: { source: string; target: string; sourceRevision: string; targetRevision: string };
  region: { source: Region; target: Region }; imported: boolean;
};
export type Placed = {
  id: string; resultId: string; issue: Issue; occurrence: string; stale: boolean;
  live: { source_span: Span | null; target_span: Span | null; suggestion_span: Span | null };
};
export type Basis = { rule_version: string; dictionary: { schema_version: string; source_commit: string; term_count: number; revision: string }; matcher_revision: string };
export type SessionBasis = Basis | null | false;
export type LongState = import('./long-review.js').LongState;
export type SegmentInput = { pair: Pair; range: { source_start: number; source_end: number; target_start: number; target_end: number }; sourceCore: string; targetCore: string; sourceHash: string; targetHash: string };
export type RecordState = 'pending' | 'saved' | 'current' | 'stale';
export type RecordView = { state: RecordState; ready: boolean; needsCheck: boolean; finished: boolean; choices: (import('./long-review.js').Choice & { view: 'applies' | 'needs_reconfirmation' | 'waiting' })[] };
export type LongCtx = { draft: Draft; basis: SessionBasis };
export type Decision = {
  issue_id: string; fingerprint: string; category: string; segment_index: number; source_revision: string; target_revision: string;
  source_span: Span | null; target_span: Span | null; decision: 'accepted' | 'adjusted' | 'ignored'; applied_text: string | null;
  basis: { review_version: string; term_basis: { dictionary_revision: string; matcher_revision: string } };
};
type Outcome = { placedId: string; resultId: string; status: string; code: string; decision: Decision };
export type SemanticState = {
  results: SegResult[]; placed: Placed[]; decisions: Decision[]; texts: { revision: string; text: string }[];
  outcomes: Outcome[]; history: unknown[]; long: LongState;
};
export type ChoiceLike = { source: string; source_span: Span; choice: string; candidate: { zh: string; en: string } | null };
export type Commit = (next: { draft?: Draft; semantic?: (state: SemanticState) => SemanticState; notice?: string | null; remember?: boolean }) => number | null;
export type PairView = {
  pair: Pair; sCore: string; tCore: string; key: string; itemKey: string; termKey: string;
  result: SegResult | null; edited: boolean; record: RecordView | null;
};

export type RunKind = 'term' | 'semantic' | 'translate';
export type RunItem = { key: string; index: number; status: string; code: string | null; attempt?: number; waited?: number | null; requestId?: string | null };
export type RunState = {
  kind: RunKind | null; phase: string; items: RunItem[]; waitUntil: number | null; stopCode: string | null; stopRequestId?: string | null;
  streak?: { code: string | null; count: number };
};
export type ExportArtifact = { filename: string; content: string; mimeType: string };
export type ImportFileLike = { name: string; size: number; arrayBuffer: () => Promise<ArrayBuffer> };
export type ImportOutcome = { status: 'imported' | 'error' | 'ignored' } | { status: 'needs_confirm_text'; pendingText: string };
