import { test, expect } from '@playwright/test';
import { S, SE, fill, busy, failure, openWorkbench, switchTo, fillPair, longPair, zhParagraph, enParagraph, TRIO, trioResponse } from '../helpers/semantic-routes.mjs';

const status = page => page.locator('.run-phase');
const progress = page => page.locator('.segment-head p');
const start = page => page.getByRole('button', { name: S.start, exact: true });

test('the overview and the two tracks keep deterministic terms apart from model issues', async ({ page }) => {
  await openWorkbench(page, { respond: trioResponse() });
  const overview = page.getByRole('group', { name: S.overviewAria });
  await expect(overview.getByRole('button', { name: fill(S.overviewTerms, { n: 0 }), exact: true })).toBeVisible();
  await expect(overview.getByRole('button', { name: S.overviewSemanticNone, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: S.termTrackTitle })).toBeVisible();
  await expect(page.getByRole('heading', { name: S.semanticTrackTitle })).toBeVisible();
  await expect(page.locator('.semantic-track .track-note')).toContainText('可能有误、请自行判断');
  await expect(page.locator('.semantic-track .track-head')).toContainText(S.experimental);
  await expect(page.locator('.semantic-track .track-note')).toContainText('实验性功能。');
  await fillPair(page, TRIO.source, TRIO.target);
  await start(page).click();
  await expect(overview.getByRole('button', { name: fill(S.overviewSemantic, { n: 3, pending: 3 }), exact: true })).toBeVisible();
  await expect(overview.getByRole('button', { name: fill(S.overviewTerms, { n: 0 }), exact: true })).toBeVisible();
});

test('a long manuscript is reviewed one segment at a time with only the previous segment as context', async ({ page }) => {
  const { source, target } = longPair(6);
  const rec = await openWorkbench(page, { delayMs: 120 });
  await fillPair(page, source, target);
  await expect(page.locator('.segment-chip')).toHaveCount(6);
  await start(page).click();
  await expect(progress(page)).toContainText(fill(S.progress, { done: 6, total: 6 }), { timeout: 30_000 });
  await expect(status(page)).toHaveText(S.phaseDone);
  expect(rec.semantic).toHaveLength(6);
  expect(rec.maxInflight).toBe(1);
  rec.semantic.forEach((body, i) => {
    expect(Array.from(body.source).length).toBeLessThanOrEqual(1800);
    expect(Array.from(body.target).length).toBeLessThanOrEqual(1800);
    expect(body.source).toBe(zhParagraph(i + 1));
    expect(body.target).toBe(enParagraph(i + 1));
    expect(body.explain_language).toBe('zh');
    if (i === 0) expect(body.context).toBeUndefined();
    else {
      expect(body.context.before.source).toContain(`第${i}段`);
      expect(body.context.before.target).toContain(`Paragraph ${i} `);
    }
  });
  await expect(page.locator('.segment-chip').first()).toContainText(S.segReviewed);
});

test('explain_language follows the interface language', async ({ page }) => {
  const rec = await openWorkbench(page, { respond: trioResponse() });
  await switchTo(page, 'English');
  await fillPair(page, TRIO.source, TRIO.target);
  await page.getByRole('button', { name: SE.start, exact: true }).click();
  await expect(page.locator('.semantic-item')).toHaveCount(3);
  expect(rec.semantic).toHaveLength(1);
  expect(rec.semantic[0].explain_language).toBe('en');
});

test('pause stops after the request in flight and continue finishes the rest', async ({ page }) => {
  const { source, target } = longPair(6);
  const rec = await openWorkbench(page);
  const hold = rec.gate(2);
  await fillPair(page, source, target);
  await start(page).click();
  await expect.poll(() => rec.semantic.length).toBe(2);
  await page.getByRole('button', { name: S.pause, exact: true }).click();
  hold.release();
  await expect(status(page)).toHaveText(fill(S.phasePaused, { done: 2, total: 6 }));
  await page.waitForTimeout(600);
  expect(rec.semantic).toHaveLength(2);
  await page.getByRole('button', { name: S.resume, exact: true }).click();
  await expect(progress(page)).toContainText(fill(S.progress, { done: 6, total: 6 }), { timeout: 30_000 });
  expect(rec.semantic).toHaveLength(6);
  expect(rec.maxInflight).toBe(1);
});

