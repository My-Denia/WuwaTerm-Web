import { test, expect } from '@playwright/test';
import { S, openWorkbench, fillPair, longPair, TRIO, trioResponse } from '../helpers/semantic-routes.mjs';

const WITHOUT = [
  ['an empty capability list', []],
  ['only translation context', ['translation-context-v1']],
  ['a 404 from an older service', 'not-found'],
  ['a network error', 'network-error'],
];

for (const [name, capabilities] of WITHOUT) {
  test.describe(`without semantic review: ${name}`, () => {
    test('the semantic track, the overview and the button are absent and term review works as before', async ({ page }) => {
      const rec = await openWorkbench(page, { capabilities });
      await fillPair(page, '今汐。\n声骸。', 'Jinhsi.\nEcho.');
      await expect(page.locator('.semantic-track')).toHaveCount(0);
      await expect(page.locator('.issue-overview')).toHaveCount(0);
      await expect(page.getByRole('button', { name: S.start, exact: true })).toHaveCount(0);
      await expect(page.getByText('语义审校', { exact: false })).toHaveCount(0);
      // A short pair has no segment panel or long-manuscript tools.
      await expect(page.locator('.segment-panel')).toHaveCount(0);
      await expect(page.locator('.long-tools')).toHaveCount(0);
      await page.getByRole('button', { name: '核对术语', exact: true }).click();
      await expect(page.locator('.review-findings .term-result')).toHaveCount(2);
      expect(rec.reviews).toHaveLength(1);
      expect(rec.semantic).toHaveLength(0);
    });
  });
}

test('a long manuscript keeps its segment panel, per-segment term check and manual split without semantic review', async ({ page }) => {
  const rec = await openWorkbench(page, { capabilities: ['translation-context-v1'] });
  const { source, target } = longPair(4);
  await fillPair(page, source, target);
  await expect(page.locator('.semantic-track')).toHaveCount(0);
  await expect(page.locator('.segment-chip')).toHaveCount(4);
  await expect(page.locator('.segment-chip').first()).toContainText(S.segTermPending);
  await page.getByRole('button', { name: S.runTerm, exact: true }).click();
  await expect(page.locator('.segment-head p')).toContainText('术语已核 4/4 段', { timeout: 30_000 });
  await expect(page.locator('.segment-chip').first()).toContainText(S.segTermChecked);
  expect(rec.reviews).toHaveLength(4);
  expect(rec.semantic).toHaveLength(0);
  // The precedent option applies to translation too, so it shows with the context capability.
  await expect(page.getByLabel(S.precedents)).toBeVisible();
  // Manual splitting stays available.
  await fillPair(page, source, target.replace(/\n\n/g, '\n'));
  await expect(page.locator('.segment-chip').filter({ hasText: S.segManual })).toHaveCount(1);
  await page.getByRole('button', { name: S.linesEverywhere, exact: true }).click();
  await expect(page.locator('.segment-chip').filter({ hasText: S.segManual })).toHaveCount(0);
});

test.describe('390px phone viewport', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the issue list is a bottom drawer that opens and closes, with no horizontal scroll', async ({ page }, testInfo) => {
    await openWorkbench(page, { respond: trioResponse() });
    await fillPair(page, TRIO.source, TRIO.target);
    await page.getByRole('button', { name: S.start, exact: true }).click();
    await expect(page.locator('.semantic-item')).toHaveCount(3);
    const list = page.locator('.semantic-list');
    const toggle = list.locator('.drawer-toggle');
    const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    await expect(toggle).toHaveText('疑点列表 · 3');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // Docked to the bottom edge, with the list itself collapsed.
    const box = await list.boundingBox();
    expect(Math.round(box.y + box.height)).toBe(844);
    await expect(list.locator('.semantic-items')).toBeHidden();
    expect(await noOverflow()).toBe(true);
    const closed = await page.screenshot({ path: testInfo.outputPath('semantic-drawer-closed.png') });
    await testInfo.attach('semantic-drawer-closed', { body: closed, contentType: 'image/png' });

    await toggle.click();
    await expect(toggle).toHaveText(S.listClose);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(list.locator('.semantic-items')).toBeVisible();
    const opened = await list.boundingBox();
    expect(opened.height).toBeGreaterThan(box.height);
    expect(Math.round(opened.y + opened.height)).toBe(844);
    expect(await noOverflow()).toBe(true);
    const open = await page.screenshot({ path: testInfo.outputPath('semantic-drawer-open.png') });
    await testInfo.attach('semantic-drawer-open', { body: open, contentType: 'image/png' });

    await toggle.click();
    await expect(toggle).toHaveText('疑点列表 · 3');
    await expect(list.locator('.semantic-items')).toBeHidden();
    expect(await noOverflow()).toBe(true);
  });
});
