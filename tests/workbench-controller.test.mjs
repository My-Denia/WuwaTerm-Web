import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { canonicalOf, createWorkbenchController, isRunActive } from '../lib/workbench-controller.ts';
import { recordView } from '../lib/long-review.js';
import { issueStatus } from '../lib/semantic-state.js';
import { FRESH_MATCHER_REVISION, fixture, freshApiReport } from './fixtures/manuscript.mjs';
import { defaultSemanticResponse, semanticResponse } from './helpers/semantic-fixture.mjs';

function makeClock(start = 1_700_000_000_000) {
  let current = start;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => current,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { id, fn, at: current + Math.max(0, ms), interval: null });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn, ms) {
      const id = nextId++;
      const step = Math.max(1, ms);
      timers.set(id, { id, fn, at: current + step, interval: step });
      return id;
    },
    clearInterval(id) { timers.delete(id); },
    activeCount() { return timers.size; },
    async advance(ms) {
      const target = current + ms;
      for (;;) {
        const due = [...timers.values()]
          .filter(t => t.at <= target)
          .sort((a, b) => a.at - b.at || a.id - b.id);
        if (!due.length) break;
        const next = due[0];
        current = next.at;
        if (next.interval === null) timers.delete(next.id);
        else next.at += next.interval;
        next.fn();
        await flushMicrotasks();
      }
      current = target;
      await flushMicrotasks();
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function flushMicrotasks(turns = 10) {
  for (let i = 0; i < turns; i += 1) {
    await new Promise(resolve => queueMicrotask(resolve));
  }
}

function jsonResponse(body, status = 200, headers = {}) {
  return {
    response: new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    }),
    value: body,
  };
}

function reviewReportFor(body, matcherRevision = FRESH_MATCHER_REVISION) {
  return {
    ...freshApiReport(fixture(body.source, body.target, body.direction).report),
    matcher_revision: matcherRevision,
  };
}

