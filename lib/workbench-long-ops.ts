// Long-manuscript term actions, semantic decisions, manual paragraph splitting,
// and Layer 1 structure checks for WorkbenchController. Zero React imports.
import {
  chooseTerm,
  reconfirmChoice,
  removeChoice,
  removeHistoryEntry,
  restorableHistory,
  restoreHistoryEntry,
  reviseSegmentTarget,
  segmentInputs,
  setCurrent,
  setFinished,
  spliceTargetSpan,
} from './long-review.ts';
import { insertParagraphBreak, linesToParagraphs, mergeParagraphs } from './manual-split.ts';
import { remapForSplice } from './manuscript.js';
import { makeSemanticDecision } from './semantic-decisions.js';
import { applySemanticSuggestion } from './semantic-review.js';
import { isHandled, issueStatus, occurrenceKey, removeDecision, upsertDecision } from './semantic-state.js';
import { CAPABILITY_STRUCTURE_CHECK, validStructureCheckResponse } from './structure-check.js';
import { emptyStructure, structurePlan, type StructureFinding, type StructureState } from './structure-layer.ts';
import { scalarOffset } from './workbench-model.ts';
import type {
  Decision, Draft, ParagraphCut, Region, SemanticDecisionCommand, SemanticDecisionResult,
  SemanticState, TermCandidateRef, TermFindingRef, TermOccurrenceAction,
} from './workbench-model.ts';
import { chars, slice, sliceEquals, type WorkbenchHost } from './workbench-store.ts';
import { runFailure } from './workbench-transport.ts';

export async function runStructureChecks(host: WorkbenchHost): Promise<void> {
  const state = host.getState();
  if (!state.capabilities?.includes(CAPABILITY_STRUCTURE_CHECK) || state.structure.phase === 'running') return;
  const { items, batches, skipped } = structurePlan(state.draft);
  if (!batches.length) {
    host.setState({ structure: { ...emptyStructure(), phase: 'done', skipped: skipped.length } });
    return;
  }
  host.rt.structureAbort?.abort();
  const abort = new AbortController();
  host.rt.structureAbort = abort;
  const epoch = host.rt.documentEpoch;
  const live = () => !host.rt.disposed && !abort.signal.aborted && host.rt.documentEpoch === epoch && host.rt.structureAbort === abort;
  const keyOf = new Map(items.map(item => [item.id, item.key]));
  const results: StructureState['results'] = {};
  let checks: string[] = [];
  host.setState({ structure: { ...state.structure, phase: 'running', error: null } });
  try {
    for (const batch of batches) {
      const { response, value } = await host.post('/api/structure-checks', batch, { signal: abort.signal, allowInvalidJson: true });
      if (!live()) return;
      host.onPoolRefresh();
      const body = value && typeof value === 'object' ? value as Record<string, unknown> : null;
      if (!response.ok) {
        const failure = runFailure(response, body);
        host.setState({ structure: { phase: 'failed', results, skipped: skipped.length, checks, error: { reason: failure.code, ...(failure.requestId ? { requestId: failure.requestId } : {}) } } });
        return;
      }
      if (!validStructureCheckResponse(body, batch)) {
        host.setState({ structure: { phase: 'failed', results, skipped: skipped.length, checks, error: { reason: 'responseInvalid' } } });
        return;
      }
      const answer = body as { checks: string[]; segments: { segment_id: string; findings: StructureFinding[]; omitted_findings: number; layout: StructureState['results'][string]['layout'] }[] };
      checks = answer.checks;
      for (const segment of answer.segments) {
        const key = keyOf.get(segment.segment_id);
        if (key) results[key] = { findings: segment.findings, omitted: segment.omitted_findings, layout: segment.layout };
      }
    }
    host.setState({ structure: { phase: 'done', results, skipped: skipped.length, checks, error: null } });
  } catch {
    if (live()) host.setState({ structure: { phase: 'failed', results, skipped: skipped.length, checks, error: { reason: 'requestFailed' } } });
  } finally {
    if (host.rt.structureAbort === abort) host.rt.structureAbort = null;
  }
}

