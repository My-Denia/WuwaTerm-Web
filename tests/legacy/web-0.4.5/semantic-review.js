// Frozen Web 0.4.5 module (tag v0.4.5, lib/semantic-review.js) for the legacy_error check of manuscript v5; do not edit.
// semantic-review-v1 and translation-context-v1 wire rules (Core ADR 0018/0019).
// Pure and browser-safe: the BFF validates with it and the workbench reuses it.
// Every length is counted in Unicode scalars (Array.from), as Core does.
import { revisionOf } from './review-report.js';

/**
 * @typedef {import('./workbench-model.ts').Direction} Direction
 * @typedef {import('./workbench-model.ts').Issue} Issue
 * @typedef {import('./workbench-model.ts').PrecedentChoice} PrecedentChoice
 * @typedef {import('./workbench-model.ts').ScalarOffset} ScalarOffset
 * @typedef {import('./workbench-model.ts').SemanticCategory} SemanticCategory
 * @typedef {import('./workbench-model.ts').SemanticConfidence} SemanticConfidence
 * @typedef {import('./workbench-model.ts').SemanticReport} SemanticReport
 * @typedef {import('./workbench-model.ts').Span} Span
 * @typedef {import('./workbench-model.ts').SuggestionWithheldReason} SuggestionWithheldReason
 * @typedef {import('./workbench-model.ts').TermEffect} TermEffect
 * @typedef {import('./workbench-model.ts').TruncatedReason} TruncatedReason
 */

export const SEMANTIC_REVIEW_VERSION = 'semantic-review-v1';
export const CAPABILITY_SEMANTIC_REVIEW = 'semantic-review-v1';
export const CAPABILITY_TRANSLATION_CONTEXT = 'translation-context-v1';
export const KNOWN_CAPABILITIES = Object.freeze([CAPABILITY_SEMANTIC_REVIEW, CAPABILITY_TRANSLATION_CONTEXT]);

export const SEMANTIC_CATEGORIES = Object.freeze(/** @type {const} */ ([
  'omission', 'unsupported_addition', 'meaning_shift', 'negation_change',
  'quantity_change', 'reference_inconsistency', 'term_sense',
]));
export const SEMANTIC_CONFIDENCES = Object.freeze(/** @type {const} */ (['high', 'medium', 'low']));
export const TERM_EFFECTS = Object.freeze(/** @type {const} */ (['none', 'alters_official_match', 'introduces_official_form', 'not_checked']));
export const WITHHELD_REASONS = Object.freeze(/** @type {const} */ (['span_too_long', 'replacement_too_long']));
export const TRUNCATED_REASONS = Object.freeze(/** @type {const} */ (['issue_limit', 'byte_limit']));
export const PRECEDENT_CHOICES = Object.freeze(/** @type {const} */ (['official_pair', 'not_a_term', 'user_rendering']));

export const SEMANTIC_LIMITS = Object.freeze({
  side: 2000,
  context: 400,
  precedents: 12,
  surface: 32,
  rendering: 48,
  snippet: 80,
  excerpt: 200,
  excerptHead: 95,
  excerptTail: 95,
  rationale: 240,
  suggestionSpan: 200,
  replacement: 240,
  alternatives: 1,
  issues: 16,
  requestBytes: 32_768,
  responseBudgetBytes: 57_344,
});

const HEX64 = /^[0-9a-f]{64}$/u;
const HEX32 = /^[0-9a-f]{32}$/u;
const CAPABILITY_NAME = /^[a-z0-9][a-z0-9.-]{0,63}$/u;
const ISOLATED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const ISSUE_KEYS = [
  'id', 'fingerprint', 'category', 'origin', 'confidence', 'source_span', 'target_span',
  'source_excerpt', 'target_excerpt', 'rationale', 'suggestion', 'suggestion_withheld', 'alternatives',
];
const RESPONSE_KEYS = [
  'request_id', 'review_version', 'source_revision', 'target_revision', 'term_basis', 'status',
  'status_reason', 'dropped_unanchored', 'checked', 'issues', 'truncated', 'truncated_reason', 'omitted_issues',
];

