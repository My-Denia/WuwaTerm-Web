// Synthetic semantic-review-v1 responses for local tests: valid against the
// Web's strict checks (exact keys, span texts, excerpts, revisions, ids).
// Nothing here calls a model or a real service.
import { createHash } from 'node:crypto';
import { excerptOf, semanticIssueId } from '../../lib/semantic-review.js';
import { revisionOf } from '../../lib/review-report.js';

const HEX64 = 'a'.repeat(64);
const scalars = text => Array.from(text);
const span = (text, range) => (range === null ? null : { start: range[0], end: range[1], text: scalars(text).slice(range[0], range[1]).join('') });
const fingerprint = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);

/** The first run of non-whitespace scalars at or after `from`, as [start, end). */
export function wordAt(text, from = 0) {
  const chars = scalars(text);
  let a = from;
  while (a < chars.length && /\s/u.test(chars[a])) a++;
  let b = a;
  while (b < chars.length && !/\s/u.test(chars[b]) && b - a < 12) b++;
  return a < b ? [a, b] : null;
}

/**
 * @param {{source: string, target: string}} request one paired segment as sent
 * @param {{category: string, source: [number, number] | null, target: [number, number] | null,
 *   suggestion?: {target: [number, number], replacement: string, term_effect?: string} | null,
 *   withheld?: string | null, alternative?: string | null, confidence?: string, rationale?: string}[]} specs
 */
export async function semanticResponse(request, specs, extra = {}) {
  const sourceRevision = await revisionOf(request.source);
  const targetRevision = await revisionOf(request.target);
  const issues = [];
  for (const spec of specs) {
    const sourceSpan = span(request.source, spec.source);
    const targetSpan = span(request.target, spec.target);
    const suggestion = spec.suggestion && !spec.withheld ? {
      target_span: span(request.target, spec.suggestion.target),
      replacement: spec.suggestion.replacement,
      term_effect: spec.suggestion.term_effect ?? 'none',
    } : null;
    issues.push({
      id: await semanticIssueId(spec.category, sourceRevision, targetRevision, sourceSpan, targetSpan),
      fingerprint: fingerprint(spec.category, sourceSpan?.text ?? null, targetSpan?.text ?? null),
      category: spec.category,
      origin: 'model',
      confidence: spec.confidence ?? 'medium',
      source_span: sourceSpan,
      target_span: targetSpan,
      source_excerpt: sourceSpan === null ? null : excerptOf(sourceSpan.text),
      target_excerpt: targetSpan === null ? null : excerptOf(targetSpan.text),
      rationale: spec.rationale ?? 'Synthetic test rationale.',
      suggestion,
      suggestion_withheld: spec.withheld ?? null,
      alternatives: suggestion && spec.alternative ? [{ replacement: spec.alternative, term_effect: 'none' }] : [],
    });
  }
  return {
    request_id: `synthetic-${sourceRevision.slice(0, 8)}`,
    review_version: 'semantic-review-v1',
    source_revision: sourceRevision,
    target_revision: targetRevision,
    term_basis: { dictionary_revision: HEX64, matcher_revision: HEX64 },
    status: 'complete',
    status_reason: null,
    dropped_unanchored: 0,
    checked: ['omission', 'unsupported_addition', 'meaning_shift', 'negation_change', 'quantity_change', 'reference_inconsistency', 'term_sense'],
    issues,
    truncated: false,
    truncated_reason: null,
    omitted_issues: 0,
    ...extra,
  };
}

/** Default plan: a suggestion on the first target word (with an alternative) and an omission on a later source word. */
export async function defaultSemanticResponse(request) {
  const firstTarget = wordAt(request.target);
  const firstSource = wordAt(request.source);
  const laterSource = firstSource ? wordAt(request.source, firstSource[1] + 1) : null;
  const specs = [];
  if (firstTarget && firstSource) {
    specs.push({ category: 'meaning_shift', source: firstSource, target: firstTarget, confidence: 'high',
      suggestion: { target: firstTarget, replacement: `[fix]${scalars(request.target).slice(firstTarget[0], firstTarget[1]).join('')}`, term_effect: 'alters_official_match' },
      alternative: '[alt]' });
  }
  if (laterSource) specs.push({ category: 'omission', source: laterSource, target: null, confidence: 'low' });
  return semanticResponse(request, specs);
}

export function capabilitiesBody(list = ['semantic-review-v1', 'translation-context-v1']) {
  return { capabilities: list, request_id: 'synthetic-capabilities' };
}
