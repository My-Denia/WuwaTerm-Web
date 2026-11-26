import { mkdirSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { msg } from '../../lib/messages.ts';
import {
  TM_FORMAT,
  TM_SCHEMA_VERSION,
  parseTranslationMemoryText,
  serializeTranslationMemory,
} from '../../lib/translation-memory.ts';
import { fixture, freshApiReport } from '../fixtures/manuscript.mjs';

const BASE = process.env.WUWATERM_BROWSER_URL ?? '';
const SCREENSHOT_DIR = '/tmp/wuwaterm-web-tm-verify';
const m = msg('zh');
const tmMsg = m.memory;

const POOL = {
  status: 'available',
  translation_enabled: true,
  terms: { used: 0, limit: 100, remaining: 100 },
  translations: { used: 0, limit: 100, remaining: 100 },
  characters: { used: 0, limit: 10000, remaining: 10000 },
  reviews: { used: 0, limit: 60, remaining: 60 },
  reset_at: '2099-01-01T00:00:00Z',
};

const STAMP = '2026-11-27T00:00:00Z';
const CANARY_SOURCE = '专属记忆句甲乙 20%，持续 10 秒';
const CANARY_TARGET = 'Exclusive memory rendering +20% for 10s (canary-tm-8f2a)';
const CANARY_NOTE = 'canary-tm-note-4d9c';

const tmFileBuffer = entries => Buffer.from(serializeTranslationMemory({
  format: TM_FORMAT,
  schema_version: TM_SCHEMA_VERSION,
  exported_at: STAMP,
  entries,
}));

const makeEntry = (over = {}) => ({
  direction: 'en',
  source_text: CANARY_SOURCE,
  target_text: CANARY_TARGET,
  prev_source_hash: null,
  next_source_hash: null,
  origin: 'imported_confirmed',
  terms_db_revision: 'r14',
  game_version: '3.0',
  note: CANARY_NOTE,
  use_count: 2,
  created_at: STAMP,
  updated_at: STAMP,
  ...over,
});

async function open(page) {
  const traffic = { requests: [], translations: [], reviews: [] };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/capabilities') {
      return route.fulfill({ json: { capabilities: ['translation-context-v1'], request_id: 'synthetic' } });
    }
    if (path === '/api/pool') return route.fulfill({ json: POOL });
    if (path === '/api/translations') {
      const body = route.request().postDataJSON();
      traffic.translations.push(body);
      return route.fulfill({
        json: { kind: 'llm', text: 'Auto model output that must never enter TM.', direction: 'en', dictionary_miss: true, request_id: 'synthetic-translation' },
      });
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
  page.on('request', request => traffic.requests.push({ url: request.url(), body: request.postData() ?? '' }));
  return traffic;
}

const panel = page => page.locator('.my-memory');
const hits = page => page.locator('.my-memory-hit');
const storage = page => page.evaluate(async () => ({
  local: localStorage.length,
  session: sessionStorage.length,
  idb: typeof indexedDB?.databases === 'function' ? (await indexedDB.databases()).length : 0,
}));

async function expand(page) {
  await panel(page).getByRole('button', { name: m.workspace.lookupShow, exact: true }).click();
  await expect(page.locator('#my-memory-body')).toBeVisible();
}

const importTmFile = (page, buffer, name = 'wuwaterm-tm.json') =>
  page.getByLabel(tmMsg.importAria).setInputFiles({ name, mimeType: 'application/json', buffer });

async function downloaded(page, click) {
  const waiting = page.waitForEvent('download');
  await click();
  const stream = await (await waiting).createReadStream();
  const parts = [];
  for await (const chunk of stream) parts.push(chunk);
  return Buffer.concat(parts).toString('utf-8');
}

test('import wuwaterm-tm-v1, match badges + numeric warning, undoable apply, explicit confirm, export, and zero storage/API/manuscript leakage', async ({ page }) => {
  const traffic = await open(page);
  const cookiesBefore = await page.evaluate(() => document.cookie);
  await expect(panel(page).getByTestId('my-memory-counts')).toHaveText(tmMsg.entryCount.replace('{n}', '0'));
  await expand(page);
  await expect(page.locator('#my-memory-body')).toContainText(tmMsg.memoryNote);

  // Reject unconfirmed origin (e.g., machine_translated) cleanly.
  const badPayload = Buffer.from(JSON.stringify({
    format: TM_FORMAT,
    schema_version: TM_SCHEMA_VERSION,
    exported_at: STAMP,
    entries: [makeEntry({ origin: 'machine_translated' })],
  }), 'utf8');
  await importTmFile(page, badPayload, 'bad-tm.json');
  await expect(panel(page).locator('.my-terms-feedback')).toContainText(tmMsg.errors.tm_unconfirmed_origin);
  await expect(panel(page).getByTestId('my-memory-counts')).toHaveText(tmMsg.entryCount.replace('{n}', '0'));

  // Import valid wuwaterm-tm-v1 file.
  await importTmFile(page, tmFileBuffer([
    makeEntry(),
    makeEntry({
      source_text: '今汐。',
      target_text: 'Jinhsi (TM).',
      origin: 'human_confirmed',
      terms_db_revision: 'old-rev',
      note: '',
    }),
  ]));
  await expect(panel(page).locator('.my-terms-feedback')).toHaveText(tmMsg.notices.imported.replace('{n}', '2'));
  await expect(panel(page).getByTestId('my-memory-counts')).toContainText(tmMsg.entryCount.replace('{n}', '2'));

  // Numeric variant match shows numeric_variant badge + numeric_changed warning and NEVER silently overwrites target!
  await page.locator('#review-target').fill('Original user target text');
  await page.locator('#review-source').fill('专属记忆句甲乙 25%，持续 12 秒');
  await expect(hits(page)).toHaveCount(1);
  await expect(hits(page).first().locator('.my-memory-kind-badge')).toHaveText(tmMsg.matchKinds.numeric_variant);
  await expect(hits(page).first().locator('.my-memory-stale-badge')).toContainText(tmMsg.staleReasons.numeric_changed);
  await expect(page.locator('#review-target')).toHaveValue('Original user target text');

  // Apply suggestion -> target updates, then Undo restores exact prior target, Redo restores suggestion.
  await hits(page).first().getByRole('button', { name: tmMsg.applyButton, exact: true }).click();
  await expect(page.locator('#review-target')).toHaveValue(CANARY_TARGET);
  await page.getByRole('button', { name: m.review.undo, exact: true }).click();
  await expect(page.locator('#review-target')).toHaveValue('Original user target text');
  await page.getByRole('button', { name: m.workspace.redo, exact: true }).click();
  await expect(page.locator('#review-target')).toHaveValue(CANARY_TARGET);
  await page.getByRole('button', { name: m.review.undo, exact: true }).click();
  await expect(page.locator('#review-target')).toHaveValue('Original user target text');

  // Machine translation output is NEVER auto-stored in TM.
  await page.locator('#review-source').fill('一条新句子');
  await page.locator('#review-target').fill('');
  await page.getByRole('button', { name: m.translation.submitIdle, exact: true }).click();
  await expect(page.locator('#review-target')).toHaveValue('Auto model output that must never enter TM.');
  await expect(panel(page).getByTestId('my-memory-counts')).toContainText(tmMsg.entryCount.replace('{n}', '2'));

  // Explicit human confirm stores into page memory with origin: "human_confirmed".
  await page.locator('#review-source').fill('手工确认句');
  await page.locator('#review-target').fill('Manually confirmed translation');
  await panel(page).getByRole('button', { name: tmMsg.confirmButton, exact: true }).click();
  await expect(panel(page).locator('.my-terms-feedback')).toHaveText(tmMsg.notices.confirmedAdded);
  await expect(panel(page).getByTestId('my-memory-counts')).toContainText(tmMsg.entryCount.replace('{n}', '3'));
  await expect(hits(page)).toHaveCount(1);
  await expect(hits(page).first().locator('.my-memory-kind-badge')).toHaveText(tmMsg.matchKinds.exact);

  // Export JSON -> valid wuwaterm-tm-v1 with human_confirmed entry.
  const exportedText = await downloaded(page, () =>
    panel(page).getByRole('button', { name: tmMsg.exportButton, exact: true }).click(),
  );
  const exported = parseTranslationMemoryText(exportedText);
  expect(exported.entries).toHaveLength(3);
  const addedEntry = exported.entries.find(e => e.source_text === '手工确认句');
  expect(addedEntry).toMatchObject({
    direction: 'en',
    source_text: '手工确认句',
    target_text: 'Manually confirmed translation',
    origin: 'human_confirmed',
    use_count: 1,
  });

  // Switch to manuscript mode and save manuscript -> TM entries NEVER enter API calls or `.wuwaterm` file.
  await page.locator('#review-source').fill('今汐。');
  await page.locator('#review-target').fill('Jinhsi.');
  await page.getByRole('button', { name: m.workspace.openManuscript, exact: true }).click();
  await page.getByRole('button', { name: m.review.checkIdle, exact: true }).click();
  await expect(page.locator('.review-current')).toHaveText(m.review.summaryCurrent);

  const savedManuscript = await downloaded(page, () =>
    page.getByRole('button', { name: m.review.save, exact: true }).click(),
  );
  const wire = JSON.stringify(traffic.requests);
  for (const secret of [CANARY_TARGET, CANARY_NOTE, 'wuwaterm-tm-v1', 'human_confirmed', 'imported_confirmed']) {
    expect(wire).not.toContain(secret);
    expect(savedManuscript).not.toContain(secret);
  }

  // Browser storage and cookies remain 100% empty; reload empties in-memory TM.
  expect(await storage(page)).toEqual({ local: 0, session: 0, idb: 0 });
  expect(await page.evaluate(() => document.cookie)).toBe(cookiesBefore);

  await page.reload();
  await expect(page.locator('.pool-strip')).toContainText('100', { timeout: 30_000 });
  await expect(panel(page).getByTestId('my-memory-counts')).toHaveText(tmMsg.entryCount.replace('{n}', '0'));
  expect(await storage(page)).toEqual({ local: 0, session: 0, idb: 0 });
});

for (const viewport of [
  { width: 1440, height: 900, label: '1440px', screenshot: 'desktop-1440x900-tm-panel.png' },
  { width: 390, height: 844, label: '390px', screenshot: 'mobile-390x844-tm-panel.png' },
]) {
  test.describe(`my memory layout at ${viewport.label}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1 });

    test('open panel has zero horizontal overflow/clipping and captures viewport screenshot', async ({ page }) => {
      mkdirSync(SCREENSHOT_DIR, { recursive: true });
      await open(page);
      await expand(page);
      await importTmFile(page, tmFileBuffer([
        makeEntry(),
        makeEntry({
          source_text: '攻击力提高 20%，持续 10 秒',
          target_text: 'ATK +20% for 10s',
          origin: 'human_confirmed',
          note: '参考已确认译文',
        }),
      ]));
      await page.locator('#review-source').fill('专属记忆句甲乙 25%，持续 12 秒');
      await page.locator('#review-target').fill('Draft translation');
      await expect(hits(page)).toHaveCount(1);

      const geometry = await page.evaluate(() => {
        const box = document.querySelector('.my-memory').getBoundingClientRect();
        const root = document.documentElement;
        return {
          scrollWidth: root.scrollWidth,
          clientWidth: root.clientWidth,
          left: box.left,
          right: box.right,
        };
      });
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
      expect(geometry.left).toBeGreaterThanOrEqual(0);
      expect(geometry.right).toBeLessThanOrEqual(geometry.clientWidth);

      await page.evaluate(() => document.querySelector('.my-memory').scrollIntoView({ block: 'start' }));
      await page.screenshot({
        path: `${SCREENSHOT_DIR}/${viewport.screenshot}`,
        fullPage: false,
      });
    });
  });
}
