// Layer 1 of the layered review: deterministic structure checks (Core ADR 0022) as session state of the workbench. Pure and
// browser-safe. A result is kept per segment by the content hashes of its two cores, so it describes exactly the texts it was
// made for and disappears from view when either changes. Nothing here is written to a manuscript, to undo history or to browser
// storage: the state lives in the controller snapshot only.
import { segmentInputs, isAmbiguousMention } from './long-review.ts';
import { isHandled, issueStatus } from './semantic-state.js';
import { alignmentsLeaveGaps, core } from './segmentation.ts';
import { sha256Hex } from './sha256.js';
import { STRUCTURE_LIMITS, structureCheckBatches, structureFindingCovers } from './structure-check.js';
import type { Decision, Draft, PairStatus, PairView, Placed, Region, Report, ScalarOffset, SemanticState, Span } from './workbench-model.ts';
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

type ExplicitAlignmentUnit = {
  index: number;
  key: string;
  source: string;
  target: string;
  sourceStart: ScalarOffset;
  sourceEnd: ScalarOffset;
  targetStart: ScalarOffset;
  targetEnd: ScalarOffset;
  checkable: boolean;
};

function explicitAlignmentUnits(draft: Draft): ExplicitAlignmentUnit[] | null {
  const alignments = draft.alignments;
  if (!alignments || alignments.length <= 1) return null;
  if (alignmentsLeaveGaps(draft.source, draft.target, alignments)) return null;
  const sc = Array.from(draft.source);
  const tc = Array.from(draft.target);
  return alignments.map((entry, index) => {
    const [sCs, sCe] = core(sc, entry.source.start, entry.source.end);
    const sourceText = sc.slice(sCs, sCe).join('');
    let tCs = 0;
    let tCe = 0;
    let targetText = '';
    if (entry.target !== null) {
      const [cs, ce] = core(tc, entry.target.start, entry.target.end);
      tCs = cs;
      tCe = ce;
      targetText = tc.slice(cs, ce).join('');
    }
    return {
      index,
      key: keyOf(sha256Hex(sourceText), sha256Hex(targetText)),
      source: sourceText,
      target: targetText,
      sourceStart: scalarOffset(sCs),
      sourceEnd: scalarOffset(sCe),
      targetStart: scalarOffset(tCs),
      targetEnd: scalarOffset(tCe),
      checkable: !!sourceText.trim(),
    };
  });
}

function shouldUseExplicitAlignmentUnits(
  explicit: readonly ExplicitAlignmentUnit[] | null,
  segItems: ReturnType<typeof segmentInputs>['items'],
): explicit is readonly ExplicitAlignmentUnit[] {
  if (!explicit) return false;
  const boundariesMatch = explicit.length === segItems.length
    && explicit.every((u, i) => {
      const s = segItems[i]!;
      return u.sourceStart === s.range.source_start
        && u.sourceEnd === s.range.source_end
        && u.targetStart === s.range.target_start
        && u.targetEnd === s.range.target_end;
    });
  if (boundariesMatch) return false;
  // Prefer explicit alignment units whenever segmentation merged multiple alignments into one
  // segment (so per-segment TM reuse checks are never masked), or when every alignment fits
  // within Core's single-segment structure-check ceiling.
  const hasMergedExplicit = segItems.some(s =>
    explicit.filter(u => u.sourceStart < s.range.source_end && s.range.source_start < u.sourceEnd).length > 1,
  );
  if (hasMergedExplicit) return true;
  return explicit.every(u =>
    Array.from(u.source).length <= STRUCTURE_LIMITS.side
    && Array.from(u.target).length <= STRUCTURE_LIMITS.side,
  );
}

/**
 * The segments of a draft a structure check sends, with the key its result is stored under. `id` is the request `segment_id`.
 * When explicit alignments differ from segmentation-v1 boundaries (e.g. merged short TM-reused segments), each aligned
 * segment is checked individually so per-segment findings cannot be masked by a merged view.
 */
