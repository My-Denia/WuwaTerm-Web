// Resumable long-manuscript term review (contracts/manuscript-v3/SPEC.md, "Runtime: reopening and re-checking").
// Every request count below is derived from a SPEC step, named beside it. Synthetic text only; the routes are local fakes.
import { test, expect } from '@playwright/test';
import { msg } from '../../lib/messages.ts';
import { serializeWorkfile } from '../../lib/manuscript.js';
import { candidate } from '../fixtures/manuscript.mjs';
import {
  S, busy, downloadFrom, enParagraph, failure, fill, fillPair, longPair, openWorkbench, termPair, termParagraph, termTargetParagraph, zhParagraph,
} from '../helpers/semantic-routes.mjs';

const M = msg('zh');
const chips = page => page.locator('.segment-chip');
const chip = (page, i) => chips(page).nth(i);
const runButton = page => page.locator('.long-tools .long-terms button');
const status = page => page.locator('.run-phase');
const findingIn = (page, i) => page.locator(`.long-term-list article[data-segment="${i}"]`);
const choiceRow = (page, i) => page.locator(`.long-choices .choice-record[data-segment="${i}"]`);
const saveState = page => page.locator('.manuscript-save-state');
const termStates = page => chips(page).evaluateAll(list => list.map(li => li.getAttribute('data-term-state')));
const asFile = (text, name = 'manuscript.json') => ({ name, mimeType: 'application/json', buffer: Buffer.from(text) });
const mention = '0:2:今汐';
const ADOPTED = { mention_id: mention, choice: 'official_pair', candidate_id: candidate.candidate_id };
const NOT_A_TERM = { mention_id: mention, choice: 'not_a_term' };
const withTarget = (n, i, tag) => Array.from({ length: n }, (_, k) => termTargetParagraph(k + 1, k + 1 === i ? tag : '')).join('\n\n');

async function run(page, rec, expected) {
  await runButton(page).click();
  await expect.poll(() => rec.reviews.length).toBe(expected);
  await expect(status(page)).toHaveAttribute('data-run-state', 'done');
  expect(rec.reviews).toHaveLength(expected);
}
async function reopen(context, text, options = {}) {
  const page = await context.newPage();
  const rec = await openWorkbench(page, { capabilities: [], ...options });
  await page.getByLabel('选择稿件文件').setInputFiles(asFile(text));
  await expect(page.locator('.notice-state')).toContainText('已在本地恢复稿件');
  return { page, rec };
}
async function shot(page, testInfo, name) {
  await testInfo.attach(name, { body: await page.locator('.segment-panel').screenshot(), contentType: 'image/png' });
}

