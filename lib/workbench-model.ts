import type { MutableRefObject } from 'react';

export type Span = { start: number; end: number; text: string };
export type Region = { start: number; end: number };
type PairRegion = { start: number; end: number; core_start: number; core_end: number };
export type Pair = { index: number; status: 'ready' | 'needs_manual_split' | 'untranslated' | 'unpaired_target'; hard_cut: boolean; source: PairRegion; target: PairRegion };
export type Draft = { source: string; target: string; direction: 'en' | 'zh'; alignments: { source: Span; target: Span | null }[] | null };
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
export type WorkRef = MutableRefObject<{ draft: Draft; semantic: SemanticState }>;
export type PairView = {
  pair: Pair; sCore: string; tCore: string; key: string; itemKey: string; termKey: string;
  result: SegResult | null; edited: boolean; record: RecordView | null;
};
