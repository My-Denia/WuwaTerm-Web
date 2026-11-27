// Segmented translation planning, incremental TM auto-reuse (ADR 0023),
// and per-pair translation for WorkbenchController. Zero React imports.
import { isLong, segmentInputs } from './long-review.ts';
import { remapForSplice, remapForTargetFill, validAlignments, type AlignmentRemap } from './manuscript.js';
import { SEGMENT_LIMIT, alignmentsLeaveGaps, core, paragraphRanges, segmentText } from './segmentation.ts';
import { CAPABILITY_TRANSLATION_CONTEXT } from './semantic-review.js';
import { contextBefore, fitRequestBody, initialRun, selectPrecedents } from './semantic-run.js';
import { semanticSegmentViews } from './semantic-state.js';
import { sha256Hex } from './sha256.js';
import { CAPABILITY_STRUCTURE_CHECK, STRUCTURE_LIMITS, structureCheckBatches, validStructureCheckResponse } from './structure-check.js';
import type { StructureFinding, StructureState } from './structure-layer.ts';
import type { TmServiceBasis } from './tm-live-provenance.ts';
import { applySegmentSuggestionResult, segmentParagraphs } from './tm-segment.ts';
import {
  TM_FRESHNESS_STALE,
  TM_FRESHNESS_UNKNOWN,
  TM_FRESHNESS_VERIFIED,
  TM_MATCH_CONTEXT_EXACT,
  matchTranslationMemory,
  type TmEntry,
} from './translation-memory.ts';
import { scalarOffset } from './workbench-model.ts';
import type {
  Draft, DraftEditSplices, PairView, RunItem, RunState, SemanticState,
  SessionBasis, Span, TmRunReceipt,
} from './workbench-model.ts';
import {
  alignmentNotice,
  chars,
  isRunActive,
  slice,
  type TranslateRunPlan,
  type TranslateRunStep,
  type WorkbenchHost,
} from './workbench-store.ts';
import { runFailure } from './workbench-transport.ts';

function resumablePartialPrefix(d: Draft) {
  if (d.alignments !== null || !d.source.trim() || !d.target.trim()) return null;
  if (!isLong(d) || segmentText(d.source).length < 2) return null;
  const sc = chars(d.source);
  const tc = chars(d.target);
  const sParas = paragraphRanges(sc);
  const tParas = paragraphRanges(tc);
  if (!(1 <= tParas.length && tParas.length < sParas.length)) return null;
  const prefixCount = tParas.length;
  const tailStart = sParas[prefixCount][0];
  const tailText = slice(sc, tailStart, sc.length);
  const [sPrevCs, sPrevCe] = core(sc, sParas[prefixCount - 1][0], sParas[prefixCount - 1][1]);
  const [tLastCs, tLastCe] = core(tc, tParas[prefixCount - 1][0], tParas[prefixCount - 1][1]);
  const sep = slice(sc, sPrevCe, tailStart) || '\n\n';
  const existingTrail = slice(tc, tLastCe, tc.length);
  const base = existingTrail === sep ? d.target : slice(tc, 0, tLastCe);
  const appendPrefix = existingTrail === sep ? '' : sep;
  const tailSegments = segmentText(tailText);
  if (!tailSegments.length) return null;
  return {
    base,
    appendPrefix,
    tailStart,
    tailSegments,
    initialBefore: {
      source: chars(slice(sc, sPrevCs, sPrevCe)).slice(-400).join(''),
      target: chars(slice(tc, tLastCs, tLastCe)).slice(-400).join(''),
    },
  };
}

export function buildTranslatePlan(
  host: WorkbenchHost,
  d: Draft,
  semanticState: SemanticState = host.getState().semantic,
  basis: SessionBasis = host.getState().basis,
): { plan: TranslateRunPlan; items: { key: string; index: number }[] } | null {
  if (!d.source.trim()) return null;
  if (!d.target.trim()) {
    const segments = segmentText(d.source);
    if (!segments.length) return null;
    const steps: TranslateRunStep[] = segments.map(segment => ({ kind: 'blank', segment }));
    return {
      plan: {
        kind: 'blank',
        source: d.source,
        direction: d.direction,
        steps,
        pieces: [],
        base: '',
        expectedTarget: '',
        appendPrefix: '',
        tailStart: 0,
        initialBefore: null,
      },
      items: steps.map((_, index) => ({ key: `tr#${index}`, index })),
    };
  }
  const hasExplicitAlignments = d.alignments !== null && d.alignments.length > 0;
  if (hasExplicitAlignments) {
    const views = semanticSegmentViews(d, semanticState, basis, host.reviewFeatures()) as { items: PairView[] };
    const untranslated = views.items.filter(
      v => v.pair.status === 'untranslated' && !!v.sCore.trim() && chars(v.sCore).length <= SEGMENT_LIMIT,
    );
    if (untranslated.length > 0) {
      const steps: TranslateRunStep[] = untranslated.map(v => ({
        kind: 'pair',
        sourceCoreStart: v.pair.source.core_start,
        sourceCoreEnd: v.pair.source.core_end,
      }));
      return {
        plan: {
          kind: 'untranslated_pairs',
          source: d.source,
          direction: d.direction,
          steps,
          pieces: [],
          base: d.target,
          expectedTarget: d.target,
          appendPrefix: '',
          tailStart: 0,
          initialBefore: null,
        },
        items: steps.map((s, index) => ({
          key: `trp#${s.kind === 'pair' ? s.sourceCoreStart : index}:${index}`,
          index,
        })),
      };
    }
  }
  const partial = resumablePartialPrefix(d);
  if (!partial) return null;
  const steps: TranslateRunStep[] = partial.tailSegments.map(segment => ({ kind: 'partial_tail', segment }));
  return {
    plan: {
      kind: 'partial_prefix',
      source: d.source,
      direction: d.direction,
      steps,
      pieces: [],
      base: partial.base,
      expectedTarget: d.target,
      appendPrefix: partial.appendPrefix,
      tailStart: partial.tailStart,
      initialBefore: partial.initialBefore,
    },
    items: steps.map((_, index) => ({ key: `trpfx#${index}`, index })),
  };
}