test('a saved long manuscript reopens with its results, choices and position; an unchanged reopen costs one request', async ({ page, context }) => {
  const { source, target } = termPair(4);
  const rec = await openWorkbench(page, { capabilities: [] });
  await fillPair(page, source, target);
  await expect(chips(page)).toHaveCount(4);
  await expect(runButton(page)).toHaveText(fill(S.runTerm, { n: 4 }));
  // Step 6: four pending segments without choices, one request each.
  await run(page, rec, 4);
  expect(await termStates(page)).toEqual(['current', 'current', 'current', 'current']);
  await findingIn(page, 1).getByRole('button', { name: M.review.adopt, exact: true }).click();
  await findingIn(page, 2).getByRole('button', { name: M.review.notTerm, exact: true }).click();
  // SPEC Writing "Choices": adding a choice to a done record makes it stale.
  expect(await termStates(page)).toEqual(['current', 'stale', 'stale', 'current']);
  // Step 6, first bullet: source hash, direction and basis unchanged, so one request each carries the confirmed choice.
  await run(page, rec, 6);
  expect(rec.reviews[4].resolutions).toEqual([ADOPTED]);
  expect(rec.reviews[5].resolutions).toEqual([NOT_A_TERM]);
  expect(rec.reviews[4].resolution_context).toEqual(expect.objectContaining({ matcher_revision: expect.stringMatching(/^[0-9a-f]{64}$/u) }));
  await chip(page, 1).getByRole('button', { name: S.segMarkFinished, exact: true }).click();
  await chip(page, 2).locator('button').first().click();
  await expect(chip(page, 2)).toHaveAttribute('data-current', 'true');

  const file = JSON.parse((await downloadFrom(page, '保存稿件')).text);
  expect(file.format).toBe('wuwaterm-manuscript-v3');
  expect(file.segments.map(r => r.status)).toEqual(['done', 'done', 'done', 'done']);
  expect(file.progress).toEqual({ current: 2, completed: [1] });
  // A choice that needs reconfirmation: unconfirmed in a done record (SPEC "Segment choice"). The file stays valid.
  file.segments[2].choices[0].confirmed = false;
  const { page: again, rec: rec2 } = await reopen(context, JSON.stringify(file));
  // Step 1: importing sends nothing; step 3: the results are reuse candidates, shown as saved until the live basis arrives.
  expect(rec2.reviews).toHaveLength(0);
  expect(await termStates(again)).toEqual(['saved', 'saved', 'saved', 'saved']);
  await expect(chip(again, 1)).toHaveAttribute('data-finished', 'true');
  await expect(chip(again, 2)).toHaveAttribute('data-current', 'true');
  await expect(choiceRow(again, 1)).toHaveAttribute('data-choice-view', 'waiting');
  await expect(choiceRow(again, 2)).toHaveAttribute('data-choice-view', 'needs_reconfirmation');
  await expect(choiceRow(again, 2)).toContainText(S.choiceNeedsReconfirm);
  await expect(saveState(again)).toContainText(M.review.saveStateMatchesImport);
  await expect(runButton(again)).toHaveText(S.runTermConfirm);
  // Step 4: nothing needs a check, so the probe goes to progress.current (segment 3); an unchanged reopen costs one request.
  await run(again, rec2, 1);
  expect(rec2.reviews[0].source).toBe(termParagraph(3));
  expect(Object.hasOwn(rec2.reviews[0], 'resolutions')).toBe(false);
  // Step 5: the same basis makes every saved result current; confirmed choices apply without confirming them again.
  expect(await termStates(again)).toEqual(['current', 'current', 'current', 'current']);
  await expect(chip(again, 1)).toContainText(S.segFinished);
  await expect(choiceRow(again, 1)).toHaveAttribute('data-choice-view', 'applies');
  await expect(choiceRow(again, 2)).toHaveAttribute('data-choice-view', 'needs_reconfirmation');
  await expect(saveState(again)).toContainText(M.review.saveStateMatchesImport);
  // Canonical round trip: saving the unchanged manuscript under the confirmed basis gives back the opened bytes.
  expect((await downloadFrom(again, '保存稿件')).text).toBe(JSON.stringify(file));
  // Reconfirming makes the record stale; step 6 first bullet: one request with the choice.
  await choiceRow(again, 2).getByRole('button', { name: S.choiceReconfirm, exact: true }).click();
  await run(again, rec2, 2);
  expect(rec2.reviews[1].resolutions).toEqual([NOT_A_TERM]);
  await expect(choiceRow(again, 2)).toHaveAttribute('data-choice-view', 'applies');
});

