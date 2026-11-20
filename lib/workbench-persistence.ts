import { historySnapshot, placeSegmentIssues, segmentKey, semanticExportItems, semanticIssuesResolved, semanticTextsWithinBudget } from './semantic-run.js';
import { exportSegments, segmentInputs } from './long-review.js';
import { SEMANTIC_REVIEW_VERSION } from './semantic-review.js';
import { addSegmentResult, emptySemantic, issueStatus, placedOccurrence } from './semantic-state.js';
import { revisionOf } from './review-report.js';
import type { Decision, Draft, Issue, LongCtx, LongState, Pair, Placed, RecordState, SegResult, SegmentInput, SemanticReport, SemanticState, SessionBasis, Span } from './workbench-model';

const uid = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
const chars = (text: string) => Array.from(text);
const slice = (list: string[], start: number, end: number) => list.slice(start, end).join('');
type TermFinding = { verdict: string; source_span: Span; target_span: Span | null; candidates: { zh: string; en: string }[]; candidates_truncated: boolean; reason?: string };
type ExportRow = { index: number; state: RecordState; stale: boolean; truncated: boolean; source_start: number; source_end: number; target_start: number; target_end: number; report: { findings: TermFinding[]; truncated: boolean } & Record<string, unknown>; findings: TermFinding[] };
const inputsOf = (draft: Draft) => segmentInputs(draft) as { long: boolean; items: SegmentInput[] };
export const longExportRows = (long: LongState, ctx: LongCtx) => exportSegments(long, ctx) as ExportRow[];

// ---- manuscript and export helpers (used by the review workbench) ----

type HistorySnap = { source: string; target: string; direction: 'en' | 'zh'; segments: { segment_index: number; source_start: number; source_end: number; target_start: number; target_end: number; report: SemanticReport }[] };
type WorkfileV2 = { source: string; target: string; direction: 'en' | 'zh'; semantic_decisions: Decision[]; semantic_texts: { revision: string; text: string }[]; semantic_history: HistorySnap[] };

/**
 * Semantic state from an imported v2 manuscript. Decisions and verified old
 * texts are kept as they are; the newest history snapshot, when it was taken
 * of exactly these texts, comes back as untrusted reference results.
 */
export async function semanticFromWorkfile(parsed: WorkfileV2): Promise<SemanticState> {
  // The texts the manuscript was saved with come first (newest): a decision made on them needs them for the re-review
  // merge once the text is edited. The writer leaves out texts equal to the current ones, so an unchanged save is unchanged.
  const [savedSource, savedTarget] = await Promise.all([revisionOf(parsed.source), revisionOf(parsed.target)]);
  const texts: { revision: string; text: string }[] = [{ revision: savedSource, text: parsed.source }];
  if (savedTarget !== savedSource) texts.push({ revision: savedTarget, text: parsed.target });
  for (const entry of parsed.semantic_texts) {
    if (!texts.some(t => t.revision === entry.revision) && await revisionOf(entry.text) === entry.revision) texts.push({ revision: entry.revision, text: entry.text });
  }
  let state: SemanticState = { ...(emptySemantic() as SemanticState), decisions: [...parsed.semantic_decisions], texts, history: [...parsed.semantic_history] };
  const last = parsed.semantic_history.at(-1);
  if (!last || last.source !== parsed.source || last.target !== parsed.target || last.direction !== parsed.direction) return state;
  const [sourceRevision, targetRevision] = await Promise.all([revisionOf(last.source), revisionOf(last.target)]);
  const sc = chars(last.source); const tc = chars(last.target);
  for (const seg of last.segments) {
    const sentSource = slice(sc, seg.source_start, seg.source_end); const sentTarget = slice(tc, seg.target_start, seg.target_end);
    const pair: Pair = { index: seg.segment_index, status: 'ready', hard_cut: false,
      source: { start: seg.source_start, end: seg.source_end, core_start: seg.source_start, core_end: seg.source_end },
      target: { start: seg.target_start, end: seg.target_end, core_start: seg.target_start, core_end: seg.target_end } };
    const result: SegResult = { id: uid(), segmentKey: segmentKey(parsed.direction, sentSource, sentTarget) as string, index: seg.segment_index, sentSource, sentTarget,
      report: seg.report, imported: true, doc: { source: last.source, target: last.target, sourceRevision, targetRevision },
      region: { source: { start: seg.source_start, end: seg.source_end }, target: { start: seg.target_start, end: seg.target_end } } };
    const placed: Placed[] = (placeSegmentIssues({ report: seg.report, pair }) as Issue[]).map(issue => ({
      id: `${result.id}:${issue.id}`, resultId: result.id, issue, occurrence: placedOccurrence(result, issue) as string, stale: false,
      live: { source_span: issue.source_span, target_span: issue.target_span, suggestion_span: issue.suggestion?.target_span ?? null },
    }));
    state = addSegmentResult(state, result, placed, []) as SemanticState;
  }
  return state;
}

