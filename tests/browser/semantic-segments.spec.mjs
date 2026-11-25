import { test, expect } from '@playwright/test';
import { serializeWorkfile } from '../../lib/manuscript.js';
import { fixture as savedFixture } from '../fixtures/manuscript.mjs';
import { S, fill, openWorkbench, fillPair, longPair, zhParagraph, enParagraph } from '../helpers/semantic-routes.mjs';

const chips = page => page.locator('.segment-chip');
const manualChip = page => chips(page).filter({ hasText: S.segManual });
const undo = page => page.getByRole('button', { name: '撤销修订', exact: true });
const zhSentence = (tag, n) => `${tag}${'甲'.repeat(n)}。`;
const enSentence = (tag, n) => `${tag} ${'b'.repeat(n)}.`;

for (const failed of [false, true]) {
  test(`an old single-pair ${failed ? 'failure' : 'translation'} cannot change a newly opened manuscript with the same text`, async ({ page }) => {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const options = { translateHold: { 1: held } };
    if (failed) options.translateFailures = { 1: { status: 502, body: { reason: 'upstream_network_error' } } };
    const rec = await openWorkbench(page, options);
    const source = '她看见三只鸟。';
    await page.locator('#review-source').fill(source);
    await page.getByRole('button', { name: S.segTranslate, exact: true }).click();
    await expect.poll(() => rec.translations.length).toBe(1);
    const file = serializeWorkfile({ source, target: '', direction: 'en', alignments: null, choices: [], history: [] });
    await page.getByLabel('选择稿件文件').setInputFiles({ name: 'same-text.json', mimeType: 'application/json', buffer: Buffer.from(file) });
    await expect(page.locator('.notice-state')).toContainText('已在本地恢复稿件');
    const response = page.waitForResponse(result => new URL(result.url()).pathname === '/api/translations');
    release();
    await response;
    await page.waitForTimeout(150);
    await expect(page.locator('#review-target')).toHaveValue('');
    await expect(page.locator('.notice-state')).toContainText('已在本地恢复稿件');
  });
}

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
    // ADR 0019 decision 5: the first segment has nothing before it and sends an empty context.
    if (i === 0) expect(body.context).toEqual({});
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

test('changing the direction during segment translation stops it and drops the reply for the old direction', async ({ page }) => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const rec = await openWorkbench(page, { capabilities: ['translation-context-v1'], translateHold: { 1: held } });
  await page.locator('#review-source').fill(longPair(3).source);
  await page.getByRole('button', { name: S.translateLong, exact: true }).click();
  await expect.poll(() => rec.translations.length).toBe(1);
  await page.locator('select[aria-label="译文语言"]').selectOption('zh');
  release();
  await expect(page.locator('.run-phase')).toContainText(S.notices.translateTargetChanged);
  await page.waitForTimeout(1_000);
  expect(rec.translations.map(body => body.to)).toEqual(['en']);
  await expect(page.locator('#review-target')).toHaveValue('');
});

test('translating one untranslated pair sends an empty context once the service negotiates it', async ({ page }) => {
  const rec = await openWorkbench(page, { capabilities: ['translation-context-v1'] });
  const source = '她看见三只鸟。';
  await page.locator('#review-source').fill(source);
  await page.getByRole('button', { name: S.segTranslate, exact: true }).click();
  await expect(page.locator('#review-target')).toHaveValue('Translated 1.', { timeout: 30_000 });
  expect(rec.translations).toEqual([{ text: source, to: 'en', context: {} }]);
});