export function hasResumableTranslate(
  host: WorkbenchHost,
  d: Draft = host.getState().draft,
  semanticState: SemanticState = host.getState().semantic,
  basis: SessionBasis = host.getState().basis,
): boolean {
  if (!d.source.trim() || !d.target.trim()) return false;
  return buildTranslatePlan(host, d, semanticState, basis) !== null;
}

export async function sendTranslate(host: WorkbenchHost, item: RunItem, signal: AbortSignal, generation: number, epoch: number): Promise<void> {
  const live = () => !host.rt.disposed && host.rt.runGeneration === generation && host.rt.documentEpoch === epoch && !signal.aborted;
  const inOrder = (failure: ReturnType<typeof runFailure>) => (
    ['wait', 'pause_quota'].includes((failure.classification as { action: string }).action)
      ? failure
      : { ...failure, classification: { action: 'stop' } }
  );
  const plan = host.rt.translateRun;
  const state = host.getState();
  const d = state.draft;
  if (!plan || d.source !== plan.source || d.direction !== plan.direction || d.target !== plan.expectedTarget) {
    host.failRun({ type: 'failed', key: item.key, code: 'translateTargetChanged', classification: { action: 'stop' }, now: host.clock.now() });
    host.commit({ semantic: x => x, notice: 'sem:translateTargetChanged', remember: false });
    return;
  }
  const step = plan.steps[item.index];
  if (!step) {
    host.dispatchRun({ type: 'skip', key: item.key });
    return;
  }
  const sc = chars(d.source);
  const contextOn = !!state.capabilities?.includes(CAPABILITY_TRANSLATION_CONTEXT);
  let coreText = '';
  let contextPayload: Record<string, unknown> = {};
  if (step.kind === 'blank') {
    coreText = slice(sc, step.segment.core_start, step.segment.core_end);
    const prevStep = item.index > 0 ? plan.steps[item.index - 1] : null;
    const prevSeg = prevStep?.kind === 'blank' ? prevStep.segment : null;
    const previousPiece = item.index > 0 ? plan.pieces[item.index - 1] ?? '' : '';
    const before = prevSeg ? {
      source: chars(slice(sc, prevSeg.core_start, prevSeg.core_end)).slice(-400).join(''),
      target: chars(previousPiece.trim()).slice(-400).join(''),
    } : null;
    if (contextOn) contextPayload = { context: before ? { before } : {} };
  } else if (step.kind === 'partial_tail') {
    const tailSc = chars(slice(sc, plan.tailStart, sc.length));
    coreText = slice(tailSc, step.segment.core_start, step.segment.core_end);
    const prevStep = item.index > 0 ? plan.steps[item.index - 1] : null;
    const prevSeg = prevStep?.kind === 'partial_tail' ? prevStep.segment : null;
    const previousPiece = item.index > 0 ? plan.pieces[item.index - 1] ?? '' : '';
    const before = item.index === 0
      ? plan.initialBefore
      : prevSeg
        ? {
            source: chars(slice(tailSc, prevSeg.core_start, prevSeg.core_end)).slice(-400).join(''),
            target: chars(previousPiece.trim()).slice(-400).join(''),
          }
        : null;
    if (contextOn) contextPayload = { context: before ? { before } : {} };
  } else {
    const pairDraft = plan.staged ? plan.staged.draft : d;
    const pairViews = plan.staged
      ? (semanticSegmentViews(pairDraft, { results: state.semantic.results, long: state.semantic.long }, state.basis, host.reviewFeatures()) as { items: PairView[] }).items
      : host.viewsFor().items;
    const pairView = pairViews.find(
      v => v.pair.status === 'untranslated'
        && v.pair.source.core_start === step.sourceCoreStart
        && v.pair.source.core_end === step.sourceCoreEnd,
    );
    if (!pairView) {
      host.failRun({ type: 'failed', key: item.key, code: 'translateTargetChanged', classification: { action: 'stop' }, now: host.clock.now() });
      host.commit({ semantic: x => x, notice: 'sem:translateTargetChanged', remember: false });
      return;
    }
    coreText = pairView.sCore;
    if (contextOn) {
      const list = segmentInputs(pairDraft).items.map(entry => entry.pair);
      const before = contextBefore({ pairs: list, segmentIndex: pairView.pair.index, source: pairDraft.source, target: pairDraft.target });
      const precedents = state.usePrecedents
        ? selectPrecedents({ items: host.precedentItems(pairDraft, state.semantic), source: pairDraft.source, pairs: list, segmentIndex: pairView.pair.index })
        : [];
      contextPayload = { context: { ...(before ? { before } : {}), ...(precedents.length ? { precedents } : {}) } };
    }
  }
  const fitted = fitRequestBody({ text: coreText, to: plan.direction, ...contextPayload });
  if (!fitted.fits) {
    host.failRun({ type: 'failed', key: item.key, code: 'bodyTooLarge', classification: { action: 'stop' }, now: host.clock.now() });
    return;
  }
  try {
    const { response, value } = await host.post('/api/translations', fitted.body, { signal, allowInvalidJson: true });
    const body = value && typeof value === 'object' ? value as Record<string, unknown> : null;
    if (!live()) return;
    host.onPoolRefresh();
    if (!response.ok || typeof body?.text !== 'string') {
      host.failRun({
        type: 'failed',
        key: item.key,
        ...(response.ok ? { code: 'responseInvalid', classification: { action: 'stop' } } : inOrder(runFailure(response, body))),
        now: host.clock.now(),
      });
      return;
    }
    const countModelCall = plan.trackTmModelCalls && body.kind === 'llm';
    const curState = host.getState();
    const latest = curState.draft;
    const stagedAlignmentsChanged = plan.staged !== undefined
      && JSON.stringify(latest.alignments) !== plan.staged.baseAlignmentsJson;
    if (latest.source !== plan.source || latest.direction !== plan.direction || latest.target !== plan.expectedTarget || stagedAlignmentsChanged) {
      host.failRun({ type: 'failed', key: item.key, code: 'translateTargetChanged', classification: { action: 'stop' }, now: host.clock.now() });
      host.commit({ semantic: x => x, notice: 'sem:translateTargetChanged', remember: false });
      return;
    }
    const staged = plan.staged;
    const workingDraft = staged ? staged.draft : latest;
    let nextTarget = '';
    let nextAlignments: Draft['alignments'] = workingDraft.alignments === null ? null : [];
    let fillRemap: AlignmentRemap | null = null;
    let splices: DraftEditSplices | undefined;
    if (step.kind === 'blank') {
      const piece = slice(sc, step.segment.start, step.segment.core_start) + body.text + slice(sc, step.segment.core_end, step.segment.end);
      plan.pieces[item.index] = piece;
      nextTarget = plan.base + plan.pieces.join('');
    } else if (step.kind === 'partial_tail') {
      const tailSc = chars(slice(sc, plan.tailStart, sc.length));
      const piece = slice(tailSc, step.segment.start, step.segment.core_start) + body.text + slice(tailSc, step.segment.core_end, step.segment.end);
      plan.pieces[item.index] = piece;
      const joined = plan.pieces.join('');
      nextTarget = plan.base + (joined ? plan.appendPrefix + joined : '');
      nextAlignments = null;
    } else {
      const currentViews = staged
        ? (semanticSegmentViews(workingDraft, { results: curState.semantic.results, long: curState.semantic.long }, curState.basis, host.reviewFeatures()) as { items: PairView[] }).items
        : host.viewsFor().items;
      const currentView = currentViews.find(
        v => v.pair.status === 'untranslated'
          && v.pair.source.core_start === step.sourceCoreStart
          && v.pair.source.core_end === step.sourceCoreEnd,
      );
      if (!currentView) {
        host.failRun({ type: 'failed', key: item.key, code: 'translateTargetChanged', classification: { action: 'stop' }, now: host.clock.now() });
        host.commit({ semantic: x => x, notice: 'sem:translateTargetChanged', remember: false });
        return;
      }
      const tc = chars(workingDraft.target);
      const region = currentView.pair.target;
      const head = slice(tc, 0, region.start);
      const ws = slice(tc, region.start, region.end);
      const tail = slice(tc, region.end, tc.length);
      const lead = head && !/\n[ \t\r]*\n[ \t\r]*$/u.test(head + ws) ? '\n\n' : '';
      const trail = tail && !/^[ \t\r]*\n[ \t\r]*\n/u.test(tail) ? '\n\n' : '';
      nextTarget = head + ws + lead + body.text + trail + tail;
      const insertAt = chars(head + ws).length;
      const coreStart = insertAt + chars(lead).length;
      const coreEnd = coreStart + chars(body.text).length;
      const delta = chars(lead + body.text + trail).length;
      fillRemap = remapForTargetFill(
        workingDraft.alignments,
        workingDraft.source,
        nextTarget,
        currentView.pair.source.start,
        currentView.pair.source.end,
        insertAt,
        coreStart,
        coreEnd,
        delta,
      );
      nextAlignments = fillRemap.alignments;
      if (!staged) {
        splices = {
          target: {
            start: scalarOffset(insertAt),
            oldEnd: scalarOffset(insertAt),
            newEnd: scalarOffset(insertAt + delta),
          },
        };
      }
      plan.pieces[item.index] = body.text;
    }
    if (staged) plan.staged = undefined;
    plan.expectedTarget = nextTarget;
    const done = plan.pieces.filter(p => p !== undefined).length === plan.steps.length;
    const lostAlignments = fillRemap ? alignmentNotice(workingDraft.alignments, fillRemap) : null;
    const activeReceipt = staged ? staged.tmReceipt : curState.tmReceipt;
    host.commit({
      draft: { ...workingDraft, target: nextTarget, alignments: nextAlignments },
      ...(splices ? { splices } : {}),
      ...(fillRemap ? { invalidated: fillRemap.invalidated } : {}),
      remember: Boolean(staged),
      notice: lostAlignments ?? (done ? 'sem:translateRunDone' : null),
      ...((plan.trackTmModelCalls && activeReceipt) || staged ? {
        extraPatch: () => {
          const baseReceipt = staged ? staged.tmReceipt : host.getState().tmReceipt;
          const nextReceipt = plan.trackTmModelCalls && baseReceipt ? {
            ...baseReceipt,
            modelCalls: baseReceipt.modelCalls + (countModelCall ? 1 : 0),
            retranslated: done
              ? Math.max(0, baseReceipt.baselineRequests - baseReceipt.reused)
              : baseReceipt.retranslated + 1,
            pendingRetranslate: done
              ? 0
              : Math.max(0, baseReceipt.pendingRetranslate - 1),
          } : host.getState().tmReceipt;
          return {
            ...(staged ? { structure: staged.structure } : {}),
            tmReceipt: nextReceipt,
          };
        },
      } : {}),
    });
    host.dispatchRun({ type: 'done', key: item.key });
  } catch {
    if (live() && !signal.aborted) {
      host.failRun({ type: 'failed', key: item.key, code: 'requestFailed', classification: { action: 'stop' }, now: host.clock.now() });
    }
  }
}