function fileFromText(name, text) {
  const bytes = new TextEncoder().encode(text);
  return {
    name,
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

async function waitUntil(predicate, limit = 80) {
  for (let i = 0; i < limit; i += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.fail('condition did not settle in time');
}

test('workbench-controller and workbench-model have zero React imports', () => {
  const controllerSrc = readFileSync(fileURLToPath(new URL('../lib/workbench-controller.ts', import.meta.url)), 'utf8');
  const modelSrc = readFileSync(fileURLToPath(new URL('../lib/workbench-model.ts', import.meta.url)), 'utf8');
  for (const [name, src] of [['lib/workbench-controller.ts', controllerSrc], ['lib/workbench-model.ts', modelSrc]]) {
    assert.equal(/\bfrom\s+['"]react['"]/u.test(src), false, `${name} must not import react`);
    assert.equal(/\brequire\(\s*['"]react['"]\s*\)/u.test(src), false, `${name} must not require react`);
  }
});

test('getSnapshot reference is stable and subscribe notifies only on state changes', () => {
  const clock = makeClock();
  const doc = createWorkbenchController({ clock, onPoolRefresh: () => {} });
  const initial = doc.getSnapshot();
  assert.equal(doc.getSnapshot(), initial);

  let notifications = 0;
  const unsubscribe = doc.subscribe(() => { notifications += 1; });
  doc.setLang('zh'); // unchanged
  assert.equal(notifications, 0);
  assert.equal(doc.getSnapshot(), initial);

  doc.editText('source', '今汐');
  assert.equal(notifications, 1);
  const afterEdit = doc.getSnapshot();
  assert.notEqual(afterEdit, initial);
  assert.equal(afterEdit.draft.source, '今汐');
  assert.equal(doc.getSnapshot(), afterEdit);

  unsubscribe();
  doc.editText('target', 'Jinhsi');
  assert.equal(notifications, 1);
  doc.dispose();
});

test('document review start, abort, stale generation guard, commit, undo and export', async () => {
  const clock = makeClock();
  const calls = [];
  const gate1 = deferred();
  let poolRefreshes = 0;
  const doc = createWorkbenchController({
    clock,
    onPoolRefresh: () => { poolRefreshes += 1; },
    post: async (path, body, options) => {
      calls.push({ path, body, signal: options?.signal, reviewFeatures: options?.reviewFeatures });
      if (calls.length === 1) {
        await gate1.promise;
        return jsonResponse(reviewReportFor(body));
      }
      return jsonResponse(reviewReportFor(body));
    },
  });

  doc.editText('source', '今汐');
  doc.editText('target', 'Jinhsi');
  const firstCheck = doc.check();
  assert.equal(doc.getSnapshot().phase, 'loading');
  assert.equal(doc.getSnapshot().inFlight, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/reviews');
  assert.equal(calls[0].reviewFeatures, true);
  assert.equal(calls[0].signal.aborted, false);

  // Editing while in flight aborts the first request and bumps generation.
  doc.editText('target', 'Jinhsi updated');
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(doc.getSnapshot().phase, 'idle');
  assert.equal(doc.getSnapshot().inFlight, false);

  // Even if the first transport promise resolves late, it cannot commit to reports.
  gate1.resolve();
  await firstCheck;
  assert.equal(doc.getSnapshot().reports.length, 0);
  assert.equal(doc.getSnapshot().phase, 'idle');

  // Fresh check commits cleanly and updates pool.
  await doc.check();
  const afterCommit = doc.getSnapshot();
  assert.equal(afterCommit.phase, 'success');
  assert.equal(afterCommit.notice, 'checked');
  assert.equal(afterCommit.reports.length, 1);
  assert.equal(afterCommit.reports[0].trusted, true);
  assert.equal(poolRefreshes, 1);

  // Save, exportResult, exportMarkdown and undo work without DOM.
  const saved = doc.save();
  assert.ok(saved);
  assert.equal(saved.filename, 'wuwaterm-manuscript.json');
  assert.equal(doc.getSnapshot().downloadedCanonical, saved.content);

  const exported = doc.exportResult();
  assert.equal(exported.filename, 'wuwaterm-result.json');
  assert.equal(JSON.parse(exported.content).report_is_current, true);

  const markdown = doc.exportMarkdown('en');
  assert.equal(markdown.filename, 'wuwaterm-report.md');
  assert.match(markdown.content, /Jinhsi updated/u);

  doc.undo();
  assert.equal(doc.getSnapshot().draft.target, 'Jinhsi');
  doc.dispose();
});

test('reopened v3/v4 manuscript: live-basis probe -> term check -> extend on changed basis -> semantic check -> waiting backoff -> stop/reset', async () => {
  const clock = makeClock(1_700_000_000_000);
  const v3Text = readFileSync(fileURLToPath(new URL('../contracts/manuscript-v3/valid-v3-all-parts.json', import.meta.url)), 'utf8');
  const v4Text = readFileSync(fileURLToPath(new URL('../contracts/manuscript-v4/valid-v4-segment-reason-only.json', import.meta.url)), 'utf8');

  const reviewCalls = [];
  const semanticCalls = [];
  let semanticAttempt = 0;
  let heldSemantic = null;
  let matcherRevision = '9'.repeat(64); // Different from saved v3 basis -> extends run to re-check saved record too!

  const doc = createWorkbenchController({
    clock,
    initialCapabilities: ['semantic-review-v1', 'translation-context-v1'],
    onPoolRefresh: () => {},
    post: async (path, body, options) => {
      if (path === '/api/reviews') {
        reviewCalls.push({ body, signal: options?.signal });
        return jsonResponse(reviewReportFor(body, matcherRevision));
      }
      if (path === '/api/semantic-reviews') {
        semanticAttempt += 1;
        semanticCalls.push({ body, signal: options?.signal, attempt: semanticAttempt });
        if (semanticAttempt === 2) {
          return jsonResponse({ status: 'unavailable', reason: 'shared_pool_busy', retry_after_seconds: 5 }, 429, { 'retry-after': '5' });
        }
        if (heldSemantic && semanticAttempt >= 4) {
          await heldSemantic.promise;
        }
        return jsonResponse(await defaultSemanticResponse(body));
      }
      throw new Error(`unexpected path: ${path}`);
    },
  });

  // 1. Reopen v4 manuscript first to verify v4 import sets basis=null and keeps saved records.
  const v4Outcome = await doc.importFile(fileFromText('v4.json', v4Text));
  assert.equal(v4Outcome.status, 'imported');
  assert.equal(doc.getSnapshot().basis, null);
  assert.equal(doc.getSnapshot().notice, 'imported');
  assert.ok(doc.getSnapshot().semantic.long.records.length > 0);

  // 2. Reopen v3 manuscript (3 segments: 0 pending, 1 saved, 2 stale).
  const v3Outcome = await doc.importFile(fileFromText('v3.json', v3Text));
  assert.equal(v3Outcome.status, 'imported');
  const opened = doc.getSnapshot();
  assert.equal(opened.basis, null);
  assert.equal(recordView(opened.semantic.long, 0, { draft: opened.draft, basis: opened.basis }).state, 'pending');
  assert.equal(recordView(opened.semantic.long, 1, { draft: opened.draft, basis: opened.basis }).state, 'saved');
  assert.equal(recordView(opened.semantic.long, 2, { draft: opened.draft, basis: opened.basis }).state, 'stale');

  // 3. Term check: probe establishes changed live basis -> extends run to include segment 1 too (all 3 checked).
  doc.startTermRun();
  await waitUntil(() => doc.getSnapshot().run.phase === 'done');
  const afterTerms = doc.getSnapshot();
  assert.equal(afterTerms.basis.matcher_revision, matcherRevision);
  assert.equal(reviewCalls.length, 3);
  assert.deepEqual(
    [0, 1, 2].map(i => recordView(afterTerms.semantic.long, i, { draft: afterTerms.draft, basis: afterTerms.basis }).state),
    ['current', 'current', 'current'],
  );

  // 4. Semantic check: call 1 succeeds, call 2 gets 429 shared_pool_busy (5s wait) -> fake clock ticks & resumes!
  doc.startSemanticRun();
  await waitUntil(() => doc.getSnapshot().run.phase === 'waiting');
  const waitingSnap = doc.getSnapshot();
  assert.equal(waitingSnap.run.phase, 'waiting');
  assert.equal(waitingSnap.run.waitUntil, 1_700_000_005_000);
  assert.equal(waitingSnap.now, 1_700_000_000_000);
  assert.equal(semanticCalls.length, 2);
  assert.ok(clock.activeCount() > 0);

  // Advance 2s: countdown ticks `now`, still waiting, no resend yet.
  await clock.advance(2000);
  assert.equal(doc.getSnapshot().run.phase, 'waiting');
  assert.equal(doc.getSnapshot().now, 1_700_000_002_000);
  assert.equal(semanticCalls.length, 2);

  // Hold the 4th semantic call (segment 3) so we can verify stop/reset aborts cleanly.
  heldSemantic = deferred();
  await clock.advance(3000); // reaches waitUntil -> resumes and retries segment 2 (call 3), then starts segment 3 (call 4)
  await waitUntil(() => semanticCalls.length === 4);
  assert.equal(doc.getSnapshot().run.phase, 'running');
  assert.equal(doc.getSnapshot().semantic.results.length, 2);
  assert.equal(semanticCalls[3].signal.aborted, false);

  // Stop/reset aborts the in-flight semantic call and resets run to idle.
  doc.stopRun();
  assert.equal(semanticCalls[3].signal.aborted, true);
  assert.equal(doc.getSnapshot().run.phase, 'idle');
  assert.equal(doc.getSnapshot().run.kind, null);
  assert.equal(clock.activeCount(), 0);

  heldSemantic.resolve();
  await flushMicrotasks();
  assert.equal(doc.getSnapshot().semantic.results.length, 2);
  doc.dispose();
});

test('piece translation, pair translation with epoch guard, and clean dispose()', async () => {
  const clock = makeClock(1_700_000_000_000);
  const translateCalls = [];
  let heldCall = null;

  const doc = createWorkbenchController({
    clock,
    initialCapabilities: ['translation-context-v1'],
    onPoolRefresh: () => {},
    post: async (path, body, options) => {
      assert.equal(path, '/api/translations');
      translateCalls.push({ body, signal: options?.signal });
      if (heldCall) {
        const currentGate = heldCall;
        heldCall = null;
        await currentGate.promise;
      }
      return jsonResponse({ text: `EN(${body.text.slice(0, 12)})` });
    },
  });

  // 1. Piece translation over a 2-paragraph blank-target long manuscript (>2000 scalars).
  const p1 = `第一段${'甲'.repeat(1100)}。`;
  const p2 = `第二段${'乙'.repeat(1100)}。`;
  doc.editText('source', `${p1}\n\n${p2}`);
  doc.startTranslateRun();
  await waitUntil(() => doc.getSnapshot().run.phase === 'done');
  assert.equal(translateCalls.length, 2);
  assert.deepEqual(translateCalls[0].body.context, {});
  assert.ok(translateCalls[1].body.context.before.source.length > 0);
  assert.ok(translateCalls[1].body.context.before.target.includes('EN('));
  assert.equal(doc.getSnapshot().notice, 'sem:translateRunDone');
  assert.ok(doc.getSnapshot().draft.target.includes('\n\n'));

  // One undo returns to the blank target before the generated translation.
  doc.undo();
  assert.equal(doc.getSnapshot().draft.target, '');

  // 2. Pair translation succeeds on an untranslated pair, and epoch guard blocks stale writes on replacement.
  doc.receiveDraft({ source: '她看见三只鸟。', target: '', direction: 'en', alignments: null });
  await doc.translatePair(0);
  assert.equal(doc.getSnapshot().pairTranslating, null);
  assert.equal(doc.getSnapshot().draft.target, 'EN(她看见三只鸟。)');
  assert.equal(doc.getSnapshot().notice, 'sem:translated');

  doc.receiveDraft({ source: '另一段待译文本。', target: '', direction: 'en', alignments: null });
  const epochBefore = doc.getSnapshot().documentEpoch;
  const pairGate = deferred();
  heldCall = pairGate;
  const pairPromise = doc.translatePair(0);
  assert.equal(doc.getSnapshot().pairTranslating, 0);
  assert.equal(isRunActive(doc.getSnapshot().run, doc.getSnapshot().pairTranslating), true);

  // Install a brand-new manuscript while pair translation is in flight.
  // The epoch guard drops the late response without mutating the new manuscript.
  doc.receiveDraft({ source: '新稿件。', target: 'New draft.', direction: 'en', alignments: null });
  assert.equal(doc.getSnapshot().documentEpoch, epochBefore + 1);
  assert.equal(doc.getSnapshot().pairTranslating, null);

  pairGate.resolve();
  await pairPromise;
  assert.equal(doc.getSnapshot().draft.target, 'New draft.');
  assert.equal(doc.getSnapshot().notice, 'receivedDraft');

  // 3. Clean dispose() while waiting timer and requests are active: aborts signals, clears timers, silences listeners.
  const reviewGate = deferred();
  const waitClock = makeClock(1_700_000_000_000);
  const disposeSignals = [];
  let callsAfterDispose = 0;
  let disposedFlag = false;
  const doc2 = createWorkbenchController({
    clock: waitClock,
    initialCapabilities: ['semantic-review-v1', 'translation-context-v1'],
    onPoolRefresh: () => {},
    post: async (path, body, options) => {
      disposeSignals.push(options?.signal);
      if (path === '/api/reviews') {
        await reviewGate.promise;
        return jsonResponse(reviewReportFor(body));
      }
      if (path === '/api/semantic-reviews') {
        return jsonResponse({ status: 'unavailable', reason: 'shared_pool_busy', retry_after_seconds: 10 }, 429, { 'retry-after': '10' });
      }
      throw new Error(`unexpected ${path}`);
    },
  });
  doc2.subscribe(() => { if (disposedFlag) callsAfterDispose += 1; });
  doc2.editText('source', '今汐。');
  doc2.editText('target', 'Jinhsi.');
  const inFlightCheck = doc2.check();
  doc2.startSemanticRun();
  await waitUntil(() => doc2.getSnapshot().run.phase === 'waiting');
  assert.ok(waitClock.activeCount() > 0);
  assert.equal(disposeSignals[0].aborted, false);

  disposedFlag = true;
  doc2.dispose();
  assert.equal(disposeSignals[0].aborted, true);
  assert.equal(waitClock.activeCount(), 0);

  reviewGate.resolve();
  await inFlightCheck;
  await waitClock.advance(20_000);
  assert.equal(callsAfterDispose, 0);
});

test('React workbench views do not assemble commit/commitLong/reconcile/domain mutations directly', () => {
  const semanticView = readFileSync(fileURLToPath(new URL('../app/components/semantic-workbench.tsx', import.meta.url)), 'utf8');
  const reviewView = readFileSync(fileURLToPath(new URL('../app/components/review-workbench.tsx', import.meta.url)), 'utf8');
  const forbidden = [
    /\bcommitLong\s*\(/u,
    /\bdoc\.commit\s*\(/u,
    /\breconcileState\b/u,
    /\bmakeSemanticDecision\b/u,
    /\bapplySemanticSuggestion\b/u,
    /\bupsertDecision\b/u,
    /\bremoveDecision\b/u,
    /\bspliceTargetSpan\b/u,
    /\breviseSegmentTarget\b/u,
    /\breconfirmChoice\b/u,
    /\brestoreHistoryEntry\b/u,
    /\bremoveHistoryEntry\b/u,
    /\bsetFinished\b/u,
    /\binsertParagraphBreak\b/u,
    /\bmergeParagraphs\b/u,
    /\blinesToParagraphs\b/u,
  ];
  for (const [name, src] of [
    ['app/components/semantic-workbench.tsx', semanticView],
    ['app/components/review-workbench.tsx', reviewView],
  ]) {
    for (const pattern of forbidden) {
      assert.equal(pattern.test(src), false, `${name} must not match ${pattern}`);
    }
  }
});

test('semantic decision commands: accept, adjust, ignore, precedent toggle, undo and reconcileState atomicity', async () => {
  const clock = makeClock(1_700_000_000_000);
  const semanticBodies = [];
  const doc = createWorkbenchController({
    clock,
    initialCapabilities: ['semantic-review-v1', 'translation-context-v1'],
    onPoolRefresh: () => {},
    post: async (path, body) => {
      assert.equal(path, '/api/semantic-reviews');
      semanticBodies.push(body);
      return jsonResponse(await semanticResponse(body, [
        {
          category: 'meaning_shift',
          source: [0, 2],
          target: [0, 5],
          confidence: 'high',
          suggestion: { target: [0, 5], replacement: 'Dawn', term_effect: 'none' },
          alternative: 'Daybreak',
        },
        {
          category: 'omission',
          source: [3, 5],
          target: [6, 11],
          confidence: 'low',
          suggestion: null,
        },
      ]));
    },
  });

  doc.editText('source', '黎明 和晨雾。');
  doc.editText('target', 'Night mists.');
  doc.startSemanticRun();
  await waitUntil(() => doc.getSnapshot().run.phase === 'done');

  const initialSnap = doc.getSnapshot();
  assert.equal(initialSnap.semantic.placed.length, 2);
  const [firstPlaced, secondPlaced] = initialSnap.semantic.placed;
  const canonicalBeforeDecision = canonicalOf(
    initialSnap.draft, initialSnap.choices, initialSnap.reports, initialSnap.semantic, initialSnap.basis,
  );

  // 1. Accept with alternative splices target, records decision, tracks lastSemanticAction, keeps notice sem:accepted (1 remaining).
  const acceptOut = await doc.applySemanticDecision({
    placedId: firstPlaced.id,
    kind: 'accepted',
    useAlternative: true,
  });
  assert.equal(acceptOut.applied, true);
  assert.equal(acceptOut.allHandled, false);
  const afterAccept = doc.getSnapshot();
  assert.equal(afterAccept.draft.target, 'Daybreak mists.');
  assert.equal(afterAccept.notice, 'sem:accepted');
  assert.equal(afterAccept.semantic.decisions.length, 1);
  assert.equal(afterAccept.semantic.decisions[0].decision, 'accepted');
  assert.equal(afterAccept.semantic.decisions[0].applied_text, 'Daybreak');
  assert.equal(afterAccept.lastSemanticAction?.placedId, firstPlaced.id);
  assert.equal(doc.canUndoSemanticDecision(firstPlaced.id), true);
  assert.notEqual(
    canonicalOf(afterAccept.draft, afterAccept.choices, afterAccept.reports, afterAccept.semantic, afterAccept.basis),
    canonicalBeforeDecision,
  );

  // If another edit sits on top of the undo stack, direct semantic undo is blocked until that edit is undone.
  doc.editText('target', 'Daybreak mists!');
  assert.equal(doc.canUndoSemanticDecision(firstPlaced.id), false);
  assert.equal(doc.undoSemanticDecision(firstPlaced.id), false);
  doc.undo();
  assert.equal(doc.getSnapshot().draft.target, 'Daybreak mists.');
  assert.equal(doc.canUndoSemanticDecision(firstPlaced.id), true);

  // Undo the accepted semantic decision atomically restores target, decisions, canonical hash, and clears lastSemanticAction.
  assert.equal(doc.undoSemanticDecision(firstPlaced.id), true);
  const afterUndoAccept = doc.getSnapshot();
  assert.equal(afterUndoAccept.draft.target, 'Night mists.');
  assert.equal(afterUndoAccept.semantic.decisions.length, 0);
  assert.equal(afterUndoAccept.lastSemanticAction, null);
  assert.equal(
    canonicalOf(afterUndoAccept.draft, afterUndoAccept.choices, afterUndoAccept.reports, afterUndoAccept.semantic, afterUndoAccept.basis),
    canonicalBeforeDecision,
  );

  // 2. Invalid adjust (blank) rejects cleanly with sem:needsReconfirm and does not push undo history.
  const historyBeforeInvalid = doc.getSnapshot().history.length;
  const badAdjust = await doc.applySemanticDecision({ placedId: firstPlaced.id, kind: 'adjusted', text: '   ' });
  assert.deepEqual(badAdjust, { applied: false, reason: 'needs_reconfirm' });
  assert.equal(doc.getSnapshot().notice, 'sem:needsReconfirm');
  assert.equal(doc.getSnapshot().history.length, historyBeforeInvalid);

  // Valid adjust updates target text and records adjusted decision.
  const adjustOut = await doc.applySemanticDecision({ placedId: firstPlaced.id, kind: 'adjusted', text: 'Sunrise' });
  assert.equal(adjustOut.applied, true);
  assert.equal(doc.getSnapshot().draft.target, 'Sunrise mists.');
  assert.equal(doc.getSnapshot().semantic.decisions[0].decision, 'adjusted');
  assert.equal(doc.getSnapshot().semantic.decisions[0].applied_text, 'Sunrise');
  assert.equal(doc.undoSemanticDecision(firstPlaced.id), true);
  assert.equal(doc.getSnapshot().draft.target, 'Night mists.');

  // 3. Ignore second issue, then edit unrelated target tail and re-review:
  // the new target revision forces reconcileState to carry the older ignored decision into outcomes!
  const ignoreOut = await doc.applySemanticDecision({ placedId: secondPlaced.id, kind: 'ignored' });
  assert.equal(ignoreOut.applied, true);
  assert.equal(ignoreOut.allHandled, false);
  assert.equal(doc.getSnapshot().notice, 'sem:ignored');

  // Add a second line so the first line remains an identical, unique block for recoverSpan while target_revision changes.
  doc.editText('target', 'Night mists.\nExtra.');
  const beforeRereviewResultId = doc.getSnapshot().semantic.results[0].id;
  doc.startSemanticRun();
  await waitUntil(() => doc.getSnapshot().run.phase === 'done'
    && doc.getSnapshot().semantic.results[0].id !== beforeRereviewResultId);
  const afterRereview = doc.getSnapshot();
  const rePlacedSecond = afterRereview.semantic.placed.find(p => p.issue.category === 'omission');
  assert.ok(rePlacedSecond);
  await waitUntil(() => doc.getSnapshot().semantic.outcomes.length === 1
    && issueStatus(doc.getSnapshot().semantic, rePlacedSecond).status === 'ignored');
  assert.equal(doc.getSnapshot().semantic.outcomes[0].status, 'carried');
  assert.equal(doc.canUndoSemanticDecision(rePlacedSecond.id), true);

  // Undoing a carried ignored decision removes both decision and carried outcome atomically!
  assert.equal(doc.undoSemanticDecision(rePlacedSecond.id), true);
  assert.equal(doc.getSnapshot().notice, 'sem:undone');
  assert.equal(doc.getSnapshot().semantic.decisions.length, 0);
  assert.equal(doc.getSnapshot().semantic.outcomes.length, 0);
  assert.equal(issueStatus(doc.getSnapshot().semantic, rePlacedSecond).status, 'pending');

  // Global undo restores the carried ignored decision and outcome!
  doc.undo();
  assert.equal(doc.getSnapshot().semantic.decisions.length, 1);
  assert.equal(doc.getSnapshot().semantic.outcomes.length, 1);
  assert.equal(issueStatus(doc.getSnapshot().semantic, rePlacedSecond).status, 'ignored');

  // Accepting the remaining issue now handles all remaining issues -> notice is sem:allHandled.
  const rePlacedFirst = doc.getSnapshot().semantic.placed.find(p => p.issue.category === 'meaning_shift');
  assert.ok(rePlacedFirst);
  const finalAccept = await doc.applySemanticDecision({ placedId: rePlacedFirst.id, kind: 'accepted' });
  assert.equal(finalAccept.applied, true);
  assert.equal(finalAccept.allHandled, true);
  assert.equal(doc.getSnapshot().notice, 'sem:allHandled');
  assert.equal(doc.getSnapshot().draft.target, 'Dawn mists.\nExtra.');

  // 4. Toggle usePrecedents controls snapshot state.
  assert.equal(doc.getSnapshot().usePrecedents, true);
  doc.toggleUsePrecedents();
  assert.equal(doc.getSnapshot().usePrecedents, false);
  doc.toggleUsePrecedents();
  assert.equal(doc.getSnapshot().usePrecedents, true);

  doc.dispose();
});

test('long-manuscript term occurrence actions, segment finish toggle, reviseSegmentText, history and undo atomicity', async () => {
  const clock = makeClock(1_700_000_000_000);
  const v3Text = readFileSync(fileURLToPath(new URL('../contracts/manuscript-v3/valid-v3-all-parts.json', import.meta.url)), 'utf8');
  const doc = createWorkbenchController({
    clock,
    onPoolRefresh: () => {},
    post: async () => { throw new Error('unexpected network call'); },
  });

  const outcome = await doc.importFile(fileFromText('v3.json', v3Text));
  assert.equal(outcome.status, 'imported');
  const opened = doc.getSnapshot();
  const baseCanonical = canonicalOf(opened.draft, opened.choices, opened.reports, opened.semantic, opened.basis);

  // Segment 1 has 3 findings and 3 choices (including an unconfirmed choice at [16,19] and confirmed ones at [0,3], [6,9]).
  const seg1Record = opened.semantic.long.records[1];
  const finding1 = seg1Record.result.findings[1]; // 示例物 [6,9] with candidates Sample Item, Sample Object
  const candidateObj = finding1.candidates[1]; // Sample Object

  // 1. Adopt candidate on finding1 replaces the existing not_a_term choice at [6,9] and updates canonical hash.
  assert.equal(doc.applyTermOccurrenceAction({
    type: 'adopt',
    segmentIndex: 1,
    finding: finding1,
    candidate: candidateObj,
  }), true);
  const afterAdopt = doc.getSnapshot();
  assert.equal(afterAdopt.notice, 'sem:longChoiceRecorded');
  const adoptedChoice = afterAdopt.semantic.long.records[1].choices.find(c => c.source_span.start === 6 && c.source_span.end === 9);
  assert.equal(adoptedChoice.choice, 'official_pair');
  assert.equal(adoptedChoice.candidate.en, 'Sample Object');
  assert.notEqual(
    canonicalOf(afterAdopt.draft, afterAdopt.choices, afterAdopt.reports, afterAdopt.semantic, afterAdopt.basis),
    baseCanonical,
  );

  // Undo restores exact prior canonical hash and choice state.
  doc.undo();
  const afterUndoAdopt = doc.getSnapshot();
  assert.equal(
    canonicalOf(afterUndoAdopt.draft, afterUndoAdopt.choices, afterUndoAdopt.reports, afterUndoAdopt.semantic, afterUndoAdopt.basis),
    baseCanonical,
  );

  // 2. Mark not_a_term on finding 0 ([0,3]) and clear_choice removes it.
  const finding0 = seg1Record.result.findings[0];
  assert.equal(doc.applyTermOccurrenceAction({
    type: 'not_a_term',
    segmentIndex: 1,
    finding: finding0,
  }), true);
  assert.equal(
    doc.getSnapshot().semantic.long.records[1].choices.find(c => c.source_span.start === 0 && c.source_span.end === 3).choice,
    'not_a_term',
  );
  assert.equal(doc.applyTermOccurrenceAction({
    type: 'clear_choice',
    at: { index: 1, start: 0, end: 3 },
  }), true);
  assert.equal(
    doc.getSnapshot().semantic.long.records[1].choices.find(c => c.source_span.start === 0 && c.source_span.end === 3),
    undefined,
  );
  doc.undo();
  doc.undo();

  // 3. Replace single occurrence in target text; stale span fails without pushing undo.
  const docTargetSpan = {
    start: seg1Record.target_start + finding0.target[0],
    end: seg1Record.target_start + finding0.target[1],
    text: 'Sample Name',
  };
  const historyBeforeStale = doc.getSnapshot().history.length;
  assert.equal(doc.applyTermOccurrenceAction({
    type: 'replace',
    docTarget: { ...docTargetSpan, text: 'Wrong Text' },
    candidate: { ...finding0.candidates[0], en: 'Official Name' },
  }), false);
  assert.equal(doc.getSnapshot().notice, 'sem:longReplaceStale');
  assert.equal(doc.getSnapshot().history.length, historyBeforeStale);

  assert.equal(doc.applyTermOccurrenceAction({
    type: 'replace',
    docTarget: docTargetSpan,
    candidate: { ...finding0.candidates[0], en: 'Official Name' },
  }), true);
  assert.equal(doc.getSnapshot().notice, 'sem:longTargetReplaced');
  assert.ok(doc.getSnapshot().draft.target.includes('Official Name met the Sample Item, and Sample Name returned'));
  doc.undo();
  assert.equal(doc.getSnapshot().draft.target, opened.draft.target);

  // 4. Toggle segment finished/unfinished (and verify pending segment 0 without result is a no-op).
  assert.equal(doc.toggleSegmentFinished(0, true), false);
  assert.deepEqual(doc.getSnapshot().semantic.long.progress.completed, [1, 2]);
  assert.equal(doc.toggleSegmentFinished(1), true);
  assert.deepEqual(doc.getSnapshot().semantic.long.progress.completed, [2]);
  assert.equal(doc.toggleSegmentFinished(1, false), false); // already false -> no-op
  assert.equal(doc.toggleSegmentFinished(1, true), true);
  assert.deepEqual(doc.getSnapshot().semantic.long.progress.completed, [1, 2]);
  doc.undo();
  assert.deepEqual(doc.getSnapshot().semantic.long.progress.completed, [2]);
  doc.undo();
  assert.deepEqual(doc.getSnapshot().semantic.long.progress.completed, [1, 2]);

  // 5. Revise segment target text with validation and undo atomicity.
  const seg0Base = doc.segmentTargetCore(0);
  assert.ok(seg0Base && seg0Base.startsWith('The Sample Place was quiet.'));
  const noopRevise = doc.reviseSegmentText(0, seg0Base, seg0Base);
  assert.deepEqual(noopRevise, { applied: false, error: 'noop' });
  const badRevise = doc.reviseSegmentText(0, 'wrong base', 'Updated');
  assert.deepEqual(badRevise, { applied: false, error: 'core_mismatch' });
  assert.equal(doc.getSnapshot().notice, 'sem:longReviseInvalid');

  const revisedCore = seg0Base.replace('The Sample Place was quiet.', 'The Sample Place stood quiet.');
  assert.deepEqual(doc.reviseSegmentText(0, seg0Base, revisedCore), { applied: true });
  assert.equal(doc.getSnapshot().notice, 'sem:longSegmentRevised');
  assert.equal(doc.segmentTargetCore(0), revisedCore);
  doc.undo();
  assert.equal(doc.segmentTargetCore(0), seg0Base);

  // 6. Remove history entry, and restore + reconfirm a history entry after round-tripping through short mode.
  assert.equal(doc.getSnapshot().semantic.long.history.length, 1);
  assert.equal(doc.removeTermHistoryEntry(0), true);
  assert.equal(doc.getSnapshot().semantic.long.history.length, 0);
  doc.undo();
  assert.equal(doc.getSnapshot().semantic.long.history.length, 1);

  // Import a v3 file with an unconfirmed choice matching finding 0 in segment 1 and a restorable history entry for segment 2.
  const customV3 = JSON.parse(v3Text);
  customV3.segments[1].choices[0].confirmed = false;
  customV3.segment_choice_history.push({
    source_hash: customV3.segments[2].source_hash,
    source_span: customV3.segments[2].choices[0].source_span,
    choice: customV3.segments[2].choices[0].choice,
    candidate: customV3.segments[2].choices[0].candidate,
    offered: [],
  });
  customV3.segments[2].choices = [];
  const customOutcome = await doc.importFile(fileFromText('v3-reconfirm.json', JSON.stringify(customV3)));
  assert.equal(customOutcome.status, 'imported');
  assert.equal(doc.getSnapshot().semantic.long.records[1].choices[0].confirmed, false);
  assert.equal(doc.applyTermOccurrenceAction({ type: 'reconfirm', at: { index: 1, start: 0, end: 3 } }), true);
  assert.equal(doc.getSnapshot().notice, 'sem:longChoiceRecorded');
  assert.equal(doc.getSnapshot().semantic.long.records[1].choices[0].confirmed, true);

  assert.equal(doc.getSnapshot().semantic.long.records[2].choices.length, 0);
  assert.equal(doc.restoreTermHistoryEntry(1), true);
  assert.equal(doc.getSnapshot().semantic.long.records[2].choices.length, 1);
  assert.equal(doc.getSnapshot().semantic.long.records[2].choices[0].confirmed, false);
  doc.undo();
  assert.equal(doc.getSnapshot().semantic.long.records[2].choices.length, 0);

  doc.dispose();
});

test('manual paragraph repair commands and document-level target revision / choice confirmation', async () => {
  const clock = makeClock(1_700_000_000_000);
  const doc = createWorkbenchController({
    clock,
    onPoolRefresh: () => {},
    post: async (path, body) => {
      assert.equal(path, '/api/reviews');
      return jsonResponse(reviewReportFor(body));
    },
  });

  // 1. Manual split, merge, and convertLinesToParagraphs with single-step undo.
  doc.editText('source', '第一句。第二句。\n第三句。');
  doc.editText('target', 'First. Second.\nThird.');
  assert.equal(doc.convertLinesToParagraphs(), true);
  assert.equal(doc.getSnapshot().notice, 'sem:lines');
  assert.equal(doc.getSnapshot().draft.source, '第一句。第二句。\n\n第三句。');
  assert.equal(doc.getSnapshot().draft.target, 'First. Second.\n\nThird.');

  assert.equal(doc.splitParagraphs([
    { side: 'source', offset: 4 },
    { side: 'target', offset: 6 },
  ]), true);
  assert.equal(doc.getSnapshot().notice, 'sem:split');
  assert.equal(doc.getSnapshot().draft.source, '第一句。\n\n第二句。\n\n第三句。');
  assert.equal(doc.getSnapshot().draft.target, 'First.\n\nSecond.\n\nThird.');

  // Single undo reverts both paired cuts atomically.
  doc.undo();
  assert.equal(doc.getSnapshot().draft.source, '第一句。第二句。\n\n第三句。');
  assert.equal(doc.getSnapshot().draft.target, 'First. Second.\n\nThird.');

  assert.equal(doc.mergeParagraphsAt('target', 14, 16), true);
  assert.equal(doc.getSnapshot().notice, 'sem:merged');
  assert.equal(doc.getSnapshot().draft.target, 'First. Second. Third.');

  // 2. Document-level target revision and choice confirmation.
  doc.receiveDraft({ source: '今汐在今州。', target: 'Someone is in Jinzhou.', direction: 'en', alignments: null });
  await doc.check();
  const snap = doc.getSnapshot();
  const latest = snap.reports.at(-1);
  const missingTargetFinding = latest.report.findings.find(f => f.source_span.text === '今汐' && f.target_span === null);
  assert.ok(missingTargetFinding);
  const candidate = missingTargetFinding.candidates[0];
  assert.equal(doc.isRevisionEligible(missingTargetFinding, candidate), true);

  // Stale generation rejects with revisionStale notice.
  const staleResult = doc.applyTargetRevision({
    snapshot: latest,
    generation: snap.generation - 1,
    draft: snap.draft,
    choices: snap.choices,
    imported: snap.imported,
    finding: missingTargetFinding,
    candidate,
    fragment: 'Someone',
    selected: { start: 0, end: 7, text: 'Someone' },
  });
  assert.deepEqual(staleResult, { status: 'stale' });
  assert.equal(doc.getSnapshot().notice, 'revisionStale');

  // Fresh revision applies cleanly and updates target text.
  const appliedResult = doc.applyTargetRevision({
    snapshot: latest,
    generation: snap.generation,
    draft: snap.draft,
    choices: snap.choices,
    imported: snap.imported,
    finding: missingTargetFinding,
    candidate,
    fragment: 'Someone',
    selected: { start: 0, end: 7, text: 'Someone' },
  });
  assert.equal(appliedResult.status, 'applied');
  assert.equal(doc.getSnapshot().draft.target, 'Jinhsi is in Jinzhou.');
  doc.undo();
  assert.equal(doc.getSnapshot().draft.target, 'Someone is in Jinzhou.');

  // Imported choice confirmation via controller.
  doc.choose(missingTargetFinding, candidate);
  const saved = doc.save();
  assert.ok(saved);
  await doc.importFile(fileFromText('reopened.json', saved.content));
  await doc.check(false);
  assert.equal(doc.canConfirmChoice(0), true);
  assert.equal(doc.confirmChoice(0), true);
  assert.equal(doc.getSnapshot().notice, 'choiceStaged');

  doc.dispose();
});