export async function applySemanticDecision(host: WorkbenchHost, command: SemanticDecisionCommand): Promise<SemanticDecisionResult> {
  const state = host.getState();
  const placed = state.semantic.placed.find(item => item.id === command.placedId);
  if (!placed) return { applied: false, reason: 'missing' };
  const result = state.semantic.results.find(item => item.id === placed.resultId);
  if (!result) return { applied: false, reason: 'missing' };

  const startDraft = state.draft;
  const startEpoch = host.rt.documentEpoch;
  let nextTarget: string | null = null;
  let applied: string | null = null;
  let spliceStart = 0;
  let spliceEnd = 0;

  if (command.kind === 'accepted') {
    if (!placed.issue.suggestion || placed.issue.suggestion_withheld !== null || !placed.live.suggestion_span) {
      return { applied: false, reason: 'invalid' };
    }
    const replacement = command.useAlternative && placed.issue.alternatives[0]
      ? placed.issue.alternatives[0].replacement
      : placed.issue.suggestion.replacement;
    const applied0 = applySemanticSuggestion({
      target: startDraft.target,
      issue: { suggestion: { ...placed.issue.suggestion, target_span: placed.live.suggestion_span }, suggestion_withheld: null },
      offset: 0,
      replacement,
    });
    if (applied0.error || applied0.target === undefined) {
      host.commit({ semantic: x => x, notice: 'sem:needsReconfirm', remember: false });
      return { applied: false, reason: 'needs_reconfirm' };
    }
    spliceStart = placed.live.suggestion_span.start;
    spliceEnd = placed.live.suggestion_span.end;
    nextTarget = applied0.target;
    applied = replacement;
  } else if (command.kind === 'adjusted') {
    const range = placed.live.suggestion_span ?? placed.live.target_span;
    if (!range || !command.text.trim() || chars(command.text).length > 2000 || !sliceEquals(startDraft.target, range)) {
      host.commit({ semantic: x => x, notice: 'sem:needsReconfirm', remember: false });
      return { applied: false, reason: 'needs_reconfirm' };
    }
    const tc = chars(startDraft.target);
    spliceStart = range.start;
    spliceEnd = range.end;
    nextTarget = slice(tc, 0, range.start) + command.text + slice(tc, range.end, tc.length);
    applied = command.text;
  }

  const decision = await makeSemanticDecision({
    issue: placed.issue,
    segmentIndex: placed.issue.segment_index,
    source: result.doc.source,
    target: result.doc.target,
    termBasis: result.report.term_basis,
    decision: command.kind,
    appliedText: applied,
  }) as Decision;

  if (host.rt.disposed || host.rt.documentEpoch !== startEpoch) return { applied: false, reason: 'stale' };
  const nowSnap = host.getState();
  if (nowSnap.draft !== startDraft) {
    host.commit({ semantic: x => x, notice: 'sem:needsReconfirm', remember: false });
    return { applied: false, reason: 'needs_reconfirm' };
  }
  const probe = upsertDecision(nowSnap.semantic, decision, placed.id);
  if (!probe) {
    host.commit({ semantic: x => x, notice: 'sem:decisionLimit', remember: false });
    return { applied: false, reason: 'decision_limit' };
  }

  const appliedLen = applied === null ? 0 : chars(applied).length;
  const remap = nextTarget === null
    ? null
    : remapForSplice(startDraft.alignments, 'target', startDraft.source, nextTarget, spliceStart, spliceEnd, appliedLen);
  const nextDraft = nextTarget === null || remap === null
    ? undefined
    : { ...startDraft, target: nextTarget, alignments: remap.alignments };
  let allHandled = false;
  const serial = host.commit({
    draft: nextDraft,
    invalidated: remap?.invalidated,
    ...(nextTarget === null
      ? {}
      : {
          splices: {
            target: {
              start: scalarOffset(spliceStart),
              oldEnd: scalarOffset(spliceEnd),
              newEnd: scalarOffset(spliceStart + appliedLen),
            },
          },
        }),
    semantic: cur => (upsertDecision(cur, decision, placed.id) as SemanticState) ?? cur,
    extraPatch: (nextSemantic, committedSerial) => {
      allHandled = !nextSemantic.placed.some(p => !isHandled((issueStatus(nextSemantic, p) as { status: string }).status) && !p.stale);
      return {
        notice: allHandled ? 'sem:allHandled' : `sem:${command.kind}`,
        lastSemanticAction: committedSerial === null ? null : { placedId: placed.id, marker: committedSerial, kind: command.kind },
      };
    },
  });
  return { applied: true, placedId: placed.id, kind: command.kind, serial, allHandled };
}