export async function startTranslateRun(host: WorkbenchHost): Promise<void> {
  const state = host.getState();
  if (state.tmPreparing || isRunActive(state.run, state.pairTranslating)) return;
  const d = state.draft;
  if (!d.source.trim()) return;
  const tmEntries = host.currentTmEntries();
  const hasExplicitAlignments = d.alignments !== null && d.alignments.length > 0;
  const blankMultiParagraph = !d.target.trim() && d.alignments === null && segmentParagraphs(d.source).length > 1;
  const explicitUntranslatedEligible =
    hasExplicitAlignments
    && !alignmentsLeaveGaps(d.source, d.target, d.alignments)
    && d.alignments!.some(item => item.target === null);

  if (tmEntries.length > 0 && (blankMultiParagraph || explicitUntranslatedEligible)) {
    const handled = await startIncrementalTmTranslateRun(host, d, tmEntries, blankMultiParagraph);
    if (handled) return;
  }

  const built = buildTranslatePlan(host, host.getState().draft);
  if (!built) return;
  host.rt.translateRun = built.plan;
  if (built.plan.kind === 'blank') {
    host.commit({ draft: { ...host.getState().draft, target: '' }, remember: true, notice: null, extraPatch: () => ({ tmReceipt: null }) });
  } else {
    host.commit({ remember: true, notice: null, extraPatch: () => ({ tmReceipt: null }) });
  }
  host.startBatch('translate', built.items);
}