test('a stale resolution_context falls back to one request without resolutions and leaves the segment to re-check', async ({ page }) => {
  // Core rejects a resolution_context it no longer accepts as invalid_request (the BFF projects it as a 400).
  const rec = await openWorkbench(page, { capabilities: [], reviewFailures: { 3: failure(400, 'invalid_request') } });
  const { source, target } = termPair(2);
  await fillPair(page, source, target);
  await run(page, rec, 2);
  await findingIn(page, 0).getByRole('button', { name: M.review.adopt, exact: true }).click();
  // Step 6 first bullet would be one request with the choice; it is rejected, so the item asks once more without
  // resolutions (which returns the basis) and stops there: at most two requests per segment item.
  await run(page, rec, 4);
  expect(rec.reviews[2].resolutions).toEqual([ADOPTED]);
  expect(Object.hasOwn(rec.reviews[3], 'resolutions')).toBe(false);
  await expect(chip(page, 0)).toHaveAttribute('data-term-state', 'stale');
  await expect(choiceRow(page, 0)).toHaveAttribute('data-choice-view', 'waiting');
  await expect(runButton(page)).toHaveText(fill(S.runTerm, { n: 1 }));
});

test('a matcher_revision change after reopen re-checks the saved results and keeps finished marks', async ({ page, context }) => {
  const { source, target } = termPair(4);
  const rec = await openWorkbench(page, { capabilities: [] });
  await fillPair(page, source, target);
  await run(page, rec, 4);
  await findingIn(page, 1).getByRole('button', { name: M.review.adopt, exact: true }).click();
  await run(page, rec, 5);
  for (const i of [1, 3]) await chip(page, i).getByRole('button', { name: S.segMarkFinished, exact: true }).click();
  const saved = (await downloadFrom(page, '保存稿件')).text;

  let release;
  const held = new Promise(resolve => { release = resolve; });
  const other = 'cd'.repeat(32);
  const { page: again, rec: rec2 } = await reopen(context, saved, { matcherRevision: other, reviewHold: { 2: held } });
  await runButton(again).click();
  await expect.poll(() => rec2.reviews.length).toBe(2);
  // Step 4: no current position and nothing due, so the probe went to segment 1 and returned another matcher_revision.
  // Step 5: that basis is now current; every other record with a result is stale, its finished mark kept.
  expect(rec2.reviews[0].source).toBe(termParagraph(1));
  await expect(chip(again, 0)).toHaveAttribute('data-term-state', 'current');
  for (const i of [1, 2, 3]) await expect(chip(again, i)).toHaveAttribute('data-term-state', 'stale');
  await expect(chip(again, 3)).toHaveAttribute('data-finished', 'true');
  await expect(chip(again, 3)).toContainText(S.segFinishedRecheck);
  release();
  await expect(status(again)).toHaveAttribute('data-run-state', 'done');
  // The probe, then segment 2 twice (step 6 second bullet: the basis changed, so first without resolutions, then once
  // more with the choice realignment kept), then segments 3 and 4 once each.
  expect(rec2.reviews).toHaveLength(5);
  expect(rec2.reviews.map(b => b.source)).toEqual([1, 2, 2, 3, 4].map(termParagraph));
  expect(Object.hasOwn(rec2.reviews[1], 'resolutions')).toBe(false);
  expect(rec2.reviews[2].resolutions).toEqual([ADOPTED]);
  expect(rec2.reviews[2].resolution_context.matcher_revision).toBe(other);
  expect(await termStates(again)).toEqual(['current', 'current', 'current', 'current']);
  for (const i of [1, 3]) await expect(chip(again, i)).toContainText(S.segFinished);
  await expect(choiceRow(again, 1)).toHaveAttribute('data-choice-view', 'applies');
});