test('an in-flight pair translation survives the first term-basis check and remains undoable', async ({ page }) => {
  let releaseTranslation;
  let releaseReview;
  const translationHeld = new Promise(resolve => { releaseTranslation = resolve; });
  const reviewHeld = new Promise(resolve => { releaseReview = resolve; });
  const rec = await openWorkbench(page, { capabilities: [], translateHold: { 1: translationHeld }, reviewHold: { 1: reviewHeld } });
  const first = `今汐在第一段。${zhParagraph(1, 75)}`;
  const second = zhParagraph(2, 85);
  const source = `${first}\n\n${second}`;
  const target = 'Jinhsi appears in the first paragraph.';
  const file = serializeWorkfile({
    source, target, direction: 'en', choices: [], history: [],
    alignments: [
      { source: { start: 0, end: first.length, text: first }, target: { start: 0, end: target.length, text: target } },
      { source: { start: first.length + 2, end: source.length, text: second }, target: null },
    ],
  });
  try {
    await page.getByLabel('选择稿件文件').setInputFiles({ name: 'partially-translated.json', mimeType: 'application/json', buffer: Buffer.from(file) });
    await expect(chips(page)).toHaveCount(2);
    await expect(chips(page).nth(1)).toContainText(S.segUntranslated);
    await chips(page).nth(1).getByRole('button', { name: S.segTranslate, exact: true }).click();
    await expect.poll(() => rec.translations.length).toBe(1);
    await page.locator('.long-tools .long-terms button').click();
    await expect.poll(() => rec.reviews.length).toBe(1);
    releaseReview();
    await expect(page.locator('.run-phase')).toHaveAttribute('data-run-state', 'done');
    await expect(chips(page).first()).toHaveAttribute('data-term-state', 'current');
    releaseTranslation();
    await expect(page.locator('#review-target')).toHaveValue(`${target}\n\nTranslated 1.`);
    await expect(page.locator('.notice-state')).toHaveText(S.notices.translated);
    await expect(page.locator('.alignment-recovery')).toHaveCount(0);
    await expect(chips(page)).toHaveCount(2);
    await expect(chips(page).nth(1)).not.toContainText(S.segUntranslated);
    await undo(page).click();
    await expect(page.locator('#review-target')).toHaveValue(target);
    await expect(chips(page).first()).toHaveAttribute('data-term-state', 'current');
    expect(rec.reviews).toHaveLength(1);
    expect(rec.translations).toHaveLength(1);
  } finally {
    releaseReview();
    releaseTranslation();
  }
});

test('the second pair translation still carries the previous pair as its before context', async ({ page }) => {
  const rec = await openWorkbench(page, { capabilities: ['translation-context-v1'] });
  // An imported aligned manuscript: the first pair is translated, the second has no target text.
  const source = '甲一。\n\n甲二。';
  const target = 'Alpha one.';
  const file = serializeWorkfile({
    source, target, direction: 'en',
    alignments: [
      { source: { start: 0, end: 3, text: '甲一。' }, target: { start: 0, end: 10, text: target } },
      { source: { start: 5, end: 8, text: '甲二。' }, target: null },
    ],
    choices: [],
    history: [{ source, target, direction: 'en', alignments: null, report: savedFixture(source, target).report, resolutions: [] }],
  });
  await page.getByLabel('选择稿件文件').setInputFiles({ name: 'manuscript.json', mimeType: 'application/json', buffer: Buffer.from(file) });
  await expect(page.locator('#review-source')).toHaveValue(source);
  await page.locator('.segment-chip').nth(1).getByRole('button', { name: S.segTranslate, exact: true }).click();
  await expect(page.locator('#review-target')).toContainText('Translated 1.', { timeout: 30_000 });
  expect(rec.translations).toEqual([{ text: '甲二。', to: 'en', context: { before: { source: '甲一。', target } } }]);
});

test('translating one untranslated pair preserves alignments so remaining untranslated segments stay ready for the next translation', async ({ page }) => {
  const rec = await openWorkbench(page, { capabilities: [] });
  // A partly translated manuscript reopened: the first paragraph is aligned, the other two are marked as having no translation.
  const source = '甲一。\n\n甲二。\n\n甲三。';
  const target = 'Alpha one.';
  const file = serializeWorkfile({
    source, target, direction: 'en', choices: [], history: [],
    alignments: [
      { source: { start: 0, end: 3, text: '甲一。' }, target: { start: 0, end: 10, text: target } },
      { source: { start: 5, end: 8, text: '甲二。' }, target: null },
      { source: { start: 10, end: 13, text: '甲三。' }, target: null },
    ],
  });
  await page.getByLabel('选择稿件文件').setInputFiles({ name: 'manuscript.json', mimeType: 'application/json', buffer: Buffer.from(file) });
  await expect(page.locator('#review-source')).toHaveValue(source);
  const untranslated = chips(page).filter({ hasText: S.segUntranslated });
  await expect(untranslated).toHaveCount(2);
  await untranslated.first().getByRole('button', { name: S.segTranslate, exact: true }).click();
  await expect(page.locator('#review-target')).toContainText('Translated 1.', { timeout: 30_000 });
  await expect(page.locator('.alignment-recovery')).toHaveCount(0);
  await expect(untranslated).toHaveCount(1);
  expect(rec.translations).toHaveLength(1);
  expect(S.translateStopped).toContain('继续翻译剩余段落');
});