test('a rate-limited public site makes the run wait and then continue on its own', async ({ page }) => {
  const { source, target } = longPair(3);
  const rec = await openWorkbench(page, { failures: { 2: busy() } });
  await fillPair(page, source, target);
  await start(page).click();
  await expect(status(page)).toContainText('公共站正在限流，请等待约');
  expect(rec.semantic).toHaveLength(2);
  await expect(progress(page)).toContainText(fill(S.progress, { done: 3, total: 3 }), { timeout: 30_000 });
  // The limited segment is sent again, not skipped.
  expect(rec.semantic).toHaveLength(4);
  expect(rec.semantic[2].source).toBe(rec.semantic[1].source);
  expect(rec.maxInflight).toBe(1);
});

test('an upstream rate limit was already charged: the run stops there and nothing is resent until the user continues', async ({ page }) => {
  const { source, target } = longPair(3);
  const rec = await openWorkbench(page, { failures: { 2: failure(429, 'upstream_rate_limited') } });
  await fillPair(page, source, target);
  await start(page).click();
  await expect(status(page)).toContainText(fill(S.phaseStopped, { reason: '' }).trim());
  // No timer resends it: the count stays at the charged request.
  await page.waitForTimeout(2_500);
  expect(rec.semantic).toHaveLength(2);
  await page.getByRole('button', { name: S.resume, exact: true }).click();
  await expect(progress(page)).toContainText(fill(S.progress, { done: 3, total: 3 }), { timeout: 30_000 });
  expect(rec.semantic).toHaveLength(4);
  expect(rec.semantic[2].source).toBe(rec.semantic[1].source);
});

// Product bug: `now` is set once at mount and only refreshed by the 1s timer, so the
// first rendering of the wait line counts down from the page's mount time, not from now.
test('the wait line never shows more seconds than retry_after_seconds', async ({ page }) => {
  const { source, target } = longPair(3);
  await openWorkbench(page, { failures: { 2: busy() } });
  await fillPair(page, source, target);
  await start(page).click();
  await expect(status(page)).toContainText('公共站正在限流，请等待约');
  const seconds = Number(/约 (\d+) 秒/.exec(await status(page).innerText())?.[1]);
  expect(seconds).toBeLessThanOrEqual(5);
});

test('an exhausted daily quota pauses the run, keeps finished segments and sends nothing more', async ({ page }) => {
  const { source, target } = longPair(4);
  const rec = await openWorkbench(page, { failures: { 2: failure(503, 'translation_pool_exhausted') } });
  await fillPair(page, source, target);
  await start(page).click();
  await expect(status(page)).toContainText('今日额度已用完');
  await expect(status(page)).toContainText(fill(S.phaseQuota, { done: 1, total: 4 }));
  await page.waitForTimeout(600);
  expect(rec.semantic).toHaveLength(2);
  await expect(progress(page)).toContainText(fill(S.progress, { done: 1, total: 4 }));
  await expect(page.getByRole('button', { name: S.resume, exact: true })).toBeVisible();
});

test('a failed segment is retried alone from the segment list', async ({ page }) => {
  const { source, target } = longPair(4);
  const rec = await openWorkbench(page, { failures: { 2: failure(502, 'upstream_network_error') } });
  await fillPair(page, source, target);
  await start(page).click();
  await expect(progress(page)).toContainText(fill(S.progress, { done: 3, total: 4 }), { timeout: 30_000 });
  await expect(progress(page)).toContainText(fill(S.progressFailed, { n: 1 }));
  const failed = page.locator('.segment-chip').nth(1);
  await expect(failed).toContainText(S.segFailed);
  expect(rec.semantic).toHaveLength(4);
  await failed.getByRole('button', { name: S.segRetry, exact: true }).click();
  await expect(failed).toContainText(S.segReviewed);
  expect(rec.semantic).toHaveLength(5);
  expect(rec.semantic[4].source).toBe(zhParagraph(2));
  expect(rec.semantic[4].target).toBe(enParagraph(2));
});

test('two segments in a row failing the same way stops the run', async ({ page }) => {
  const { source, target } = longPair(5);
  const rec = await openWorkbench(page, { failures: { 2: failure(502, 'upstream_network_error'), 3: failure(502, 'upstream_network_error') } });
  await fillPair(page, source, target);
  await start(page).click();
  await expect(status(page)).toContainText(S.stopRepeated);
  await page.waitForTimeout(600);
  expect(rec.semantic).toHaveLength(3);
});