test('an edit re-checks only that segment, in the session and after save and reopen', async ({ page, context }) => {
  const n = 4;
  const { source, target } = termPair(n);
  const rec = await openWorkbench(page, { capabilities: [] });
  await fillPair(page, source, target);
  await run(page, rec, 4);
  await findingIn(page, 2).getByRole('button', { name: M.review.adopt, exact: true }).click();
  await page.locator('#review-target').fill(withTarget(n, 3, ' again'));
  // Step 6, first bullet (an in-session target-only edit): only segment 3, one request with its confirmed choice.
  await expect(runButton(page)).toHaveText(fill(S.runTerm, { n: 1 }));
  await run(page, rec, 5);
  expect(rec.reviews[4]).toEqual(expect.objectContaining({ source: termParagraph(3), target: termTargetParagraph(3, ' again'), resolutions: [ADOPTED] }));

  // Segment 3 (with its choice) and segment 4 (without) are edited, then saved and reopened.
  const edited = Array.from({ length: n }, (_, k) => termTargetParagraph(k + 1, k >= 2 ? ' later' : '')).join('\n\n');
  await page.locator('#review-target').fill(edited);
  const saved = (await downloadFrom(page, '保存稿件')).text;
  expect(JSON.parse(saved).segments.map(r => r.status)).toEqual(['done', 'done', 'pending', 'pending']);
  const { page: again, rec: rec2 } = await reopen(context, saved);
  expect(await termStates(again)).toEqual(['saved', 'saved', 'pending', 'pending']);
  // Step 4: the probe goes to the first segment that needs a check (segment 3). Step 6 second bullet: a pending record is
  // checked without resolutions, then once more with the kept choice; segment 4 has no choice, so one request.
  await run(again, rec2, 3);
  expect(rec2.reviews.map(b => b.source)).toEqual([3, 3, 4].map(termParagraph));
  expect(Object.hasOwn(rec2.reviews[0], 'resolutions')).toBe(false);
  expect(rec2.reviews[1].resolutions).toEqual([ADOPTED]);
  expect(Object.hasOwn(rec2.reviews[2], 'resolutions')).toBe(false);
  expect(await termStates(again)).toEqual(['current', 'current', 'current', 'current']);
});

test('a failed segment keeps the finished ones and the run resumes from it, in the session and after save and reopen', async ({ page, context }) => {
  const { source, target } = termPair(4);
  // An upstream rate limit was charged: the run stops at that segment and nothing is resent until the user continues.
  const rec = await openWorkbench(page, { capabilities: [], reviewFailures: { 2: failure(429, 'upstream_rate_limited') } });
  await fillPair(page, source, target);
  await runButton(page).click();
  await expect(status(page)).toHaveAttribute('data-run-state', 'failed');
  expect(rec.reviews).toHaveLength(2);
  // Step 9: the failed check changed only its own segment.
  expect(await termStates(page)).toEqual(['current', 'pending', 'pending', 'pending']);
  await expect(chip(page, 1)).toHaveAttribute('data-run-state', 'failed');
  await page.getByRole('button', { name: S.resume, exact: true }).click();
  await expect(status(page)).toHaveAttribute('data-run-state', 'done');
  expect(rec.reviews.map(b => b.source)).toEqual([1, 2, 2, 3, 4].map(termParagraph));

  const first = await context.newPage();
  const recFirst = await openWorkbench(first, { capabilities: [], reviewFailures: { 3: failure(429, 'upstream_rate_limited') } });
  await fillPair(first, source, target);
  await runButton(first).click();
  await expect(status(first)).toHaveAttribute('data-run-state', 'failed');
  expect(recFirst.reviews).toHaveLength(3);
  const saved = (await downloadFrom(first, '保存稿件')).text;
  expect(JSON.parse(saved).segments.map(r => r.status)).toEqual(['done', 'done', 'pending', 'pending']);
  const { page: again, rec: rec2 } = await reopen(context, saved);
  // Step 4: the probe goes to segment 3, the first that needs a check; segments 1 and 2 are confirmed by it, not re-requested.
  await run(again, rec2, 2);
  expect(rec2.reviews.map(b => b.source)).toEqual([3, 4].map(termParagraph));
});

