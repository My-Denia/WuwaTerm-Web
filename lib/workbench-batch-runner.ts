// Serial batch runner (wait timers, pump loop, semantic & term segment sending)
// for WorkbenchController. Zero React imports.
import {
  applyResult,
  recheckPlan,
  recordView,
  sameV3Basis,
  segmentInputs,
  segmentRequest,
  termPlan,
  termSegmentKey,
} from './long-review.ts';
import { REPORT_V4, REPORT_V5, REVIEW_FEATURE_AMBIGUOUS_MENTION, recoverSpan, validReport } from './manuscript.js';
import { revisionOf } from './review-report.js';
import { SEMANTIC_REVIEW_VERSION, validSemanticReviewResponse, verifySemanticReviewIdentity } from './semantic-review.js';
import { contextBefore, fitRequestBody, initialRun, nextToSend, runReducer, selectPrecedents } from './semantic-run.js';
import { addSegmentResult, decisionFor, placeSemanticResult } from './semantic-state.js';
import type { UiLanguage } from './ui-language.ts';
import type {
  Decision, Draft, LongCtx, Pair, PairView, RunItem, RunKind, RunState,
  SegmentInput, SemanticReport, SemanticState, Span,
} from './workbench-model.ts';
import type { WorkbenchHost } from './workbench-store.ts';
import { REVIEW_REQUEST_LIMIT, runFailure } from './workbench-transport.ts';

export function clearWaitTimers(host: WorkbenchHost): void {
  if (host.rt.waitTimeout !== null) {
    host.clock.clearTimeout(host.rt.waitTimeout);
    host.rt.waitTimeout = null;
  }
  if (host.rt.waitInterval !== null) {
    host.clock.clearInterval(host.rt.waitInterval);
    host.rt.waitInterval = null;
  }
  host.rt.waitTarget = null;
}

export function syncWaitTimer(host: WorkbenchHost): void {
  const { run } = host.getState();
  if (host.rt.disposed || run.phase !== 'waiting' || run.waitUntil === null) {
    clearWaitTimers(host);
    return;
  }
  const target = run.waitUntil;
  if (host.rt.waitTarget === target && (host.rt.waitInterval !== null || host.rt.waitTimeout !== null)) return;
  clearWaitTimers(host);
  host.rt.waitTarget = target;

  const tick = () => {
    if (host.rt.disposed) { clearWaitTimers(host); return; }
    const currentNow = host.clock.now();
    const currentRun = host.getState().run;
    if (currentRun.phase !== 'waiting' || currentRun.waitUntil === null) {
      clearWaitTimers(host);
      return;
    }
    if (currentNow >= currentRun.waitUntil) {
      clearWaitTimers(host);
      host.setState({ now: currentNow });
      dispatchRun(host, { type: 'resume' });
    } else {
      host.setState({ now: currentNow });
    }
  };

  const remaining = target - host.clock.now();
  if (remaining <= 0) {
    host.rt.waitTimeout = host.clock.setTimeout(tick, 0);
    return;
  }
  host.rt.waitInterval = host.clock.setInterval(tick, 1000);
  host.rt.waitTimeout = host.clock.setTimeout(tick, remaining);
}

export function dispatchRun(host: WorkbenchHost, event: Record<string, unknown>): void {
  if (host.rt.disposed) return;
  if (event.type === 'reset') {
    host.resetRun();
    return;
  }
  const nextRun = runReducer(host.getState().run, event) as RunState;
  host.setState({ run: nextRun });
  syncWaitTimer(host);
  pumpRun(host);
}

export function failRun(host: WorkbenchHost, event: Record<string, unknown> & { now: number }): void {
  if (host.rt.disposed) return;
  const nextRun = runReducer(host.getState().run, event) as RunState;
  host.setState({ now: event.now, run: nextRun });
  syncWaitTimer(host);
  pumpRun(host);
}