export async function startIncrementalTmTranslateRun(
  host: WorkbenchHost,
  startDraft: Draft,
  tmEntries: readonly TmEntry[],
  isBlankMode: boolean,
  options: { requireReuse?: boolean; stageUntilFirstSuccess?: boolean } = {},
): Promise<boolean> {
  host.rt.tmPrepareAbort?.abort();
  const abort = new AbortController();
  host.rt.tmPrepareAbort = abort;
  const prepGen = ++host.rt.tmPrepareGeneration;
  const epoch = host.rt.documentEpoch;
  const live = () =>
    !host.rt.disposed
    && !abort.signal.aborted
    && host.rt.tmPrepareGeneration === prepGen
    && host.rt.documentEpoch === epoch
    && host.getState().draft === startDraft;
  host.setState({ tmPreparing: true });

  try {
    if (host.getState().capabilities === null && host.rt.capabilitiesPromise) {
      await host.rt.capabilitiesPromise.catch(() => []);
      if (!live()) return true;
    }

    let basis: TmServiceBasis = { currentTermsDbRevision: null, currentGameVersion: null };
    try {
      basis = await host.resolveTmAutoReuseBasis(host.getState().reports.at(-1) ?? null);
    } catch {
      basis = { currentTermsDbRevision: null, currentGameVersion: null };
    }
    if (!live()) return true;

    type CandidateUnit = {
      segmentIndex: number;
      sourceText: string;
      prevSource: string | null;
      nextSource: string | null;
    };

    const sourceSegments = segmentParagraphs(startDraft.source);
    const candidates: CandidateUnit[] = [];

    if (isBlankMode) {
      if (sourceSegments.length > 64) {
        return false;
      }
      for (let i = 0; i < sourceSegments.length; i += 1) {
        candidates.push({
          segmentIndex: i,
          sourceText: sourceSegments[i]!.text,
          prevSource: i > 0 ? sourceSegments[i - 1]!.text : null,
          nextSource: i + 1 < sourceSegments.length ? sourceSegments[i + 1]!.text : null,
        });
      }
    } else {
      const sc = chars(startDraft.source);
      const tc = chars(startDraft.target);
      const alignments = startDraft.alignments!;
      const sourceCoreOf = (span: Span): string => {
        const [cs, ce] = core(sc, span.start, span.end);
        return slice(sc, cs, ce);
      };
      for (let i = 0; i < alignments.length; i += 1) {
        const entry = alignments[i]!;
        if (entry.target !== null) continue;
        let prevEnd = 0;
        for (let j = i - 1; j >= 0; j -= 1) {
          if (alignments[j]!.target !== null) {
            prevEnd = alignments[j]!.target!.end;
            break;
          }
        }
        let nextStart = tc.length;
        for (let j = i + 1; j < alignments.length; j += 1) {
          if (alignments[j]!.target !== null) {
            nextStart = alignments[j]!.target!.start;
            break;
          }
        }
        if (prevEnd > nextStart || slice(tc, prevEnd, nextStart).trim().length > 0) continue;
        const srcText = sourceCoreOf(entry.source);
        if (!srcText) continue;
        candidates.push({
          segmentIndex: i,
          sourceText: srcText,
          prevSource: i > 0 ? sourceCoreOf(alignments[i - 1]!.source) || null : null,
          nextSource: i + 1 < alignments.length ? sourceCoreOf(alignments[i + 1]!.source) || null : null,
        });
      }
    }

    if (candidates.length === 0) return false;

    let referenced = 0;
    let staleOrUnknown = 0;
    const reusedUnits: (CandidateUnit & { targetText: string })[] = [];

    for (const unit of candidates) {
      const matches = matchTranslationMemory(tmEntries, unit.sourceText, startDraft.direction, {
        prevSource: unit.prevSource,
        nextSource: unit.nextSource,
        currentTermsDbRevision: basis.currentTermsDbRevision,
        currentGameVersion: basis.currentGameVersion,
        limit: 1,
      });
      const top = matches[0] ?? null;
      if (
        basis.currentTermsDbRevision !== null
        && top !== null
        && top.matchKind === TM_MATCH_CONTEXT_EXACT
        && top.freshness === TM_FRESHNESS_VERIFIED
        && segmentParagraphs(top.entry.target_text).length === 1
        && chars(unit.sourceText).length <= SEGMENT_LIMIT
        && chars(top.entry.target_text).length <= SEGMENT_LIMIT
      ) {
        reusedUnits.push({ ...unit, targetText: top.entry.target_text });
      } else if (top !== null) {
        if (top.freshness === TM_FRESHNESS_STALE || top.freshness === TM_FRESHNESS_UNKNOWN) {
          staleOrUnknown += 1;
        } else {
          referenced += 1;
        }
      }
    }

    if (options.requireReuse && reusedUnits.length === 0) {
      return false;
    }

    let updatedDraft: Draft = startDraft;
    let appliedReusedUnits: (CandidateUnit & { targetText: string })[] = [];
    let scheduledRemainingCount = candidates.length;

    if (reusedUnits.length > 0) {
      if (isBlankMode) {
        const reusedByIndex = new Map(reusedUnits.map(u => [u.segmentIndex, u]));
        const targetParts: string[] = [];
        const targetSpans = new Map<number, Span>();
        let cursor = 0;
        for (let i = 0; i < sourceSegments.length; i += 1) {
          const unit = reusedByIndex.get(i);
          if (!unit) continue;
          if (targetParts.length > 0) {
            targetParts.push('\n\n');
            cursor += 2;
          }
          const len = chars(unit.targetText).length;
          targetParts.push(unit.targetText);
          targetSpans.set(i, {
            start: scalarOffset(cursor),
            end: scalarOffset(cursor + len),
            text: unit.targetText,
          });
          cursor += len;
        }
        const nextTarget = targetParts.join('');
        const nextAlignments: { source: Span; target: Span | null }[] = [];
        let unreusedScheduled = 0;
        for (let i = 0; i < sourceSegments.length; i += 1) {
          const seg = sourceSegments[i]!;
          const reusedTarget = targetSpans.get(i);
          if (reusedTarget) {
            nextAlignments.push({
              source: { start: seg.coreStart, end: seg.coreEnd, text: seg.text },
              target: reusedTarget,
            });
            continue;
          }
          const segChars = chars(seg.text);
          if (segChars.length <= SEGMENT_LIMIT) {
            nextAlignments.push({
              source: { start: seg.coreStart, end: seg.coreEnd, text: seg.text },
              target: null,
            });
            unreusedScheduled += 1;
          } else {
            const subSegments = segmentText(seg.text);
            for (const sub of subSegments) {
              const subText = slice(segChars, sub.core_start, sub.core_end);
              if (!subText.trim()) continue;
              nextAlignments.push({
                source: {
                  start: scalarOffset(seg.coreStart + sub.core_start),
                  end: scalarOffset(seg.coreStart + sub.core_end),
                  text: subText,
                },
                target: null,
              });
              unreusedScheduled += 1;
            }
          }
        }
        if (nextAlignments.length <= 64 && validAlignments(nextAlignments, startDraft.source, nextTarget)) {
          const candidateDraft: Draft = { ...startDraft, target: nextTarget, alignments: nextAlignments };
          if (unreusedScheduled === 0 || buildTranslatePlan(host, candidateDraft) !== null) {
            updatedDraft = candidateDraft;
            appliedReusedUnits = reusedUnits;
            scheduledRemainingCount = unreusedScheduled;
          }
        } else if (reusedUnits.length < candidates.length) {
          return false;
        }
      } else {
        let curTarget = startDraft.target;
        let curAlignments = startDraft.alignments ? [...startDraft.alignments] : null;
        const sc = chars(startDraft.source);
        for (const unit of reusedUnits) {
          const alignmentEntry = curAlignments?.[unit.segmentIndex];
          if (!alignmentEntry || alignmentEntry.target !== null) continue;
          const [aCoreStart, aCoreEnd] = core(sc, alignmentEntry.source.start, alignmentEntry.source.end);
          const segIdx = sourceSegments.findIndex(seg => seg.coreStart === aCoreStart && seg.coreEnd === aCoreEnd);
          if (segIdx < 0) continue;
          const applied = applySegmentSuggestionResult(curTarget, sourceSegments, segIdx, unit.targetText, {
            source: startDraft.source,
            alignments: curAlignments,
          });
          if (applied.applied) {
            curTarget = applied.target;
            curAlignments = applied.alignments;
            appliedReusedUnits.push(unit);
          }
        }
        if (appliedReusedUnits.length > 0) {
          updatedDraft = { ...startDraft, target: curTarget, alignments: curAlignments };
          scheduledRemainingCount = candidates.length - appliedReusedUnits.length;
        }
      }
    }

    const curStructure = host.getState().structure;
    let structureCheckStatus: TmRunReceipt['structureCheckStatus'] = 'skipped';
    const demotedSet = new Set<number>();
    const mergedStructureResults: StructureState['results'] = { ...curStructure.results };
    let structureChecks = curStructure.checks;
    let structurePhase = curStructure.phase;
    let structureError = curStructure.error;

    if (appliedReusedUnits.length > 0) {
      if (
        host.fetchCapabilities
        && (host.getState().capabilities === null || !host.getState().capabilities!.includes(CAPABILITY_STRUCTURE_CHECK))
      ) {
        const refreshed = await host.fetchCapabilities(abort.signal).catch(() => null);
        if (!live()) return true;
        if (Array.isArray(refreshed)) {
          host.setState({ capabilities: refreshed });
        }
      }
      const structureOn = !!host.getState().capabilities?.includes(CAPABILITY_STRUCTURE_CHECK);
      if (!structureOn) {
        structureCheckStatus = 'unavailable';
        for (const unit of appliedReusedUnits) demotedSet.add(unit.segmentIndex);
      } else {
        const trimCore = (value: string) => {
          const list = chars(value);
          const [cs, ce] = core(list, 0, list.length);
          return slice(list, cs, ce);
        };
        const checkItems: { id: string; key: string; source: string; target: string; segmentIndex?: number }[] = [];
        for (const unit of appliedReusedUnits) {
          const sourceCore = trimCore(unit.sourceText);
          const targetCore = trimCore(unit.targetText);
          const key = `${sha256Hex(sourceCore)}:${sha256Hex(targetCore)}`;
          checkItems.push({
            id: `tm-${unit.segmentIndex}`,
            key,
            source: sourceCore,
            target: targetCore,
            segmentIndex: unit.segmentIndex,
          });
        }
        const byId = new Map(checkItems.map(item => [item.id, item]));
        const { batches, skipped } = structureCheckBatches(
          checkItems.map(({ id, source, target }) => ({ id, source, target })),
          STRUCTURE_LIMITS.batchBytes,
        );
        for (const skippedId of skipped) {
          const item = byId.get(skippedId);
          if (item?.segmentIndex !== undefined) demotedSet.add(item.segmentIndex);
        }

        let checkFailed = false;
        const checkedSegmentIndices = new Set<number>();
        for (const batch of batches) {
          try {
            const { response, value } = await host.post('/api/structure-checks', batch, {
              signal: abort.signal,
              allowInvalidJson: true,
            });
            if (!live()) return true;
            host.onPoolRefresh();
            const body = value && typeof value === 'object' ? value as Record<string, unknown> : null;
            if (!response.ok || !validStructureCheckResponse(body, batch)) {
              checkFailed = true;
              structureError = response.ok
                ? { reason: 'responseInvalid' }
                : { reason: runFailure(response, body).code };
              break;
            }
            const answer = body as {
              checks: string[];
              segments: { segment_id: string; findings: StructureFinding[]; omitted_findings: number; layout: StructureState['results'][string]['layout'] }[];
            };
            structureChecks = answer.checks;
            for (const segment of answer.segments) {
              const item = byId.get(segment.segment_id);
              if (!item) continue;
              mergedStructureResults[item.key] = {
                findings: segment.findings,
                omitted: segment.omitted_findings,
                layout: segment.layout,
              };
              if (item.segmentIndex !== undefined) {
                checkedSegmentIndices.add(item.segmentIndex);
                if (segment.findings.length > 0 || segment.omitted_findings > 0) {
                  demotedSet.add(item.segmentIndex);
                }
              }
            }
          } catch {
            if (!live()) return true;
            checkFailed = true;
            structureError = { reason: 'requestFailed' };
            break;
          }
        }

        if (checkFailed) {
          structureCheckStatus = 'failed';
          structurePhase = 'failed';
          for (const unit of appliedReusedUnits) {
            if (!checkedSegmentIndices.has(unit.segmentIndex)) {
              demotedSet.add(unit.segmentIndex);
            }
          }
        } else {
          structurePhase = 'done';
          structureError = null;
          structureCheckStatus = demotedSet.size > 0 ? 'findings' : 'passed';
        }
      }
    }

    const demotedSegmentIndices = [...demotedSet].sort((a, b) => a - b);
    const remainingCount = appliedReusedUnits.length > 0
      ? scheduledRemainingCount
      : candidates.length;
    const baselineRequests = appliedReusedUnits.length + remainingCount;
    const tmReceipt: TmRunReceipt = {
      reused: appliedReusedUnits.length,
      referenced,
      staleOrUnknown,
      retranslated: 0,
      pendingRetranslate: remainingCount,
      demotedByStructureCheck: demotedSegmentIndices.length,
      demotedSegmentIndices,
      modelCalls: 0,
      baselineRequests,
      termsDbRevision: basis.currentTermsDbRevision,
      gameVersion: basis.currentGameVersion,
      structureCheckStatus,
    };

    const nextStructure: StructureState = {
      ...host.getState().structure,
      phase: structurePhase,
      results: mergedStructureResults,
      checks: structureChecks,
      error: structureError,
    };

    if (remainingCount === 0 && appliedReusedUnits.length > 0) {
      host.commit({
        draft: updatedDraft,
        remember: true,
        notice: 'sem:translateRunDone',
        extraPatch: () => ({
          structure: nextStructure,
          tmReceipt,
          run: initialRun() as RunState,
        }),
      });
      return true;
    }

    const built = buildTranslatePlan(host, updatedDraft);
    if (!built) {
      host.commit({
        draft: updatedDraft,
        remember: true,
        notice: null,
        extraPatch: () => ({ structure: nextStructure, tmReceipt }),
      });
      return true;
    }

    built.plan.trackTmModelCalls = true;
    if (options.stageUntilFirstSuccess && updatedDraft !== startDraft) {
      built.plan.staged = {
        draft: updatedDraft,
        structure: nextStructure,
        tmReceipt,
        baseAlignmentsJson: JSON.stringify(startDraft.alignments),
      };
      built.plan.expectedTarget = startDraft.target;
      host.rt.translateRun = built.plan;
      host.startBatch('translate', built.items);
      return true;
    }
    host.rt.translateRun = built.plan;
    if (built.plan.kind === 'blank') {
      host.commit({
        draft: { ...updatedDraft, target: '' },
        remember: true,
        notice: null,
        extraPatch: () => ({ structure: nextStructure, tmReceipt }),
      });
    } else {
      host.commit({
        draft: updatedDraft !== startDraft ? updatedDraft : undefined,
        remember: true,
        notice: null,
        extraPatch: () => ({ structure: nextStructure, tmReceipt }),
      });
    }
    host.startBatch('translate', built.items);
    return true;
  } finally {
    if (host.rt.tmPrepareAbort === abort) host.rt.tmPrepareAbort = null;
    if (!host.rt.disposed && host.rt.tmPrepareGeneration === prepGen && host.getState().tmPreparing) {
      host.setState({ tmPreparing: false });
    }
  }
}