test('the term run shows waiting, retrying, paused and failed apart', async ({ page }, testInfo) => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const rec = await openWorkbench(page, { capabilities: [], reviewFailures: { 2: busy(), 4: failure(429, 'upstream_rate_limited') }, reviewHold: { 3: held } });
  const { source, target } = termPair(4);
  await fillPair(page, source, target);
  await runButton(page).click();
  await expect(status(page)).toHaveAttribute('data-run-state', 'waiting');
  await expect(status(page)).toContainText('公共站正在限流，请等待约');
  await expect(chip(page, 1)).toHaveAttribute('data-run-state', 'waiting');
  await expect(chip(page, 1)).toContainText(S.segWaiting);
  await shot(page, testInfo, 'term-run-waiting');
  // Resent on its own after the wait: the second attempt reads retrying, not sending, and says how long it waited (busy(): 5 s).
  await expect(status(page)).toHaveAttribute('data-run-state', 'retrying', { timeout: 15_000 });
  await expect(status(page)).toHaveText(fill(S.phaseRetryingAfterWait, { w: 5, i: 2, a: 2 }));
  await expect(chip(page, 1)).toHaveAttribute('data-run-state', 'retrying');
  await expect(chip(page, 1)).toContainText(S.segRetrying);
  await shot(page, testInfo, 'term-run-retrying');
  await page.getByRole('button', { name: S.pause, exact: true }).click();
  release();
  await expect(status(page)).toHaveAttribute('data-run-state', 'paused');
  await expect(status(page)).toHaveText(fill(S.phasePaused, { done: 2, total: 4 }));
  await expect(chip(page, 2)).toHaveAttribute('data-run-state', 'paused');
  await expect(chip(page, 2)).toContainText(S.segPaused);
  await shot(page, testInfo, 'term-run-paused');
  await page.getByRole('button', { name: S.resume, exact: true }).click();
  await expect(status(page)).toHaveAttribute('data-run-state', 'failed');
  await expect(status(page)).toContainText(fill(S.phaseStopped, { reason: '' }).trim());
  await expect(chip(page, 2)).toHaveAttribute('data-run-state', 'failed');
  await expect(chip(page, 2)).toContainText(S.segFailed);
  await shot(page, testInfo, 'term-run-failed');
  expect(rec.reviews.map(b => b.source)).toEqual([1, 2, 2, 3].map(termParagraph));
  expect(await termStates(page)).toEqual(['current', 'current', 'pending', 'pending']);
});

test('the segment translation run shows waiting, retrying, paused and failed apart', async ({ page }, testInfo) => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const rec = await openWorkbench(page, { capabilities: ['translation-context-v1'], translateFailures: { 2: busy(), 4: failure(502, 'upstream_network_error', { request_id: 'synthetic-request-4' }) },
    translateHold: { 3: held }, translate: (body, n) => `T${n}.` });
  await page.locator('#review-source').fill(longPair(3).source);
  await page.getByRole('button', { name: S.translateLong, exact: true }).click();
  await expect(status(page)).toHaveAttribute('data-run-state', 'waiting');
  await expect(status(page)).toContainText('公共站正在限流，请等待约');
  await shot(page, testInfo, 'translate-run-waiting');
  await expect(status(page)).toHaveAttribute('data-run-state', 'retrying', { timeout: 15_000 });
  await expect(status(page)).toHaveText(fill(S.phaseRetryingAfterWait, { w: 5, i: 2, a: 2 }));
  await shot(page, testInfo, 'translate-run-retrying');
  await page.getByRole('button', { name: S.pause, exact: true }).click();
  release();
  await expect(status(page)).toHaveAttribute('data-run-state', 'paused');
  await expect(status(page)).toHaveText(fill(S.phasePaused, { done: 2, total: 3 }));
  await shot(page, testInfo, 'translate-run-paused');
  await page.getByRole('button', { name: S.resume, exact: true }).click();
  await expect(status(page)).toHaveAttribute('data-run-state', 'failed');
  await expect(status(page)).toContainText(S.translateStopped);
  // The stop says what kind of failure it was, what to do and which request failed.
  for (const line of [M.failure.causeUnavailable, M.failure.adviceTranslation, fill(M.failure.requestId, { id: 'synthetic-request-4' })]) await expect(status(page)).toContainText(line);
  await shot(page, testInfo, 'translate-run-failed');
  // Finished segments stay in order; the failed one is sent first on continue (SPEC step 9 for the translation run).
  await expect(page.locator('#review-target')).toHaveValue('T1.\n\nT3.\n\n');
  expect(rec.translations.map(b => b.text)).toEqual([1, 2, 2, 3].map(i => zhParagraph(i)));
});