/** Property-name sets of the wire schemas, keyed by Core's OpenAPI schema name (checked by the contract test). */
export const SEMANTIC_WIRE_KEYS = Object.freeze({
  CapabilitiesResponseBody: ['api_version', 'capabilities', 'request_id'],
  SemanticReviewResponseBody: RESPONSE_KEYS,
  SemanticIssueBody: ISSUE_KEYS,
  SemanticSuggestionBody: ['target_span', 'replacement', 'term_effect'],
  SemanticAlternativeBody: ['replacement', 'term_effect'],
  SemanticSpanBody: ['start', 'end', 'text'],
  SemanticTermBasisBody: ['dictionary_revision', 'matcher_revision'],
  SemanticReviewRequestBody: ['source', 'target', 'direction', 'review_version', 'explain_language', 'context', 'precedents'],
  SemanticPrecedentBody: ['surface', 'choice', 'rendering', 'snippet', 'anchor', 'scope'],
  SemanticPrecedentAnchorBody: ['segment_index', 'source_start', 'source_end'],
});

/** @param {unknown} x @returns {x is Record<string, any>} */
function object(x) { return Boolean(x) && typeof x === 'object' && !Array.isArray(x); }
/** @param {unknown} x @param {readonly string[]} keys @returns {x is Record<string, any>} */
function exactKeys(x, keys) {
  return object(x) && Object.keys(x).length === keys.length && keys.every(key => Object.hasOwn(x, key));
}
/** @param {unknown} x @returns {x is string} */
function scalarString(x) { return typeof x === 'string' && !ISOLATED_SURROGATE.test(x); }
/** @param {string} x @returns {number} */
function scalarCount(x) { return Array.from(x).length; }
/** @param {unknown} x @param {number} max @returns {x is string} */
function bounded(x, max) { return scalarString(x) && scalarCount(x) <= max; }
/** @param {unknown} x @returns {x is string} */
function nonBlank(x) { return typeof x === 'string' && x.trim().length > 0; }
/** @param {unknown} x @returns {x is number} */
function count(x) { return Number.isSafeInteger(x) && /** @type {number} */ (x) >= 0; }
/** @param {RegExp} pattern @param {unknown} x @returns {x is string} */
function hex(pattern, x) { return typeof x === 'string' && pattern.test(x); }
/** @param {unknown} x @returns {x is string} */
function requestId(x) {
  return typeof x === 'string' && x.trim().length > 0 && x.length <= 256
    && !ISOLATED_SURROGATE.test(x) && !/[\u0000-\u001f\u007f]/u.test(x);
}
/** @param {readonly string[]} list @param {unknown} value @returns {boolean} */
function includesStr(list, value) { return typeof value === 'string' && list.includes(value); }

/** Display-only excerpt, exactly as Core builds it: the text up to 200 scalars, else head…tail. @param {string} text @returns {string} */
export function excerptOf(text) {
  const chars = Array.from(text);
  if (chars.length <= SEMANTIC_LIMITS.excerpt) return text;
  return chars.slice(0, SEMANTIC_LIMITS.excerptHead).join('') + '…' + chars.slice(-SEMANTIC_LIMITS.excerptTail).join('');
}

// A span is executable text: [start, end) is non-empty and `text` is exactly that slice.
/** @param {unknown} span @param {readonly string[]} chars @returns {span is Span} */
function validSpan(span, chars) {
  return exactKeys(span, ['start', 'end', 'text'])
    && Number.isSafeInteger(span.start) && Number.isSafeInteger(span.end)
    && span.start >= 0 && span.start < span.end && span.end <= chars.length
    && typeof span.text === 'string' && chars.slice(span.start, span.end).join('') === span.text;
}

/** @param {unknown} x @returns {boolean} */
function validAlternative(x) {
  return exactKeys(x, ['replacement', 'term_effect']) && bounded(x.replacement, SEMANTIC_LIMITS.replacement)
    && includesStr(TERM_EFFECTS, x.term_effect);
}

