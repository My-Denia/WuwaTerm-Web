'use client';

import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';
import { segmentText } from '../../lib/segmentation.js';
import { contextBefore, fitRequestBody, selectPrecedents } from '../../lib/semantic-run.js';
import { applyResult, recheckPlan, recordView, sameV3Basis, segmentInputs, segmentRequest, termPlan, termSegmentKey } from '../../lib/long-review.js';
import { SEMANTIC_REVIEW_VERSION, validSemanticReviewResponse, verifySemanticReviewIdentity } from '../../lib/semantic-review.js';
import { addSegmentResult, decisionFor, placeSemanticResult, semanticSegmentViews } from '../../lib/semantic-state.js';
import { REPORT_V4, recoverSpan, validReport } from '../../lib/manuscript.js';
import { revisionOf } from '../../lib/review-report.js';
import { requestPoolRefresh } from '../../lib/pool-snapshot';
import { postWorkbench, REVIEW_REQUEST_LIMIT, runFailure } from '../../lib/workbench-transport';
import { useSemanticRun, type RunItem } from './use-semantic-run';
import type { ChoiceLike, Commit, Decision, Draft, LongCtx, LongState, Pair, PairView, RecordView, SegmentInput, SemanticReport, SemanticState, SessionBasis, Span, WorkRef } from '../../lib/workbench-model';
import type { UiLanguage } from '../../lib/ui-language';

const uid = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
const chars = (text: string) => Array.from(text);
const slice = (list: string[], start: number, end: number) => list.slice(start, end).join('');
const inputsOf = (draft: Draft) => segmentInputs(draft) as { long: boolean; items: SegmentInput[] };
const viewOf = (long: LongState, index: number, ctx: LongCtx) => recordView(long, index, ctx) as RecordView | null;
const termKey = termSegmentKey;
const failureOf = runFailure;

type Props = {
  lang: UiLanguage;
  work: WorkRef;
  choices: ChoiceLike[];
  basisRef: MutableRefObject<SessionBasis>;
  documentEpoch: MutableRefObject<number>;
  setSemantic: (update: (state: SemanticState) => SemanticState) => void;
  commit: Commit;
  setBasis: (basis: SessionBasis) => void;
  resetSignal: number;
  usePrecedents: boolean;
  contextOn: boolean;
  ready: PairView[];
  onStart: () => void;
};