test('segment checks send alignments by the SPEC rule, and automatic correspondence omits them again', async ({ page }) => {
  const rec = await openWorkbench(page, { capabilities: [] });
  const paragraphs = [1, 2].map(termParagraph);
  const translations = [1, 2].map(i => termTargetParagraph(i));
  const source = paragraphs.join('\n\n');
  const target = translations.join('\n\n');
  const span = (text, part) => { const start = text.indexOf(part); return { start, end: start + part.length, text: part }; };
  const alignments = paragraphs.map((p, i) => ({ source: span(source, p), target: span(target, translations[i]) }));
  const file = serializeWorkfile({ source, target, direction: 'en', alignments, choices: [], history: [] });
  await page.getByLabel('选择稿件文件').setInputFiles(asFile(file));
  await expect(page.locator('#review-source')).toHaveValue(source);
  // Explicit alignments: each segment sends the alignments clipped to its cores, rebased, with the core text.
  await run(page, rec, 2);
  rec.reviews.forEach((body, i) => expect(body.alignments).toEqual([
    { source: { start: 0, end: paragraphs[i].length, text: paragraphs[i] }, target: { start: 0, end: translations[i].length, text: translations[i] } },
  ]));
  await page.locator('.alignment-panel summary').click();
  await page.getByRole('button', { name: M.review.alignmentClear, exact: true }).click();
  // [] is a real input that differs from omitting the key: the alignment input changed, so both results are stale.
  expect(await termStates(page)).toEqual(['stale', 'stale']);
  await run(page, rec, 4);
  expect(rec.reviews.slice(2).map(b => b.alignments)).toEqual([[], []]);
  await page.getByRole('button', { name: S.useAutoAlignment, exact: true }).click();
  await expect(page.getByRole('button', { name: S.useAutoAlignment, exact: true })).toHaveCount(0);
  await run(page, rec, 6);
  expect(rec.reviews.slice(4).map(b => Object.hasOwn(b, 'alignments'))).toEqual([false, false]);
  // The switch is one undoable edit.
  await page.getByRole('button', { name: '撤销修订', exact: true }).click();
  await expect(page.getByRole('button', { name: S.useAutoAlignment, exact: true })).toBeVisible();
});