export async function translatePair(host: WorkbenchHost, viewOrIndex: PairView | number): Promise<void> {
  const state = host.getState();
  if (host.rt.disposed || state.pairTranslating !== null) return;
  const view = typeof viewOrIndex === 'number'
    ? host.viewsFor().items.find(v => v.pair.index === viewOrIndex) ?? null
    : viewOrIndex;
  if (!view || !view.sCore.trim() || chars(view.sCore).length > SEGMENT_LIMIT) return;
  const isRetranslate = view.pair.status === 'ready';
  if (view.pair.status !== 'untranslated' && (!isRetranslate || view.pair.hard_cut)) return;
  const d = state.draft;
  const epoch = host.rt.documentEpoch;
  const list = segmentInputs(d).items.map(item => item.pair);
  const before = contextBefore({ pairs: list, segmentIndex: view.pair.index, source: d.source, target: d.target });
  const precedents = state.usePrecedents
    ? selectPrecedents({ items: host.precedentItems(d, state.semantic), source: d.source, pairs: list, segmentIndex: view.pair.index })
    : [];
  const contextOn = !!state.capabilities?.includes(CAPABILITY_TRANSLATION_CONTEXT);
  const context = contextOn ? { context: { ...(before ? { before } : {}), ...(precedents.length ? { precedents } : {}) } } : {};
  const fitted = fitRequestBody({ text: view.sCore, to: d.direction, ...context });
  if (!fitted.fits) return;

  const abort = new AbortController();
  host.rt.pairAbort = abort;
  host.setState({ pairTranslating: view.pair.index, tmReceipt: null });
  try {
    const { response, value } = await host.post('/api/translations', fitted.body, { signal: abort.signal, allowInvalidJson: true });
    const body = value && typeof value === 'object' ? value as Record<string, unknown> : null;
    if (!host.rt.disposed) host.onPoolRefresh();
    if (host.rt.disposed || host.rt.documentEpoch !== epoch || abort.signal.aborted) return;
    if (!response.ok || typeof body?.text !== 'string') {
      const id = typeof body?.request_id === 'string' && body.request_id ? `#${body.request_id}` : '';
      host.commit({ semantic: x => x, notice: `t:${typeof body?.reason === 'string' ? body.reason : 'fallback'}${id}`, remember: false });
      return;
    }
    const latest = host.getState().draft;
    const tc = chars(latest.target);
    const region = view.pair.target;
    if (latest.source !== d.source || latest.target !== d.target || latest.direction !== d.direction
      || JSON.stringify(latest.alignments) !== JSON.stringify(d.alignments)) {
      host.commit({ semantic: x => x, notice: 'sem:segmentChanged', remember: false });
      return;
    }
    if (isRetranslate) {
      const nextTarget = slice(tc, 0, region.core_start) + body.text + slice(tc, region.core_end, tc.length);
      const replacementLen = chars(body.text).length;
      const remap = remapForSplice(latest.alignments, 'target', latest.source, nextTarget, region.core_start, region.core_end, replacementLen);
      host.commit({
        draft: { ...latest, target: nextTarget, alignments: remap.alignments },
        invalidated: remap.invalidated,
        splices: {
          target: {
            start: region.core_start,
            oldEnd: region.core_end,
            newEnd: scalarOffset(region.core_start + replacementLen),
          },
        },
        notice: alignmentNotice(latest.alignments, remap) ?? 'sem:retranslated',
      });
      return;
    }
    const head = slice(tc, 0, region.start);
    const ws = slice(tc, region.start, region.end);
    const tail = slice(tc, region.end, tc.length);
    const lead = head && !/\n[ \t\r]*\n[ \t\r]*$/u.test(head + ws) ? '\n\n' : '';
    const trail = tail && !/^[ \t\r]*\n[ \t\r]*\n/u.test(tail) ? '\n\n' : '';
    const nextTarget = head + ws + lead + body.text + trail + tail;
    const insertAt = chars(head + ws).length;
    const coreStart = insertAt + chars(lead).length;
    const coreEnd = coreStart + chars(body.text).length;
    const delta = chars(lead + body.text + trail).length;
    const remap = remapForTargetFill(
      latest.alignments,
      latest.source,
      nextTarget,
      view.pair.source.start,
      view.pair.source.end,
      insertAt,
      coreStart,
      coreEnd,
      delta,
    );
    host.commit({
      draft: { ...latest, target: nextTarget, alignments: remap.alignments },
      invalidated: remap.invalidated,
      splices: {
        target: {
          start: scalarOffset(insertAt),
          oldEnd: scalarOffset(insertAt),
          newEnd: scalarOffset(insertAt + delta),
        },
      },
      notice: alignmentNotice(latest.alignments, remap) ?? 'sem:translated',
    });
  } catch {
    if (!host.rt.disposed && host.rt.documentEpoch === epoch && !abort.signal.aborted) {
      host.commit({ semantic: x => x, notice: 't:fallback', remember: false });
    }
  } finally {
    if (host.rt.pairAbort === abort) host.rt.pairAbort = null;
    if (!host.rt.disposed && host.rt.documentEpoch === epoch) {
      host.setState({ pairTranslating: null });
    }
  }
}