/** @param {unknown} issue @param {readonly string[]} sourceChars @param {readonly string[]} targetChars @returns {boolean} */
function validIssue(issue, sourceChars, targetChars) {
  if (!exactKeys(issue, ISSUE_KEYS)) return false;
  if (!hex(HEX32, issue.id) || !hex(HEX32, issue.fingerprint)) return false;
  if (!includesStr(SEMANTIC_CATEGORIES, issue.category) || issue.origin !== 'model'
    || !includesStr(SEMANTIC_CONFIDENCES, issue.confidence)) return false;
  if (issue.source_span === null && issue.target_span === null) return false;
  if (issue.source_span !== null && !validSpan(issue.source_span, sourceChars)) return false;
  if (issue.target_span !== null && !validSpan(issue.target_span, targetChars)) return false;
  // Excerpts are display only; the span is what gets located and replaced.
  if (issue.source_excerpt !== (issue.source_span === null ? null : excerptOf(issue.source_span.text))) return false;
  if (issue.target_excerpt !== (issue.target_span === null ? null : excerptOf(issue.target_span.text))) return false;
  if (!bounded(issue.rationale, SEMANTIC_LIMITS.rationale)) return false;
  if (issue.suggestion_withheld !== null && !includesStr(WITHHELD_REASONS, issue.suggestion_withheld)) return false;
  if (!Array.isArray(issue.alternatives) || issue.alternatives.length > SEMANTIC_LIMITS.alternatives
    || !issue.alternatives.every(validAlternative)) return false;
  if (issue.suggestion === null) return issue.alternatives.length === 0;
  // A suggestion is one unit: its complete range, that range's text and the replacement.
  const suggestion = issue.suggestion;
  return issue.suggestion_withheld === null
    && exactKeys(suggestion, ['target_span', 'replacement', 'term_effect'])
    && validSpan(suggestion.target_span, targetChars)
    && suggestion.target_span.end - suggestion.target_span.start <= SEMANTIC_LIMITS.suggestionSpan
    && bounded(suggestion.replacement, SEMANTIC_LIMITS.replacement)
    && includesStr(TERM_EFFECTS, suggestion.term_effect);
}

/**
 * Exact-key structural check of a semantic-review-v1 response for the segment
 * that was sent. Revisions and ids are checked by verifySemanticReviewIdentity.
 * @param {unknown} body
 * @param {unknown} source
 * @param {unknown} target
 * @returns {body is SemanticReport & { source_revision: string, target_revision: string }}
 */
export function validSemanticReviewResponse(body, source, target) {
  if (!exactKeys(body, RESPONSE_KEYS) || typeof source !== 'string' || typeof target !== 'string') return false;
  if (!requestId(body.request_id) || body.review_version !== SEMANTIC_REVIEW_VERSION) return false;
  if (!hex(HEX64, body.source_revision) || !hex(HEX64, body.target_revision)) return false;
  if (!exactKeys(body.term_basis, ['dictionary_revision', 'matcher_revision'])
    || !hex(HEX64, body.term_basis.dictionary_revision) || !hex(HEX64, body.term_basis.matcher_revision)) return false;
  if (!count(body.dropped_unanchored) || !count(body.omitted_issues) || typeof body.truncated !== 'boolean') return false;
  if (!Array.isArray(body.checked) || new Set(body.checked).size !== body.checked.length
    || !body.checked.every(category => includesStr(SEMANTIC_CATEGORIES, category))) return false;
  if (!Array.isArray(body.issues) || body.issues.length > SEMANTIC_LIMITS.issues) return false;
  if (body.status === 'complete') {
    if (body.status_reason !== null) return false;
  } else if (body.status === 'not_reviewed') {
    // Nothing was checked: this is never an all-clear.
    if (body.status_reason !== 'invalid_model_output' || body.checked.length !== 0 || body.issues.length !== 0) return false;
  } else return false;
  if (body.truncated !== body.omitted_issues > 0) return false;
  if (body.truncated ? !includesStr(TRUNCATED_REASONS, body.truncated_reason) : body.truncated_reason !== null) return false;
  if (body.truncated_reason === 'issue_limit' && body.issues.length !== SEMANTIC_LIMITS.issues) return false;
  const sourceChars = Array.from(source);
  const targetChars = Array.from(target);
  return new Set(body.issues.map(issue => issue?.id)).size === body.issues.length
    && body.issues.every(issue => validIssue(issue, sourceChars, targetChars));
}

/**
 * Core's occurrence id: sha256 of a compact JSON array, first 32 hex digits.
 * @param {SemanticCategory | string} category
 * @param {string} sourceRevision
 * @param {string} targetRevision
 * @param {Span | null} sourceSpan
 * @param {Span | null} targetSpan
 * @returns {Promise<string>}
 */
