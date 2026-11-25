// GENERATED FILE — DO NOT EDIT DIRECTLY.
// Source: contracts/schemas/manuscript.schema.json (`npm run generate:contracts`).

export const DIRECTION_VALUES = ['en', 'zh'] as const;
export type Direction = (typeof DIRECTION_VALUES)[number];

export const VERDICT_VALUES = ['verified_constraint', 'confirmed_conflict', 'needs_review', 'not_evaluated'] as const;
export type Verdict = (typeof VERDICT_VALUES)[number];

export const REASON_VALUES = [
  'not_a_term',
  'ordinary_word',
  'no_target_region',
  'found_outside_region',
  'ambiguous_repeat',
] as const;
export type ReasonValue = (typeof REASON_VALUES)[number];

export const REASON_VALUES_V5 = [
  'not_a_term',
  'ordinary_word',
  'no_target_region',
  'found_outside_region',
  'ambiguous_repeat',
  'ambiguous_mention',
] as const;
export type ReasonValueV5 = (typeof REASON_VALUES_V5)[number];

export const REVIEW_FEATURE_VALUES = ['ambiguous-mention-v1'] as const;
export type ReviewFeature = (typeof REVIEW_FEATURE_VALUES)[number];

export const SEGMENTATION_VERSION_V5_VALUES = ['segmentation-v1', 'segmentation-v1-gaps'] as const;
export type SegmentationVersionV5 = (typeof SEGMENTATION_VERSION_V5_VALUES)[number];

export const CHOICE_KIND_VALUES = ['official_pair', 'not_a_term'] as const;
export type ChoiceKind = (typeof CHOICE_KIND_VALUES)[number];

export const RECORD_STATUS_VALUES = ['pending', 'done', 'stale'] as const;
export type RecordStatus = (typeof RECORD_STATUS_VALUES)[number];

export const SEMANTIC_CATEGORY_VALUES = [
  'omission',
  'unsupported_addition',
  'meaning_shift',
  'negation_change',
  'quantity_change',
  'reference_inconsistency',
  'term_sense',
] as const;
export type SemanticCategory = (typeof SEMANTIC_CATEGORY_VALUES)[number];

export const SEMANTIC_ORIGIN_VALUES = ['model'] as const;
export type SemanticOrigin = (typeof SEMANTIC_ORIGIN_VALUES)[number];

export const SEMANTIC_CONFIDENCE_VALUES = ['high', 'medium', 'low'] as const;
export type SemanticConfidence = (typeof SEMANTIC_CONFIDENCE_VALUES)[number];

export const TERM_EFFECT_VALUES = ['none', 'alters_official_match', 'introduces_official_form', 'not_checked'] as const;
export type TermEffect = (typeof TERM_EFFECT_VALUES)[number];

export const SUGGESTION_WITHHELD_REASON_VALUES = ['span_too_long', 'replacement_too_long'] as const;
export type SuggestionWithheldReason = (typeof SUGGESTION_WITHHELD_REASON_VALUES)[number];

export const TRUNCATED_REASON_VALUES = ['issue_limit', 'byte_limit'] as const;
export type TruncatedReason = (typeof TRUNCATED_REASON_VALUES)[number];

export const SEMANTIC_RESPONSE_STATUS_VALUES = ['complete', 'not_reviewed'] as const;
export type SemanticResponseStatus = (typeof SEMANTIC_RESPONSE_STATUS_VALUES)[number];

export const SEMANTIC_DECISION_KIND_VALUES = ['accepted', 'adjusted', 'ignored'] as const;
export type SemanticDecisionKind = (typeof SEMANTIC_DECISION_KIND_VALUES)[number];

export const WORKFILE_FORMAT_VALUES = [
  'wuwaterm-manuscript-v1',
  'wuwaterm-manuscript-v2',
  'wuwaterm-manuscript-v3',
  'wuwaterm-manuscript-v4',
  'wuwaterm-manuscript-v5',
] as const;
export type WorkfileFormat = (typeof WORKFILE_FORMAT_VALUES)[number];

export type ContractSpan = { start: number; end: number; text: string };

export type ContractAlignment = { source: ContractSpan; target: null | ContractSpan };

export type ContractCandidateSource = { source_file: string; source_id: string };

export type ContractCompactCandidate = { candidate_id: string; zh: string; en: string; category: string };

export type ContractCandidateV1 = { zh: string; en: string; category: string; sources: ContractCandidateSource[] };

