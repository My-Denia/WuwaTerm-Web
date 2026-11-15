// A whole-text translation keeps the source's paragraphs only when it carries translation-context-v1 (Core uses
// prepare_text_keeping_paragraphs with a context and folds blank lines without one), so review can pair the paragraphs.
// The context is sent, even as {}, only when the service negotiates it (MY-238). Synthetic text; the routes are local fakes.
import { test, expect } from '@playwright/test';
import { msg } from '../../lib/messages.ts';
import { FULL, S, openWorkbench } from '../helpers/semantic-routes.mjs';

const M = msg('zh');
// Twelve short paragraphs: the source stays under 2,000 characters, the translation goes over 1,800, so review pairs paragraphs.
const ids = Array.from({ length: 12 }, (_, k) => k + 1);
const zh = i => `第${i}段第一句${'甲'.repeat(50)}。第${i}段第二句${'乙'.repeat(50)}。`;
const en = i => `Paragraph ${i} says ${'word '.repeat(40)}in one sentence.`;
const SOURCE = ids.map(zh).join('\n\n');
// The fake service behaves like Core here: paragraphs kept with a context, folded into one without.
const echo = body => {
  const parts = body.text.split(/\n\s*\n/u).map((_, k) => en(k + 1));
  return body.context !== undefined ? parts.join('\n\n') : parts.join(' ');
};
const chips = page => page.locator('.segment-chip');

test('with translation-context-v1 a whole-text translation sends context {} and its paragraphs pair in review', async ({ page }) => {
  const rec = await openWorkbench(page, { capabilities: FULL, translate: echo });
  await page.locator('#review-source').fill(SOURCE);
  await page.getByRole('button', { name: M.review.translateIdle, exact: true }).click();
  await expect(page.locator('#review-target')).toHaveValue(ids.map(en).join('\n\n'));
  expect(rec.translations).toEqual([{ text: SOURCE, to: 'en', context: {} }]);
  await expect(chips(page)).toHaveCount(2);
  await expect(chips(page).filter({ hasText: S.segManual })).toHaveCount(0);
});

test('without translation-context-v1 no context is sent, and a folded translation needs a manual split', async ({ page }) => {
  const rec = await openWorkbench(page, { capabilities: [], translate: echo });
  await page.locator('#review-source').fill(SOURCE);
  await page.getByRole('button', { name: M.review.translateIdle, exact: true }).click();
  await expect(page.locator('#review-target')).toHaveValue(ids.map(en).join(' '));
  expect(rec.translations).toEqual([{ text: SOURCE, to: 'en' }]);
  await expect(chips(page)).toHaveCount(1);
  await expect(chips(page).filter({ hasText: S.segManual })).toHaveCount(1);
});

for (const [label, capabilities, extra] of [['negotiated', FULL, { context: {} }], ['not negotiated', [], {}]]) {
  test(`the translation workbench sends context {} on a whole-text translation only when negotiated (${label})`, async ({ page }) => {
    const rec = await openWorkbench(page, { capabilities });
    await page.locator('#translation-source').fill('今汐。\n\n声骸。');
    await page.getByRole('button', { name: M.translation.submitIdle, exact: true }).click();
    await expect.poll(() => rec.translations.length).toBe(1);
    expect(rec.translations[0]).toEqual({ text: '今汐。\n\n声骸。', ...extra });
  });
}
