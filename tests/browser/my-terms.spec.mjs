import { test, expect } from '@playwright/test';
import { msg } from '../../lib/messages.ts';
import { parseTermbaseText, serializeTermbase } from '../../lib/termbase.ts';
import { fixture, freshApiReport } from '../fixtures/manuscript.mjs';
import { openInspectorTab } from '../helpers/editor.mjs';

// My terms (reference): a person's own term list held in page memory. It is imported and exported as a file, shown as a
// reference when the current text contains an entry, and never stored, sent or written into a manuscript.
const BASE = process.env.WUWATERM_BROWSER_URL ?? '';
const m = msg('zh');
const t = m.termbase;
const POOL = {
  status: 'available', translation_enabled: true,
  terms: { used: 0, limit: 100, remaining: 100 },
  translations: { used: 0, limit: 100, remaining: 100 },
  characters: { used: 0, limit: 10000, remaining: 10000 },
  reviews: { used: 0, limit: 60, remaining: 60 },
  reset_at: '2099-01-01T00:00:00Z',
};
// Strings that exist only in the termbase, so any copy of them elsewhere is a leak.
const CANARY_SOURCE = '专属词甲乙';
const CANARY_TARGET = 'canary-rendering-7f3a';
const CANARY_NOTE = 'canary-note-91c4';
const STAMP = '2026-11-25T00:00:00Z';
const entry = (id, source, target, over = {}) => ({ id, source, target, direction: 'en', kind: 'community_term', note: '', updated_at: STAMP, ...over });
const termbaseFile = entries => Buffer.from(serializeTermbase({ format: 'wuwaterm-termbase-v1', schema_version: 1, updated_at: STAMP, entries }));
const STARTER = [
  entry('tb-001', CANARY_SOURCE, CANARY_TARGET, { note: CANARY_NOTE }),
  entry('tb-002', '主C', 'main DPS', { kind: 'preferred_term' }),
  entry('tb-003', 'burst window', '爆发窗口', { direction: 'zh', kind: 'do_not_translate' }),
];

async function open(page) {
  const traffic = { requests: [], translations: [], reviews: [] };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/capabilities') return route.fulfill({ json: { capabilities: ['translation-context-v1'], request_id: 'synthetic' } });
    if (path === '/api/pool') return route.fulfill({ json: POOL });
    if (path === '/api/translations') {
      const body = route.request().postDataJSON();
      traffic.translations.push(body);
      return route.fulfill({ json: { kind: 'exact', text: 'Jinhsi.', direction: 'en', dictionary_miss: false, request_id: 'synthetic-translation' } });
    }
    if (path === '/api/reviews') {
      const body = route.request().postDataJSON();
      traffic.reviews.push(body);
      return route.fulfill({ json: freshApiReport(fixture(body.source, body.target, body.direction).report) });
    }
    throw new Error(`Unexpected API request: ${path}`);
  });
  await page.goto(BASE + '/');
  await expect(page.locator('.pool-strip')).toContainText('100', { timeout: 30_000 });
  await page.waitForTimeout(300);
  // From here on, count every request the page makes, whatever its URL.
  page.on('request', request => traffic.requests.push({ url: request.url(), body: request.postData() ?? '' }));
  return traffic;
}

const panel = page => page.locator('.my-terms');
const hits = page => page.locator('.my-terms-hit');
const storage = page => page.evaluate(async () => ({
  local: localStorage.length,
  session: sessionStorage.length,
  idb: typeof indexedDB?.databases === 'function' ? (await indexedDB.databases()).length : 0,
}));
async function expand(page) {
  await panel(page).getByRole('button', { name: m.workspace.lookupShow, exact: true }).click();
  await expect(page.locator('#my-terms-body')).toBeVisible();
}
const importFile = (page, buffer, name = 'terms.json') =>
  page.getByLabel(t.importAria).setInputFiles({ name, mimeType: 'application/json', buffer });
async function downloaded(page, click) {
  const waiting = page.waitForEvent('download');
  await click();
  const stream = await (await waiting).createReadStream();
  const parts = [];
  for await (const chunk of stream) parts.push(chunk);
  return Buffer.concat(parts).toString('utf-8');
}