export type ContractCandidateV2 = { candidate_id: string; zh: string; en: string; category: string; sources: ContractCandidateSource[] };

export type ContractDictionaryV1 = { schema_version: string | null; source_commit: string | null; term_count: number };

export type ContractDictionaryV2 = { schema_version: string | null; source_commit: string | null; term_count: number; revision: string };

export type ContractStrictDictionaryV3 = { schema_version: string; source_commit: string; term_count: number; revision: string };

export type ContractReviewCoverage = { evaluated: number; not_evaluated: number; rules: string[] };

export type ContractFindingV1 = { id: string; rule_id: string; verdict: Verdict; source_span: ContractSpan; target_span: null | ContractSpan; candidates: ContractCandidateV1[]; candidates_truncated: boolean };

export type ContractFindingV2 = { id: string; rule_id: string; verdict: Verdict; source_span: ContractSpan; target_span: null | ContractSpan; candidates: ContractCandidateV2[]; candidates_truncated: boolean };

export type ContractFindingV4 = { id: string; rule_id: string; verdict: Verdict; source_span: ContractSpan; target_span: null | ContractSpan; candidates: ContractCandidateV2[]; candidates_truncated: boolean } | { id: string; rule_id: string; verdict: "not_evaluated"; source_span: ContractSpan; target_span: null | ContractSpan; candidates: ContractCandidateV2[]; candidates_truncated: boolean; reason: ReasonValue };

export type ContractFindingV5 = { id: string; rule_id: string; verdict: Verdict; source_span: ContractSpan; target_span: null | ContractSpan; candidates: ContractCandidateV2[]; candidates_truncated: boolean } | { id: string; rule_id: string; verdict: "not_evaluated"; source_span: ContractSpan; target_span: null | ContractSpan; candidates: ContractCandidateV2[]; candidates_truncated: boolean; reason: ReasonValueV5 };

export type ContractReportV1 = { request_id: string; source_revision: string; target_revision: string; rule_version: "review-v1"; matcher_revision?: string; dictionary: ContractDictionaryV1; coverage: ContractReviewCoverage; findings: ContractFindingV1[]; truncated: boolean };

export type ContractReportV2 = { request_id: string; source_revision: string; target_revision: string; rule_version: "review-v2"; matcher_revision?: string; dictionary: ContractDictionaryV2; coverage: ContractReviewCoverage; findings: ContractFindingV2[]; truncated: boolean };

export type ContractReportV4 = { request_id: string; source_revision: string; target_revision: string; rule_version: "review-v2"; matcher_revision?: string; dictionary: ContractDictionaryV2; coverage: ContractReviewCoverage; findings: ContractFindingV4[]; truncated: boolean };

export type ContractReportV5 = { request_id: string; source_revision: string; target_revision: string; rule_version: "review-v2"; matcher_revision?: string; dictionary: ContractDictionaryV2; coverage: ContractReviewCoverage; findings: ContractFindingV5[]; truncated: boolean };

export type ContractChoiceBasis = { rule_version: "review-v2"; dictionary: ContractDictionaryV2; matcher_revision?: string };

export type ContractDocumentChoice = { source: string; direction: Direction; source_span: ContractSpan; scope: string; choice: "not_a_term"; candidate: null; basis: ContractChoiceBasis } | { source: string; direction: Direction; source_span: ContractSpan; scope: string; choice: "official_pair"; candidate: ContractCompactCandidate; basis: ContractChoiceBasis };

export type ContractResolution = { mention_id: string; choice: "not_a_term" } | { mention_id: string; choice: "official_pair"; candidate_id: string };

export type ContractHistorySnapshotV1toV3 = { source: string; target: string; direction: Direction; alignments: null | ContractAlignment[]; report: ContractReportV1 | ContractReportV2; resolutions?: ContractResolution[] };

export type ContractHistorySnapshotV4 = { source: string; target: string; direction: Direction; alignments: null | ContractAlignment[]; report: ContractReportV1 | ContractReportV4; resolutions?: ContractResolution[] };

export type ContractHistorySnapshotV5 = { source: string; target: string; direction: Direction; alignments: null | ContractAlignment[]; report: ContractReportV1 | ContractReportV5; resolutions?: ContractResolution[] };

export type ContractSemanticTermBasis = { dictionary_revision: string; matcher_revision: string };

export type ContractSemanticDecisionBasis = { review_version: "semantic-review-v1"; term_basis: ContractSemanticTermBasis };

