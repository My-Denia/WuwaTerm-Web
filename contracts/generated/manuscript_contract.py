# GENERATED FILE — DO NOT EDIT DIRECTLY.
# Source: contracts/schemas/manuscript.schema.json (`npm run generate:contracts`).

from __future__ import annotations

from typing import Literal, NotRequired, TypedDict

DIRECTION_VALUES: tuple[str, ...] = ("en", "zh",)
Direction = Literal["en", "zh"]

VERDICT_VALUES: tuple[str, ...] = ("verified_constraint", "confirmed_conflict", "needs_review", "not_evaluated",)
Verdict = Literal["verified_constraint", "confirmed_conflict", "needs_review", "not_evaluated"]

REASON_VALUES: tuple[str, ...] = ("not_a_term", "ordinary_word", "no_target_region", "found_outside_region", "ambiguous_repeat",)
ReasonValue = Literal["not_a_term", "ordinary_word", "no_target_region", "found_outside_region", "ambiguous_repeat"]

CHOICE_KIND_VALUES: tuple[str, ...] = ("official_pair", "not_a_term",)
ChoiceKind = Literal["official_pair", "not_a_term"]

RECORD_STATUS_VALUES: tuple[str, ...] = ("pending", "done", "stale",)
RecordStatus = Literal["pending", "done", "stale"]

SEMANTIC_CATEGORY_VALUES: tuple[str, ...] = ("omission", "unsupported_addition", "meaning_shift", "negation_change", "quantity_change", "reference_inconsistency", "term_sense",)
SemanticCategory = Literal["omission", "unsupported_addition", "meaning_shift", "negation_change", "quantity_change", "reference_inconsistency", "term_sense"]

SEMANTIC_ORIGIN_VALUES: tuple[str, ...] = ("model",)
SemanticOrigin = Literal["model"]

SEMANTIC_CONFIDENCE_VALUES: tuple[str, ...] = ("high", "medium", "low",)
SemanticConfidence = Literal["high", "medium", "low"]

TERM_EFFECT_VALUES: tuple[str, ...] = ("none", "alters_official_match", "introduces_official_form", "not_checked",)
TermEffect = Literal["none", "alters_official_match", "introduces_official_form", "not_checked"]

SUGGESTION_WITHHELD_REASON_VALUES: tuple[str, ...] = ("span_too_long", "replacement_too_long",)
SuggestionWithheldReason = Literal["span_too_long", "replacement_too_long"]

TRUNCATED_REASON_VALUES: tuple[str, ...] = ("issue_limit", "byte_limit",)
TruncatedReason = Literal["issue_limit", "byte_limit"]

SEMANTIC_RESPONSE_STATUS_VALUES: tuple[str, ...] = ("complete", "not_reviewed",)
SemanticResponseStatus = Literal["complete", "not_reviewed"]

SEMANTIC_DECISION_KIND_VALUES: tuple[str, ...] = ("accepted", "adjusted", "ignored",)
SemanticDecisionKind = Literal["accepted", "adjusted", "ignored"]

WORKFILE_FORMAT_VALUES: tuple[str, ...] = ("wuwaterm-manuscript-v1", "wuwaterm-manuscript-v2", "wuwaterm-manuscript-v3", "wuwaterm-manuscript-v4",)
WorkfileFormat = Literal["wuwaterm-manuscript-v1", "wuwaterm-manuscript-v2", "wuwaterm-manuscript-v3", "wuwaterm-manuscript-v4"]

class ContractSpan(TypedDict):
    start: int
    end: int
    text: str

class ContractAlignment(TypedDict):
    source: ContractSpan
    target: None | ContractSpan

class ContractCandidateSource(TypedDict):
    source_file: str
    source_id: str

class ContractCompactCandidate(TypedDict):
    candidate_id: str
    zh: str
    en: str
    category: str

class ContractCandidateV1(TypedDict):
    zh: str
    en: str
    category: str
    sources: list[ContractCandidateSource]

class ContractCandidateV2(TypedDict):
    candidate_id: str
    zh: str
    en: str
    category: str
    sources: list[ContractCandidateSource]

class ContractDictionaryV1(TypedDict):
    schema_version: str | None
    source_commit: str | None
    term_count: int

class ContractDictionaryV2(TypedDict):
    schema_version: str | None
    source_commit: str | None
    term_count: int
    revision: str

class ContractStrictDictionaryV3(TypedDict):
    schema_version: str
    source_commit: str
    term_count: int
    revision: str

class ContractReviewCoverage(TypedDict):
    evaluated: int
    not_evaluated: int
    rules: list[str]

class ContractFindingV1(TypedDict):
    id: str
    rule_id: str
    verdict: Verdict
    source_span: ContractSpan
    target_span: None | ContractSpan
    candidates: list[ContractCandidateV1]
    candidates_truncated: bool