export function startBatch(host: WorkbenchHost, kind: RunKind, items: { key: string; index: number }[]): void {
  if (host.rt.disposed) return;
  clearWaitTimers(host);
  host.rt.runGeneration += 1;
  host.rt.runAbort?.abort();
  host.rt.runAbort = null;
  host.rt.inflight = null;
  const nextRun = runReducer(host.getState().run, { type: 'start', kind, items }) as RunState;
  host.setState({ run: nextRun });
  syncWaitTimer(host);
  pumpRun(host);
}

export function retryFailedRunItems(host: WorkbenchHost): void {
  const failedKeys = host.getState().run.items.filter(i => i.status === 'failed').map(i => i.key);
  for (const key of failedKeys) dispatchRun(host, { type: 'retry', key });
}

export function resetRun(host: WorkbenchHost): void {
  host.abortRunInternal();
  host.setState({ run: initialRun() as RunState });
}

export function pumpRun(host: WorkbenchHost): void {
  if (host.rt.disposed || host.rt.pumping) return;
  host.rt.pumping = true;
  try {
    for (;;) {
      if (host.rt.disposed) return;
      const item = nextToSend(host.getState().run, host.rt.inflight) as RunItem | null;
      if (!item || !host.getState().run.kind) return;
      const kind = host.getState().run.kind!;
      host.rt.inflight = { key: item.key, attempt: (item.attempt ?? 0) + 1 };
      const sentRun = runReducer(host.getState().run, { type: 'sent', key: item.key }) as RunState;
      host.setState({ run: sentRun });
      const abortController = new AbortController();
      host.rt.runAbort = abortController;
      const currentGeneration = host.rt.runGeneration;
      const currentEpoch = host.rt.documentEpoch;
      void host.executeRunItem(kind, item, abortController.signal, currentGeneration, currentEpoch)
        .catch(() => {
          if (!host.rt.disposed && host.rt.runGeneration === currentGeneration && host.rt.documentEpoch === currentEpoch) {
            failRun(host, { type: 'failed', key: item.key, code: 'requestFailed', classification: { action: 'stop' }, now: host.clock.now() });
          }
        })
        .finally(() => {
          if (host.rt.runAbort === abortController) host.rt.runAbort = null;
        });
    }
  } finally {
    host.rt.pumping = false;
  }
}

export function precedentItems(host: WorkbenchHost, d: Draft, state: SemanticState) {
  const items: { span: Span; choice: string; rendering: string | null }[] = [];
  for (const c of host.getState().choices) {
    const span = recoverSpan(c.source, c.source_span, d.source);
    if (!span) continue;
    items.push({
      span,
      choice: c.choice,
      rendering: c.choice === 'not_a_term' ? null : c.candidate ? (d.direction === 'en' ? c.candidate.en : c.candidate.zh) : null,
    });
  }
  for (const p of state.placed) {
    const decided = decisionFor(state, p) as Decision | null;
    if (!decided || decided.decision === 'ignored' || !p.live.source_span || !decided.applied_text) continue;
    items.push({ span: p.live.source_span, choice: 'user_rendering', rendering: decided.applied_text });
  }
  return items;
}

async function placeSemantic(
  host: WorkbenchHost,
  sentDoc: Draft, pair: Pair, sentSource: string, sentTarget: string,
  report: SemanticReport, key: string, canApply: () => boolean,
): Promise<boolean> {
  const [sourceRevision, targetRevision] = await Promise.all([revisionOf(sentDoc.source), revisionOf(sentDoc.target)]);
  if (!canApply()) return false;
  const current = host.getState().draft;
  const placement = placeSemanticResult({
    id: host.uid(), sentDoc, current, pair, sentSource, sentTarget, report, key, sourceRevision, targetRevision,
  });
  if (!placement || !canApply()) return false;
  host.applySemantic(state => addSegmentResult(state, placement.result, placement.placed, [
    { revision: sourceRevision, text: sentDoc.source },
    { revision: targetRevision, text: sentDoc.target },
  ]) as SemanticState);
  return true;
}

