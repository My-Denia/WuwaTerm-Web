import { test, expect } from '@playwright/test';
import { S, fill, openWorkbench, fillPair, longPair, zhParagraph, enParagraph } from '../helpers/semantic-routes.mjs';

const chips = page => page.locator('.segment-chip');
const manualChip = page => chips(page).filter({ hasText: S.segManual });
const undo = page => page.getByRole('button', { name: '撤销修订', exact: true });
const zhSentence = (tag, n) => `${tag}${'甲'.repeat(n)}。`;
const enSentence = (tag, n) => `${tag} ${'b'.repeat(n)}.`;

test('single line breaks on one side need a manual split, and one click turns every line into a paragraph', async ({ page }) => {
  await openWorkbench(page);
  const paragraphs = [1, 2, 3].map(i => zhParagraph(i));
  const lines = [1, 2, 3].map(i => enParagraph(i));
  await fillPair(page, paragraphs.join('\n\n'), lines.join('\n'));
  await expect(chips(page)).toHaveCount(1);
  await expect(manualChip(page)).toHaveCount(1);
  const hint = chips(page).first().locator('.segment-hint');
  await expect(hint).toContainText('原文 3 段');
  await expect(hint).toContainText('译文 1 段');
  await page.getByRole('button', { name: S.linesEverywhere, exact: true }).click();
  await expect(page.locator('#review-target')).toHaveValue(lines.join('\n\n'));
  await expect(page.locator('.notice-state')).toHaveText(S.notices.lines);
  await expect(chips(page)).toHaveCount(3);
  await expect(manualChip(page)).toHaveCount(0);
  await expect(chips(page).first()).toContainText(S.segPending);
  await undo(page).click();
  await expect(page.locator('#review-target')).toHaveValue(lines.join('\n'));
  await expect(manualChip(page)).toHaveCount(1);
});

test('a translation with one paragraph too many is repaired in the split helper by merging', async ({ page }) => {
  await openWorkbench(page);
  const source = [zhParagraph(1), zhParagraph(2, 100), zhParagraph(3)].join('\n\n');
  const half = k => enParagraph(2, 17).replace(/Paragraph 2/g, `Paragraph 2${k}`);
  const target = [enParagraph(1), half('a'), half('b'), enParagraph(3)].join('\n\n');
  await fillPair(page, source, target);
  await expect(manualChip(page)).toHaveCount(1);
  await expect(chips(page).first().locator('.segment-hint')).toContainText('原文 3 段');
  await expect(chips(page).first().locator('.segment-hint')).toContainText('译文 4 段');
  await chips(page).first().getByRole('button', { name: S.manualOpen, exact: true }).click();
  const helper = page.getByRole('region', { name: S.splitTitle });
  await expect(helper).toContainText(fill(S.splitCount, { n: 3 }));
  await expect(helper).toContainText(fill(S.splitCount, { n: 4 }));
  await helper.getByRole('button', { name: fill(S.splitMergeAria, { side: S.splitTarget, n: 2 }), exact: true }).click();
  await expect(page.locator('.notice-state')).toHaveText(S.notices.merged);
  await expect(page.locator('#review-target')).toHaveValue([enParagraph(1), `${half('a')} ${half('b')}`, enParagraph(3)].join('\n\n'));
  await expect(manualChip(page)).toHaveCount(0);
  await expect(chips(page).filter({ hasText: S.segPending }).first()).toBeVisible();
});

test('a long paragraph with different sentence counts is cut on both sides together', async ({ page }) => {
  await openWorkbench(page);
  const middleSource = [zhSentence('甲一', 700), zhSentence('乙二', 700), zhSentence('丙三', 700)].join('');
  const middleTarget = [enSentence('Alpha', 500), enSentence('Beta', 500), enSentence('Gamma', 500), enSentence('Delta', 500)].join(' ');
  const source = [zhParagraph(1), middleSource, zhParagraph(3)].join('\n\n');
  const target = [enParagraph(1), middleTarget, enParagraph(3)].join('\n\n');
  await fillPair(page, source, target);
  await expect(manualChip(page)).toHaveCount(1);
  await manualChip(page).getByRole('button', { name: S.manualOpen, exact: true }).click();
  const helper = page.getByRole('region', { name: S.splitTitle });
  await helper.getByRole('button', { name: fill(S.splitInsertAria, { side: S.splitSource, n: 1, i: 1 }), exact: true }).click();
  await expect(helper.locator('.split-pending')).toContainText('已选：');
  // Nothing was inserted yet: one-sided blank lines would unpair the whole text.
  await expect(page.locator('#review-source')).toHaveValue(source);
  await helper.getByRole('button', { name: fill(S.splitInsertAria, { side: S.splitTarget, n: 1, i: 1 }), exact: true }).click();
  await expect(page.locator('.notice-state')).toHaveText(S.notices.split);
  await expect(page.locator('#review-source')).not.toHaveValue(source);
  await expect(page.locator('#review-target')).not.toHaveValue(target);
  await expect(manualChip(page)).toHaveCount(0);
  await undo(page).click();
  await expect(page.locator('#review-source')).toHaveValue(source);
  await expect(page.locator('#review-target')).toHaveValue(target);
  await expect(manualChip(page)).toHaveCount(1);
});

