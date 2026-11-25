// Layer 1 of the layered review: deterministic structure checks (Core ADR 0022) as session state of the workbench. Pure and
// browser-safe. A result is kept per segment by the content hashes of its two cores, so it describes exactly the texts it was
// made for and disappears from view when either changes. Nothing here is written to a manuscript, to undo history or to browser
// storage: the state lives in the controller snapshot only.
import { segmentInputs, isAmbiguousMention } from './long-review.ts';
import { STRUCTURE_LIMITS, structureCheckBatches, structureFindingCovers } from './structure-check.js';
import type { Draft, PairStatus, Report, ScalarOffset, Span } from './workbench-model.ts';
import { scalarOffset } from './workbench-model.ts';

export type StructureRule =
  | 'empty_target' | 'paragraph_count_mismatch' | 'line_count_mismatch' | 'placeholder_missing' | 'placeholder_unexpected'
  | 'tag_unbalanced' | 'number_missing' | 'number_unexpected';
export type StructureSpan = { start: number; end: number; text: string };
export type StructureFinding = { rule_id: StructureRule; source_span: StructureSpan | null; target_span: StructureSpan | null };
export type StructureLayout = { source_paragraphs: number; target_paragraphs: number; source_lines: number; target_lines: number };
/** One segment's answer: findings with core-relative spans, the count Core left out, and the layout counts. */
export type StructureResult = { findings: StructureFinding[]; omitted: number; layout: StructureLayout };
export type StructureState = {
  phase: 'idle' | 'running' | 'done' | 'failed';
  /** Results by `sourceHash:targetHash` of the two cores sent. */
  results: Record<string, StructureResult>;
  /** Segments of the last run that could not be sent (a side over 2,000 scalars or a request over the byte cap). */
  skipped: number;
  checks: string[];
  error: { reason: string; requestId?: string } | null;
};

export const emptyStructure = (): StructureState => ({ phase: 'idle', results: {}, skipped: 0, checks: [], error: null });

/** The pair statuses Layer 1 checks: a ready pair, and an untranslated one (its empty target is the finding). */
const CHECKED: readonly PairStatus[] = ['ready', 'untranslated'];
const keyOf = (sourceHash: string, targetHash: string) => `${sourceHash}:${targetHash}`;

/**
 * The segments of a draft a structure check sends, with the key its result is stored under. `id` is the request `segment_id`.
 */
export function structureItems(draft: Draft): { id: string; index: number; key: string; source: string; target: string }[] {
  return segmentInputs(draft).items.flatMap((item, index) => (CHECKED.includes(item.pair.status) && item.sourceCore.trim()
    ? [{ id: `s${index}`, index, key: keyOf(item.sourceHash, item.targetHash), source: item.sourceCore, target: item.targetCore }]
    : []));
}

/** The request batches of a draft (structureCheckBatches) and the items behind them. */
export function structurePlan(draft: Draft) {
  const items = structureItems(draft);
  const { batches, skipped } = structureCheckBatches(items.map(({ id, source, target }) => ({ id, source, target })), STRUCTURE_LIMITS.batchBytes);
  return { items, batches, skipped };
}

/** A segment's place in the whole text and its Layer 1 result there (whole-text spans), or `result: null` when it has none. */
export type StructureView = {
  index: number;
  checkable: boolean;
  sourceStart: ScalarOffset;
  targetStart: ScalarOffset;
  result: (Omit<StructureResult, 'findings'> & { findings: (StructureFinding & { source_span: Span | null; target_span: Span | null })[] }) | null;
};

const shift = (span: StructureSpan | null, by: number): Span | null =>
  (span === null ? null : { start: scalarOffset(span.start + by), end: scalarOffset(span.end + by), text: span.text });

/** The Layer 1 view of every segment of the draft under `structure`, in segment order. */
export function structureViews(draft: Draft, structure: StructureState): StructureView[] {
  return segmentInputs(draft).items.map((item, index) => {
    const stored = structure.results[keyOf(item.sourceHash, item.targetHash)];
    const checkable = CHECKED.includes(item.pair.status) && !!item.sourceCore.trim();
    return {
      index,
      checkable,
      sourceStart: item.range.source_start,
      targetStart: item.range.target_start,
      result: stored && checkable ? {
        ...stored,
        findings: stored.findings.map(f => ({ ...f, source_span: shift(f.source_span, item.range.source_start), target_span: shift(f.target_span, item.range.target_start) })),
      } : null,
    };
  });
}

/** Counts for the Layer 1 summary: checked segments, segments with a finding, findings shown, findings Core left out, and unchecked ones. */
export function structureSummary(views: readonly StructureView[]) {
  const checked = views.filter(v => v.result !== null);
  return {
    checked: checked.length,
    withFindings: checked.filter(v => v.result!.findings.length > 0 || v.result!.omitted > 0).length,
    findings: checked.reduce((n, v) => n + v.result!.findings.length, 0),
    omitted: checked.reduce((n, v) => n + v.result!.omitted, 0),
    unchecked: views.filter(v => v.checkable && v.result === null).length,
  };
}

/**
 * Whether a Layer 1 finding of the issue's segment already describes it (structureFindingCovers), so the Layer 2 list does not
 * raise the same break twice. Only results for the current cores count, since a view holds no other.
 */
export function coveredByStructure(
  issue: { category: string; source_span: Span | null; target_span: Span | null },
  view: StructureView | null | undefined,
): boolean {
  return !!view?.result && view.result.findings.some(finding => structureFindingCovers(issue, finding));
}

/**
 * A review report without its ambiguous one-character names: the judged findings, and `not_evaluated` coverage lowered by their
 * count, so a summary never counts an unresolved name as a problem (manuscript-v5 SPEC "Reason `ambiguous_mention`").
 */
export function judgedReport(report: Report): { report: Report; ambiguous: Report['findings'] } {
  const ambiguous = report.findings.filter(isAmbiguousMention);
  if (!ambiguous.length) return { report, ambiguous };
  return {
    report: {
      ...report,
      findings: report.findings.filter(f => !isAmbiguousMention(f)),
      coverage: { ...report.coverage, not_evaluated: Math.max(0, report.coverage.not_evaluated - ambiguous.length) },
    },
    ambiguous,
  };
}