test('import, add, edit and delete entries; a match is labelled as the user’s own reference; export is a valid termbase; nothing leaves the page or is stored', async ({ page }) => {
  const traffic = await open(page);
  const cookiesBefore = await page.evaluate(() => document.cookie);
  await expect(panel(page).getByTestId('my-terms-counts')).toHaveText(t.entryCount.replace('{n}', '0'));
  await expand(page);
  await expect(page.locator('#my-terms-body')).toContainText(t.memoryNote);
  await expect(page.locator('#my-terms-body')).toContainText(t.listEmpty);

  await importFile(page, termbaseFile(STARTER));
  await expect(page.locator('.my-terms-feedback')).toHaveText(t.notices.imported.replace('{n}', '3'));
  await expect(panel(page).getByTestId('my-terms-counts')).toContainText(t.entryCount.replace('{n}', '3'));

  // Chinese source: the two zh→en entries are read, the English one is not.
  await page.locator('#review-source').fill(`今天${CANARY_SOURCE}和主C一起上场，主C很强。`);
  await expect(hits(page)).toHaveCount(2);
  await expect(hits(page).first()).toContainText(CANARY_SOURCE);
  await expect(hits(page).first()).toContainText(CANARY_TARGET);
  await expect(hits(page).first()).toContainText(CANARY_NOTE);
  await expect(hits(page).nth(1)).toContainText(t.hitOccurrences.replace('{n}', '2'));
  for (const badge of await page.locator('.my-terms-badge').all()) await expect(badge).toHaveText(t.hitBadge);
  await expect(page.locator('.my-terms-badge').first()).toContainText('非官方词典');
  await expect(page.locator('.my-terms-badge').first()).toContainText('不参与机器翻译或术语锁定');
  await expect(panel(page).getByTestId('my-terms-counts')).toContainText(t.hitCount.replace('{n}', '2'));

  // English source: the automatic direction follows the text, so the zh entry is read instead.
  await page.locator('#review-source').fill('Save the Burst Window for later.');
  await expect(hits(page)).toHaveCount(1);
  await expect(hits(page).first()).toContainText('burst window');
  await expect(hits(page).first()).toContainText(t.kinds.do_not_translate);
  await page.locator('#review-source').fill(`那一刻 很强 ${CANARY_SOURCE}`);

  // Add: the new entry matches at once and takes the next free id.
  await panel(page).getByLabel(t.fieldSource, { exact: true }).fill(' 很强 ');
  await panel(page).getByLabel(t.fieldTarget, { exact: true }).fill('very strong');
  await panel(page).getByLabel(t.fieldKind, { exact: true }).selectOption('preferred_term');
  await panel(page).getByRole('button', { name: t.add, exact: true }).click();
  await expect(page.locator('.my-terms-feedback')).toHaveText(t.notices.added);
  await expect(hits(page)).toHaveCount(2);
  await expect(panel(page).getByLabel(t.fieldSource, { exact: true })).toHaveValue('');

  // Edit it in place.
  await panel(page).locator('.my-terms-list li', { hasText: '很强' }).getByRole('button', { name: new RegExp(`^${t.edit}`) }).click();
  await expect(page.locator('#my-terms-form-title')).toContainText('tb-004');
  await expect(panel(page).getByLabel(t.fieldSource, { exact: true })).toHaveValue('很强');
  await panel(page).getByLabel(t.fieldTarget, { exact: true }).fill('really strong');
  await panel(page).getByRole('button', { name: t.update, exact: true }).click();
  await expect(page.locator('.my-terms-feedback')).toHaveText(t.notices.updated);
  await expect(hits(page).filter({ hasText: 'really strong' })).toHaveCount(1);
  await expect(page.locator('.my-terms-list li')).toHaveCount(4);

  // A field problem is explained and nothing is saved.
  await panel(page).getByLabel(t.fieldSource, { exact: true }).fill('只有原文');
  await panel(page).getByRole('button', { name: t.add, exact: true }).click();
  await expect(page.locator('.my-terms-feedback')).toHaveText(t.errors.fieldRequired.replace('{field}', t.fieldTarget));
  await expect(page.locator('.my-terms-list li')).toHaveCount(4);
  await panel(page).getByLabel(t.fieldSource, { exact: true }).fill('');

  // Delete.
  await panel(page).locator('.my-terms-list li', { hasText: '很强' }).getByRole('button', { name: new RegExp(`^${t.remove}`) }).click();
  await expect(page.locator('.my-terms-feedback')).toHaveText(t.notices.removed);
  await expect(page.locator('.my-terms-list li')).toHaveCount(3);

  // Export: the file is the canonical termbase of what the page holds.
  const text = await downloaded(page, () => panel(page).getByRole('button', { name: t.exportButton, exact: true }).click());
  const exported = parseTermbaseText(text);
  expect(exported.entries.map(e => e.id)).toEqual(['tb-001', 'tb-002', 'tb-003']);
  expect(exported.entries[0]).toMatchObject({ source: CANARY_SOURCE, target: CANARY_TARGET, note: CANARY_NOTE, direction: 'en', kind: 'community_term' });
  expect(serializeTermbase(exported)).toBe(text);
  await expect(page.locator('.my-terms-feedback')).toHaveText(t.notices.exported.replace('{n}', '3'));

  // Nothing was requested, stored or set as a cookie by any of this.
  expect(traffic.requests).toEqual([]);
  expect(await storage(page)).toEqual({ local: 0, session: 0, idb: 0 });
  expect(await page.evaluate(() => document.cookie)).toBe(cookiesBefore);
});