export async function semanticIssueId(category, sourceRevision, targetRevision, sourceSpan, targetSpan) {
  const parts = [
    category, sourceRevision, targetRevision,
    sourceSpan === null ? null : [sourceSpan.start, sourceSpan.end],
    targetSpan === null ? null : [targetSpan.start, targetSpan.end],
  ];
  return (await revisionOf(JSON.stringify(parts))).slice(0, 32);
}

/**
 * The response belongs to exactly the texts that were sent, and every id is
 * bound to its occurrence. The fingerprint is not recomputed: it needs Python's
 * casefold, and it only finds candidates.
 * @param {SemanticReport & { source_revision: string, target_revision: string }} body
 * @param {string} source
 * @param {string} target
 * @returns {Promise<boolean>}
 */
export async function verifySemanticReviewIdentity(body, source, target) {
  if (body.source_revision !== await revisionOf(source) || body.target_revision !== await revisionOf(target)) return false;
  for (const issue of body.issues) {
    const expected = await semanticIssueId(issue.category, body.source_revision, body.target_revision, issue.source_span, issue.target_span);
    if (issue.id !== expected) return false;
  }
  return true;
}

/** @param {Span | null} span @returns {Span | null} */
function copySpan(span) { return span === null ? null : { start: span.start, end: span.end, text: span.text }; }

/** Rebuild the response from validated fields only. @param {Record<string, any>} body */
export function projectSemanticReviewResponse(body) {
  return {
    request_id: body.request_id,
    review_version: body.review_version,
    source_revision: body.source_revision,
    target_revision: body.target_revision,
    term_basis: { dictionary_revision: body.term_basis.dictionary_revision, matcher_revision: body.term_basis.matcher_revision },
    status: body.status,
    status_reason: body.status_reason,
    dropped_unanchored: body.dropped_unanchored,
    checked: [...body.checked],
    issues: body.issues.map((/** @type {any} */ issue) => ({
      id: issue.id,
      fingerprint: issue.fingerprint,
      category: issue.category,
      origin: issue.origin,
      confidence: issue.confidence,
      source_span: copySpan(issue.source_span),
      target_span: copySpan(issue.target_span),
      source_excerpt: issue.source_excerpt,
      target_excerpt: issue.target_excerpt,
      rationale: issue.rationale,
      suggestion: issue.suggestion === null ? null : {
        target_span: copySpan(issue.suggestion.target_span),
        replacement: issue.suggestion.replacement,
        term_effect: issue.suggestion.term_effect,
      },
      suggestion_withheld: issue.suggestion_withheld,
      alternatives: issue.alternatives.map((/** @type {any} */ item) => ({ replacement: item.replacement, term_effect: item.term_effect })),
    })),
    truncated: body.truncated,
    truncated_reason: body.truncated_reason,
    omitted_issues: body.omitted_issues,
  };
}

/** @param {unknown} x @returns {boolean} */
function validBefore(x) {
  return exactKeys(x, ['source', 'target'])
    && bounded(x.source, SEMANTIC_LIMITS.context) && bounded(x.target, SEMANTIC_LIMITS.context);
}

/** @param {unknown} x @returns {boolean} */
export function validPrecedent(x) {
  if (!exactKeys(x, ['surface', 'choice', 'rendering', 'snippet', 'anchor', 'scope'])) return false;
  if (!bounded(x.surface, SEMANTIC_LIMITS.surface) || x.surface.length === 0) return false;
  if (!includesStr(PRECEDENT_CHOICES, x.choice) || x.scope !== 'occurrence') return false;
  // rendering is null exactly for not_a_term.
  if (x.choice === 'not_a_term' ? x.rendering !== null
    : !bounded(x.rendering, SEMANTIC_LIMITS.rendering) || x.rendering.length === 0) return false;
  if (!bounded(x.snippet, SEMANTIC_LIMITS.snippet)) return false;
  const anchor = x.anchor;
  return exactKeys(anchor, ['segment_index', 'source_start', 'source_end'])
    && count(anchor.segment_index) && count(anchor.source_start) && count(anchor.source_end)
    && anchor.source_start < anchor.source_end;
}