export function structureItems(draft: Draft): { id: string; index: number; key: string; source: string; target: string }[] {
  const segItems = segmentInputs(draft).items;
  const explicit = explicitAlignmentUnits(draft);
  if (shouldUseExplicitAlignmentUnits(explicit, segItems)) {
    return explicit.flatMap(unit => (unit.checkable
      ? [{ id: `s${unit.index}`, index: unit.index, key: unit.key, source: unit.source, target: unit.target }]
      : []));
  }
  return segItems.flatMap((item, index) => (CHECKED.includes(item.pair.status) && item.sourceCore.trim()
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
  sourceEnd: ScalarOffset;
  targetStart: ScalarOffset;
  targetEnd: ScalarOffset;
  result: (Omit<StructureResult, 'findings'> & { findings: (StructureFinding & { source_span: Span | null; target_span: Span | null })[] }) | null;
};

const shift = (span: StructureSpan | null, by: number): Span | null =>
  (span === null ? null : { start: scalarOffset(span.start + by), end: scalarOffset(span.end + by), text: span.text });

/** The Layer 1 view of every segment of the draft under `structure`, in segment order. */
export function structureViews(draft: Draft, structure: StructureState): StructureView[] {
  const segItems = segmentInputs(draft).items;
  const explicit = explicitAlignmentUnits(draft);
  if (shouldUseExplicitAlignmentUnits(explicit, segItems)) {
    return explicit.map(unit => {
      const stored = structure.results[unit.key];
      return {
        index: unit.index,
        checkable: unit.checkable,
        sourceStart: unit.sourceStart,
        sourceEnd: unit.sourceEnd,
        targetStart: unit.targetStart,
        targetEnd: unit.targetEnd,
        result: stored && unit.checkable ? {
          ...stored,
          findings: stored.findings.map(f => ({
            ...f,
            source_span: shift(f.source_span, unit.sourceStart),
            target_span: shift(f.target_span, unit.targetStart),
          })),
        } : null,
      };
    });
  }
  return segItems.map((item, index) => {
    const stored = structure.results[keyOf(item.sourceHash, item.targetHash)];
    const checkable = CHECKED.includes(item.pair.status) && !!item.sourceCore.trim();
    return {
      index,
      checkable,
      sourceStart: item.range.source_start,
      sourceEnd: item.range.source_end,
      targetStart: item.range.target_start,
      targetEnd: item.range.target_end,
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

/**
 * One semantic issue (layer 2) as the review lists it: its handling status, its segment and position, and `covered` when it is
 * unhandled and a layer 1 finding of its segment already describes it (coveredByStructure), so the list leaves it out and says so.
 */
export type LayerTwoRow = {
  placed: Placed;
  status: string;
  decision: Decision | null;
  reference: Decision | null;
  segment: number | null;
  position: number;
  imported: boolean;
  covered: boolean;
};

/** The layer 2 rows of a session, in text order; the one list the semantic track and the review overview both read. */
export function layerTwoRows(semantic: SemanticState, views: readonly PairView[], layer1: readonly StructureView[]): LayerTwoRow[] {
  const overlaps = (a: Region, b: Region) => a.start < b.end && b.start < a.end;
  const resultOf = (p: Placed) => semantic.results.find(r => r.id === p.resultId);
  const segmentOf = (p: Placed): PairView | null => {
    const span = p.live.source_span ?? p.live.target_span;
    const found = span ? views.find(v => (p.live.source_span
      ? v.pair.source.core_start <= span.start && span.end <= v.pair.source.core_end
      : v.pair.target.core_start <= span.start && span.end <= v.pair.target.core_end)) : null;
    if (found) return found;
    const result = resultOf(p);
    return result ? views.find(v => overlaps(result.region.source, { start: v.pair.source.core_start, end: v.pair.source.core_end })) ?? null : null;
  };
  const boundariesAligned = layer1.length === views.length
    && layer1.every((l1, i) => {
      const pair = views[i]!.pair;
      return l1.sourceStart === pair.source.core_start
        && l1.sourceEnd === pair.source.core_end
        && l1.targetStart === pair.target.core_start
        && l1.targetEnd === pair.target.core_end;
    });
  return semantic.placed.map(p => {
    const info = issueStatus(semantic, p) as { status: string; decision: Decision | null; reference: Decision | null };
    const view = segmentOf(p);
    const segment = view ? view.pair.index : null;
    const position = p.live.source_span?.start ?? p.live.target_span?.start ?? resultOf(p)?.region.source.start ?? 0;
    const issueCheck = { category: p.issue.category, source_span: p.live.source_span, target_span: p.live.target_span };
    const matchingLayer1 = boundariesAligned
      ? (segment !== null && layer1[segment] ? [layer1[segment]!] : [])
      : layer1.filter(v => {
          if (p.live.source_span) {
            return overlaps(p.live.source_span, { start: v.sourceStart, end: v.sourceEnd });
          }
          if (p.live.target_span) {
            return v.targetEnd > v.targetStart && overlaps(p.live.target_span, { start: v.targetStart, end: v.targetEnd });
          }
          return view !== null && overlaps(
            { start: view.pair.source.core_start, end: view.pair.source.core_end },
            { start: v.sourceStart, end: v.sourceEnd },
          );
        });
    const covered = !isHandled(info.status) && segment !== null
      && matchingLayer1.some(v => coveredByStructure(issueCheck, v));
    return { placed: p, ...info, segment, position, imported: !!resultOf(p)?.imported, covered };
  }).sort((a, b) => a.position - b.position || a.placed.id.localeCompare(b.placed.id));
}

/** Overview counts of layer 2: listed issues, those still to handle and how many of them are high, medium and low confidence (folded), and covered ones. */
export function layerTwoCounts(rows: readonly LayerTwoRow[]) {
  const listed = rows.filter(r => !r.covered);
  const open = listed.filter(r => !isHandled(r.status) && r.status !== 'stale');
  const by = (confidence: string) => open.filter(r => r.placed.issue.confidence === confidence).length;
  return { listed: listed.length, pending: open.length, high: by('high'), medium: by('medium'), low: by('low'), covered: rows.length - listed.length };
}