test('a refused import changes nothing and says why; replacing a non-empty list asks first; a reload empties the list', async ({ page }) => {
  const traffic = await open(page);
  await expand(page);
  await importFile(page, termbaseFile(STARTER));
  await expect(page.locator('.my-terms-list li')).toHaveCount(3);

  const duplicate = Buffer.from(`{"format":"wuwaterm-termbase-v1","format":"wuwaterm-termbase-v1","schema_version":1,"updated_at":"${STAMP}","entries":[]}`);
  await importFile(page, duplicate);
  await expect(page.locator('.my-terms-feedback')).toContainText(t.errors.termbase_duplicate_key);
  await expect(page.locator('.my-terms-feedback')).toContainText(t.errors.importFailed);
  await expect(page.locator('.my-terms-list li')).toHaveCount(3);

  await importFile(page, Buffer.from('{"__proto__":{"polluted":true}}'));
  await expect(page.locator('.my-terms-feedback')).toContainText(t.errors.termbase_forbidden_key);
  await importFile(page, Buffer.from(`{"format":"wuwaterm-termbase-v1","schema_version":1,"updated_at":"${STAMP}","entries":[{"id":"a","source":"x","target":"y","direction":"en","kind":"community_term","note":"a\\u0000b","updated_at":"${STAMP}"}]}`));
  await expect(page.locator('.my-terms-feedback')).toContainText(t.errors.termbase_nul);
  await importFile(page, Buffer.alloc(1_048_577, 0x20));
  await expect(page.locator('.my-terms-feedback')).toContainText(t.errors.termbase_too_large);
  await expect(page.locator('.my-terms-list li')).toHaveCount(3);

  // A valid file over a non-empty list waits for the person's decision.
  await importFile(page, termbaseFile([entry('x-1', 'only one', 'single')]), 'other.json');
  await expect(page.locator('.my-terms-confirm')).toContainText(t.replacePrompt.replace('{n}', '3'));
  await expect(page.locator('.my-terms-list li')).toHaveCount(3);
  await panel(page).getByRole('button', { name: t.replaceKeep, exact: true }).click();
  await expect(page.locator('.my-terms-confirm')).toHaveCount(0);
  await expect(page.locator('.my-terms-list li')).toHaveCount(3);
  await importFile(page, termbaseFile([entry('x-1', 'only one', 'single')]), 'other.json');
  await panel(page).getByRole('button', { name: t.replaceConfirm, exact: true }).click();
  await expect(page.locator('.my-terms-list li')).toHaveCount(1);
  await expect(page.locator('.my-terms-feedback')).toHaveText(t.notices.imported.replace('{n}', '1'));

  // The page keeps the list in memory only: a reload starts empty and nothing was stored meanwhile.
  expect(await storage(page)).toEqual({ local: 0, session: 0, idb: 0 });
  expect(traffic.requests).toEqual([]);
  await page.reload();
  await expect(page.locator('.pool-strip')).toContainText('100', { timeout: 30_000 });
  await expect(panel(page).getByTestId('my-terms-counts')).toHaveText(t.entryCount.replace('{n}', '0'));
  expect(await storage(page)).toEqual({ local: 0, session: 0, idb: 0 });
});

