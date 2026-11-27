import { test, expect } from '@playwright/test';
import { openWorkbench } from '../helpers/semantic-routes.mjs';
import { editorSelectionInView, fillEditor, setEditorScroll } from '../helpers/editor.mjs';

// Lines short enough never to wrap at 390px, so a selection's position stays unambiguous across both desktop and phone.
const filler = (label, n) => Array.from({ length: n }, (_, k) => `${label} ${k + 1}.`).join('\n');
const SOURCE = `今汐。\n${filler('第行', 60)}\n声骸。`;
const TARGET = `Jinhsi.\n${filler('Line', 60)}\nEcho.`;

// Before, locating set the selection without scrolling the box: a word outside the box's visible lines stayed out of sight,
// and the box only looked as if nothing had happened.
for (const [name, use] of [['desktop', { viewport: { width: 1440, height: 900 } }], ['phone', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }]]) {
  test.describe(name, () => {
    test.use(use);
    test('locating a term scrolls the text box to the selected word, up and down', async ({ page }) => {
      await openWorkbench(page, { capabilities: [] });
      await fillEditor(page, '#review-source', SOURCE);
      await fillEditor(page, '#review-target', TARGET);
      await page.getByRole('button', { name: '核对术语', exact: true }).click();
      await page.getByRole('button', { name: '全部 2', exact: true }).click();
      const first = page.locator('[data-mention-id="0:2:今汐"]');
      await expect(first).toBeVisible();
      const at = Array.from(SOURCE.slice(0, SOURCE.indexOf('声骸'))).length;
      const last = page.locator(`[data-mention-id="${at}:${at + 2}:声骸"]`);

      // Box scrolled to the end, word on the first line.
      await setEditorScroll(page, '#review-target', 'end');
      await first.getByRole('button', { name: '定位译文', exact: true }).click();
      expect(await editorSelectionInView(page, '#review-target')).toEqual({ selected: 'Jinhsi', inView: true });
      await setEditorScroll(page, '#review-source', 'end');
      await first.getByRole('button', { name: '定位原文', exact: true }).click();
      expect(await editorSelectionInView(page, '#review-source')).toEqual({ selected: '今汐', inView: true });

      // Box at the top, word on the last line.
      await setEditorScroll(page, '#review-target', 0);
      await last.getByRole('button', { name: '定位译文', exact: true }).click();
      expect(await editorSelectionInView(page, '#review-target')).toEqual({ selected: 'Echo', inView: true });
    });
  });
}