class ContractFindingV2(TypedDict):
    id: str
    rule_id: str
    verdict: Verdict
    source_span: ContractSpan
    target_span: None | ContractSpan
    candidates: list[ContractCandidateV2]
    candidates_truncated: bool

class ContractFindingV4(TypedDict):
    id: str
    rule_id: str
    verdict: Verdict | Literal['not_evaluated']
    source_span: ContractSpan
    target_span: None | ContractSpan
    candidates: list[ContractCandidateV2]
    candidates_truncated: bool

class ContractReportV1(TypedDict):
    request_id: str
    source_revision: str
    target_revision: str
    rule_version: Literal['review-v1']
    matcher_revision: NotRequired[str]
    dictionary: ContractDictionaryV1
    coverage: ContractReviewCoverage
    findings: list[ContractFindingV1]
    truncated: bool

class ContractReportV2(TypedDict):
    request_id: str
    source_revision: str
    target_revision: str
    rule_version: Literal['review-v2']
    matcher_revision: NotRequired[str]
    dictionary: ContractDictionaryV2
    coverage: ContractReviewCoverage
    findings: list[ContractFindingV2]
    truncated: bool

class ContractReportV4(TypedDict):
    request_id: str
    source_revision: str
    target_revision: str
    rule_version: Literal['review-v2']
    matcher_revision: NotRequired[str]
    dictionary: ContractDictionaryV2
    coverage: ContractReviewCoverage
    findings: list[ContractFindingV4]
    truncated: bool

class ContractChoiceBasis(TypedDict):
    rule_version: Literal['review-v2']
    dictionary: ContractDictionaryV2
    matcher_revision: NotRequired[str]

class ContractDocumentChoice(TypedDict):
    source: str
    direction: Direction
    source_span: ContractSpan
    scope: str
    choice: Literal['not_a_term'] | Literal['official_pair']
    candidate: None | ContractCompactCandidate
    basis: ContractChoiceBasis

class ContractResolution(TypedDict):
    mention_id: str
    choice: Literal['not_a_term'] | Literal['official_pair']

class ContractHistorySnapshotV1toV3(TypedDict):
    source: str
    target: str
    direction: Direction
    alignments: None | list[ContractAlignment]
    report: ContractReportV1 | ContractReportV2
    resolutions: NotRequired[list[ContractResolution]]

class ContractHistorySnapshotV4(TypedDict):
    source: str
    target: str
    direction: Direction
    alignments: None | list[ContractAlignment]
    report: ContractReportV1 | ContractReportV4
    resolutions: NotRequired[list[ContractResolution]]

class ContractSemanticTermBasis(TypedDict):
    dictionary_revision: str
    matcher_revision: str

class ContractSemanticDecisionBasis(TypedDict):
    review_version: Literal['semantic-review-v1']
    term_basis: ContractSemanticTermBasis

class ContractSemanticDecision(TypedDict):
    issue_id: str
    fingerprint: str
    category: SemanticCategory
    segment_index: int
    source_revision: str
    target_revision: str
    source_span: None | ContractSpan
    target_span: None | ContractSpan
    decision: Literal['ignored'] | Literal['accepted', 'adjusted']
    applied_text: None | str
    basis: ContractSemanticDecisionBasis

class ContractSemanticText(TypedDict):
    revision: str
    text: str

class ContractSemanticSuggestion(TypedDict):
    target_span: ContractSpan
    replacement: str
    term_effect: TermEffect

class ContractSemanticAlternative(TypedDict):
    replacement: str
    term_effect: TermEffect

class ContractSemanticIssue(TypedDict):
    id: str
    fingerprint: str
    category: SemanticCategory
    origin: SemanticOrigin
    confidence: SemanticConfidence
    source_span: None | ContractSpan
    target_span: None | ContractSpan
    source_excerpt: str | None
    target_excerpt: str | None
    rationale: str
    suggestion: None | ContractSemanticSuggestion
    suggestion_withheld: None | SuggestionWithheldReason | None
    alternatives: list[ContractSemanticAlternative]

class ContractSemanticReport(TypedDict):
    request_id: str
    review_version: Literal['semantic-review-v1']
    source_revision: str
    target_revision: str
    term_basis: ContractSemanticTermBasis
    status: SemanticResponseStatus
    status_reason: Literal['invalid_model_output'] | None
    dropped_unanchored: int
    checked: list[SemanticCategory]
    issues: list[ContractSemanticIssue]
    truncated: bool
    truncated_reason: None | TruncatedReason
    omitted_issues: int

class ContractSemanticHistorySegment(TypedDict):
    segment_index: int
    source_start: int
    source_end: int
    target_start: int
    target_end: int
    report: ContractSemanticReport

class ContractSemanticHistorySnapshot(TypedDict):
    source: str
    target: str
    direction: Direction
    segments: list[ContractSemanticHistorySegment]

class ContractV3Basis(TypedDict):
    rule_version: Literal['review-v2']
    dictionary: ContractStrictDictionaryV3
    matcher_revision: str