test('a handled semantic suggestion stays handled after saving a v3 manuscript, reopening it and reviewing again', async ({ page, context }) => {
  // Each target paragraph starts with its own line, so the issue on that line survives an edit later in the segment
  // (old spans are only followed inside an identical line).
  const source = termPair(2).source;
  const lines = [1, 2].map(i => `Jinhsi appears in paragraph ${i}.\n${enParagraph(i)}`);
  const rec = await openWorkbench(page);
  await fillPair(page, source, lines.join('\n\n'));
  await page.getByRole('button', { name: S.start, exact: true }).click();
  await expect(page.locator('.segment-head p')).toContainText(fill(S.progress, { done: 2, total: 2 }), { timeout: 30_000 });
  expect(rec.semantic).toHaveLength(2);
  await page.locator('.semantic-card').getByRole('button', { name: S.ignore, exact: true }).click();
  await expect(page.getByRole('button', { name: `${S.statusHandled} 1`, exact: true })).toBeVisible();
  const saved = (await downloadFrom(page, '保存稿件')).text;
  const file = JSON.parse(saved);
  // A long manuscript always saves as v3 (SPEC "Writing"); the decision is in its v2 part.
  expect(file.format).toBe('wuwaterm-manuscript-v3');
  expect(file.semantic_decisions.map(d => d.decision)).toEqual(['ignored']);

  const { page: again, rec: rec2 } = await reopen(context, saved, { capabilities: undefined });
  expect(rec2.semantic).toHaveLength(0);
  await expect(again.getByRole('button', { name: `${S.statusHandled} 1`, exact: true })).toBeVisible();
  // Edit the first segment away from its issues, then review it again: the ignore is carried, not raised again.
  await again.locator('#review-target').fill([`${lines[0]} Extra.`, lines[1]].join('\n\n'));
  await chip(again, 0).getByRole('button', { name: S.segReview, exact: true }).click();
  await expect.poll(() => rec2.semantic.length).toBe(1);
  // The re-review merge settles asynchronously: pending 3 (the new omission and segment 2's two issues), handled 1.
  await expect(again.getByRole('button', { name: `${S.statusPending} 3`, exact: true })).toBeVisible();
  await again.getByRole('button', { name: `${S.statusHandled} 1`, exact: true }).click();
  await expect(again.locator('.semantic-item .semantic-state')).toHaveText([S.statuses.ignored]);
  await expect(again.locator('.semantic-item')).toContainText(S.categories.meaning_shift);
});

test('a reused segment exports its rebuilt report, and an exported result cannot be imported as a manuscript', async ({ page, context }) => {
  const n = 3;
  const { source, target } = termPair(n);
  const rec = await openWorkbench(page, { capabilities: [] });
  await fillPair(page, source, target);
  await run(page, rec, 3);
  const first = JSON.parse((await downloadFrom(page, '导出当前结果')).text);
  // Every segment checked and current: the export says so (it used to read requires_recheck in long mode).
  expect([first.status, first.report_is_current, first.report]).toEqual(['current_terminology_check', true, null]);
  const live = first.segment_term_reports;
  expect(live.map(r => r.report.request_id)).toEqual(['fixture-request', 'fixture-request', 'fixture-request']);
  const saved = (await downloadFrom(page, '保存稿件')).text;

  const { page: again, rec: rec2 } = await reopen(context, saved);
  await run(again, rec2, 1);
  await again.locator('#review-target').fill(withTarget(n, 3, ' again'));
  const edited = JSON.parse((await downloadFrom(again, '导出当前结果')).text);
  expect([edited.status, edited.report_is_current]).toEqual(['requires_recheck', false]);
  await run(again, rec2, 2);
  const exported = (await downloadFrom(again, '导出当前结果')).text;
  const reports = JSON.parse(exported).segment_term_reports;
  expect([JSON.parse(exported).status, JSON.parse(exported).report_is_current]).toEqual(['current_terminology_check', true]);
  expect(reports.map(r => [r.segment, r.stale])).toEqual([[1, false], [2, false], [3, false]]);
  // SPEC "Compact term result": a reused segment's report is the live response for the same cores with request_id null
  // and every candidate's sources empty; nothing else differs.
  const reused = report => ({ ...report, request_id: null, findings: report.findings.map(f => ({ ...f, candidates: f.candidates.map(c => ({ ...c, sources: [] })) })) });
  for (const i of [0, 1]) expect(reports[i].report).toEqual(reused(live[i].report));
  // The segment checked in this session keeps the live response.
  expect(reports[2].report.request_id).toBe('fixture-request');
  expect(reports[2].report.findings[0].candidates[0].sources).toEqual(candidate.sources);

  // A report export is not a resumable manuscript: importing it is rejected, plainly, and the open manuscript is kept.
  await again.getByLabel('选择稿件文件').setInputFiles(asFile(exported, 'wuwaterm-result.json'));
  await expect(again.locator('.error-panel')).toHaveText(M.errors.importReportExport);
  await expect(again.locator('#review-source')).toHaveValue(source);
  await expect(again.locator('#review-target')).toHaveValue(withTarget(n, 3, ' again'));
});

