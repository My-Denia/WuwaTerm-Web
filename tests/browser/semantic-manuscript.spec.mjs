import { test, expect } from '@playwright/test';
import { msg } from '../../lib/messages.ts';
import { S, openWorkbench, fillPair, downloadFrom, TRIO, trioResponse } from '../helpers/semantic-routes.mjs';

const card = page => page.locator('.semantic-card');
const act = (page, name) => card(page).getByRole('button', { name, exact: true });
const filter = (page, name, n) => page.getByRole('button', { name: `${name} ${n}`, exact: true });
const buffer = text => ({ name: 'manuscript.json', mimeType: 'application/json', buffer: Buffer.from(text) });

/** Reviews TRIO, ignores the first issue, accepts the second (unless `accept` is false) and leaves the rest pending. */
async function handleTrio(page, { accept = true, ...options } = {}) {
  const rec = await openWorkbench(page, { respond: trioResponse(), ...options });
  await fillPair(page, TRIO.source, TRIO.target);
  await page.getByRole('button', { name: S.start, exact: true }).click();
  await expect(page.locator('.semantic-item')).toHaveCount(3);
  await act(page, S.ignore).click();
  if (!accept) {
    await expect(filter(page, S.statusHandled, 1)).toBeVisible();
    return rec;
  }
  await act(page, S.accept).click();
  await expect(page.locator('#review-target')).toHaveValue('She saw two birds. He did not come. We leave today.');
  await expect(filter(page, S.statusHandled, 2)).toBeVisible();
  return rec;
}

test('the Markdown report lists semantic issues under a heading that says they may be wrong', async ({ page }) => {
  await handleTrio(page);
  const markdown = (await downloadFrom(page, '导出 Markdown 报告')).text;
  const md = msg('zh').md;
  expect(markdown).toContain(`## ${md.semanticHeading}`);
  expect(markdown).toContain('可能有误');
  expect(markdown).toContain('已处理 2 条');
  expect(markdown).toContain('已审校段落：1 / 1');
  expect(markdown).toContain(md.semanticStatuses.ignored);
  expect(markdown).toContain(md.semanticStatuses.accepted);
  expect(markdown).toContain(md.semanticStatuses.pending);
  expect(markdown).toContain('理由');
});

test('the result export counts handled issues and never claims sentence meaning was evaluated', async ({ page }) => {
  await handleTrio(page);
  const result = JSON.parse((await downloadFrom(page, '导出当前结果')).text);
  expect(result.sentence_meaning_evaluated).toBe(false);
  expect(result.semantic_issues_resolved).toBe(2);
  expect(result.semantic_review.review_version).toBe('semantic-review-v1');
  expect(result.semantic_review.origin).toBe('model');
  expect(result.semantic_review.items).toHaveLength(3);
  expect(result.semantic_review.items.map(item => item.status).sort()).toEqual(['accepted', 'ignored', 'pending']);
});

test('a saved v2 manuscript with an ignored issue comes back as history with the ignore kept, and saves back byte for byte', async ({ page }) => {
  await handleTrio(page, { accept: false });
  const saved = (await downloadFrom(page, '保存稿件')).text;
  const file = JSON.parse(saved);
  expect(file.format).toBe('wuwaterm-manuscript-v2');
  expect(file.semantic_decisions.map(d => d.decision)).toEqual(['ignored']);
  expect(file.semantic_history).toHaveLength(1);

  await page.getByRole('button', { name: '清空稿件', exact: true }).click();
  await expect(page.locator('#review-source')).toHaveValue('');
  await expect(page.locator('.semantic-item')).toHaveCount(0);

  await page.getByLabel('选择稿件文件').setInputFiles(buffer(saved));
  await expect(page.locator('.notice-state')).toContainText('已在本地恢复稿件，未上传');
  await expect(page.locator('#review-target')).toHaveValue(TRIO.target);
  await filter(page, S.statusAll, 3).click();
  await expect(page.locator('.semantic-item')).toHaveCount(3);
  await expect(card(page)).toContainText(S.importedBadge);
  await expect(page.locator('.semantic-item .semantic-state')).toHaveText([S.statuses.ignored, S.statuses.pending, S.statuses.pending]);
  expect((await downloadFrom(page, '保存稿件')).text).toBe(saved);
});

test('a v2 manuscript with an applied suggestion keeps its decisions through clear and import and saves back byte for byte', async ({ page }) => {
  await handleTrio(page);
  const saved = (await downloadFrom(page, '保存稿件')).text;
  const file = JSON.parse(saved);
  expect(file.format).toBe('wuwaterm-manuscript-v2');
  expect(file.semantic_decisions.map(d => d.decision).sort()).toEqual(['accepted', 'ignored']);
  await page.getByRole('button', { name: '清空稿件', exact: true }).click();
  await page.getByLabel('选择稿件文件').setInputFiles(buffer(saved));
  await expect(page.locator('.notice-state')).toContainText('已在本地恢复稿件，未上传');
  await expect(page.locator('#review-target')).toHaveValue('She saw two birds. He did not come. We leave today.');
  expect((await downloadFrom(page, '保存稿件')).text).toBe(saved);
});

test('a page without semantic review keeps the decisions of an imported v2 manuscript when it saves again', async ({ page, context }) => {
  await handleTrio(page);
  const saved = (await downloadFrom(page, '保存稿件')).text;
  const plain = await context.newPage();
  await openWorkbench(plain, { capabilities: ['translation-context-v1'] });
  await expect(plain.locator('.semantic-track')).toHaveCount(0);
  await plain.getByLabel('选择稿件文件').setInputFiles(buffer(saved));
  await expect(plain.locator('.notice-state')).toContainText('已在本地恢复稿件，未上传');
  await expect(plain.locator('.semantic-track')).toHaveCount(0);
  const resaved = JSON.parse((await downloadFrom(plain, '保存稿件')).text);
  const original = JSON.parse(saved);
  expect(resaved.format).toBe('wuwaterm-manuscript-v2');
  expect(resaved.semantic_decisions).toEqual(original.semantic_decisions);
  expect(resaved.semantic_texts).toEqual(original.semantic_texts);
  expect(resaved.semantic_history).toEqual(original.semantic_history);
});