class ContractCompactFindingV3(TypedDict):
    verdict: Verdict
    source: tuple[int, int]
    target: None | tuple[int, int]
    candidates: list[ContractCompactCandidate]
    candidates_truncated: bool

class ContractCompactFindingV4(TypedDict):
    verdict: Verdict | Literal['not_evaluated']
    source: tuple[int, int]
    target: None | tuple[int, int]
    candidates: list[ContractCompactCandidate]
    candidates_truncated: bool

class ContractCompactResultV3(TypedDict):
    truncated: bool
    evaluated: int
    not_evaluated: int
    findings: list[ContractCompactFindingV3]

class ContractCompactResultV4(TypedDict):
    truncated: bool
    evaluated: int
    not_evaluated: int
    findings: list[ContractCompactFindingV4]

class ContractSegmentChoice(TypedDict):
    source_span: ContractSpan
    choice: Literal['official_pair'] | Literal['not_a_term']
    candidate: ContractCompactCandidate | None
    offered: list[str]
    confirmed: bool

class ContractPendingSegmentChoice(TypedDict):
    source_span: ContractSpan
    choice: Literal['official_pair'] | Literal['not_a_term']
    candidate: ContractCompactCandidate | None
    offered: list[str]
    confirmed: Literal[False]

class ContractSegmentHistoryEntry(TypedDict):
    source_hash: str
    source_span: ContractSpan
    choice: Literal['official_pair'] | Literal['not_a_term']
    candidate: ContractCompactCandidate | None
    offered: list[str]

class ContractSegmentRecordV3(TypedDict):
    index: int
    segmentation_version: Literal['segmentation-v1']
    source_start: int
    source_end: int
    target_start: int
    target_end: int
    source_hash: str
    target_hash: str
    status: Literal['pending'] | Literal['done', 'stale']
    direction: None | Direction
    alignment_input: None | Literal['automatic'] | str
    basis: None | ContractV3Basis
    result: None | ContractCompactResultV3
    choices: list[ContractPendingSegmentChoice] | list[ContractSegmentChoice]

class ContractSegmentRecordV4(TypedDict):
    index: int
    segmentation_version: Literal['segmentation-v1']
    source_start: int
    source_end: int
    target_start: int
    target_end: int
    source_hash: str
    target_hash: str
    status: Literal['pending'] | Literal['done', 'stale']
    direction: None | Direction
    alignment_input: None | Literal['automatic'] | str
    basis: None | ContractV3Basis
    result: None | ContractCompactResultV4
    choices: list[ContractPendingSegmentChoice] | list[ContractSegmentChoice]

class ContractProgress(TypedDict):
    current: int | None
    completed: list[int]

class ContractManuscriptV1(TypedDict):
    format: Literal['wuwaterm-manuscript-v1']
    source: str
    target: str
    direction: Direction
    alignments: None | list[ContractAlignment]
    choices: list[ContractDocumentChoice]
    history: list[ContractHistorySnapshotV1toV3]

class ContractManuscriptV2(TypedDict):
    format: Literal['wuwaterm-manuscript-v2']
    source: str
    target: str
    direction: Direction
    alignments: None | list[ContractAlignment]
    choices: list[ContractDocumentChoice]
    history: list[ContractHistorySnapshotV1toV3]
    semantic_decisions: list[ContractSemanticDecision]
    semantic_texts: list[ContractSemanticText]
    semantic_history: list[ContractSemanticHistorySnapshot]

class ContractManuscriptV3(TypedDict):
    format: Literal['wuwaterm-manuscript-v3']
    source: str
    target: str
    direction: Direction
    alignments: None | list[ContractAlignment]
    choices: list[ContractDocumentChoice]
    history: list[ContractHistorySnapshotV1toV3]
    semantic_decisions: list[ContractSemanticDecision]
    semantic_texts: list[ContractSemanticText]
    semantic_history: list[ContractSemanticHistorySnapshot]
    segments: list[ContractSegmentRecordV3]
    segment_choice_history: list[ContractSegmentHistoryEntry]
    progress: ContractProgress

class ContractManuscriptV4(TypedDict):
    format: Literal['wuwaterm-manuscript-v4']
    source: str
    target: str
    direction: Direction
    alignments: None | list[ContractAlignment]
    choices: list[ContractDocumentChoice]
    history: list[ContractHistorySnapshotV4]
    semantic_decisions: list[ContractSemanticDecision]
    semantic_texts: list[ContractSemanticText]
    semantic_history: list[ContractSemanticHistorySnapshot]
    segments: list[ContractSegmentRecordV4]
    segment_choice_history: list[ContractSegmentHistoryEntry]
    progress: ContractProgress

ContractManuscript = (
    ContractManuscriptV1
    | ContractManuscriptV2
    | ContractManuscriptV3
    | ContractManuscriptV4
)