export function canUndoSemanticDecision(host: WorkbenchHost, placedId: string): boolean {
  const state = host.getState();
  const placed = state.semantic.placed.find(item => item.id === placedId);
  if (!placed) return false;
  const info = issueStatus(state.semantic, placed) as { status: string; decision: Decision | null; reference: Decision | null };
  if (!info.decision) return false;
  if (info.decision.decision === 'ignored') return true;
  return state.lastSemanticAction?.placedId === placedId && host.canUndoLast(state.lastSemanticAction.marker);
}

export function undoSemanticDecision(host: WorkbenchHost, placedId: string): boolean {
  const state = host.getState();
  const placed = state.semantic.placed.find(item => item.id === placedId);
  if (!placed) return false;
  const info = issueStatus(state.semantic, placed) as { status: string; decision: Decision | null; reference: Decision | null };
  if (!info.decision) return false;
  if (info.decision.decision === 'ignored') {
    const key = occurrenceKey(info.decision);
    host.commit({
      semantic: cur => {
        const removed = removeDecision(cur, key) as SemanticState;
        return {
          ...removed,
          outcomes: removed.outcomes.filter(o => occurrenceKey(o.decision) !== key),
        };
      },
      notice: 'sem:undone',
      extraPatch: () => ({ lastSemanticAction: null }),
    });
    return true;
  }
  if (state.lastSemanticAction?.placedId === placedId && host.canUndoLast(state.lastSemanticAction.marker)) {
    host.undo();
    return true;
  }
  return false;
}

export function applyTermOccurrenceAction(host: WorkbenchHost, action: TermOccurrenceAction): boolean {
  switch (action.type) {
    case 'adopt':
      return host.commitLong(
        state => chooseTerm(state, { index: action.segmentIndex, finding: action.finding, candidate: action.candidate }, host.longCtx()),
        'sem:longChoiceRecorded',
      );
    case 'not_a_term':
      return host.commitLong(
        state => chooseTerm(state, { index: action.segmentIndex, finding: action.finding, candidate: null }, host.longCtx()),
        'sem:longChoiceRecorded',
      );
    case 'replace': {
      if (!action.docTarget) return false;
      const d = host.getState().draft;
      const replacement = d.direction === 'en' ? action.candidate.en : action.candidate.zh;
      const out = spliceTargetSpan(d.target, action.docTarget, replacement);
      if (out.error === 'span_mismatch') {
        host.commit({ semantic: x => x, notice: 'sem:longReplaceStale', remember: false });
        return false;
      }
      if (out.target === undefined) return false;
      const remap = remapForSplice(d.alignments, 'target', d.source, out.target, action.docTarget.start, action.docTarget.end,
        chars(replacement).length);
      host.commit({
        draft: { ...d, target: out.target, alignments: remap.alignments },
        invalidated: remap.invalidated,
        splices: {
          target: {
            start: action.docTarget.start,
            oldEnd: action.docTarget.end,
            newEnd: out.span.end,
          },
        },
        notice: 'sem:longTargetReplaced',
      });
      return true;
    }
    case 'reconfirm':
      return host.commitLong(
        state => reconfirmChoice(state, action.at),
        'sem:longChoiceRecorded',
      );
    case 'clear_choice':
      return host.commitLong(state => removeChoice(state, action.at));
  }
}

export function chooseLong(host: WorkbenchHost, index: number, finding: TermFindingRef, candidate: TermCandidateRef | null): boolean {
  return applyTermOccurrenceAction(
    host,
    candidate
      ? { type: 'adopt', segmentIndex: index, finding, candidate }
      : { type: 'not_a_term', segmentIndex: index, finding },
  );
}

export function segmentTargetCore(host: WorkbenchHost, index: number): string | null {
  return segmentInputs(host.getState().draft).items[index]?.targetCore ?? null;
}

