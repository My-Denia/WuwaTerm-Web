import { test, expect } from '@playwright/test';
import { openWorkbench } from '../helpers/semantic-routes.mjs';

// Lines short enough never to wrap at 390px, so a selection's line number gives its place in the box without measuring text.
const filler = (label, n) => Array.from({ length: n }, (_, k) => `${label} ${k + 1}.`).join('\n');
const SOURCE = `今汐。\n${filler('第行', 60)}\n声骸。`;
const TARGET = `Jinhsi.\n${filler('Line', 60)}\nEcho.`;

/** Whether the selected text of a textarea lies inside its visible scroll window, from line numbers and the line height. */
function selectionInView(page, selector) {
  return page.locator(selector).evaluate(el => {
    const style = getComputedStyle(el);
    const line = el.value.slice(0, el.selectionStart).split('\n').length - 1;
    const lineHeight = parseFloat(style.lineHeight);
    const top = parseFloat(style.paddingTop) + line * lineHeight;
    return { selected: el.value.slice(el.selectionStart, el.selectionEnd), inView: top >= el.scrollTop - 1 && top + lineHeight <= el.scrollTop + el.clientHeight + 1 };
  });
}

// Before, locating set the selection without scrolling the box: a word outside the box's visible lines stayed out of sight,
// and the box only looked as if nothing had happened.
for (const [name, use] of [['desktop', { viewport: { width: 1440, height: 900 } }], ['phone', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }]]) {
  test.describe(name, () => {
    test.use(use);
    test('locating a term scrolls the text box to the selected word, up and down', async ({ page }) => {
      await openWorkbench(page, { capabilities: [] });
      await page.locator('#review-source').fill(SOURCE);
      await page.locator('#review-target').fill(TARGET);
      await page.getByRole('button', { name: '核对术语', exact: true }).click();
      await page.getByRole('button', { name: '全部 2', exact: true }).click();
      const first = page.locator('[data-mention-id="0:2:今汐"]');
      await expect(first).toBeVisible();
      const at = Array.from(SOURCE.slice(0, SOURCE.indexOf('声骸'))).length;
      const last = page.locator(`[data-mention-id="${at}:${at + 2}:声骸"]`);

      // Box scrolled to the end, word on the first line.
      await page.locator('#review-target').evaluate(el => { el.scrollTop = el.scrollHeight; });
      await first.getByRole('button', { name: '定位译文', exact: true }).click();
      expect(await selectionInView(page, '#review-target')).toEqual({ selected: 'Jinhsi', inView: true });
      await page.locator('#review-source').evaluate(el => { el.scrollTop = el.scrollHeight; });
      await first.getByRole('button', { name: '定位原文', exact: true }).click();
      expect(await selectionInView(page, '#review-source')).toEqual({ selected: '今汐', inView: true });

      // Box at the top, word on the last line.
      await page.locator('#review-target').evaluate(el => { el.scrollTop = 0; });
      await last.getByRole('button', { name: '定位译文', exact: true }).click();
      expect(await selectionInView(page, '#review-target')).toEqual({ selected: 'Echo', inView: true });
    });
  });
}