/** The v2 parts of a manuscript body; the body is returned unchanged when there is no semantic data (written as v1). */
export function semanticWorkfileParts<T extends { source: string; target: string; direction: 'en' | 'zh' }>(base: T, semantic: SemanticState): T {
  const snapshot = historySnapshot({ source: base.source, target: base.target, direction: base.direction, segments: semantic.results.map(r => ({
    segment_index: r.index, sentSource: r.sentSource, sentTarget: r.sentTarget, report: r.report, sourceRegion: r.region.source, targetRegion: r.region.target,
  })) });
  const seen = new Set<string>();
  const history = [...semantic.history, ...(snapshot ? [snapshot] : [])].filter(h => { const k = JSON.stringify(h); return !seen.has(k) && !!seen.add(k); }).slice(-2);
  if (!semantic.decisions.length && !history.length) return base;
  const payload = { ...base, semantic_decisions: semantic.decisions, semantic_texts: [] as { revision: string; text: string }[], semantic_history: history };
  try {
    const { texts } = semanticTextsWithinBudget({ payload, candidates: semantic.texts, currentTexts: { source: base.source, target: base.target } }) as { texts: { revision: string; text: string }[] };
    return { ...payload, semantic_texts: texts };
  } catch { return payload; }
}

/**
 * Export parts: the long manuscript's segment term reports and the semantic issue rows with their handling status;
 * never a sentence-meaning certification. A segment term report is the live response when it was obtained in this
 * session, else the report rebuilt from the saved record (SPEC "Compact term result": request_id null, no sources).
 */
export function semanticExport(draft: Draft, semantic: SemanticState, basis: SessionBasis) {
  const segments = inputsOf(draft).long ? longExportRows(semantic.long, { draft, basis }) : [];
  const terms = segments.length ? {
    segment_term_reports: segments.map(({ index, stale, source_start, source_end, target_start, target_end, report }) => ({ segment: index + 1, stale, source_start, source_end, target_start, target_end, report })),
  } : {};
  const markdownTerms = segments.length ? segments.map(({ index, state, stale, truncated, findings }) => ({ index, state, stale, truncated, findings })) : null;
  if (!semantic.placed.length && !semantic.decisions.length) return { result: terms, markdown: null, segmentTerms: markdownTerms };
  // Keyed by occurrence (the placed issue), not by issue id: two identical
  // segments report the same id for different places with different statuses.
  const statuses = new Map<string, string>();
  const items = semantic.placed.map(p => {
    const status = (issueStatus(semantic, p) as { status: string }).status;
    statuses.set(p.id, status);
    return semanticExportItems({ issues: [{ ...p.issue, stale: p.stale }], statuses: new Map([[p.issue.id, status]]) })[0];
  });
  const resolved = semanticIssuesResolved(statuses) as number;
  const readyPairs = inputsOf(draft).items.map(item => item.pair).filter(p => p.status === 'ready');
  const reviewed = readyPairs.filter(p => semantic.results.some(r => r.region.source.start === p.source.core_start && r.region.target.start === p.target.core_start
    && r.region.source.end === p.source.core_end && r.region.target.end === p.target.core_end)).length;
  return {
    result: { ...terms, semantic_review: { review_version: SEMANTIC_REVIEW_VERSION, origin: 'model', items }, semantic_issues_resolved: resolved },
    markdown: { items, resolved, segments: { total: readyPairs.length, reviewed } },
    segmentTerms: markdownTerms,
  };
}