test('with entries loaded, translation and review requests and the saved manuscript carry nothing of the termbase', async ({ page }) => {
  const traffic = await open(page);
  await expand(page);
  await importFile(page, termbaseFile(STARTER));
  const source = `今汐。${CANARY_SOURCE}`;
  await page.locator('#review-source').fill(source);
  await expect(hits(page)).toHaveCount(1);

  await page.getByRole('button', { name: m.translation.submitIdle, exact: true }).click();
  await expect(page.locator('#review-target')).toHaveValue('Jinhsi.');
  expect(traffic.translations).toEqual([{ text: source, context: {} }]);

  await page.getByRole('button', { name: m.workspace.openManuscript, exact: true }).click();
  await page.getByRole('button', { name: m.review.checkIdle, exact: true }).click();
  await expect(page.locator('.review-current')).toHaveText(m.review.summaryCurrent);
  expect(traffic.reviews).toHaveLength(1);
  // The termbase hit stays in the Terms & glossary inspector tab apart from the official review.
  await expect(page.locator('.term-track')).not.toContainText(CANARY_TARGET);
  await openInspectorTab(page, 'terms');
  await expect(hits(page)).toHaveCount(1);

  // Every request the page made after load, in full: not one carries a termbase string or field.
  const wire = JSON.stringify(traffic.requests);
  expect(traffic.requests.length).toBeGreaterThan(0);
  for (const secret of [CANARY_TARGET, CANARY_NOTE, 'termbase', 'user_glossary', 'tb-001']) expect(wire).not.toContain(secret);
  for (const secret of [CANARY_TARGET, CANARY_NOTE, 'termbase', 'user_glossary']) {
    expect(JSON.stringify(traffic.translations)).not.toContain(secret);
    expect(JSON.stringify(traffic.reviews)).not.toContain(secret);
  }

  // The manuscript file the page saves is the manuscript alone.
  const saved = await downloaded(page, () => page.getByRole('button', { name: m.review.save, exact: true }).click());
  expect(JSON.parse(saved).format).toMatch(/^wuwaterm-manuscript-v\d$/);
  for (const secret of [CANARY_TARGET, CANARY_NOTE, 'termbase', 'user_glossary', 'tb-001']) expect(saved).not.toContain(secret);
  expect(await storage(page)).toEqual({ local: 0, session: 0, idb: 0 });
});

for (const viewport of [{ width: 1440, height: 900, label: '1440px' }, { width: 390, height: 844, label: '390px' }]) {
  for (const scheme of ['light', 'dark']) {
    test.describe(`my terms at ${viewport.label}, ${scheme}`, () => {
      test.use({ viewport: { width: viewport.width, height: viewport.height }, colorScheme: scheme });

      test('the open panel has no horizontal overflow in either mode, and its text stays readable', async ({ page }) => {
        await open(page);
        await expand(page);
        const long = entry('tb-009', 'a-very-long-source-surface-without-any-break-opportunities-'.repeat(2), 'an-equally-long-target-rendering-without-breaks-'.repeat(3), { note: 'n'.repeat(160) });
        await importFile(page, termbaseFile([...STARTER, long]));
        await page.locator('#review-source').fill(`${CANARY_SOURCE} ${long.source}`);
        await expect(hits(page)).toHaveCount(2);
        for (const label of ['quick', 'manuscript']) {
          if (label === 'manuscript') {
            await page.getByRole('button', { name: m.workspace.modeManuscript, exact: true }).click();
            await openInspectorTab(page, 'terms');
            if (!(await page.locator('#my-terms-body').isVisible())) await expand(page);
          }
          const geometry = await page.evaluate(() => {
            const box = document.querySelector('.my-terms').getBoundingClientRect();
            const root = document.documentElement;
            return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, left: box.left, right: box.right };
          });
          expect(geometry.scrollWidth, label).toBeLessThanOrEqual(geometry.clientWidth);
          expect(geometry.left, label).toBeGreaterThanOrEqual(0);
          expect(geometry.right, label).toBeLessThanOrEqual(geometry.clientWidth);
          const badge = await page.locator('.my-terms-badge').first().evaluate(node => {
            const style = getComputedStyle(node);
            return { color: style.color, background: getComputedStyle(document.body).backgroundColor };
          });
          expect(badge.color).not.toBe(badge.background);
        }
      });
    });
  }
}
