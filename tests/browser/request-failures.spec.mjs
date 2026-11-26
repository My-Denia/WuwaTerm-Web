// What a failed translation or term check tells the user: the cause class, what to do, the wait the service asked for and the
// request id (first long-manuscript end-to-end run, 2026-11-16). Synthetic text; every /api response is a local fake.
import { test, expect } from '@playwright/test';
import { fill, msg } from '../../lib/messages.ts';
import { S, failure, fillPair, openWorkbench } from '../helpers/semantic-routes.mjs';

const M = msg('zh');
const panel = page => page.locator('.document-workspace .error-panel');
const requestIdLabel = M.failure.requestId.split('{')[0];

test('a failed translation in the review workbench says what failed, what to do and which request it was', async ({ page }) => {
  await openWorkbench(page, { capabilities: [], translateFailures: {
    1: failure(503, 'llm_unavailable', { request_id: 'synthetic-request-1' }),
    2: failure(504, 'upstream_timeout'),
    3: failure(503, 'llm_unavailable'),
  } });
  await page.locator('#review-source').fill('她看见三只鸟。');
  await page.getByRole('button', { name: M.review.translateIdle, exact: true }).click();
  for (const line of [M.tMsg.llm_unavailable, M.failure.causeUnavailable, M.failure.adviceReview, fill(M.failure.requestId, { id: 'synthetic-request-1' })]) {
    await expect(panel(page)).toContainText(line);
  }
  // A seven-character sentence is not split any further: the advice is to retry.
  await expect(panel(page)).not.toContainText(M.failure.adviceTranslation);
  await page.getByRole('button', { name: M.review.translateIdle, exact: true }).click();
  await expect(panel(page)).toContainText(M.failure.causeTimeout);
  await expect(panel(page)).toContainText(M.failure.adviceReview);
  await expect(panel(page)).not.toContainText(M.failure.adviceTranslation);
  // The site timed out waiting, so no upstream request id exists to show.
  await expect(panel(page)).not.toContainText(requestIdLabel);
  // Over 200 characters the advice names a path every user has: retry, or split the text and translate the parts in quick
  // translation.
  await page.locator('#review-source').fill('她看见三只鸟。'.repeat(30));
  await page.getByRole('button', { name: M.review.translateIdle, exact: true }).click();
  await expect(panel(page)).toContainText('可以稍后重试；文本较长时，可以拆成几段较短的文本，在“快速翻译”中分别翻译。');
  await expect(panel(page)).not.toContainText('审校工作台逐段翻译');
});

test('a failed term check shows the request id, and a refused one the wait the service asked for', async ({ page }) => {
  await openWorkbench(page, { capabilities: [], reviewFailures: {
    1: failure(503, 'upstream_unavailable', { request_id: 'synthetic-review-1' }),
    2: failure(429, 'shared_pool_busy', { retry_after_seconds: 7 }),
  } });
  await fillPair(page, '今汐。', 'Jinhsi.');
  await page.getByRole('button', { name: M.review.checkIdle, exact: true }).click();
  for (const line of [M.failure.causeUnavailable, M.failure.adviceReview, fill(M.failure.requestId, { id: 'synthetic-review-1' })]) {
    await expect(panel(page)).toContainText(line);
  }
  await page.getByRole('button', { name: M.review.checkIdle, exact: true }).click();
  await expect(panel(page)).toContainText(fill(M.failure.wait, { n: 7 }));
});

test('a failed single-pair translation names the cause and the request id', async ({ page }) => {
  await openWorkbench(page, { capabilities: [], translateFailures: { 1: failure(503, 'llm_unavailable', { request_id: 'synthetic-pair-1' }) } });
  await page.locator('#review-source').fill('她看见三只鸟。');
  await page.getByRole('button', { name: S.segTranslate, exact: true }).click();
  const notice = page.locator('.document-workspace .notice-state');
  for (const line of [M.tMsg.llm_unavailable, M.failure.causeUnavailable, fill(M.failure.requestId, { id: 'synthetic-pair-1' })]) {
    await expect(notice).toContainText(line);
  }
});
