import { test, expect } from '@playwright/test';
import { serializeWorkfile } from '../../lib/manuscript.js';
import { msg } from '../../lib/messages.ts';
import { fixture, freshApiReport } from '../fixtures/manuscript.mjs';
import { expectEditorValue, fillEditor } from '../helpers/editor.mjs';

// One document workspace: quick translation and manuscript review are two layouts of one controller. A long text, an
// imported manuscript or an explicit switch moves to manuscript mode in place, with no handoff dialog and nothing lost;
// the page reads the pool and capabilities once; redo and IME composition reach the real editors; nothing is stored.
const BASE = process.env.WUWATERM_BROWSER_URL ?? '';
const m = msg('zh');
const w = m.workspace;
const POOL = {
  status: 'available', translation_enabled: true,
  terms: { used: 0, limit: 100, remaining: 100 },
  translations: { used: 0, limit: 100, remaining: 100 },
  characters: { used: 0, limit: 10000, remaining: 10000 },
  reviews: { used: 0, limit: 60, remaining: 60 },
  reset_at: '2099-01-01T00:00:00Z',
};

async function open(page) {
  const calls = [];
  const translations = [];
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    calls.push(path);
    if (path === '/api/capabilities') return route.fulfill({ json: { capabilities: ['translation-context-v1'], request_id: 'synthetic' } });
    if (path === '/api/pool') return route.fulfill({ json: POOL });
    if (path === '/api/translations') {
      const body = route.request().postDataJSON();
      translations.push(body);
      return route.fulfill({ json: { kind: 'exact', text: 'Jinhsi.', direction: body.to ?? 'en', dictionary_miss: false, request_id: 'synthetic-translation' } });
    }
    if (path === '/api/reviews') {
      const body = route.request().postDataJSON();
      return route.fulfill({ json: freshApiReport(fixture(body.source, body.target, body.direction).report) });
    }
    throw new Error(`Unexpected API request: ${path}`);
  });
  await page.goto(BASE + '/');
  await expect(page.locator('.pool-strip')).toContainText('100', { timeout: 30_000 });
  return { calls, translations };
}

const mode = page => page.locator('.document-workspace');
const storage = page => page.evaluate(async () => ({
  local: localStorage.length,
  session: sessionStorage.length,
  idb: typeof indexedDB?.databases === 'function' ? (await indexedDB.databases()).length : 0,
}));

test('a page load reads the pool once and capabilities once, reads no dictionary info, and stores nothing', async ({ page }) => {
  const { calls } = await open(page);
  await expect(page.locator('.runtime-status')).toContainText(w.capabilityContext);
  // Give any late duplicate a chance to show up before counting.
  await page.waitForTimeout(500);
  expect(calls.filter(p => p === '/api/pool')).toHaveLength(1);
  expect(calls.filter(p => p === '/api/capabilities')).toHaveLength(1);
  expect(calls.filter(p => p === '/api/meta')).toHaveLength(0);
  await expect(mode(page)).toHaveAttribute('data-mode', 'quick');
  expect(await storage(page)).toEqual({ local: 0, session: 0, idb: 0 });
});

test('quick translation fills the shared document, and passing 2,000 characters moves to manuscript in place with focus, caret and history', async ({ page }) => {
  const { translations } = await open(page);
  const source = page.locator('#review-source');
  await source.fill('今汐。');
  await page.getByRole('button', { name: m.translation.submitIdle, exact: true }).click();
  await expect(page.locator('#review-target')).toHaveValue('Jinhsi.');
  expect(translations).toEqual([{ text: '今汐。', context: {} }]);
  await expect(page.locator('.translation-result')).toContainText(m.translation.kindExact);

  // Typing on past the limit: the same editor keeps focus and caret, and the switch asks nothing.
  await source.focus();
  await page.evaluate(() => { const box = document.getElementById('review-source'); box.setSelectionRange(box.value.length, box.value.length); });
  const added = '甲'.repeat(2000);
  await page.keyboard.insertText(added);
  await expect(mode(page)).toHaveAttribute('data-mode', 'manuscript');
  await expect(page.locator('.notice-state')).toHaveText(m.notices.switchedToManuscript);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expectEditorValue(page, '#review-source', '今汐。' + added);
  await expectEditorValue(page, '#review-target', 'Jinhsi.');
  const caret = await page.evaluate(() => {
    const el = document.activeElement;
    const view = el?.__cm6View ?? el?.cmView?.view;
    if (view) return { id: el.id, at: view.state.selection.main.from, length: view.state.doc.length };
    return { id: el?.id, at: el?.selectionStart, length: el?.value?.length };
  });
  expect(caret).toEqual({ id: 'review-source', at: 2003, length: 2003 });
  await expect(page.getByRole('button', { name: w.modeQuick, exact: true })).toBeDisabled();

  // Undo still holds the quick translation step: one undo drops the long insert, the next the translation.
  await page.getByRole('button', { name: m.review.undo, exact: true }).click();
  await expectEditorValue(page, '#review-source', '今汐。');
  await expectEditorValue(page, '#review-target', 'Jinhsi.');
  await expect(mode(page)).toHaveAttribute('data-mode', 'manuscript');
  await page.getByRole('button', { name: m.review.undo, exact: true }).click();
  await expectEditorValue(page, '#review-target', '');
  expect(await storage(page)).toEqual({ local: 0, session: 0, idb: 0 });
});