export type ContractSemanticDecision = { issue_id: string; fingerprint: string; category: SemanticCategory; segment_index: number; source_revision: string; target_revision: string; source_span: null | ContractSpan; target_span: null | ContractSpan; decision: "ignored"; applied_text: null; basis: ContractSemanticDecisionBasis } | { issue_id: string; fingerprint: string; category: SemanticCategory; segment_index: number; source_revision: string; target_revision: string; source_span: null | ContractSpan; target_span: null | ContractSpan; decision: "accepted" | "adjusted"; applied_text: string; basis: ContractSemanticDecisionBasis };

export type ContractSemanticText = { revision: string; text: string };

export type ContractSemanticSuggestion = { target_span: ContractSpan; replacement: string; term_effect: TermEffect };

export type ContractSemanticAlternative = { replacement: string; term_effect: TermEffect };

export type ContractSemanticIssue = { id: string; fingerprint: string; category: SemanticCategory; origin: SemanticOrigin; confidence: SemanticConfidence; source_span: null | ContractSpan; target_span: null | ContractSpan; source_excerpt: string | null; target_excerpt: string | null; rationale: string; suggestion: null; suggestion_withheld: null | SuggestionWithheldReason; alternatives: ContractSemanticAlternative[] } | { id: string; fingerprint: string; category: SemanticCategory; origin: SemanticOrigin; confidence: SemanticConfidence; source_span: null | ContractSpan; target_span: null | ContractSpan; source_excerpt: string | null; target_excerpt: string | null; rationale: string; suggestion: ContractSemanticSuggestion; suggestion_withheld: null; alternatives: ContractSemanticAlternative[] };

export type ContractSemanticReport = { request_id: string; review_version: "semantic-review-v1"; source_revision: string; target_revision: string; term_basis: ContractSemanticTermBasis; status: SemanticResponseStatus; status_reason: null | "invalid_model_output"; dropped_unanchored: number; checked: SemanticCategory[]; issues: ContractSemanticIssue[]; truncated: boolean; truncated_reason: null | TruncatedReason; omitted_issues: number };

export type ContractSemanticHistorySegment = { segment_index: number; source_start: number; source_end: number; target_start: number; target_end: number; report: ContractSemanticReport };

export type ContractSemanticHistorySnapshot = { source: string; target: string; direction: Direction; segments: ContractSemanticHistorySegment[] };

export type ContractV3Basis = { rule_version: "review-v2"; dictionary: ContractStrictDictionaryV3; matcher_revision: string };

export type ContractCompactFindingV3 = { verdict: Verdict; source: [number, number]; target: null | [number, number]; candidates: ContractCompactCandidate[]; candidates_truncated: boolean };

export type ContractCompactFindingV4 = { verdict: Verdict; source: [number, number]; target: null | [number, number]; candidates: ContractCompactCandidate[]; candidates_truncated: boolean } | { verdict: "not_evaluated"; source: [number, number]; target: null | [number, number]; candidates: ContractCompactCandidate[]; candidates_truncated: boolean; reason: ReasonValue };

export type ContractCompactFindingV5 = { verdict: Verdict; source: [number, number]; target: null | [number, number]; candidates: ContractCompactCandidate[]; candidates_truncated: boolean } | { verdict: "not_evaluated"; source: [number, number]; target: null | [number, number]; candidates: ContractCompactCandidate[]; candidates_truncated: boolean; reason: ReasonValueV5 };

export type ContractCompactResultV3 = { truncated: boolean; evaluated: number; not_evaluated: number; findings: ContractCompactFindingV3[] };

export type ContractCompactResultV4 = { truncated: boolean; evaluated: number; not_evaluated: number; findings: ContractCompactFindingV4[] };

export type ContractCompactResultV5 = { truncated: boolean; evaluated: number; not_evaluated: number; findings: ContractCompactFindingV5[] };

export type ContractSegmentChoice = { source_span: ContractSpan; choice: "official_pair"; candidate: ContractCompactCandidate; offered: string[]; confirmed: boolean } | { source_span: ContractSpan; choice: "not_a_term"; candidate: null; offered: string[]; confirmed: boolean };

export type ContractPendingSegmentChoice = ContractSegmentChoice & { confirmed?: false };

export type ContractSegmentHistoryEntry = { source_hash: string; source_span: ContractSpan; choice: "official_pair"; candidate: ContractCompactCandidate; offered: string[] } | { source_hash: string; source_span: ContractSpan; choice: "not_a_term"; candidate: null; offered: string[] };