test('a long source without a translation is translated segment by segment, each with the previous segment as context', async ({ page }) => {
  const { source } = longPair(3);
  const rec = await openWorkbench(page, { capabilities: ['translation-context-v1'] });
  await page.locator('#review-source').fill(source);
  await expect(page.locator('.long-translate')).toContainText(S.translateLongHint);
  await page.getByRole('button', { name: S.translateLong, exact: true }).click();
  await expect(page.locator('#review-target')).toHaveValue('Translated 1.\n\nTranslated 2.\n\nTranslated 3.', { timeout: 30_000 });
  await expect(page.locator('.notice-state')).toHaveText(S.notices.translateRunDone);
  expect(rec.translations).toHaveLength(3);
  rec.translations.forEach((body, i) => {
    expect(body.text).toBe(zhParagraph(i + 1));
    expect(body.to).toBe('en');
    if (i === 0) expect(body.context).toBeUndefined();
    else {
      expect(body.context.before.source).toBe(Array.from(zhParagraph(i)).slice(-400).join(''));
      expect(body.context.before.target).toBe(`Translated ${i}.`);
    }
  });
});

test('a failed segment stops the segment translation in order and continuing resends it first', async ({ page }) => {
  const { source } = longPair(3);
  const rec = await openWorkbench(page, { capabilities: ['translation-context-v1'], translateFailures: { 2: { status: 502, body: { status: 'unavailable', reason: 'upstream_network_error' } } },
    translate: body => `T:${Array.from(body.text).slice(0, 3).join('')}` });
  await page.locator('#review-source').fill(source);
  await page.getByRole('button', { name: S.translateLong, exact: true }).click();
  await expect(page.locator('.run-phase')).toContainText(S.translateStopped, { timeout: 30_000 });
  // Only the first segment is in the translation: nothing after the failed one was appended.
  await expect(page.locator('#review-target')).toHaveValue(`T:${Array.from(zhParagraph(1)).slice(0, 3).join('')}\n\n`);
  expect(rec.translations).toHaveLength(2);
  await page.getByRole('button', { name: S.resume, exact: true }).click();
  const expected = [1, 2, 3].map(i => `T:${Array.from(zhParagraph(i)).slice(0, 3).join('')}`).join('\n\n');
  await expect(page.locator('#review-target')).toHaveValue(expected, { timeout: 30_000 });
  expect(rec.translations.map(body => body.text)).toEqual([zhParagraph(1), zhParagraph(2), zhParagraph(2), zhParagraph(3)]);
});

test('without the context capability the segment translation sends no context', async ({ page }) => {
  const rec = await openWorkbench(page, { capabilities: [] });
  await page.locator('#review-source').fill(longPair(2).source);
  await page.getByRole('button', { name: S.translateLong, exact: true }).click();
  await expect(page.locator('#review-target')).toHaveValue('Translated 1.\n\nTranslated 2.', { timeout: 30_000 });
  expect(rec.translations.map(body => body.context)).toEqual([undefined, undefined]);
});

test('forced cuts, untranslated segments and an extra translation paragraph each carry their own hint', async ({ page }) => {
  await openWorkbench(page);
  // One 2,500-character sentence per side with commas to cut at, no sentence end inside it.
  await fillPair(page, `${'甲'.repeat(49)}，`.repeat(50), `${'b'.repeat(49)},`.repeat(50));
  await expect(chips(page).first()).toContainText(S.segHardCut);
  await expect(chips(page).first().locator('.segment-hint')).toContainText(S.hardCutHint);
  await fillPair(page, '', '');
  await fillPair(page, '她看见三只鸟。', '');
  await expect(chips(page).first()).toContainText(S.segUntranslated);
  await expect(chips(page).first().locator('.segment-hint')).toHaveText(S.untranslatedHint);
  await fillPair(page, '', 'She saw two birds.');
  await expect(chips(page).first()).toContainText(S.segUnpaired);
  await expect(chips(page).first().locator('.segment-hint')).toHaveText(S.unpairedHint);
});
