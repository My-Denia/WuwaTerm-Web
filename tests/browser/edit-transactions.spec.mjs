import { test, expect } from '@playwright/test';
import { serializeWorkfile } from '../../lib/manuscript.js';
import { msg } from '../../lib/messages.ts';
import { downloadFrom, fill, openWorkbench } from '../helpers/semantic-routes.mjs';

// Edit transactions in the review workbench (contracts/workbench-state/edit-transactions.json): an edit that crosses one
// alignment boundary takes only the crossed entries out, says so, and one undo brings them back; a deleted translation keeps
// its source anchor; a saved manuscript holds only the kept alignments; nothing reaches browser storage.
const m = msg('zh');
const SOURCE = '甲一。\n\n甲二。\n\n甲三。';
const TARGET = 'One.\n\nTwo.\n\nThree.';
const ALIGNMENTS = [
  { source: { start: 0, end: 3, text: '甲一。' }, target: { start: 0, end: 4, text: 'One.' } },
  { source: { start: 5, end: 8, text: '甲二。' }, target: { start: 6, end: 10, text: 'Two.' } },
  { source: { start: 10, end: 13, text: '甲三。' }, target: { start: 12, end: 18, text: 'Three.' } },
];
const summary = page => page.locator('.alignment-panel summary');
const rows = page => page.locator('.alignment-panel .alignment-row');
const undo = page => page.getByRole('button', { name: m.review.undo, exact: true });

async function openAligned(page) {
  await openWorkbench(page);
  const file = serializeWorkfile({ source: SOURCE, target: TARGET, direction: 'en', alignments: ALIGNMENTS, choices: [], history: [] });
  await page.getByLabel('选择稿件文件').setInputFiles({ name: 'aligned.json', mimeType: 'application/json', buffer: Buffer.from(file) });
  await expect(page.locator('#review-source')).toHaveValue(SOURCE);
  await expect(summary(page)).toHaveText(fill(m.review.alignmentSummaryCount, { n: 3 }));
  await summary(page).click();
}

test('an edit across one alignment boundary keeps the untouched alignment, and one undo restores the crossed ones', async ({ page }) => {
  await openAligned(page);
  // Deleting '。\n\n甲' joins the first two paragraphs: it crosses the end of 甲一。 and the start of 甲二。 only.
  await page.locator('#review-source').fill('甲一二。\n\n甲三。');
  await expect(page.locator('.notice-state')).toHaveText(m.notices.editedAlignmentsPartial);
  await expect(summary(page)).toHaveText(fill(m.review.alignmentSummaryCount, { n: 1 }));
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('甲三。');
  await expect(rows(page).first()).toContainText('Three.');
  await expect(page.locator('.alignment-recovery')).toHaveCount(0);

  // The saved manuscript holds the one kept alignment, shifted to the new text, and nothing about the invalidated ones.
  const saved = JSON.parse((await downloadFrom(page, m.review.save)).text);
  expect(saved.source).toBe('甲一二。\n\n甲三。');
  expect(saved.alignments).toEqual([
    { source: { start: 6, end: 9, text: '甲三。' }, target: { start: 12, end: 18, text: 'Three.' } },
  ]);
  expect(JSON.stringify(saved)).not.toMatch(/invalidat|original_?index|emptied/iu);

  await undo(page).click();
  await expect(page.locator('#review-source')).toHaveValue(SOURCE);
  await expect(summary(page)).toHaveText(fill(m.review.alignmentSummaryCount, { n: 3 }));
  await expect(rows(page)).toHaveCount(3);
  await expect(page.locator('.notice-state')).toHaveText(m.notices.undoLocal);

  // A deleted translation keeps its source anchor as an untranslated alignment; the others stay.
  await page.locator('#review-target').fill('One.\n\n\n\nThree.');
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).nth(1)).toContainText('甲二。');
  await expect(rows(page).nth(1)).toContainText(m.review.alignmentRowOmit);
  await expect(rows(page).nth(2)).toContainText('Three.');
  await expect(page.getByText(m.notices.editedAlignmentsPartial)).toHaveCount(0);
  await expect(page.getByText(m.notices.editedAlignments)).toHaveCount(0);

  // Crossing every entry still leaves none and keeps the existing recovery prompt.
  await page.locator('#review-source').fill('甲');
  await expect(page.locator('.notice-state')).toHaveText(m.notices.editedAlignments);
  await expect(page.locator('.alignment-recovery')).toHaveCount(1);

  const storage = await page.evaluate(async () => ({
    local: localStorage.length,
    session: sessionStorage.length,
    idb: typeof indexedDB?.databases === 'function' ? (await indexedDB.databases()).length : 0,
  }));
  expect(storage).toEqual({ local: 0, session: 0, idb: 0 });
});