/** Request coordination for term, semantic and translation work in a manuscript. */
export function useSemanticRequests({ lang, work, choices, basisRef, documentEpoch, setSemantic, commit, setBasis, resetSignal, usePrecedents, contextOn, ready, onStart }: Props) {
  const { run, dispatch, now, fail: failRun, isLive, start: startBatch, runners } = useSemanticRun(resetSignal, documentEpoch);
  const translateRun = useRef<{ source: string; direction: 'en' | 'zh'; segments: { start: number; end: number; core_start: number; core_end: number }[]; pieces: string[]; base: string } | null>(null);
  const [pairTranslating, setPairTranslating] = useState<number | null>(null);
  const [resetSeen, setResetSeen] = useState(resetSignal);
  if (resetSeen !== resetSignal) {
    setResetSeen(resetSignal);
    setPairTranslating(null);
  }
  useEffect(() => { translateRun.current = null; }, [resetSignal]);
  const viewsFor = () => {
    const { draft: currentDraft, semantic: currentState } = work.current;
    return { draft: currentDraft, ...semanticSegmentViews(currentDraft, currentState, basisRef.current) } as { draft: Draft; pairs: Pair[]; items: PairView[] };
  };

  const precedentItems = (d: Draft, state: SemanticState) => {
    const items: { span: Span; choice: string; rendering: string | null }[] = [];
    for (const c of choices) {
      const span = recoverSpan(c.source, c.source_span, d.source) as Span | null;
      if (!span) continue;
      items.push({ span, choice: c.choice, rendering: c.choice === 'not_a_term' ? null : c.candidate ? (d.direction === 'en' ? c.candidate.en : c.candidate.zh) : null });
    }
    for (const p of state.placed) {
      const decided = decisionFor(state, p) as Decision | null;
      if (!decided || decided.decision === 'ignored' || !p.live.source_span || !decided.applied_text) continue;
      items.push({ span: p.live.source_span, choice: 'user_rendering', rendering: decided.applied_text });
    }
    return items;
  };

  const place = async (sentDoc: Draft, pair: Pair, sentSource: string, sentTarget: string, report: SemanticReport, key: string, canApply: () => boolean) => {
    const [sourceRevision, targetRevision] = await Promise.all([revisionOf(sentDoc.source), revisionOf(sentDoc.target)]);
    if (!canApply()) return false;
    const current = work.current.draft;
    const placement = placeSemanticResult({ id: uid(), sentDoc, current, pair, sentSource, sentTarget, report, key, sourceRevision, targetRevision });
    if (!placement || !canApply()) return false;
    setSemantic(state => addSegmentResult(state, placement.result, placement.placed, [
      { revision: sourceRevision, text: sentDoc.source }, { revision: targetRevision, text: sentDoc.target },
    ]) as SemanticState);
    return true;
  };

  const sendSemantic = async (item: RunItem, signal: AbortSignal, generation: number) => {
    const epoch = documentEpoch.current;
    const sentBasis = basisRef.current;
    const live = () => isLive(generation) && documentEpoch.current === epoch && !signal.aborted;
    const { draft: d, pairs: list, items } = viewsFor();
    const found = items.find(v => v.itemKey === item.key && v.pair.status === 'ready');
    if (!found) { dispatch({ type: 'skip', key: item.key }); return; }
    const precedents = usePrecedents ? selectPrecedents({ items: precedentItems(d, work.current.semantic), source: d.source, pairs: list, segmentIndex: found.pair.index }) : [];
    const before = contextBefore({ pairs: list, segmentIndex: found.pair.index, source: d.source, target: d.target });
    const fitted = fitRequestBody({
      source: found.sCore, target: found.tCore, direction: d.direction, review_version: SEMANTIC_REVIEW_VERSION, explain_language: lang,
      ...(before ? { context: { before } } : {}), ...(precedents.length ? { precedents } : {}),
    });
    if (!fitted.fits) { failRun({ type: 'failed', key: item.key, code: 'bodyTooLarge', classification: { action: 'segment_failed' }, now: Date.now() }); return; }
    try {
      const { response, value } = await postWorkbench('/api/semantic-reviews', fitted.body, { signal, allowInvalidJson: true });
      const body = value && typeof value === 'object' ? value as Record<string, unknown> : null;
      if (!live()) return;
      requestPoolRefresh();
      if (!response.ok) { failRun({ type: 'failed', key: item.key, ...failureOf(response, body), now: Date.now() }); return; }
      if (!validSemanticReviewResponse(body, found.sCore, found.tCore) || !await verifySemanticReviewIdentity(body, found.sCore, found.tCore)) {
        if (live()) failRun({ type: 'failed', key: item.key, code: 'responseInvalid', classification: { action: 'segment_failed' }, now: Date.now() });
        return;
      }
      const report = body as unknown as SemanticReport;
      if (report.status === 'not_reviewed') { failRun({ type: 'failed', key: item.key, code: 'not_reviewed', classification: { action: 'segment_failed' }, now: Date.now() }); return; }
      const ok = await place(d, found.pair, found.sCore, found.tCore, report, found.key,
        () => live() && (basisRef.current === sentBasis || sameV3Basis(basisRef.current, sentBasis)));
      if (!live()) return;
      dispatch(ok ? { type: 'done', key: item.key } : { type: 'skip', key: item.key });
    } catch {
      if (live() && !signal.aborted) failRun({ type: 'failed', key: item.key, code: 'requestFailed', classification: { action: 'segment_failed' }, now: Date.now() });
    }
  };

  // Long-mode term check of one segment (SPEC "Runtime", steps 4 to 9). The first request after opening carries no
  // resolutions and supplies the live basis; after every response the session basis is the returned one, and records
  // that it makes due join the run. One item sends at most two requests: a second one with the choices realignment kept
  // (step 6), or a request without resolutions when Core rejects a stale resolution_context. A failure changes nothing.
  const sendTerm = async (item: RunItem, signal: AbortSignal, generation: number) => {
    const epoch = documentEpoch.current;
    const live = () => isLive(generation) && documentEpoch.current === epoch && !signal.aborted;
    const fail = (code: string) => failRun({ type: 'failed', key: item.key, code, classification: { action: 'segment_failed' }, now: Date.now() });
    const [, , sourceHash, targetHash] = item.key.split(':');
    // The segment the run planned: still at its index, or moved by an edit with the same cores.
    const locateItem = () => {
      const { items } = inputsOf(work.current.draft);
      const same = (x: SegmentInput | undefined) => !!x && x.sourceHash === sourceHash && x.targetHash === targetHash;
      return same(items[item.index]) ? item.index : items.findIndex(same);
    };
    let at = locateItem();
    let ctx: LongCtx = { draft: work.current.draft, basis: basisRef.current };
    const first = at < 0 ? null : viewOf(work.current.semantic.long, at, ctx);
    if (!first || !first.ready) { dispatch({ type: 'skip', key: item.key }); return; }
    // Confirmed current by an earlier response of this run: nothing to send.
    if (ctx.basis !== null && !first.needsCheck) { dispatch({ type: 'done', key: item.key }); return; }
    let withResolutions = recheckPlan(work.current.semantic.long, at, ctx) === 'with_resolutions';
    let sent = 0;
    for (;;) {
      const request = segmentRequest(work.current.semantic.long, at, ctx, { withResolutions }) as { index: number; body: Record<string, unknown>; alignmentInput: string; sentKey: string } | null;
      if (!request) { dispatch({ type: 'skip', key: item.key }); return; }
      if (new TextEncoder().encode(JSON.stringify(request.body)).length > REVIEW_REQUEST_LIMIT) { fail('bodyTooLarge'); return; }
      sent += 1;
      try {
        const { response, value } = await postWorkbench('/api/reviews', request.body, { signal, reviewFeatures: true, allowInvalidJson: true });
        const body = value && typeof value === 'object' ? value as Record<string, unknown> : null;
        if (!live()) return;
        requestPoolRefresh();
        if (!response.ok) {
          const failure = failureOf(response, body);
          // A resolution_context Core no longer accepts: ask again without resolutions, which also returns the basis.
          if (Object.hasOwn(request.body, 'resolutions') && failure.code === 'invalid_request' && sent < 2) { withResolutions = false; continue; }
          failRun({ type: 'failed', key: item.key, ...failure, now: Date.now() });
          return;
        }
        if (!validReport(body, request.body.source, request.body.target, REPORT_V4) || body?.rule_version !== 'review-v2') { fail('responseInvalid'); return; }
        const before = basisRef.current;
        let out: { long: LongState; basis: SessionBasis; secondRequest: boolean; error: string | null } | null = null;
        setSemantic(state => {
          out = applyResult(state.long, { draft: work.current.draft, basis: before }, request, body) as typeof out;
          return out && out.long !== state.long ? { ...state, long: out.long } : state;
        });
        const result = out as unknown as { long: LongState; basis: SessionBasis; secondRequest: boolean; error: string | null };
        if (result.error === 'response_invalid') { fail('responseBasisMismatch'); return; }
        setBasis(result.basis);
        // A different basis re-evaluates every record (step 5): the ones it makes due are checked in this run too.
        if (!sameV3Basis(before, result.basis)) {
          const now = { draft: work.current.draft, basis: result.basis };
          const { items } = inputsOf(now.draft);
          const due = work.current.semantic.long.records.flatMap((_, i) => (viewOf(work.current.semantic.long, i, now)?.needsCheck ? [{ key: termKey(i, items[i]), index: i }] : []));
          if (due.length) dispatch({ type: 'extend', items: due });
        }
        if (result.error === 'segment_changed') { dispatch({ type: 'skip', key: item.key }); return; }
        if (result.error) { fail(result.error === 'no_basis' ? 'responseBasisMissing' : 'responseInvalid'); return; }
        if (result.secondRequest && sent < 2) {
          at = locateItem();
          if (at < 0) { dispatch({ type: 'skip', key: item.key }); return; }
          ctx = { draft: work.current.draft, basis: result.basis };
          withResolutions = true;
          continue;
        }
        dispatch({ type: 'done', key: item.key });
        return;
      } catch {
        if (live() && !signal.aborted) fail('requestFailed');
        return;
      }
    }
  };

  // The translation is assembled in order, so a failed segment is never skipped:
  // anything but a wait or a quota pause stops the run with that segment queued,
  // and continuing sends it first.
  const inOrder = (failure: ReturnType<typeof failureOf>) => (['wait', 'pause_quota'].includes((failure.classification as { action: string }).action)
    ? failure : { ...failure, classification: { action: 'stop' } });
  const sendTranslate = async (item: RunItem, signal: AbortSignal, generation: number) => {
    const epoch = documentEpoch.current;
    const live = () => isLive(generation) && documentEpoch.current === epoch && !signal.aborted;
    const plan = translateRun.current;
    const d = work.current.draft;
    // The run translates one source in one direction; any change stops it before sending.
    if (!plan || d.source !== plan.source || d.direction !== plan.direction || d.target !== plan.base + plan.pieces.join('')) {
      failRun({ type: 'failed', key: item.key, code: 'translateTargetChanged', classification: { action: 'stop' }, now: Date.now() });
      commit({ semantic: x => x, notice: 'sem:translateTargetChanged', remember: false });
      return;
    }
    const segment = plan.segments[item.index];
    const sc = chars(d.source);
    const core = slice(sc, segment.core_start, segment.core_end);
    const prev = item.index > 0 ? plan.segments[item.index - 1] : null;
    const previousPiece = item.index > 0 ? plan.pieces[item.index - 1] : '';
    const before = prev ? { source: chars(slice(sc, prev.core_start, prev.core_end)).slice(-400).join(''), target: chars(previousPiece.trim()).slice(-400).join('') } : null;
    const fitted = fitRequestBody({ text: core, to: plan.direction, ...(contextOn ? { context: before ? { before } : {} } : {}) });
    if (!fitted.fits) { failRun({ type: 'failed', key: item.key, code: 'bodyTooLarge', classification: { action: 'stop' }, now: Date.now() }); return; }
    try {
      const { response, value } = await postWorkbench('/api/translations', fitted.body, { signal, allowInvalidJson: true });
      const body = value && typeof value === 'object' ? value as Record<string, unknown> : null;
      if (!live()) return;
      requestPoolRefresh();
      if (!response.ok || typeof body?.text !== 'string') {
        failRun({ type: 'failed', key: item.key, ...(response.ok ? { code: 'responseInvalid', classification: { action: 'stop' } } : inOrder(failureOf(response, body))), now: Date.now() });
        return;
      }
      const latest = work.current.draft;
      if (latest.source !== plan.source || latest.direction !== plan.direction || latest.target !== plan.base + plan.pieces.join('')) {
        failRun({ type: 'failed', key: item.key, code: 'translateTargetChanged', classification: { action: 'stop' }, now: Date.now() });
        commit({ semantic: x => x, notice: 'sem:translateTargetChanged', remember: false });
        return;
      }
      const piece = slice(sc, segment.start, segment.core_start) + body.text + slice(sc, segment.core_end, segment.end);
      plan.pieces[item.index] = piece;
      const done = plan.pieces.filter(p => p !== undefined).length === plan.segments.length;
      commit({ draft: { ...latest, target: plan.base + plan.pieces.join(''), alignments: latest.alignments === null ? null : [] }, remember: false, notice: done ? 'sem:translateRunDone' : null });
      dispatch({ type: 'done', key: item.key });
    } catch {
      if (live() && !signal.aborted) failRun({ type: 'failed', key: item.key, code: 'requestFailed', classification: { action: 'stop' }, now: Date.now() });
    }
  };

  useLayoutEffect(() => { runners.current = { term: sendTerm, translate: sendTranslate, semantic: sendSemantic }; });

  function startRun(kind: 'semantic', only?: PairView[]) {
    const list = only ?? ready.filter(v => !v.result);
    onStart();
    startBatch(kind, list.map(v => ({ key: v.itemKey, index: v.pair.index })));
  }
  /**
   * The long-mode term run: every segment that needs a check, and before the live basis is known the probe first
   * (SPEC "Runtime", step 4), so saved results are confirmed by one request. Segments that the probe's basis makes
   * stale join the run as it goes.
   */
  function startTermRun() {
    const { draft: d, semantic: state } = work.current;
    const ctx: LongCtx = { draft: d, basis: basisRef.current };
    const { items } = inputsOf(d);
    const plan = termPlan(state.long, ctx);
    if (!plan.order.length) return;
    startBatch('term', plan.order.map((i: number) => ({ key: termKey(i, items[i]), index: i })));
  }
  function startTranslateRun() {
    const d = work.current.draft;
    if (!d.source.trim() || d.target.trim()) return;
    const segments = segmentText(d.source) as { start: number; end: number; core_start: number; core_end: number }[];
    translateRun.current = { source: d.source, direction: d.direction, segments, pieces: [], base: '' };
    // One undo step for the whole generated translation: the blank target before it.
    commit({ draft: { ...d, target: '' }, remember: true, notice: null });
    startBatch('translate', segments.map((_, index) => ({ key: `tr#${index}`, index })));
  }

  async function translatePair(view: PairView) {
    if (pairTranslating !== null || !view.sCore.trim()) return;
    const d = work.current.draft;
    const epoch = documentEpoch.current;
    const sentBasis = basisRef.current;
    const list = inputsOf(d).items.map(item => item.pair);
    const before = contextBefore({ pairs: list, segmentIndex: view.pair.index, source: d.source, target: d.target });
    const precedents = usePrecedents ? selectPrecedents({ items: precedentItems(d, work.current.semantic), source: d.source, pairs: list, segmentIndex: view.pair.index }) : [];
    // ADR 0019 decision 5: a negotiated context is always present, even as {} on the first pair.
    const context = contextOn ? { context: { ...(before ? { before } : {}), ...(precedents.length ? { precedents } : {}) } } : {};
    const fitted = fitRequestBody({ text: view.sCore, to: d.direction, ...context });
    if (!fitted.fits) return;
    setPairTranslating(view.pair.index);
    try {
      const { response, value } = await postWorkbench('/api/translations', fitted.body, { allowInvalidJson: true });
      const body = value && typeof value === 'object' ? value as Record<string, unknown> : null;
      requestPoolRefresh();
      if (documentEpoch.current !== epoch) return;
      if (!response.ok || typeof body?.text !== 'string') {
        // The reason, then the request id after '#', so the notice can show both (review-workbench noticeText).
        const id = typeof body?.request_id === 'string' && body.request_id ? `#${body.request_id}` : '';
        commit({ semantic: x => x, notice: `t:${typeof body?.reason === 'string' ? body.reason : 'fallback'}${id}`, remember: false }); return;
      }
      const latest = work.current.draft;
      const tc = chars(latest.target);
      const region = view.pair.target;
      if (latest.source !== d.source || latest.target !== d.target || latest.direction !== d.direction
        || JSON.stringify(latest.alignments) !== JSON.stringify(d.alignments)
        || (basisRef.current !== sentBasis && !sameV3Basis(basisRef.current, sentBasis))) { commit({ semantic: x => x, notice: 'sem:segmentChanged', remember: false }); return; }
      const head = slice(tc, 0, region.start); const ws = slice(tc, region.start, region.end); const tail = slice(tc, region.end, tc.length);
      const lead = head && !/\n[ \t\r]*\n[ \t\r]*$/u.test(head + ws) ? '\n\n' : '';
      const trail = tail && !/^[ \t\r]*\n[ \t\r]*\n/u.test(tail) ? '\n\n' : '';
      commit({ draft: { ...latest, target: head + ws + lead + body.text + trail + tail, alignments: latest.alignments === null ? null : [] }, notice: 'sem:translated' });
    } catch {
      if (documentEpoch.current === epoch) commit({ semantic: x => x, notice: 't:fallback', remember: false });
    } finally { if (documentEpoch.current === epoch) setPairTranslating(null); }
  }

  return { run, dispatch, now, pairTranslating, startRun, startTermRun, startTranslateRun, translatePair };
}