test('reopened partial manuscript batch-resumes, ready segment retranslate preserves alignments with undo, and zero browser storage is written', async ({ page }) => {
  const rec = await openWorkbench(page, { capabilities: ['translation-context-v1'] });
  // Each paragraph > 950 scalars so ready pairs stay distinct under segmentation's 1800-scalar merge cap.
  const p1 = `甲一。${'文'.repeat(980)}`;
  const p2 = `甲二。${'文'.repeat(980)}`;
  const p3 = `甲三。${'文'.repeat(980)}`;
  const source = `${p1}\n\n${p2}\n\n${p3}`;
  const target = `Alpha one.${'x'.repeat(980)}`;
  const s1End = Array.from(p1).length;
  const s2Start = s1End + 2;
  const s2End = s2Start + Array.from(p2).length;
  const s3Start = s2End + 2;
  const s3End = s3Start + Array.from(p3).length;
  const file = serializeWorkfile({
    source, target, direction: 'en', choices: [], history: [],
    alignments: [
      { source: { start: 0, end: s1End, text: p1 }, target: { start: 0, end: Array.from(target).length, text: target } },
      { source: { start: s2Start, end: s2End, text: p2 }, target: null },
      { source: { start: s3Start, end: s3End, text: p3 }, target: null },
    ],
  });
  await page.getByLabel('选择稿件文件').setInputFiles({ name: 'resume-partial.json', mimeType: 'application/json', buffer: Buffer.from(file) });
  await expect(page.locator('#review-source')).toHaveValue(source);
  await page.getByRole('button', { name: S.translateResume, exact: true }).click();
  await expect(page.locator('#review-target')).toHaveValue(`${target}\n\nTranslated 1.\n\nTranslated 2.`, { timeout: 30_000 });
  await expect(page.locator('.alignment-recovery')).toHaveCount(0);
  await expect(chips(page)).toHaveCount(3);
  expect(rec.translations.map(t => t.text)).toEqual([p2, p3]);

  // Single-segment retranslate of ready pair 0 keeps shifted alignments for pairs 1 and 2, and Undo restores target & alignments.
  await chips(page).nth(0).getByRole('button', { name: S.segRetranslate, exact: true }).click();
  await expect(page.locator('#review-target')).toHaveValue('Translated 3.\n\nTranslated 1.\n\nTranslated 2.', { timeout: 30_000 });
  await expect(page.locator('.notice-state')).toHaveText(S.notices.retranslated);
  await undo(page).click();
  await expect(page.locator('#review-target')).toHaveValue(`${target}\n\nTranslated 1.\n\nTranslated 2.`);

  const storage = await page.evaluate(async () => ({
    local: localStorage.length,
    session: sessionStorage.length,
    idb: typeof indexedDB?.databases === 'function' ? (await indexedDB.databases()).length : 0,
    caches: typeof caches?.keys === 'function' ? (await caches.keys()).length : 0,
  }));
  expect(storage).toEqual({ local: 0, session: 0, idb: 0, caches: 0 });
});

test('without the context capability the segment translation sends no context', async ({ page }) => {
  const rec = await openWorkbench(page, { capabilities: [] });
  await page.locator('#review-source').fill(longPair(2).source);
  await page.getByRole('button', { name: S.translateLong, exact: true }).click();
  await expect(page.locator('#review-target')).toHaveValue('Translated 1.\n\nTranslated 2.', { timeout: 30_000 });
  expect(rec.translations.map(body => body.context)).toEqual([undefined, undefined]);
});

test('without the context capability the single-pair translation sends no context key (MY-238)', async ({ page }) => {
  const rec = await openWorkbench(page, { capabilities: [] });
  const source = '她看见三只鸟。';
  await page.locator('#review-source').fill(source);
  await page.getByRole('button', { name: S.segTranslate, exact: true }).click();
  await expect(page.locator('#review-target')).toHaveValue('Translated 1.', { timeout: 30_000 });
  expect(rec.translations).toHaveLength(1);
  expect(Object.hasOwn(rec.translations[0], 'context')).toBe(false);
  expect(rec.translations[0]).toEqual({ text: source, to: 'en' });
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