export async function sendSemantic(host: WorkbenchHost, item: RunItem, signal: AbortSignal, generation: number, epoch: number): Promise<void> {
  const state = host.getState();
  const sentBasis = state.basis;
  const live = () => !host.rt.disposed && host.rt.runGeneration === generation && host.rt.documentEpoch === epoch && !signal.aborted;
  const { draft: d, pairs: list, items } = host.viewsFor();
  const found = items.find(v => v.itemKey === item.key && v.pair.status === 'ready');
  if (!found) { dispatchRun(host, { type: 'skip', key: item.key }); return; }
  const precedents = state.usePrecedents
    ? selectPrecedents({ items: precedentItems(host, d, state.semantic), source: d.source, pairs: list, segmentIndex: found.pair.index })
    : [];
  const before = contextBefore({ pairs: list, segmentIndex: found.pair.index, source: d.source, target: d.target });
  const fitted = fitRequestBody({
    source: found.sCore, target: found.tCore, direction: d.direction,
    review_version: SEMANTIC_REVIEW_VERSION, explain_language: state.lang,
    ...(before ? { context: { before } } : {}),
    ...(precedents.length ? { precedents } : {}),
  });
  if (!fitted.fits) {
    failRun(host, { type: 'failed', key: item.key, code: 'bodyTooLarge', classification: { action: 'segment_failed' }, now: host.clock.now() });
    return;
  }
  try {
    const { response, value } = await host.post('/api/semantic-reviews', fitted.body, { signal, allowInvalidJson: true });
    const body = value && typeof value === 'object' ? value as Record<string, unknown> : null;
    if (!live()) return;
    host.onPoolRefresh();
    if (!response.ok) {
      failRun(host, { type: 'failed', key: item.key, ...runFailure(response, body), now: host.clock.now() });
      return;
    }
    const valid = validSemanticReviewResponse(body, found.sCore, found.tCore)
      && await verifySemanticReviewIdentity(body, found.sCore, found.tCore);
    if (!live()) return;
    if (!valid) {
      failRun(host, { type: 'failed', key: item.key, code: 'responseInvalid', classification: { action: 'segment_failed' }, now: host.clock.now() });
      return;
    }
    const report = body as unknown as SemanticReport;
    if (report.status === 'not_reviewed') {
      failRun(host, { type: 'failed', key: item.key, code: 'not_reviewed', classification: { action: 'segment_failed' }, now: host.clock.now() });
      return;
    }
    const ok = await placeSemantic(
      host,
      d, found.pair, found.sCore, found.tCore, report, found.key,
      () => live() && (host.getState().basis === sentBasis || sameV3Basis(host.getState().basis, sentBasis)),
    );
    if (!live()) return;
    dispatchRun(host, ok ? { type: 'done', key: item.key } : { type: 'skip', key: item.key });
  } catch {
    if (live() && !signal.aborted) {
      failRun(host, { type: 'failed', key: item.key, code: 'requestFailed', classification: { action: 'segment_failed' }, now: host.clock.now() });
    }
  }
}

