import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createWorkbenchController, isRunActive } from '../lib/workbench-controller.ts';
import { recordView } from '../lib/long-review.js';
import { FRESH_MATCHER_REVISION, fixture, freshApiReport } from './fixtures/manuscript.mjs';
import { defaultSemanticResponse } from './helpers/semantic-fixture.mjs';

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