/** @param {unknown} x @returns {boolean} */
function validPrecedents(x) {
  return Array.isArray(x) && x.length <= SEMANTIC_LIMITS.precedents && x.every(validPrecedent);
}

/**
 * One paired segment for POST /v1/semantic-reviews. The Web only sends `ready`
 * pairs, so both sides must hold text (Core also accepts empty sides).
 * @param {unknown} value
 * @returns {boolean}
 */
export function validSemanticReviewRequest(value) {
  if (!object(value)) return false;
  const optional = ['context', 'precedents'].filter(key => Object.hasOwn(value, key));
  if (!exactKeys(value, ['source', 'target', 'direction', 'review_version', 'explain_language', ...optional])) return false;
  if (!bounded(value.source, SEMANTIC_LIMITS.side) || !bounded(value.target, SEMANTIC_LIMITS.side)
    || !nonBlank(value.source) || !nonBlank(value.target)) return false;
  if (!['en', 'zh'].includes(value.direction) || value.review_version !== SEMANTIC_REVIEW_VERSION
    || !['zh', 'en'].includes(value.explain_language)) return false;
  if (Object.hasOwn(value, 'context') && value.context !== null
    && !(exactKeys(value.context, ['before']) && validBefore(value.context.before))) return false;
  return !Object.hasOwn(value, 'precedents') || validPrecedents(value.precedents);
}

/**
 * translation-context-v1: `context: {before?, precedents?}` with the semantic-review shapes.
 * @param {unknown} value
 * @returns {boolean}
 */
export function validTranslationContext(value) {
  if (!object(value)) return false;
  const present = ['before', 'precedents'].filter(key => Object.hasOwn(value, key));
  if (!exactKeys(value, present)) return false;
  if (Object.hasOwn(value, 'before') && value.before !== null && !validBefore(value.before)) return false;
  return !Object.hasOwn(value, 'precedents') || validPrecedents(value.precedents);
}

/** @param {unknown} body @returns {boolean} */
export function validCapabilitiesResponse(body) {
  return exactKeys(body, ['api_version', 'capabilities', 'request_id'])
    && requestId(body.api_version) && body.api_version.length <= 128
    && requestId(body.request_id)
    && Array.isArray(body.capabilities) && body.capabilities.length <= 32
    && new Set(body.capabilities).size === body.capabilities.length
    && body.capabilities.every(name => hex(CAPABILITY_NAME, name));
}

/**
 * Unknown capability names are dropped: the client cannot use them anyway.
 * @param {{ capabilities: string[], request_id: string }} body
 */
export function projectCapabilities(body) {
  return { capabilities: body.capabilities.filter(name => KNOWN_CAPABILITIES.includes(name)), request_id: body.request_id };
}

/**
 * Adopt a suggestion only when its complete executable range still reads the
 * same in the current translation. `offset` maps segment scalars to the whole
 * document (the pair's target core_start). A withheld suggestion is never
 * adoptable; a range that no longer matches needs reconfirmation and nothing is
 * replaced.
 * @param {{ target: string, issue: Issue | { suggestion: Issue['suggestion'], suggestion_withheld: Issue['suggestion_withheld'] }, offset?: number, replacement?: string }} params
 * @returns {{ target: string, span: Span, error?: undefined } | { error: 'suggestion_unavailable' | 'needs_reconfirmation', target?: undefined, span?: undefined }}
 */
export function applySemanticSuggestion({ target, issue, offset = 0, replacement }) {
  if (!object(issue) || issue.suggestion === null || issue.suggestion_withheld !== null) return { error: 'suggestion_unavailable' };
  const span = issue.suggestion.target_span;
  const text = replacement ?? issue.suggestion.replacement;
  if (!scalarString(target) || !scalarString(text) || !Number.isSafeInteger(offset) || offset < 0) return { error: 'needs_reconfirmation' };
  const chars = Array.from(target);
  const start = offset + span.start;
  const end = offset + span.end;
  if (!(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start < end && end <= chars.length)
    || chars.slice(start, end).join('') !== span.text) return { error: 'needs_reconfirmation' };
  const next = chars.slice(0, start).join('') + text + chars.slice(end).join('');
  return { target: next, span: { start: /** @type {ScalarOffset} */ (start), end: /** @type {ScalarOffset} */ (start + scalarCount(text)), text } };
}