export async function sendTerm(host: WorkbenchHost, item: RunItem, signal: AbortSignal, generation: number, epoch: number): Promise<void> {
  const live = () => !host.rt.disposed && host.rt.runGeneration === generation && host.rt.documentEpoch === epoch && !signal.aborted;
  const fail = (code: string) => failRun(host, { type: 'failed', key: item.key, code, classification: { action: 'segment_failed' }, now: host.clock.now() });
  const [, , sourceHash, targetHash] = item.key.split(':');
  const locateItem = () => {
    const { items } = segmentInputs(host.getState().draft);
    const same = (x: SegmentInput | undefined) => !!x && x.sourceHash === sourceHash && x.targetHash === targetHash;
    return same(items[item.index]) ? item.index : items.findIndex(same);
  };
  if (host.getState().capabilities === null && host.rt.capabilitiesPromise) {
    await host.requestFeatures();
    if (!live()) return;
  }
  let at = locateItem();
  let ctx: LongCtx = host.longCtx();
  const first = at < 0 ? null : recordView(host.getState().semantic.long, at, ctx);
  if (!first || !first.ready) { dispatchRun(host, { type: 'skip', key: item.key }); return; }
  if (ctx.basis !== null && !first.needsCheck) { dispatchRun(host, { type: 'done', key: item.key }); return; }
  let withResolutions = recheckPlan(host.getState().semantic.long, at, ctx) === 'with_resolutions';
  let sent = 0;
  for (;;) {
    const request = segmentRequest(host.getState().semantic.long, at, ctx, { withResolutions });
    if (!request) { dispatchRun(host, { type: 'skip', key: item.key }); return; }
    if (new TextEncoder().encode(JSON.stringify(request.body)).length > REVIEW_REQUEST_LIMIT) {
      fail('bodyTooLarge');
      return;
    }
    sent += 1;
    try {
      const features = request.features ?? [];
      const { response, value } = await host.post('/api/reviews', request.body, { signal, reviewFeatures: features.length ? features : true, allowInvalidJson: true });
      const body = value && typeof value === 'object' ? value as Record<string, unknown> : null;
      if (!live()) return;
      host.onPoolRefresh();
      if (!response.ok) {
        const failure = runFailure(response, body);
        if (Object.hasOwn(request.body, 'resolutions') && failure.code === 'invalid_request' && sent < 2) {
          withResolutions = false;
          continue;
        }
        failRun(host, { type: 'failed', key: item.key, ...failure, now: host.clock.now() });
        return;
      }
      if (!validReport(body, request.body.source, request.body.target, features.includes(REVIEW_FEATURE_AMBIGUOUS_MENTION) ? REPORT_V5 : REPORT_V4)
        || body?.rule_version !== 'review-v2') {
        fail('responseInvalid');
        return;
      }
      const curState = host.getState();
      const before = curState.basis;
      const result = applyResult(
        curState.semantic.long,
        host.longCtx(before),
        request,
        body,
      );
      if (result.error === 'response_invalid') { fail('responseBasisMismatch'); return; }
      const nextSemantic = result.long !== curState.semantic.long
        ? { ...curState.semantic, long: result.long }
        : curState.semantic;
      host.setState({ semantic: nextSemantic, basis: result.basis });
      if (!sameV3Basis(before, result.basis)) {
        const nowCtx = host.longCtx(result.basis);
        const { items } = segmentInputs(nowCtx.draft);
        const updatedLong = host.getState().semantic.long;
        const due = updatedLong.records.flatMap((_, i) =>
          (recordView(updatedLong, i, nowCtx)?.needsCheck ? [{ key: termSegmentKey(i, items[i]), index: i }] : []),
        );
        if (due.length) dispatchRun(host, { type: 'extend', items: due });
      }
      if (result.error === 'segment_changed') { dispatchRun(host, { type: 'skip', key: item.key }); return; }
      if (result.error) { fail(result.error === 'no_basis' ? 'responseBasisMissing' : 'responseInvalid'); return; }
      if (result.secondRequest && sent < 2) {
        at = locateItem();
        if (at < 0) { dispatchRun(host, { type: 'skip', key: item.key }); return; }
        ctx = host.longCtx(result.basis);
        withResolutions = true;
        continue;
      }
      dispatchRun(host, { type: 'done', key: item.key });
      return;
    } catch {
      if (live() && !signal.aborted) fail('requestFailed');
      return;
    }
  }
}

export function startSemanticRun(host: WorkbenchHost, only?: PairView[], lang?: UiLanguage): void {
  if (lang) host.setState({ lang });
  const list = only ?? host.viewsFor().items.filter(v => v.pair.status === 'ready' && !v.result);
  startBatch(host, 'semantic', list.map(v => ({ key: v.itemKey, index: v.pair.index })));
}

export function startTermRun(host: WorkbenchHost): void {
  const { draft, semantic } = host.getState();
  const ctx: LongCtx = host.longCtx();
  const { items } = segmentInputs(draft);
  const plan = termPlan(semantic.long, ctx);
  if (!plan.order.length) return;
  startBatch(host, 'term', plan.order.map((i: number) => ({ key: termSegmentKey(i, items[i]), index: i })));
}