export function reviseSegmentText(host: WorkbenchHost, index: number, expectedBase: string, nextText: string): { applied: boolean; error?: string } {
  const d = host.getState().draft;
  const item = segmentInputs(d).items[index];
  if (!item) {
    host.commit({ semantic: x => x, notice: 'sem:longReviseInvalid', remember: false });
    return { applied: false, error: 'core_mismatch' };
  }
  const out = reviseSegmentTarget(d.target, { start: item.range.target_start, end: item.range.target_end }, expectedBase, nextText);
  if (out.target === undefined) {
    if (out.error !== 'noop') host.commit({ semantic: x => x, notice: 'sem:longReviseInvalid', remember: false });
    return { applied: false, error: out.error };
  }
  const remap = remapForSplice(d.alignments, 'target', d.source, out.target, item.range.target_start, item.range.target_end,
    chars(nextText).length);
  host.commit({
    draft: { ...d, target: out.target, alignments: remap.alignments },
    invalidated: remap.invalidated,
    splices: {
      target: {
        start: item.range.target_start,
        oldEnd: item.range.target_end,
        newEnd: scalarOffset(item.range.target_start + chars(nextText).length),
      },
    },
    notice: 'sem:longSegmentRevised',
  });
  return { applied: true };
}

export function toggleSegmentFinished(host: WorkbenchHost, index: number, finished?: boolean): boolean {
  const currentlyFinished = host.getState().semantic.long.progress.completed.includes(index);
  const target = finished ?? !currentlyFinished;
  if (target === currentlyFinished) return false;
  return host.commitLong(state => setFinished(state, index, target));
}

export function restoreTermHistoryEntry(host: WorkbenchHost, position: number, targetSegmentIndex?: number): boolean {
  const targetIndex = targetSegmentIndex ?? restorableHistory(host.getState().semantic.long, host.longCtx())[position];
  if (targetIndex === null || targetIndex === undefined) return false;
  return host.commitLong(
    state => restoreHistoryEntry(state, position, targetIndex, host.longCtx()),
  );
}

export function removeTermHistoryEntry(host: WorkbenchHost, position: number): boolean {
  return host.commitLong(state => removeHistoryEntry(state, position));
}

export function selectLongSegment(host: WorkbenchHost, index: number | null): void {
  host.commit({
    semantic: state => ({ ...state, long: setCurrent(state.long, index) }),
    remember: false,
  });
}

export function splitParagraphs(host: WorkbenchHost, cuts: ParagraphCut[]): boolean {
  if (cuts.length === 0) return false;
  const d = host.getState().draft;
  let next: Draft = { ...d };
  let firstSplice = null;
  for (const cut of cuts) {
    const updated = insertParagraphBreak(next[cut.side], cut.offset);
    if (!updated) return false;
    if (cuts.length === 1) firstSplice = updated.splice;
    next = { ...next, [cut.side]: updated.text };
  }
  host.commit({
    draft: { ...next, alignments: d.alignments === null ? null : [] },
    ...(cuts.length === 1 && firstSplice ? { splices: { [cuts[0].side]: firstSplice } } : {}),
    notice: 'sem:split',
  });
  return true;
}

export function mergeParagraphsAt(host: WorkbenchHost, side: 'source' | 'target', gapStart: number, gapEnd: number): boolean {
  const d = host.getState().draft;
  const merged = mergeParagraphs(d[side], gapStart, gapEnd);
  if (!merged) return false;
  host.commit({
    draft: { ...d, [side]: merged.text, alignments: d.alignments === null ? null : [] },
    ...(merged.splice ? { splices: { [side]: merged.splice } } : {}),
    notice: 'sem:merged',
  });
  return true;
}

export function convertLinesToParagraphs(host: WorkbenchHost, scope?: { side: 'source' | 'target'; region?: Region }): boolean {
  const d = host.getState().draft;
  if (!scope) {
    const s1 = linesToParagraphs(d.source);
    const t1 = linesToParagraphs(d.target);
    if (!s1 && !t1) return false;
    host.commit({
      draft: { ...d, source: s1?.text ?? d.source, target: t1?.text ?? d.target, alignments: d.alignments === null ? null : [] },
      notice: 'sem:lines',
    });
    return true;
  }
  const converted = linesToParagraphs(d[scope.side], scope.region ?? null);
  if (!converted) return false;
  host.commit({
    draft: { ...d, [scope.side]: converted.text, alignments: d.alignments === null ? null : [] },
    notice: 'sem:lines',
  });
  return true;
}
