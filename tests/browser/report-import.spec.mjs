// A report export is not a manuscript and not a backup (Finding 2026-10-06): importing one says so and replaces nothing, and a
// plain source text replaces unsaved work only after the user confirms. Synthetic text; every /api response is a local fake.
import { test, expect } from '@playwright/test';
import { msg } from '../../lib/messages.ts';
import { downloadFrom, fillPair, openWorkbench } from '../helpers/semantic-routes.mjs';

const M = msg('zh');

test('an exported Markdown report is not imported as source text, and plain text asks before replacing unsaved work', async ({ page }) => {
  await openWorkbench(page, { capabilities: [] });
  await fillPair(page, '今汐。', 'Jinhsi.');
  const report = await downloadFrom(page, M.review.exportMarkdown);
  const input = page.getByLabel('选择稿件文件');
  await input.setInputFiles({ name: 'wuwaterm-report.md', mimeType: 'text/markdown', buffer: Buffer.from(report.text) });
  await expect(page.locator('.review-card .error-panel')).toHaveText(M.errors.importReportExport);
  await expect(page.locator('#review-source')).toHaveValue('今汐。');
  await expect(page.locator('#review-target')).toHaveValue('Jinhsi.');

  const dialog = page.getByRole('dialog', { name: M.review.importReplaceTitle });
  await input.setInputFiles({ name: 'source.txt', mimeType: 'text/plain', buffer: Buffer.from('新的原文。') });
  await dialog.getByRole('button', { name: M.review.dialogKeep, exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#review-source')).toHaveValue('今汐。');
  await expect(page.locator('#review-target')).toHaveValue('Jinhsi.');

  await input.setInputFiles({ name: 'source.txt', mimeType: 'text/plain', buffer: Buffer.from('新的原文。') });
  await dialog.getByRole('button', { name: M.review.importReplaceConfirm, exact: true }).click();
  await expect(page.locator('#review-source')).toHaveValue('新的原文。');
  await expect(page.locator('#review-target')).toHaveValue('');
  await expect(page.locator('.review-card .notice-state')).toHaveText(M.notices.importedSourceText);
});