test('opening manuscript review keeps the quick translation and its direction, and a check runs on the same document', async ({ page }) => {
  await open(page);
  await page.getByLabel(m.translation.directionAria).selectOption('en');
  await page.locator('#review-source').fill('今汐。');
  await page.getByRole('button', { name: m.translation.submitIdle, exact: true }).click();
  await expect(page.locator('#review-target')).toHaveValue('Jinhsi.');
  await page.getByRole('button', { name: w.openManuscript, exact: true }).click();
  await expect(mode(page)).toHaveAttribute('data-mode', 'manuscript');
  await expectEditorValue(page, '#review-source', '今汐。');
  await expect(page.getByLabel(m.review.directionAria)).toHaveValue('en');
  await page.getByRole('button', { name: m.review.checkIdle, exact: true }).click();
  await expect(page.locator('.review-current')).toHaveText(m.review.summaryCurrent);
  // Back to quick: still the same document.
  await page.getByRole('button', { name: w.modeQuick, exact: true }).click();
  await expect(mode(page)).toHaveAttribute('data-mode', 'quick');
  await expect(page.locator('#review-target')).toHaveValue('Jinhsi.');
});

test('importing a manuscript from quick mode opens it in manuscript mode without a handoff dialog', async ({ page }) => {
  await open(page);
  const file = serializeWorkfile({ source: '今汐。', target: 'Jinhsi.', direction: 'en', alignments: null, choices: [], history: [] });
  await page.getByLabel(m.review.importFileAria).setInputFiles({ name: 'draft.json', mimeType: 'application/json', buffer: Buffer.from(file) });
  await expect(mode(page)).toHaveAttribute('data-mode', 'manuscript');
  await expectEditorValue(page, '#review-source', '今汐。');
  await expectEditorValue(page, '#review-target', 'Jinhsi.');
  await expect(page.locator('.notice-state')).toHaveText(m.notices.imported);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('redo brings back an edit that took alignments out, and undo restores them again', async ({ page }) => {
  await open(page);
  const SOURCE = '甲一。\n\n甲二。\n\n甲三。';
  const TARGET = 'One.\n\nTwo.\n\nThree.';
  const alignments = [
    { source: { start: 0, end: 3, text: '甲一。' }, target: { start: 0, end: 4, text: 'One.' } },
    { source: { start: 5, end: 8, text: '甲二。' }, target: { start: 6, end: 10, text: 'Two.' } },
    { source: { start: 10, end: 13, text: '甲三。' }, target: { start: 12, end: 18, text: 'Three.' } },
  ];
  const file = serializeWorkfile({ source: SOURCE, target: TARGET, direction: 'en', alignments, choices: [], history: [] });
  await page.getByLabel(m.review.importFileAria).setInputFiles({ name: 'aligned.json', mimeType: 'application/json', buffer: Buffer.from(file) });
  const summary = page.locator('.alignment-panel summary');
  const count = n => m.review.alignmentSummaryCount.replace('{n}', String(n));
  const redo = page.getByRole('button', { name: w.redo, exact: true });
  const undo = page.getByRole('button', { name: m.review.undo, exact: true });
  await expect(summary).toHaveText(count(3));
  await expect(redo).toBeDisabled();
  // Deleting '。\n\n甲' joins the first two paragraphs: only the two entries it crosses leave the list.
  await fillEditor(page, '#review-source', '甲一二。\n\n甲三。');
  await expect(page.locator('.notice-state')).toHaveText(m.notices.editedAlignmentsPartial);
  await expect(summary).toHaveText(count(1));
  await undo.click();
  await expect(summary).toHaveText(count(3));
  await expect(redo).toBeEnabled();
  await redo.click();
  await expectEditorValue(page, '#review-source', '甲一二。\n\n甲三。');
  await expect(page.locator('.notice-state')).toHaveText(m.notices.redoLocal);
  await expect(summary).toHaveText(count(1));
  await expect(redo).toBeDisabled();
  await undo.click();
  await expectEditorValue(page, '#review-source', SOURCE);
  await expect(summary).toHaveText(count(3));
  // A new edit makes the undone step unreachable.
  await fillEditor(page, '#review-target', TARGET + ' ');
  await expect(redo).toBeDisabled();
});

test('an IME composition in the editor is one undo step', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Input.imeSetComposition is a Chromium DevTools command');
  await open(page);
  const source = page.locator('#review-source');
  await source.fill('Alpha');
  await source.focus();
  await page.evaluate(() => { const box = document.getElementById('review-source'); box.setSelectionRange(5, 5); });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'n', selectionStart: 1, selectionEnd: 1 });
  await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 });
  await cdp.send('Input.imeSetComposition', { text: '你', selectionStart: 1, selectionEnd: 1 });
  await cdp.send('Input.insertText', { text: '你' });
  await expect(source).toHaveValue('Alpha你');
  await page.getByRole('button', { name: m.review.undo, exact: true }).click();
  await expect(source).toHaveValue('Alpha');
  await page.getByRole('button', { name: w.redo, exact: true }).click();
  await expect(source).toHaveValue('Alpha你');
});

test('the runtime drawer holds the pool explanation and reads dictionary info only on request', async ({ page }) => {
  const { calls } = await open(page);
  await page.route('**/api/meta', route => { calls.push('/api/meta'); return route.fulfill({ json: {
    schema_version: '3.6', source_commit: 'abc123', game_version: '2.4', resource_version: null, changelist: null, term_count: 12, request_id: 'meta-1',
  } }); });
  await page.getByRole('button', { name: w.details, exact: true }).click();
  const drawer = page.getByRole('dialog', { name: w.drawerTitle });
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText(m.pool.noticeTitle);
  expect(calls.filter(p => p === '/api/meta')).toHaveLength(0);
  await drawer.getByRole('button', { name: m.provenance.open, exact: true }).click();
  await expect(drawer).toContainText('2.4');
  await drawer.getByRole('button', { name: w.drawerClose, exact: true }).click();
  await expect(drawer).toBeHidden();
  await expect(page.locator('.runtime-status')).toContainText('2.4');
  expect(calls.filter(p => p === '/api/meta')).toHaveLength(1);
});
