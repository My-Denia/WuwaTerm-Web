// Semantic review decisions and their re-review merge rules (Core ADR 0019).
// Pure and browser-safe. Spans are in WHOLE-document scalar coordinates.
import { recoverSpan } from './manuscript.js';
import { revisionOf } from './review-report.js';
import { SEMANTIC_REVIEW_VERSION } from './semantic-review.js';

function copySpan(span) { return span === null || span === undefined ? null : { start: span.start, end: span.end, text: span.text }; }
function shift(span, offset) {
  return span === null || span === undefined ? null : { start: span.start + offset, end: span.end + offset, text: span.text };
}
function sameRange(a, b) { return a === null ? b === null : b !== null && a.start === b.start && a.end === b.end; }

/** Shift a segment-relative issue into document coordinates (the request carried the segment core). */
export function toDocumentIssue(issue, pair) {
  const sourceOffset = pair.source.core_start; const targetOffset = pair.target.core_start;
  const result = {
    ...issue,
    segment_index: pair.index,
    source_span: shift(issue.source_span, sourceOffset),
    target_span: shift(issue.target_span, targetOffset),
  };
  if (issue.suggestion) result.suggestion = { ...issue.suggestion, target_span: shift(issue.suggestion.target_span, targetOffset) };
  return result;
}

/** `issue` is already in document coordinates; the revisions cover the WHOLE source and target. */
export async function makeSemanticDecision({ issue, segmentIndex, source, target, termBasis, decision, appliedText }) {
  return {
    issue_id: issue.id,
    fingerprint: issue.fingerprint,
    category: issue.category,
    segment_index: segmentIndex ?? issue.segment_index,
    source_revision: await revisionOf(source),
    target_revision: await revisionOf(target),
    source_span: copySpan(issue.source_span),
    target_span: copySpan(issue.target_span),
    decision,
    applied_text: decision === 'ignored' ? null : appliedText,
    basis: {
      review_version: SEMANTIC_REVIEW_VERSION,
      term_basis: { dictionary_revision: termBasis.dictionary_revision, matcher_revision: termBasis.matcher_revision },
    },
  };
}

/** The old text for a revision: the current text if it matches, else a hash-verified stored text. */
async function textFor(revision, current, texts, currentRevision) {
  if (currentRevision === revision) return current;
  for (const entry of texts) {
    if (entry?.revision === revision && typeof entry.text === 'string' && await revisionOf(entry.text) === revision) return entry.text;
  }
  return null;
}

/** Minimal verified `semantic_texts` entries the `ignored` decisions need beyond the current texts. */
export async function buildSemanticTexts({ decisions, texts, source, target }) {
  const list = [...texts];
  const currentRevisions = new Set([await revisionOf(source), await revisionOf(target)]);
  const wanted = new Set();
  for (const d of decisions) {
    if (d.decision !== 'ignored') continue;
    for (const revision of [d.source_revision, d.target_revision]) if (!currentRevisions.has(revision)) wanted.add(revision);
  }
  const result = [];
  for (const revision of wanted) {
    for (const entry of list) {
      if (entry?.revision === revision && typeof entry.text === 'string' && await revisionOf(entry.text) === revision) {
        result.push({ revision, text: entry.text });
        break;
      }
    }
  }
  return result;
}

function outcome(decision, status, code, issue = null, source = null, target = null) {
  return { decision, status, code, issue_id: issue ? issue.id : null, source_span: source, target_span: target };
}

async function reconcileOne(decision, candidates, context) {
  const { texts, source, target, sourceRevision, targetRevision } = context;
  if (candidates.length === 0) return outcome(decision, 'not_reported', 'not_reported');
  const oldSource = await textFor(decision.source_revision, source, texts, sourceRevision);
  if (decision.decision !== 'ignored') {
    // History only: the text already changed. A new report at the same place is shown, never collapsed.
    if (oldSource !== null && decision.source_span !== null) {
      const here = recoverSpan(oldSource, decision.source_span, source);
      const match = here && candidates.find(c => c.source_span && sameRange(c.source_span, here));
      if (match) return outcome(decision, 'previously_applied', 'previously_applied', match, here, copySpan(match.target_span));
    }
    return outcome(decision, 'needs_reconfirmation', 'applied_not_carried');
  }
  const oldTarget = await textFor(decision.target_revision, target, texts, targetRevision);
  if (oldSource === null || oldTarget === null) return outcome(decision, 'needs_reconfirmation', 'old_text_unavailable');
  const sourceSpan = decision.source_span === null ? null : recoverSpan(oldSource, decision.source_span, source);
  if (decision.source_span !== null && sourceSpan === null) return outcome(decision, 'needs_reconfirmation', 'source_span_unrecoverable');
  const targetSpan = decision.target_span === null ? null : recoverSpan(oldTarget, decision.target_span, target);
  if (decision.target_span !== null && targetSpan === null) return outcome(decision, 'needs_reconfirmation', 'target_span_unrecoverable');
  if (candidates.length !== 1) return outcome(decision, 'needs_reconfirmation', 'multiple_candidates');
  const [candidate] = candidates;
  if (!sameRange(sourceSpan, candidate.source_span ?? null) || !sameRange(targetSpan, candidate.target_span ?? null)) {
    return outcome(decision, 'needs_reconfirmation', 'candidate_elsewhere');
  }
  return outcome(decision, 'carried', 'carried', candidate, sourceSpan, targetSpan);
}

/**
 * Fingerprints only find candidates. Only `ignored` decisions carry over, and only
 * when both old texts are verified, both spans recover uniquely and exactly one
 * candidate sits at the recovered place. Everything else is shown for reconfirmation.
 * @returns {Promise<{results: object[], carried_issue_ids: string[]}>}
 */
export async function reconcileSemanticDecisions({ decisions, texts = [], source, target, issues }) {
  const context = { texts, source, target, sourceRevision: await revisionOf(source), targetRevision: await revisionOf(target) };
  const results = [];
  for (const decision of decisions) {
    const candidates = issues.filter(i => i.fingerprint === decision.fingerprint && i.category === decision.category);
    results.push(await reconcileOne(decision, candidates, context));
  }
  const counts = new Map();
  for (const r of results) if (r.status === 'carried') counts.set(r.issue_id, (counts.get(r.issue_id) ?? 0) + 1);
  const final = results.map(r => (r.status === 'carried' && counts.get(r.issue_id) > 1
    ? outcome(r.decision, 'needs_reconfirmation', 'converged_on_one_issue') : r));
  return { results: final, carried_issue_ids: final.filter(r => r.status === 'carried').map(r => r.issue_id) };
}
