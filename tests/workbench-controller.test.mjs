import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { MAX_UNDO, canonicalOf, createWorkbenchController, isRunActive } from '../lib/workbench-controller.ts';
import { recordView } from '../lib/long-review.ts';
import {
  makeChoice, remapAlignmentsForTargetFill, remapAlignmentsForTargetSplice, remapForSplice, remapForTargetFill, sanitizeDuplicateChoices, serializeWorkfile,
} from '../lib/manuscript.js';
import { freshSemantic, issueStatus } from '../lib/semantic-state.js';
import { FRESH_MATCHER_REVISION, fixture, freshApiReport } from './fixtures/manuscript.mjs';
import { defaultSemanticResponse, semanticResponse } from './helpers/semantic-fixture.mjs';

/** Load `draft` as a new document through the public replacement path (one protected undo step, fresh semantic state). */
function load(doc, draft) {
  doc.replaceWithWorkfile({ draft, choices: [], reports: [], semantic: freshSemantic(draft), importedBody: null });
}

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

test('workbench-controller, its submodules, and workbench-model have zero React imports', () => {
  const files = [
    'lib/workbench-controller.ts',
    'lib/workbench-store.ts',
    'lib/workbench-document-ops.ts',
    'lib/workbench-long-ops.ts',
    'lib/workbench-batch-runner.ts',
    'lib/workbench-tm-translate.ts',
    'lib/workbench-workfile-io.ts',
    'lib/workbench-model.ts',
  ];
  for (const name of files) {
    const src = readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8');
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
  load(doc, { source: '她看见三只鸟。', target: '', direction: 'en', alignments: null });
  await doc.translatePair(0);
  assert.equal(doc.getSnapshot().pairTranslating, null);
  assert.equal(doc.getSnapshot().draft.target, 'EN(她看见三只鸟。)');
  assert.equal(doc.getSnapshot().notice, 'sem:translated');

  load(doc, { source: '另一段待译文本。', target: '', direction: 'en', alignments: null });
  const epochBefore = doc.getSnapshot().documentEpoch;
  const pairGate = deferred();
  heldCall = pairGate;
  const pairPromise = doc.translatePair(0);
  assert.equal(doc.getSnapshot().pairTranslating, 0);
  assert.equal(isRunActive(doc.getSnapshot().run, doc.getSnapshot().pairTranslating), true);

  // Install a brand-new manuscript while pair translation is in flight.
  // The epoch guard drops the late response without mutating the new manuscript.
  load(doc, { source: '新稿件。', target: 'New draft.', direction: 'en', alignments: null });
  assert.equal(doc.getSnapshot().documentEpoch, epochBefore + 1);
  assert.equal(doc.getSnapshot().pairTranslating, null);

  pairGate.resolve();
  await pairPromise;
  assert.equal(doc.getSnapshot().draft.target, 'New draft.');
  assert.equal(doc.getSnapshot().notice, 'imported');

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
  const workspaceDir = fileURLToPath(new URL('../app/components/workspace', import.meta.url));
  const workspaceSubmodules = readdirSync(workspaceDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && /\.(ts|tsx)$/u.test(entry.name))
    .map(entry => `app/components/workspace/${entry.name}`)
    .sort();
  assert.ok(workspaceSubmodules.length > 0, 'expected workspace submodules under app/components/workspace');
  const workspaceFiles = [
    'app/components/semantic-workbench.tsx',
    'app/components/document-workspace.tsx',
    ...workspaceSubmodules,
  ];
  for (const name of workspaceFiles) {
    const src = readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8');
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
  load(doc, { source: '今汐在今州。', target: 'Someone is in Jinzhou.', direction: 'en', alignments: null });
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
  const reopened = await doc.importFile(fileFromText('reopened.json', saved.content));
  assert.equal(reopened.status, 'needs_confirm_workfile');
  doc.replaceWithWorkfile(reopened.pendingWorkfile);
  await doc.check(false);
  assert.equal(doc.canConfirmChoice(0), true);
  assert.equal(doc.confirmChoice(0), true);
  assert.equal(doc.getSnapshot().notice, 'choiceStaged');

  doc.dispose();
});

test('remapAlignmentsForTargetSplice and remapAlignmentsForTargetFill preserve valid spans and invalidate only crossed or ambiguous entries', () => {
  const source = '甲一。\n\n甲二。\n\n甲三。';
  const target = 'Alpha one.\n\nBeta two.\n\nGamma three.';
  const alignments = [
    { source: { start: 0, end: 3, text: '甲一。' }, target: { start: 0, end: 10, text: 'Alpha one.' } },
    { source: { start: 5, end: 8, text: '甲二。' }, target: { start: 12, end: 21, text: 'Beta two.' } },
    { source: { start: 10, end: 13, text: '甲三。' }, target: { start: 23, end: 35, text: 'Gamma three.' } },
  ];
  assert.equal(remapAlignmentsForTargetSplice(null, source, target, 0, 5, 2), null);

  // Localized splice inside span 0 resizes span 0 and shifts spans 1 & 2.
  const next1 = 'Alpha ONE.\n\nBeta two.\n\nGamma three.';
  assert.deepEqual(remapAlignmentsForTargetSplice(alignments, source, next1, 6, 9, 3), alignments.map((a, i) => (
    i === 0 ? { ...a, target: { start: 0, end: 10, text: 'Alpha ONE.' } } : a
  )));
  const next2 = 'A1.\n\nBeta two.\n\nGamma three.';
  const remapped = remapAlignmentsForTargetSplice(alignments, source, next2, 0, 10, 3);
  assert.equal(remapped?.[0].target?.text, 'A1.');
  assert.equal(remapped?.[1].target?.text, 'Beta two.');
  assert.equal(remapped?.[1].target?.start, 5);
  assert.equal(remapped?.[2].target?.text, 'Gamma three.');
  assert.equal(remapped?.[2].target?.start, 16);

  // R3: a splice crossing the end of span 0 and the start of span 1 invalidates those two only; span 2 stays (delta 0).
  const crossedTarget = 'Alpha oncrosseda two.\n\nGamma three.';
  assert.deepEqual(remapForSplice(alignments, 'target', source, crossedTarget, 8, 15, 7), {
    alignments: [alignments[2]],
    invalidated: [
      { originalIndex: 0, reason: 'crossed_boundary', entry: alignments[0] },
      { originalIndex: 1, reason: 'crossed_boundary', entry: alignments[1] },
    ],
    emptiedTargets: [],
    fallbackAll: false,
  });
  // R6 safety net: coordinates that do not fit the next text (malformed input, never an edit) still clear every alignment.
  assert.deepEqual(remapAlignmentsForTargetSplice(alignments, source, 'crossed', 8, 15, 7), []);
  assert.equal(remapForSplice(alignments, 'target', source, 'crossed', 8, 15, 7).fallbackAll, true);

  // Filling an untranslated span populates target:null and preserves surrounding spans.
  const partialAlign = [
    { source: { start: 0, end: 3, text: '甲一。' }, target: { start: 0, end: 10, text: 'Alpha one.' } },
    { source: { start: 5, end: 8, text: '甲二。' }, target: null },
    { source: { start: 10, end: 13, text: '甲三。' }, target: { start: 12, end: 24, text: 'Gamma three.' } },
  ];
  const filledTarget = 'Alpha one.\n\nInserted two.\n\nGamma three.';
  const filled = remapAlignmentsForTargetFill(partialAlign, source, filledTarget, 5, 8, 12, 12, 25, 15);
  assert.equal(filled?.[0].target?.text, 'Alpha one.');
  assert.equal(filled?.[1].target?.text, 'Inserted two.');
  assert.equal(filled?.[2].target?.text, 'Gamma three.');
  assert.equal(filled?.[2].target?.start, 27);

  // remapAlignmentsForTargetFill preserves null. With no untranslated entry in the pair region the fill is a plain insertion:
  // span 0 ends before the insertion point and stays.
  assert.equal(remapAlignmentsForTargetFill(null, source, filledTarget, 5, 8, 12, 12, 25, 15), null);
  assert.deepEqual(
    remapAlignmentsForTargetFill([alignments[0]], source, filledTarget, 5, 8, 12, 12, 25, 15),
    [alignments[0]],
  );
  // R3 fill_ambiguous: two untranslated entries in the pair region; only they are invalidated (here that is every entry).
  const twoNull = [
    { source: { start: 0, end: 3, text: '甲一。' }, target: null },
    { source: { start: 5, end: 8, text: '甲二。' }, target: null },
  ];
  assert.deepEqual(remapAlignmentsForTargetFill(twoNull, '甲一。\n\n甲二。', 'One.\n\nTwo.', 0, 8, 0, 0, 4, 4), []);
  assert.deepEqual(
    remapForTargetFill(twoNull, '甲一。\n\n甲二。', 'One.\n\nTwo.', 0, 8, 0, 0, 4, 4).invalidated.map(x => [x.originalIndex, x.reason]),
    [[0, 'fill_ambiguous'], [1, 'fill_ambiguous']],
  );
});

test('localized target edits, reopened batch resume, ready retranslate and undo preserve explicit alignments', async () => {
  const clock = makeClock();
  const translateCalls = [];
  const doc = createWorkbenchController({
    clock,
    onPoolRefresh: () => {},
    initialCapabilities: ['translation-context-v1', 'review-v2'],
    post: async (path, body) => {
      if (path === '/api/translations') {
        translateCalls.push(body);
        return jsonResponse({ text: `[${body.text.slice(0, 6)}]` });
      }
      if (path === '/api/semantic-reviews') {
        return jsonResponse(await semanticResponse(body, [
          {
            category: 'meaning_shift',
            source: [0, 2],
            target: [0, 5],
            confidence: 'high',
            suggestion: { target: [0, 5], replacement: 'Dawn!', term_effect: 'none' },
          },
        ]));
      }
      if (path === '/api/reviews') {
        return jsonResponse(reviewReportFor(body));
      }
      throw new Error(`unexpected path ${path}`);
    },
  });

  // 1. Reopened explicit untranslated manuscript: batch resume fills regions & keeps alignments, 1 undo reverts all.
  const p1 = `甲一。${'文'.repeat(980)}`;
  const p2 = `甲二。${'文'.repeat(980)}`;
  const p3 = `甲三。${'文'.repeat(980)}`;
  const src3 = `${p1}\n\n${p2}\n\n${p3}`;
  const t1Init = `Alpha one.${'x'.repeat(980)}`;
  const s1End = Array.from(p1).length;
  const s2Start = s1End + 2;
  const s2End = s2Start + Array.from(p2).length;
  const s3Start = s2End + 2;
  const s3End = s3Start + Array.from(p3).length;
  const resumedFile = serializeWorkfile({
    source: src3,
    target: t1Init,
    direction: 'en',
    alignments: [
      { source: { start: 0, end: s1End, text: p1 }, target: { start: 0, end: Array.from(t1Init).length, text: t1Init } },
      { source: { start: s2Start, end: s2End, text: p2 }, target: null },
      { source: { start: s3Start, end: s3End, text: p3 }, target: null },
    ],
    choices: [],
    history: [],
  });
  await doc.importFile(fileFromText('resume.json', resumedFile));
  assert.equal(doc.hasResumableTranslate(), true);
  doc.startTranslateRun();
  await waitUntil(() => doc.getSnapshot().run.phase === 'done');
  assert.equal(translateCalls.length, 2);
  const afterBatch = doc.getSnapshot().draft;
  assert.equal(afterBatch.target, `${t1Init}\n\n[甲二。文文文]\n\n[甲三。文文文]`);
  assert.equal(afterBatch.alignments?.length, 3);
  assert.equal(afterBatch.alignments?.[0].target?.text, t1Init);
  assert.equal(afterBatch.alignments?.[1].target?.text, '[甲二。文文文]');
  assert.equal(afterBatch.alignments?.[2].target?.text, '[甲三。文文文]');

  doc.undo();
  assert.equal(doc.getSnapshot().draft.target, t1Init);
  assert.equal(doc.getSnapshot().draft.alignments?.[1].target, null);

  // Re-run batch then test single-segment retranslate of ready pair 0 + Undo.
  doc.startTranslateRun();
  await waitUntil(() => doc.getSnapshot().run.phase === 'done');
  await doc.translatePair(0);
  const afterRetrans = doc.getSnapshot().draft;
  assert.equal(doc.getSnapshot().notice, 'sem:retranslated');
  assert.equal(afterRetrans.target, '[甲一。文文文]\n\n[甲二。文文文]\n\n[甲三。文文文]');
  assert.equal(afterRetrans.alignments?.[0].target?.text, '[甲一。文文文]');
  assert.equal(afterRetrans.alignments?.[1].target?.text, '[甲二。文文文]');
  assert.equal(afterRetrans.alignments?.[2].target?.text, '[甲三。文文文]');
  doc.undo();
  assert.equal(doc.getSnapshot().draft.target, `${t1Init}\n\n[甲二。文文文]\n\n[甲三。文文文]`);
  assert.equal(doc.getSnapshot().draft.alignments?.[0].target?.text, t1Init);

  // 2. Short unaligned manuscript with existing translation must NOT offer partial-prefix resume;
  // multi-segment unaligned partial-prefix DOES offer resume and keeps prefix + context.
  load(doc, { source: '第一段。\n\n第二段。', target: '已有译文', direction: 'en', alignments: null });
  assert.equal(doc.hasResumableTranslate(), false);

  translateCalls.length = 0;
  load(doc, { source: src3, target: 'Prefix one.', direction: 'en', alignments: null });
  assert.equal(doc.hasResumableTranslate(), true);
  doc.startTranslateRun();
  await waitUntil(() => doc.getSnapshot().run.phase === 'done');
  assert.equal(translateCalls.length, 2);
  assert.deepEqual(translateCalls[0].context, { before: { source: p1.slice(-400), target: 'Prefix one.' } });
  assert.equal(doc.getSnapshot().draft.target, 'Prefix one.\n\n[甲二。文文文]\n\n[甲三。文文文]');

  // 3. Localized semantic decision, reviseSegmentText, term occurrence replace, and applyTargetRevision preserve shifted alignments.
  const sA = `今汐在今州。${'文'.repeat(980)}`;
  const sB = `声骸。${'文'.repeat(980)}`;
  const tA = `Night is in Jinzhou.${'x'.repeat(980)}`;
  const tB = `Echo.${'x'.repeat(980)}`;
  const tBOrigStart = Array.from(tA).length + 2;
  load(doc, {
    source: `${sA}\n\n${sB}`,
    target: `${tA}\n\n${tB}`,
    direction: 'en',
    alignments: [
      { source: { start: 0, end: Array.from(sA).length, text: sA }, target: { start: 0, end: Array.from(tA).length, text: tA } },
      {
        source: { start: Array.from(sA).length + 2, end: Array.from(sA).length + 2 + Array.from(sB).length, text: sB },
        target: { start: tBOrigStart, end: tBOrigStart + Array.from(tB).length, text: tB },
      },
    ],
  });
  doc.startSemanticRun();
  await waitUntil(() => doc.getSnapshot().run.phase === 'done');
  const placedId = doc.getSnapshot().semantic.placed[0].id;
  await doc.applySemanticDecision({ placedId, kind: 'accepted' });
  const tADawn = `Dawn! is in Jinzhou.${'x'.repeat(980)}`;
  assert.equal(doc.getSnapshot().draft.target, `${tADawn}\n\n${tB}`);
  assert.equal(doc.getSnapshot().draft.alignments?.[0].target?.text, tADawn);
  assert.equal(doc.getSnapshot().draft.alignments?.[1].target?.text, tB);

  doc.reviseSegmentText(0, tADawn, tA);
  assert.equal(doc.getSnapshot().draft.alignments?.[0].target?.text, tA);
  assert.equal(doc.getSnapshot().draft.alignments?.[1].target?.text, tB);
  assert.equal(doc.getSnapshot().draft.alignments?.[1].target?.start, tBOrigStart);

  doc.startTermRun();
  await waitUntil(() => doc.getSnapshot().run.phase === 'done');
  const jinhsiFinding = fixture(sA, tA, 'en').report.findings[0].candidates[0];
  assert.equal(doc.applyTermOccurrenceAction({
    type: 'replace',
    segmentIndex: 0,
    docTarget: { start: 0, end: 5, text: 'Night' },
    candidate: jinhsiFinding,
  }), true);
  const tAJinhsi = `Jinhsi is in Jinzhou.${'x'.repeat(980)}`;
  assert.equal(doc.getSnapshot().draft.target, `${tAJinhsi}\n\n${tB}`);
  assert.equal(doc.getSnapshot().draft.alignments?.[0].target?.text, tAJinhsi);
  assert.equal(doc.getSnapshot().draft.alignments?.[1].target?.text, tB);
  assert.equal(doc.getSnapshot().draft.alignments?.[1].target?.start, tBOrigStart + 1);

  // Short-doc applyTargetRevision preserves explicit alignments too.
  load(doc, {
    source: '今汐在今州。',
    target: 'Someone is in Jinzhou.',
    direction: 'en',
    alignments: [{ source: { start: 0, end: 6, text: '今汐在今州。' }, target: { start: 0, end: 22, text: 'Someone is in Jinzhou.' } }],
  });
  await doc.check();
  const revSnap = doc.getSnapshot();
  const revReport = revSnap.reports.at(-1);
  const revFinding = revReport.report.findings.find(f => f.source_span.text === '今汐' && f.target_span === null);
  const revOut = doc.applyTargetRevision({
    snapshot: revReport,
    generation: revSnap.generation,
    draft: revSnap.draft,
    choices: revSnap.choices,
    imported: revSnap.imported,
    finding: revFinding,
    candidate: revFinding.candidates[0],
    fragment: 'Someone',
    selected: { start: 0, end: 7, text: 'Someone' },
  });
  assert.equal(revOut.status, 'applied');
  assert.equal(doc.getSnapshot().draft.alignments?.[0].target?.text, 'Jinhsi is in Jinzhou.');

  // replaceTerm preserves explicit alignments cleanly.
  await doc.check();
  const repSnap = doc.getSnapshot();
  const repFinding = repSnap.reports.at(-1).report.findings.find(f => f.source_span.text === '今汐' && f.target_span);
  assert.ok(repFinding);
  doc.replaceTerm(repFinding, { ...repFinding.candidates[0], en: 'Jinhsi!' });
  assert.equal(doc.getSnapshot().draft.target, 'Jinhsi! is in Jinzhou.');
  assert.equal(doc.getSnapshot().draft.alignments?.[0].target?.text, 'Jinhsi! is in Jinzhou.');

  // Merged short aligned pairs fail closed to [] on retranslate and emit editedAlignments notice (never misleading sem:retranslated).
  load(doc, {
    source: '甲一。\n\n甲二。',
    target: 'One.\n\nTwo.',
    direction: 'en',
    alignments: [
      { source: { start: 0, end: 3, text: '甲一。' }, target: { start: 0, end: 4, text: 'One.' } },
      { source: { start: 5, end: 8, text: '甲二。' }, target: { start: 6, end: 10, text: 'Two.' } },
    ],
  });
  await doc.translatePair(0);
  assert.equal(doc.getSnapshot().draft.alignments?.length, 0);
  assert.equal(doc.getSnapshot().notice, 'editedAlignments');

  doc.dispose();
});

test('workfile import guard protects unsaved edits, coalesces typing undo, keeps eviction-immune checkpoint, and resolves duplicate save conflicts', async () => {
  const clock = makeClock(1_700_000_000_000);
  const doc = createWorkbenchController({ clock, onPoolRefresh: () => {} });

  // 1. JSON import over unsaved edits after save requires confirmation and keeps edits intact until confirmed.
  const sourceDraft = 'alpha\nbeta\ngamma\ndelta\nepsilon\nzeta';
  doc.editText('source', sourceDraft);
  doc.editText('target', 'initial target');
  const saved = doc.save();
  assert.ok(saved);
  doc.editText('target', 'initial target + unsaved edit');

  const gatedOutcome = await doc.importFile(fileFromText('saved.json', saved.content));
  assert.equal(gatedOutcome.status, 'needs_confirm_workfile');
  assert.equal(doc.getSnapshot().draft.target, 'initial target + unsaved edit');

  doc.replaceWithWorkfile(gatedOutcome.pendingWorkfile);
  assert.equal(doc.getSnapshot().draft.target, 'initial target');
  assert.ok(doc.getSnapshot().documentCheckpoint);

  // 2. Typing 25 sequential characters after import coalesces into 1 typing undo transaction: 2 undos reach pre-import draft.
  const beforeTypingCount = doc.getSnapshot().history.length;
  for (let i = 1; i <= 25; i++) {
    doc.editText('target', `initial target${'!'.repeat(i)}`);
  }
  assert.equal(doc.getSnapshot().history.length, beforeTypingCount + 1);
  doc.undo();
  assert.equal(doc.getSnapshot().draft.target, 'initial target');
  doc.undo();
  assert.equal(doc.getSnapshot().draft.target, 'initial target + unsaved edit');

  // 3. Even if >MAX_UNDO separate typing transactions evict the replace record from history, documentCheckpoint restores pre-import work.
  const confirmOutcome = await doc.importFile(fileFromText('saved.json', saved.content));
  assert.equal(confirmOutcome.status, 'needs_confirm_workfile');
  doc.replaceWithWorkfile(confirmOutcome.pendingWorkfile);
  for (let i = 1; i <= MAX_UNDO + 10; i++) {
    await clock.advance(2000);
    doc.editText('target', `burst-${i}`);
  }
  assert.equal(doc.getSnapshot().history.length, MAX_UNDO);
  assert.equal(doc.getSnapshot().history.some(u => u.replacedDocument), false);
  assert.ok(doc.getSnapshot().documentCheckpoint);
  assert.equal(doc.restoreDocumentCheckpoint(), true);
  assert.equal(doc.getSnapshot().draft.target, 'initial target + unsaved edit');
  assert.equal(doc.getSnapshot().notice, 'restoredCheckpoint');

  // 4. Duplicate-choice save failure sets saveConflict and resolveConflictingChoicesAndSave() clears colliding choices undoably.
  const f1 = fixture('beta', '译文');
  const s1 = 'alpha\nbeta';
  const collidingA = makeChoice({
    source: 'alpha\nbeta\none',
    direction: 'en',
    alignments: null,
    report: { ...f1.report, findings: [{ ...f1.report.findings[0], source_span: { start: 6, end: 10, text: 'beta' }, id: '6:10:beta' }] },
    finding: { ...f1.report.findings[0], source_span: { start: 6, end: 10, text: 'beta' }, id: '6:10:beta' },
    candidate: null,
  });
  const collidingB = makeChoice({
    source: 'alpha\nbeta\ntwo',
    direction: 'en',
    alignments: null,
    report: { ...f1.report, findings: [{ ...f1.report.findings[0], source_span: { start: 6, end: 10, text: 'beta' }, id: '6:10:beta' }] },
    finding: { ...f1.report.findings[0], source_span: { start: 6, end: 10, text: 'beta' }, id: '6:10:beta' },
    candidate: null,
  });
  const docConflict = createWorkbenchController({ clock, onPoolRefresh: () => {} });
  load(docConflict, { source: s1, target: '阿尔法', direction: 'en', alignments: null });
  docConflict['setState']({ choices: [collidingA, collidingB] });
  assert.equal(docConflict.save(), null);
  assert.equal(docConflict.getSnapshot().error?.code, 'workfile_duplicate_choices');
  assert.equal(docConflict.getSnapshot().error?.saveConflict, true);

  const sanitized = sanitizeDuplicateChoices({ source: s1, direction: 'en', choices: [collidingA, collidingB] });
  assert.equal(sanitized.dropped, 2);

  const prose = docConflict.exportProseTxt();
  assert.equal(prose.filename, 'wuwaterm-prose.txt');
  assert.equal(prose.content, `${s1}\n\n---\n\n阿尔法`);

  const beforeGen = docConflict.getSnapshot().generation;
  docConflict['setState']({ phase: 'loading', translating: true, inFlight: true });
  const resolvedSave = docConflict.resolveConflictingChoicesAndSave();
  assert.ok(resolvedSave);
  const afterSnap = docConflict.getSnapshot();
  assert.equal(afterSnap.choices.length, 0);
  assert.equal(afterSnap.draft.source, s1);
  assert.equal(afterSnap.notice, 'resolvedConflictsSaved');
  assert.equal(afterSnap.generation, beforeGen + 1);
  assert.equal(afterSnap.phase, 'idle');
  assert.equal(afterSnap.translating, false);
  assert.equal(afterSnap.inFlight, false);

  docConflict.undo();
  assert.equal(docConflict.getSnapshot().choices.length, 2);
  docConflict.dispose();
  doc.dispose();
});

test('editText remaps confirmed alignments, keeps emptied targets as null and emits editedAlignments only when every entry is lost', () => {
  const doc = createWorkbenchController({});
  doc.editText('source', 'Alpha Beta');
  doc.editText('target', '甲 乙');
  assert.equal(doc.recordAlignment(
    { start: 0, end: 5, text: 'Alpha' },
    { start: 0, end: 1, text: '甲' },
  ), true);
  assert.equal(doc.recordAlignment(
    { start: 6, end: 10, text: 'Beta' },
    { start: 2, end: 3, text: '乙' },
  ), true);

  doc.editText('source', '00 Alpha Beta');
  assert.deepEqual(doc.getSnapshot().draft.alignments, [
    { source: { start: 3, end: 8, text: 'Alpha' }, target: { start: 0, end: 1, text: '甲' } },
    { source: { start: 9, end: 13, text: 'Beta' }, target: { start: 2, end: 3, text: '乙' } },
  ]);
  assert.notEqual(doc.getSnapshot().notice, 'editedAlignments');

  // R4: clearing the translation empties both targets; both entries keep their source anchors as untranslated.
  doc.editText('target', '');
  assert.deepEqual(doc.getSnapshot().draft.alignments, [
    { source: { start: 3, end: 8, text: 'Alpha' }, target: null },
    { source: { start: 9, end: 13, text: 'Beta' }, target: null },
  ]);
  assert.equal(doc.getSnapshot().notice, '', 'no alignment was lost and there is no report to mark stale');
  assert.deepEqual(doc.getSnapshot().alignmentInvalidations, []);

  // R4: clearing a single-span confirmed translation keeps the source anchor.
  doc.editText('source', '今汐。');
  doc.editText('target', 'Jinhsi.');
  assert.equal(doc.recordAlignment(
    { start: 0, end: 3, text: '今汐。' },
    { start: 0, end: 7, text: 'Jinhsi.' },
  ), true);
  doc.editText('target', '');
  assert.deepEqual(doc.getSnapshot().draft.alignments, [{ source: { start: 0, end: 3, text: '今汐。' }, target: null }]);

  // R3: deleting the only aligned source text invalidates the only entry, so every alignment is lost.
  doc.editText('source', '');
  assert.deepEqual(doc.getSnapshot().draft.alignments, []);
  assert.equal(doc.getSnapshot().notice, 'editedAlignments');
  assert.deepEqual(doc.getSnapshot().alignmentInvalidations.map(x => x.reason), ['source_emptied']);

  doc.editText('source', 'Alpha Beta');
  doc.editText('target', '甲 乙');
  assert.equal(doc.recordAlignment(
    { start: 0, end: 5, text: 'Alpha' },
    { start: 0, end: 1, text: '甲' },
  ), true);
  assert.equal(doc.recordAlignment(
    { start: 6, end: 10, text: 'Beta' },
    { start: 2, end: 3, text: '乙' },
  ), true);
  assert.deepEqual(doc.getSnapshot().alignmentInvalidations, [], 'recording an alignment starts the session list over');
  // R4: deleting the first target span in full keeps it as untranslated and shifts the second.
  doc.editText('target', ' 乙');
  assert.deepEqual(doc.getSnapshot().draft.alignments, [
    { source: { start: 0, end: 5, text: 'Alpha' }, target: null },
    { source: { start: 6, end: 10, text: 'Beta' }, target: { start: 1, end: 2, text: '乙' } },
  ]);
  // R3: an edit across the Alpha/Beta source boundary invalidates both crossed entries only; nothing else is left here.
  doc.undo();
  doc.editText('source', 'AlphXeta');
  assert.deepEqual(doc.getSnapshot().draft.alignments, []);
  assert.equal(doc.getSnapshot().notice, 'editedAlignments');
  doc.dispose();
});