export type ContractSegmentRecordV3 = { index: number; segmentation_version: 'segmentation-v1'; source_start: number; source_end: number; target_start: number; target_end: number; source_hash: string; target_hash: string; status: "pending"; direction: null; alignment_input: null; basis: null; result: null; choices: ContractPendingSegmentChoice[] } | { index: number; segmentation_version: 'segmentation-v1'; source_start: number; source_end: number; target_start: number; target_end: number; source_hash: string; target_hash: string; status: "done" | "stale"; direction: Direction; alignment_input: "automatic" | string; basis: ContractV3Basis; result: ContractCompactResultV3; choices: ContractSegmentChoice[] };

export type ContractSegmentRecordV4 = { index: number; segmentation_version: 'segmentation-v1'; source_start: number; source_end: number; target_start: number; target_end: number; source_hash: string; target_hash: string; status: "pending"; direction: null; alignment_input: null; basis: null; result: null; choices: ContractPendingSegmentChoice[] } | { index: number; segmentation_version: 'segmentation-v1'; source_start: number; source_end: number; target_start: number; target_end: number; source_hash: string; target_hash: string; status: "done" | "stale"; direction: Direction; alignment_input: "automatic" | string; basis: ContractV3Basis; result: ContractCompactResultV4; choices: ContractSegmentChoice[] };

export type ContractSegmentRecordV5 = { index: number; segmentation_version: SegmentationVersionV5; source_start: number; source_end: number; target_start: number; target_end: number; source_hash: string; target_hash: string; status: "pending"; direction: null; alignment_input: null; basis: null; result: null; choices: ContractPendingSegmentChoice[] } | { index: number; segmentation_version: SegmentationVersionV5; source_start: number; source_end: number; target_start: number; target_end: number; source_hash: string; target_hash: string; status: "done" | "stale"; direction: Direction; alignment_input: "automatic" | string; basis: ContractV3Basis; result: ContractCompactResultV5; choices: ContractSegmentChoice[] };

export type ContractProgress = { current: number | null; completed: number[] };

export type ContractManuscriptV1 = { format: "wuwaterm-manuscript-v1"; source: string; target: string; direction: Direction; alignments: null | ContractAlignment[]; choices: ContractDocumentChoice[]; history: ContractHistorySnapshotV1toV3[] };

export type ContractManuscriptV2 = { format: "wuwaterm-manuscript-v2"; source: string; target: string; direction: Direction; alignments: null | ContractAlignment[]; choices: ContractDocumentChoice[]; history: ContractHistorySnapshotV1toV3[]; semantic_decisions: ContractSemanticDecision[]; semantic_texts: ContractSemanticText[]; semantic_history: ContractSemanticHistorySnapshot[] };

export type ContractManuscriptV3 = { format: "wuwaterm-manuscript-v3"; source: string; target: string; direction: Direction; alignments: null | ContractAlignment[]; choices: ContractDocumentChoice[]; history: ContractHistorySnapshotV1toV3[]; semantic_decisions: ContractSemanticDecision[]; semantic_texts: ContractSemanticText[]; semantic_history: ContractSemanticHistorySnapshot[]; segments: ContractSegmentRecordV3[]; segment_choice_history: ContractSegmentHistoryEntry[]; progress: ContractProgress };

export type ContractManuscriptV4 = { format: "wuwaterm-manuscript-v4"; source: string; target: string; direction: Direction; alignments: null | ContractAlignment[]; choices: ContractDocumentChoice[]; history: ContractHistorySnapshotV4[]; semantic_decisions: ContractSemanticDecision[]; semantic_texts: ContractSemanticText[]; semantic_history: ContractSemanticHistorySnapshot[]; segments: ContractSegmentRecordV4[]; segment_choice_history: ContractSegmentHistoryEntry[]; progress: ContractProgress };

export type ContractManuscriptV5 = { format: "wuwaterm-manuscript-v5"; source: string; target: string; direction: Direction; alignments: null | ContractAlignment[]; choices: ContractDocumentChoice[]; history: ContractHistorySnapshotV5[]; semantic_decisions: ContractSemanticDecision[]; semantic_texts: ContractSemanticText[]; semantic_history: ContractSemanticHistorySnapshot[]; segments: ContractSegmentRecordV5[]; segment_choice_history: ContractSegmentHistoryEntry[]; progress: ContractProgress; review_features: ReviewFeature[] };

export type ContractManuscript =
  | ContractManuscriptV1
  | ContractManuscriptV2
  | ContractManuscriptV3
  | ContractManuscriptV4
  | ContractManuscriptV5;