test('a sent draft asks before replacing a workbench that holds only the segment choice history', async ({ page }) => {
  const rec = await openWorkbench(page, { capabilities: [] });
  const { source, target } = termPair(2);
  await fillPair(page, source, target);
  await run(page, rec, 2);
  await findingIn(page, 0).getByRole('button', { name: M.review.adopt, exact: true }).click();
  // SPEC "Leaving long mode": emptying both boxes moves the choice to the segment choice history; it is still work.
  await fillPair(page, '', '');
  await expect(page.locator('.long-history summary')).toHaveText(fill(S.historyTitle, { n: 1 }));
  await page.locator('#translation-source').fill('今汐。');
  await page.getByRole('button', { name: '翻译整句', exact: true }).click();
  await expect(page.locator('.translated-text')).toHaveText('Translated 1.');
  await page.getByRole('button', { name: '送去审校', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: M.review.dialogTitle });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: M.review.dialogKeep, exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#review-source')).toHaveValue('');
  await expect(page.locator('.long-history summary')).toHaveText(fill(S.historyTitle, { n: 1 }));
  const file = JSON.parse((await downloadFrom(page, '保存稿件')).text);
  expect(file.segment_choice_history.map(e => [e.choice, e.source_span.text])).toEqual([['official_pair', '今汐']]);
});

test('a truncated segment result still takes choices on the findings it shows, and says that more were left out', async ({ page }) => {
  // SPEC "Segment choice": Core's 32-finding cap left findings out of segment 1's result.
  const rec = await openWorkbench(page, { capabilities: [], reviewTruncated: body => body.source === termParagraph(1) });
  const { source, target } = termPair(2);
  await fillPair(page, source, target);
  await run(page, rec, 2);
  const note = page.locator('.long-term-truncated');
  await expect(note).toHaveCount(1);
  await expect(note).toHaveAttribute('data-segment', '0');
  await expect(note).toHaveText(fill(S.longTermsTruncated, { n: 1, k: 1 }));
  const adopt = findingIn(page, 0).getByRole('button', { name: M.review.adopt, exact: true });
  await expect(adopt).toBeEnabled();
  await adopt.click();
  await expect(choiceRow(page, 0)).toHaveCount(1);
  // The choice goes out with the segment's re-check like any other (SPEC "Runtime" step 6).
  await runButton(page).click();
  await expect.poll(() => rec.reviews.length).toBe(3);
  expect(rec.reviews[2].resolutions).toEqual([ADOPTED]);
});

test('the Markdown export follows the long-mode state like the JSON export, without a document report from a shorter text', async ({ page }) => {
  const rec = await openWorkbench(page, { capabilities: [] });
  // A document report of an earlier, shorter text.
  await fillPair(page, '今汐。', 'Jinhsi.');
  await page.getByRole('button', { name: M.review.checkIdle, exact: true }).click();
  await expect.poll(() => rec.reviews.length).toBe(1);
  await expect(page.locator('.review-current')).toBeVisible();
  const { source, target } = termPair(2);
  await fillPair(page, source, target);
  await run(page, rec, 3);
  const exports = async () => ({
    md: (await downloadFrom(page, M.review.exportMarkdown)).text,
    json: JSON.parse((await downloadFrom(page, '导出当前结果')).text),
  });
  const current = await exports();
  expect([current.json.status, current.json.report]).toEqual(['current_terminology_check', null]);
  expect(current.md).toContain(M.md.currencyCurrent);
  expect(current.md).not.toContain('`fixture-request`');
  await page.locator('#review-target').fill(withTarget(2, 2, ' again'));
  const edited = await exports();
  expect(edited.json.status).toBe('requires_recheck');
  expect(edited.md).toContain(M.md.currencyStale);
  expect(edited.md).not.toContain(M.md.currencyCurrent);
});
