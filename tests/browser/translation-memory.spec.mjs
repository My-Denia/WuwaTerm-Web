import { mkdirSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { msg } from '../../lib/messages.ts';
import {
  TM_FORMAT,
  TM_SCHEMA_VERSION,
  parseTranslationMemoryText,
  serializeTranslationMemory,
} from '../../lib/translation-memory.ts';
import { fixture, freshApiReport, dictionary as fixtureDictionary } from '../fixtures/manuscript.mjs';
import { expectEditorValue, fillEditor, openInspectorTab, setEditorSelection } from '../helpers/editor.mjs';

const BASE = process.env.WUWATERM_BROWSER_URL ?? '';
const SCREENSHOT_DIR = '/tmp/wuwaterm-web-tm-freshness-verify';
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
const META = {
  schema_version: fixtureDictionary.schema_version,
  source_commit: fixtureDictionary.source_commit,
  game_version: '3.6.0',
  resource_version: 'synthetic-resource',
  changelist: null,
  term_count: fixtureDictionary.term_count,
  request_id: 'synthetic-meta',
};
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

async function open(page, options = {}) {
  const traffic = { requests: [], translations: [], reviews: [], meta: 0 };
  if (options.mockClock) {
    await page.addInitScript(startNow => {
      let currentNow = startNow;
      window.__setMockNow = value => { currentNow = value; };
      window.__advanceMockNow = delta => { currentNow += delta; };
      Date.now = () => currentNow;
    }, options.startNow ?? 1_700_000_000_000);
  }
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/capabilities') {
      return route.fulfill({ json: { capabilities: ['translation-context-v1'], request_id: 'synthetic' } });
    }
    if (path === '/api/pool') return route.fulfill({ json: POOL });
    if (path === '/api/meta') {
      traffic.meta += 1;
      if (options.metaHandler) return options.metaHandler(route, traffic);
      return route.fulfill({ json: META });
    }
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
  // Opening the panel asks once for the running service's dictionary; a later open reuses that read (shared meta quota).
  await expect.poll(() => traffic.meta).toBe(1);
  await panel(page).getByRole('button', { name: m.workspace.lookupHide, exact: true }).click();
  await expect(page.locator('#my-memory-body')).toBeHidden();
  await expand(page);
  expect(traffic.meta).toBe(1);

  // Reject invalid JSON and unconfirmed origin with importFailed (never exportFailed).
  await importTmFile(page, Buffer.from('{not json', 'utf8'), 'broken.json');
  await expect(panel(page).locator('.my-terms-feedback')).toContainText(tmMsg.errors.tm_not_json);
  await expect(panel(page).locator('.my-terms-feedback')).toContainText(tmMsg.errors.importFailed);
  await expect(panel(page).locator('.my-terms-feedback')).not.toContainText(tmMsg.errors.exportFailed);
  await expect(panel(page).getByTestId('my-memory-counts')).toHaveText(tmMsg.entryCount.replace('{n}', '0'));

  const badPayload = Buffer.from(JSON.stringify({
    format: TM_FORMAT,
    schema_version: TM_SCHEMA_VERSION,
    exported_at: STAMP,
    entries: [makeEntry({ origin: 'machine_translated' })],
  }), 'utf8');
  await importTmFile(page, badPayload, 'bad-tm.json');
  await expect(panel(page).locator('.my-terms-feedback')).toContainText(tmMsg.errors.tm_unconfirmed_origin);
  await expect(panel(page).locator('.my-terms-feedback')).toContainText(tmMsg.errors.importFailed);
  await expect(panel(page).locator('.my-terms-feedback')).not.toContainText(tmMsg.errors.exportFailed);
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

  // Numeric variant match shows numeric_variant badge + numeric_changed + provenance_unknown warning and NEVER silently overwrites target!
  await page.locator('#review-target').fill('Original user target text');
  await page.locator('#review-source').fill('专属记忆句甲乙 25%，持续 12 秒');
  await expect(hits(page)).toHaveCount(1);
  await expect(hits(page).first()).toHaveAttribute('data-freshness', 'known_stale');
  await expect(hits(page).first().locator('.my-memory-kind-badge')).toHaveText(tmMsg.matchKinds.numeric_variant);
  await expect(hits(page).first().locator('[data-stale="numeric_changed"]')).toHaveText(tmMsg.staleReasons.numeric_changed);
  await expect(hits(page).first().locator('[data-stale="provenance_unknown"]')).toHaveText(tmMsg.staleReasons.provenance_unknown);
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
  await expect(hits(page).first()).toHaveAttribute('data-freshness', 'provenance_unknown');
  await expect(hits(page).first()).toHaveAttribute('data-needs-recheck', 'true');
  await expect(hits(page).first().locator('.my-memory-kind-badge')).toHaveText(tmMsg.matchKinds.exact);
  await expect(hits(page).first().locator('[data-stale="provenance_unknown"]')).toHaveText(tmMsg.staleReasons.provenance_unknown);
  await expect(hits(page).first().locator('.my-memory-recheck-hint')).toContainText(tmMsg.staleReasons.provenance_unknown);

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

test('meta error retries after cooldown, TTL refresh drops stale verified_fresh, and lastKnown error does not grant verified_fresh', async ({ page }) => {
  let metaMode = 'fail';
  const traffic = await open(page, {
    mockClock: true,
    metaHandler: route => metaMode === 'fail'
      ? route.fulfill({ status: 502, body: 'upstream-unavailable' })
      : route.fulfill({ json: META }),
  });

  // First open fails -> meta.kind === 'error', does not immediately retry within 30s cooldown.
  await expand(page);
  await expect.poll(() => traffic.meta).toBe(1);
  await importTmFile(page, tmFileBuffer([
    makeEntry({
      source_text: '今汐。',
      target_text: 'Jinhsi (fresh candidate).',
      terms_db_revision: fixtureDictionary.revision,
      game_version: META.game_version,
    }),
  ]));
  await page.locator('#review-source').fill('今汐。');
  await page.locator('#review-target').fill('Jinhsi.');
  await page.getByRole('button', { name: m.workspace.openManuscript, exact: true }).click();
  await page.getByRole('button', { name: m.review.checkIdle, exact: true }).click();
  await expect(page.locator('.review-current')).toHaveText(m.review.summaryCurrent);

  // Even with a live review, failed /api/meta must NOT grant verified_fresh.
  await openInspectorTab(page, 'memory');
  await expect(hits(page).first()).toHaveAttribute('data-freshness', 'provenance_unknown');

  // Re-opening inside 30s cooldown skips retry.
  await panel(page).getByRole('button', { name: m.workspace.lookupHide, exact: true }).click();
  await page.evaluate(() => window.__advanceMockNow(10_000));
  await expand(page);
  expect(traffic.meta).toBe(1);

  // After 30s cooldown elapses, re-opening retries automatically and upgrades match to verified_fresh.
  metaMode = 'ok';
  await panel(page).getByRole('button', { name: m.workspace.lookupHide, exact: true }).click();
  await page.evaluate(() => window.__advanceMockNow(25_000));
  await expand(page);
  await expect.poll(() => traffic.meta).toBe(2);
  await expect(hits(page).first()).toHaveAttribute('data-freshness', 'verified_fresh');

  // After 10-minute TTL expires and re-read fails, lastKnown does NOT confer verified_fresh.
  metaMode = 'fail';
  await panel(page).getByRole('button', { name: m.workspace.lookupHide, exact: true }).click();
  await page.evaluate(() => window.__advanceMockNow(10 * 60 * 1000 + 1_000));
  await expand(page);
  await expect.poll(() => traffic.meta).toBe(3);
  await expect(hits(page).first()).toHaveAttribute('data-freshness', 'provenance_unknown');
  expect(await storage(page)).toEqual({ local: 0, session: 0, idb: 0 });
});

test('per-segment TM matching with prevSource/nextSource context_exact, per-segment confirm, and undoable single-segment apply', async ({ page }) => {
  await open(page);
  await expand(page);

  const shared = '共鸣效率提高 10%。';
  const multiSource = `第一段背景。\n\n${shared}\n\n第三段尾声。`;
  const multiTarget = 'Paragraph 1 target.\n\nOld segment 2.\n\nParagraph 3 target.';

  await importTmFile(page, tmFileBuffer([
    makeEntry({
      source_text: shared,
      target_text: 'Energy Regen +10% (wrong context).',
      prev_source_hash: null,
      next_source_hash: null,
      terms_db_revision: fixtureDictionary.revision,
      game_version: META.game_version,
      use_count: 10,
    }),
  ]));

  // Populate multi-paragraph draft; move cursor to segment 2 (index 1), confirm a segment entry with neighbours,
  // then test context_exact ranking and single-segment apply + undo.
  await page.locator('#review-source').fill(multiSource);
  await page.locator('#review-target').fill(multiTarget);
  const seg2Offset = '第一段背景。\n\n'.length + 2;
  await page.locator('#review-source').evaluate((el, pos) => {
    el.focus();
    el.setSelectionRange(pos, pos);
  }, seg2Offset);
  await page.locator('#review-source').press('ArrowRight');

  await expect(panel(page).getByTestId('my-memory-segment-scope')).toContainText(
    tmMsg.segmentScope.replace('{i}', '2').replace('{n}', '3'),
  );
  await expect(panel(page).getByRole('button', { name: tmMsg.confirmSegmentButton, exact: true })).toBeVisible();

  // Confirm segment 2 ("Old segment 2.") with its surrounding context, then export & inspect saved prev/next hashes.
  await panel(page).getByRole('button', { name: tmMsg.confirmSegmentButton, exact: true }).click();
  await expect(panel(page).locator('.my-terms-feedback')).toHaveText(tmMsg.notices.confirmedAdded);

  // Move to segment 3, then back to segment 2; confirm context_exact beats higher-use plain exact!
  await panel(page).getByRole('button', { name: tmMsg.segmentNext, exact: true }).click();
  await expect(panel(page).getByTestId('my-memory-segment-scope')).toContainText(
    tmMsg.segmentScope.replace('{i}', '3').replace('{n}', '3'),
  );
  await panel(page).getByRole('button', { name: tmMsg.segmentPrev, exact: true }).click();
  await expect(panel(page).getByTestId('my-memory-segment-scope')).toContainText(
    tmMsg.segmentScope.replace('{i}', '2').replace('{n}', '3'),
  );
  await expect(hits(page).first()).toHaveAttribute('data-match-kind', 'context_exact');

  // Edit segment 2 target temporarily, then apply plain exact suggestion ("Energy Regen +10% (wrong context).")
  // and verify ONLY segment 2 changes while segments 1 and 3 stay intact; then Undo restores exact prior target.
  await page.locator('#review-target').fill('Paragraph 1 target.\n\nDraft segment 2.\n\nParagraph 3 target.');
  await panel(page).getByRole('button', { name: tmMsg.segmentPrev, exact: true }).click();
  await expect(panel(page).getByTestId('my-memory-segment-scope')).toContainText(
    tmMsg.segmentScope.replace('{i}', '2').replace('{n}', '3'),
  );

  const exactHit = hits(page).filter({ hasText: 'Energy Regen +10% (wrong context).' });
  await exactHit.getByRole('button', { name: tmMsg.applyButton, exact: true }).click();
  await expect(page.locator('#review-target')).toHaveValue(
    'Paragraph 1 target.\n\nEnergy Regen +10% (wrong context).\n\nParagraph 3 target.',
  );

  await page.getByRole('button', { name: m.review.undo, exact: true }).click();
  await expect(page.locator('#review-target')).toHaveValue(
    'Paragraph 1 target.\n\nDraft segment 2.\n\nParagraph 3 target.',
  );
  expect(await storage(page)).toEqual({ local: 0, session: 0, idb: 0 });
});

test('skip-segment fill never overwrites later segment, multi-paragraph suggestion is rejected, CRLF caret selects right segment, and open-panel TTL expiry drops verified_fresh', async ({ page }) => {
  await page.clock.install({ time: 1_700_000_000_000 });
  await open(page);
  await expand(page);

  const src3 = '首段原文。\n\n中段原文。\n\n末段原文。';
  await importTmFile(page, tmFileBuffer([
    makeEntry({
      source_text: '末段原文。',
      target_text: 'Tres',
      terms_db_revision: fixtureDictionary.revision,
      game_version: META.game_version,
    }),
    makeEntry({
      source_text: '中段原文。',
      target_text: 'Dos',
      terms_db_revision: fixtureDictionary.revision,
      game_version: META.game_version,
    }),
    makeEntry({
      source_text: '首段原文。',
      target_text: 'Multi line A.\n\nMulti line B.',
      terms_db_revision: fixtureDictionary.revision,
      game_version: META.game_version,
    }),
  ]));

  // Start from blank target: apply segment 1 (`Uno`), skip segment 2 to fill segment 3 (`Tres`),
  // then return to segment 2 and fill `Dos` -> must produce `Uno\n\nDos\n\nTres` without overwriting `Tres`!
  await page.locator('#review-source').fill(src3);
  await page.locator('#review-target').fill('');
  await importTmFile(page, tmFileBuffer([
    makeEntry({
      source_text: '首段原文。',
      target_text: 'Uno',
      terms_db_revision: fixtureDictionary.revision,
      game_version: META.game_version,
    }),
  ]));
  await panel(page).getByRole('button', { name: tmMsg.mergeConfirm, exact: true }).click();
  await hits(page).filter({ hasText: 'Uno' }).getByRole('button', { name: tmMsg.applyButton, exact: true }).click();
  await expect(page.locator('#review-target')).toHaveValue('Uno');
  await panel(page).getByRole('button', { name: tmMsg.segmentNext, exact: true }).click();
  await panel(page).getByRole('button', { name: tmMsg.segmentNext, exact: true }).click();
  await expect(panel(page).getByTestId('my-memory-segment-scope')).toContainText(
    tmMsg.segmentScope.replace('{i}', '3').replace('{n}', '3'),
  );
  await hits(page).first().getByRole('button', { name: tmMsg.applyButton, exact: true }).click();
  await expect(page.locator('#review-target')).toHaveValue('Uno\n\nTres');

  await panel(page).getByRole('button', { name: tmMsg.segmentPrev, exact: true }).click();
  await expect(panel(page).getByTestId('my-memory-segment-scope')).toContainText(
    tmMsg.segmentScope.replace('{i}', '2').replace('{n}', '3'),
  );
  // Confirm button must stay disabled because segment 2 has target: null (never borrows `Tres`!).
  await expect(panel(page).getByRole('button', { name: tmMsg.confirmSegmentButton, exact: true })).toBeDisabled();
  await hits(page).first().getByRole('button', { name: tmMsg.applyButton, exact: true }).click();
  await expect(page.locator('#review-target')).toHaveValue('Uno\n\nDos\n\nTres');

  // Verify live TTL expiry while panel remains open (no collapse/reopen) + live re-check on confirm:
  await page.getByRole('button', { name: m.workspace.openManuscript, exact: true }).click();
  await page.getByRole('button', { name: m.review.checkIdle, exact: true }).click();
  await expect(page.locator('.review-current')).toHaveText(m.review.summaryCurrent);

  // Move to segment 1 (`首段原文。`): verified_fresh before TTL; applying multi-paragraph suggestion
  // without explicit multi-paragraph protection is refused when alignments are cleared.
  await openInspectorTab(page, 'memory');
  await panel(page).getByRole('button', { name: tmMsg.segmentPrev, exact: true }).click();
  await expect(hits(page).first()).toHaveAttribute('data-freshness', 'verified_fresh');

  // Fast-forward past 10-minute TTL while panel stays open -> badge immediately degrades to provenance_unknown.
  await page.clock.fastForward(10 * 60 * 1000 + 50);
  await expect(hits(page).first()).toHaveAttribute('data-freshness', 'provenance_unknown');

  // Confirming segment 1 after TTL expiry must write BOTH terms_db_revision: null AND game_version: null (P1-02!).
  await panel(page).getByRole('button', { name: tmMsg.confirmSegmentButton, exact: true }).click();
  const exportedAfterTtl = await downloaded(page, () =>
    panel(page).getByRole('button', { name: tmMsg.exportButton, exact: true }).click(),
  );
  const parsedAfterTtl = parseTranslationMemoryText(exportedAfterTtl);
  const confirmedSeg1 = parsedAfterTtl.entries.find(
    e => e.source_text === '首段原文。' && e.target_text === 'Uno' && e.origin === 'human_confirmed',
  );
  expect(confirmedSeg1?.terms_db_revision).toBeNull();
  expect(confirmedSeg1?.game_version).toBeNull();

  // Multi-paragraph TM suggestion rejected when alignments are cleared (no explicit alignments).
  await page.locator('.alignment-panel summary').click();
  await page.getByRole('button', { name: m.review.alignmentReset, exact: true }).click();
  await expect(hits(page).filter({ hasText: 'Multi line A.' })).toHaveCount(1);
  await hits(page).filter({ hasText: 'Multi line A.' }).getByRole('button', { name: tmMsg.applyButton, exact: true }).click();
  await expect(panel(page).locator('.my-terms-feedback')).toHaveText(tmMsg.errors.multiParagraphSuggestion);
  await expectEditorValue(page, '#review-target', 'Uno\n\nDos\n\nTres');

  // Import a CRLF `.txt` manuscript (`第一段CRLF。\r\n\r\n第二段CRLF。`) and click at DOM offset of second paragraph:
  // DOM normalized selectionStart (`5`) must map back to raw CRLF offset (`7`) and select segment 2 / 2!
  await page.getByLabel(m.review.importFileAria).setInputFiles({
    name: 'crlf.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('第一段CRLF。\r\n\r\n第二段CRLF。', 'utf8'),
  });
  await page.getByRole('button', { name: m.review.importReplaceConfirm, exact: true }).click();
  await expect(panel(page).getByTestId('my-memory-segment-scope')).toContainText(
    tmMsg.segmentScope.replace('{i}', '1').replace('{n}', '2'),
  );
  const domSeg2Start = '第一段CRLF。\n\n'.length;
  await setEditorSelection(page, '#review-source', domSeg2Start, domSeg2Start);
  await expect(panel(page).getByTestId('my-memory-segment-scope')).toContainText(
    tmMsg.segmentScope.replace('{i}', '2').replace('{n}', '2'),
  );
  expect(await storage(page)).toEqual({ local: 0, session: 0, idb: 0 });
});

test('three-state freshness badges after term check and merge 8 MiB overflow protection', async ({ page }) => {
  await open(page);
  await expand(page);

  await importTmFile(page, tmFileBuffer([
    makeEntry({
      source_text: '今汐。',
      target_text: 'Jinhsi (verified).',
      terms_db_revision: fixtureDictionary.revision,
      game_version: META.game_version,
    }),
    makeEntry({
      source_text: '声骸。',
      target_text: 'Echo (stale).',
      terms_db_revision: 'old-rev',
      game_version: null,
    }),
  ]));

  // Before term check, currentTermsDbRevision is null -> provenance_unknown.
  await page.locator('#review-source').fill('今汐。');
  await expect(hits(page)).toHaveCount(1);
  await expect(hits(page).first()).toHaveAttribute('data-freshness', 'provenance_unknown');
  await expect(hits(page).first().locator('[data-stale="provenance_unknown"]')).toHaveText(tmMsg.staleReasons.provenance_unknown);

  // Run term check so currentTermsDbRevision becomes fixtureDictionary.revision.
  await page.locator('#review-target').fill('Jinhsi.');
  await page.getByRole('button', { name: m.workspace.openManuscript, exact: true }).click();
  await page.getByRole('button', { name: m.review.checkIdle, exact: true }).click();
  await expect(page.locator('.review-current')).toHaveText(m.review.summaryCurrent);

  // Matching revision and game version -> verified_fresh with zero stale badges.
  await openInspectorTab(page, 'memory');
  await expect(hits(page).first()).toHaveAttribute('data-freshness', 'verified_fresh');
  await expect(hits(page).first()).toHaveAttribute('data-needs-recheck', 'false');
  await expect(hits(page).first().locator('.my-memory-stale-badge')).toHaveCount(0);

  // Mismatched revision -> known_stale with terms_revision_changed badge.
  await fillEditor(page, '#review-source', '声骸。');
  await expect(hits(page)).toHaveCount(1);
  await expect(hits(page).first()).toHaveAttribute('data-freshness', 'known_stale');
  await expect(hits(page).first()).toHaveAttribute('data-needs-recheck', 'true');
  await expect(hits(page).first().locator('[data-stale="terms_revision_changed"]')).toHaveText(tmMsg.staleReasons.terms_revision_changed);

  // Merge > 8 MiB guard keeps existing entries intact and shows tm_too_large error.
  const mkChunk = (prefix, count) => tmFileBuffer(
    Array.from({ length: count }, (_, i) => makeEntry({
      source_text: `${prefix}-${i}-` + 'x'.repeat(1800),
      target_text: `${prefix}-${i}-` + 'y'.repeat(1800),
      note: '',
    })),
  );
  await importTmFile(page, mkChunk('part-a', 1200), 'part-a.json');
  await panel(page).getByRole('button', { name: tmMsg.replaceConfirm, exact: true }).click();
  await expect(panel(page).getByTestId('my-memory-counts')).toContainText(tmMsg.entryCount.replace('{n}', '1200'));

  await importTmFile(page, mkChunk('part-b', 1200), 'part-b.json');
  await panel(page).getByRole('button', { name: tmMsg.mergeConfirm, exact: true }).click();
  await expect(panel(page).locator('.my-terms-feedback')).toContainText(tmMsg.errors.tm_too_large);
  await expect(panel(page).getByTestId('my-memory-counts')).toContainText(tmMsg.entryCount.replace('{n}', '1200'));
});

test('gap-occupied handwritten draft blocks skip-fill, aligned extra paragraphs suppress false warning, and Apply rechecks live TTL at click time', async ({ page }) => {
  const traffic = await open(page, { mockClock: true, startNow: 1_700_000_000_000 });
  await expand(page);

  await importTmFile(page, tmFileBuffer([
    makeEntry({
      source_text: '首段原文。',
      target_text: 'Uno (TM)',
      terms_db_revision: fixtureDictionary.revision,
      game_version: META.game_version,
    }),
    makeEntry({
      source_text: '中段原文。',
      target_text: 'Dos (TM)',
      terms_db_revision: fixtureDictionary.revision,
      game_version: META.game_version,
    }),
    makeEntry({
      source_text: '末段原文。',
      target_text: 'Tres (TM)',
      terms_db_revision: fixtureDictionary.revision,
      game_version: META.game_version,
    }),
  ]));

  const src3 = '首段原文。\n\n中段原文。\n\n末段原文。';
  await page.locator('#review-source').fill(src3);
  await page.locator('#review-target').fill('');
  // Apply segment 1 (`Uno (TM)`) from blank target to establish explicit [Uno (TM), null, null] alignments,
  // then skip to segment 3 and apply `Tres (TM)` -> [Uno (TM), null, Tres (TM)].
  await hits(page).first().getByRole('button', { name: tmMsg.applyButton, exact: true }).click();
  await expect(page.locator('#review-target')).toHaveValue('Uno (TM)');
  await page.getByRole('button', { name: m.workspace.openManuscript, exact: true }).click();
  await page.getByRole('button', { name: m.review.checkIdle, exact: true }).click();
  await expect(page.locator('.review-current')).toHaveText(m.review.summaryCurrent);

  await openInspectorTab(page, 'memory');
  await panel(page).getByRole('button', { name: tmMsg.segmentNext, exact: true }).click();
  await panel(page).getByRole('button', { name: tmMsg.segmentNext, exact: true }).click();
  await hits(page).first().getByRole('button', { name: tmMsg.applyButton, exact: true }).click();
  await expectEditorValue(page, '#review-target', 'Uno (TM)\n\nTres (TM)');

  // Manually type handwritten text into the unaligned middle gap in target, keeping segment 2 aligned as null.
  await fillEditor(page, '#review-target', 'Uno (TM)\n\nDos manual draft\n\nTres (TM)');
  // Clicking directly inside handwritten `Dos manual draft` must NOT fall back to segment 1 (`Uno (TM)`);
  // segment label reports unmapped caret (NOT `当前第 1 / 3 段`), displays unaligned hint, and disables Apply & Confirm!
  const unalignedTargetCaret = 'Uno (TM)\n\nDos '.length;
  await setEditorSelection(page, '#review-target', unalignedTargetCaret, unalignedTargetCaret);
  await expect(panel(page).getByTestId('my-memory-segment-scope')).toHaveAttribute('data-target-unaligned', 'true');
  await expect(panel(page).locator('.my-memory-segment-label')).toHaveText(
    tmMsg.segmentScopeUnaligned.replace('{n}', '3'),
  );
  await expect(panel(page).getByTestId('my-memory-alignment-hint')).toHaveText(tmMsg.segmentTargetCursorUnalignedHint);
  await expect(panel(page).getByRole('button', { name: tmMsg.confirmSegmentButton, exact: true })).toBeDisabled();
  await expect(hits(page).first().getByRole('button', { name: tmMsg.applyButton, exact: true })).toBeDisabled();
  await expectEditorValue(page, '#review-target', 'Uno (TM)\n\nDos manual draft\n\nTres (TM)');

  await panel(page).getByRole('button', { name: tmMsg.segmentNext, exact: true }).click();
  await expect(panel(page).getByTestId('my-memory-segment-scope')).toHaveAttribute('data-target-unaligned', 'false');
  await expect(panel(page).locator('.my-memory-segment-label')).toHaveText(
    tmMsg.segmentScope.replace('{i}', '2').replace('{n}', '3'),
  );
  await expect(panel(page).getByTestId('my-memory-alignment-hint')).toHaveText(tmMsg.segmentGapOccupiedHint);
  await expect(hits(page).first().getByRole('button', { name: tmMsg.applyButton, exact: true })).toBeEnabled();
  await hits(page).first().getByRole('button', { name: tmMsg.applyButton, exact: true }).click();
  await expect(panel(page).locator('.my-terms-feedback')).toHaveText(tmMsg.errors.targetGapOccupied);
  await expectEditorValue(page, '#review-target', 'Uno (TM)\n\nDos manual draft\n\nTres (TM)');

  // Even when a segment's aligned target spans multiple paragraphs (targetSegmentTotal > sourceSegmentTotal),
  // clear explicit alignment suppresses the false segmentUnalignedHint banner!
  await fillEditor(page, '#review-source', '首段原文。\n\n末段原文。');
  await fillEditor(page, '#review-target', 'One A.\n\nOne B.\n\nTres (TM)');
  await page.locator('.alignment-panel summary').click();
  await page.getByRole('button', { name: m.review.alignmentReset, exact: true }).click();
  // After clearing alignments on unaligned 3-para target vs 2-para source, warning banner shows;
  await expect(panel(page).getByTestId('my-memory-alignment-hint')).toBeVisible();
  // Pair paragraph 1 (`首段原文。`) to multi-paragraph `One A.\n\nOne B.` and paragraph 2 to `Tres (TM)`:
  const selectSourceSpan = (text, needle) => {
    const start = text.indexOf(needle);
    return { start, end: start + needle.length };
  };
  const s1Span = selectSourceSpan('首段原文。\n\n末段原文。', '首段原文。');
  await setEditorSelection(page, '#review-source', s1Span.start, s1Span.end);
  const t1Span = selectSourceSpan('One A.\n\nOne B.\n\nTres (TM)', 'One A.\n\nOne B.');
  await setEditorSelection(page, '#review-target', t1Span.start, t1Span.end);
  await page.getByRole('button', { name: m.review.alignmentConfirm, exact: true }).click();
  const s2Span = selectSourceSpan('首段原文。\n\n末段原文。', '末段原文。');
  await setEditorSelection(page, '#review-source', s2Span.start, s2Span.end);
  const t2Span = selectSourceSpan('One A.\n\nOne B.\n\nTres (TM)', 'Tres (TM)');
  await setEditorSelection(page, '#review-target', t2Span.start, t2Span.end);
  await page.getByRole('button', { name: m.review.alignmentConfirm, exact: true }).click();
  await expect(panel(page).getByTestId('my-memory-alignment-hint')).toHaveCount(0);

  // Move to segment 1, advance Date.now() past 10m TTL without firing setTimeout, then click Apply immediately:
  // Apply must recompute live basis at click time, show the recheck notice, and degrade the hit badge!
  await page.getByRole('button', { name: m.review.checkIdle, exact: true }).click();
  await openInspectorTab(page, 'review');
  await expect(page.locator('.review-current')).toHaveText(m.review.summaryCurrent);
  await openInspectorTab(page, 'memory');
  await panel(page).getByRole('button', { name: tmMsg.segmentPrev, exact: true }).click();
  await expect(hits(page).first()).toHaveAttribute('data-freshness', 'verified_fresh');
  await page.evaluate(() => window.__advanceMockNow(10 * 60 * 1000 + 50));
  await hits(page).first().getByRole('button', { name: tmMsg.applyButton, exact: true }).click();
  await expect(panel(page).locator('.my-terms-feedback')).toHaveText(
    tmMsg.notices.appliedSegmentRecheck.replace('{i}', '1').replace('{n}', '2'),
  );
  await expect(hits(page).first()).toHaveAttribute('data-freshness', 'provenance_unknown');

  // Clearing/removing every alignment row leaves `draft.alignments` as empty `[]` (instead of null);
  // 1) Skip-fill past empty segments must be refused without rewriting `[]` to auto-generated alignments;
  // 2) Sequential replace/apply keeps `alignments: []` intact so backend review-v2 keeps receiving `alignments: []`.
  await page.getByRole('button', { name: m.review.alignmentClear, exact: true }).click();
  await fillEditor(page, '#review-source', '首段原文。\n\n中段原文。\n\n末段原文。');
  await fillEditor(page, '#review-target', 'Uno');
  await panel(page).getByRole('button', { name: tmMsg.segmentNext, exact: true }).click();
  await panel(page).getByRole('button', { name: tmMsg.segmentNext, exact: true }).click();
  await expect(panel(page).getByTestId('my-memory-alignment-hint')).toHaveText(tmMsg.segmentClearedSkipHint);
  await hits(page).first().getByRole('button', { name: tmMsg.applyButton, exact: true }).click();
  await expect(panel(page).locator('.my-terms-feedback')).toHaveText(tmMsg.errors.clearedAlignmentsSkip);
  await expectEditorValue(page, '#review-target', 'Uno');

  await fillEditor(page, '#review-source', '首段原文。');
  await fillEditor(page, '#review-target', 'Draft with empty alignments');
  await expect(panel(page).getByRole('button', { name: tmMsg.confirmButton, exact: true })).toBeEnabled();
  await hits(page).first().getByRole('button', { name: tmMsg.applyButton, exact: true }).click();
  await expectEditorValue(page, '#review-target', 'Uno (TM)');
  await page.getByRole('button', { name: m.review.checkIdle, exact: true }).click();
  await openInspectorTab(page, 'review');
  await expect(page.locator('.review-current')).toHaveText(m.review.summaryCurrent);
  expect(traffic.reviews.at(-1)?.alignments).toEqual([]);
});

for (const viewport of [
  { width: 1440, height: 900, label: '1440px', screenshot: 'desktop_1440x900_tm_freshness.png' },
  { width: 390, height: 844, label: '390px', screenshot: 'mobile_390x844_tm_freshness.png' },
]) {
  test.describe(`my memory layout at ${viewport.label}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1 });

    test('open panel has zero horizontal overflow/clipping and captures viewport screenshot', async ({ page }) => {
      mkdirSync(SCREENSHOT_DIR, { recursive: true });
      await open(page);
      await expand(page);
      await importTmFile(page, tmFileBuffer([
        makeEntry({
          source_text: '今汐。',
          target_text: 'Jinhsi.',
          origin: 'human_confirmed',
          terms_db_revision: fixtureDictionary.revision,
          game_version: META.game_version,
          note: '已核对当前词库版本',
          use_count: 5,
        }),
        makeEntry({
          source_text: '今汐。',
          target_text: 'Jinhsi (unverified origin).',
          origin: 'imported_confirmed',
          terms_db_revision: null,
          game_version: null,
          note: '旧文件导入，缺少词库版本',
          use_count: 3,
        }),
        makeEntry({
          source_text: '今汐。',
          target_text: 'Jinxi (old revision).',
          origin: 'imported_confirmed',
          terms_db_revision: 'old-terms-r10',
          game_version: null,
          note: '旧版词库译法，需重新核对',
          use_count: 2,
        }),
      ]));
      await page.locator('#review-source').fill('今汐。');
      await page.locator('#review-target').fill('Jinhsi.');
      await page.getByRole('button', { name: m.workspace.openManuscript, exact: true }).click();
      await page.getByRole('button', { name: m.review.checkIdle, exact: true }).click();
      await expect(page.locator('.review-current')).toHaveText(m.review.summaryCurrent);

      await openInspectorTab(page, 'memory');
      await expect(hits(page)).toHaveCount(3);
      await expect(hits(page).nth(0)).toHaveAttribute('data-freshness', 'verified_fresh');
      await expect(hits(page).nth(1)).toHaveAttribute('data-freshness', 'provenance_unknown');
      await expect(hits(page).nth(1).locator('[data-stale="provenance_unknown"]')).toHaveText(tmMsg.staleReasons.provenance_unknown);
      await expect(hits(page).nth(2)).toHaveAttribute('data-freshness', 'known_stale');
      await expect(hits(page).nth(2).locator('[data-stale="terms_revision_changed"]')).toHaveText(tmMsg.staleReasons.terms_revision_changed);

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

      await page.evaluate(() => document.querySelector('.my-memory-hits').scrollIntoView({ block: 'center' }));
      await page.screenshot({
        path: `${SCREENSHOT_DIR}/${viewport.screenshot}`,
        fullPage: false,
      });
    });
  });
}

test('direct /api/dictionary identity, P1-03 partial-target guard, and batch incremental reuse with Layer 1 check + non-text receipt', async ({ page }) => {
  const dictRev = 'd9f5e4ae' + '1'.repeat(56);
  const traffic = { dictionary: 0, translations: [], structureChecks: 0 };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/capabilities') {
      return route.fulfill({
        json: { capabilities: ['dictionary-identity-v1', 'structure-check-v1', 'translation-context-v1'], request_id: 'cap-live' },
      });
    }
    if (path === '/api/pool') return route.fulfill({ json: POOL });
    if (path === '/api/dictionary') {
      traffic.dictionary += 1;
      return route.fulfill({
        json: {
          revision: dictRev,
          schema_version: '2',
          source_commit: '9ddee819',
          game_version: '3.7.0',
          term_count: 12097,
          request_id: 'dict-live',
        },
      });
    }
    if (path === '/api/structure-checks') {
      traffic.structureChecks += 1;
      const body = route.request().postDataJSON();
      return route.fulfill({
        json: {
          request_id: 'sc-live',
          check_version: 'structure-check-v1',
          checks: ['empty_target', 'numbers', 'placeholders', 'paragraphs'],
          segments: body.segments.map((seg, index) => ({
            index,
            segment_id: seg.segment_id,
            findings: [],
            omitted_findings: 0,
            layout: { source_paragraphs: 1, target_paragraphs: 1, source_lines: 1, target_lines: 1 },
          })),
        },
      });
    }
    if (path === '/api/translations') {
      const body = route.request().postDataJSON();
      traffic.translations.push(body);
      return route.fulfill({
        json: { kind: 'llm', text: 'Edited Para 3 translated.', direction: 'en', dictionary_miss: false, request_id: 'tr-live' },
      });
    }
    throw new Error(`Unexpected API request: ${path}`);
  });

  await page.goto(BASE + '/');
  await expect(page.locator('.pool-strip')).toContainText('100', { timeout: 30_000 });
  await expand(page);
  await expect.poll(() => traffic.dictionary).toBe(1);
  await expect(panel(page).getByTestId('my-memory-dictionary-status')).toHaveAttribute('data-dict-state', 'verified');
  await expect(panel(page).getByTestId('my-memory-dictionary-status')).toContainText('d9f5e4ae1111');

  // Confirm 3 segments against live /api/dictionary (NO /api/reviews needed!).
  const s1 = '首段：今汐共鸣效率提高 10%。';
  const s2 = '中段：暴击率提高 20%。';
  const s3 = '末段：攻击力提高 30%。';
  await page.getByRole('button', { name: m.workspace.openManuscript, exact: true }).click();
  await fillEditor(page, '#review-source', `${s1}\n\n${s2}\n\n${s3}`);
  await fillEditor(page, '#review-target', 'First: Jinhsi Energy Regen +10%.\n\nMiddle: CRIT Rate +20%.\n\nLast: ATK +30%.');
  // Move caret to segment 1 so we confirm segments 1, 2, 3 in order.
  await setEditorSelection(page, '#review-source', 0, 0);
  await openInspectorTab(page, 'memory');
  await expect(panel(page).getByTestId('my-memory-segment-scope')).toContainText(
    tmMsg.segmentScope.replace('{i}', '1').replace('{n}', '3'),
  );

  for (let i = 0; i < 3; i += 1) {
    await panel(page).getByRole('button', { name: tmMsg.confirmSegmentButton, exact: true }).click();
    if (i < 2) await panel(page).getByRole('button', { name: tmMsg.segmentNext, exact: true }).click();
  }
  await expect(panel(page).getByTestId('my-memory-counts')).toContainText(tmMsg.entryCount.replace('{n}', '3'));

  // Verify P1-03 guard on partial target A'/C' vs A/B/C: refuses overwrite and disables Confirm!
  await fillEditor(page, '#review-target', "First: Jinhsi Energy Regen +10%.\n\nLast: ATK +30%.");
  await panel(page).getByRole('button', { name: tmMsg.segmentPrev, exact: true }).click();
  await expect(panel(page).getByTestId('my-memory-alignment-hint')).toHaveAttribute('data-alignment-status', 'target_fewer_paragraphs');
  await expect(panel(page).getByRole('button', { name: tmMsg.confirmSegmentButton, exact: true })).toBeDisabled();
  await hits(page).first().getByRole('button', { name: tmMsg.applyButton, exact: true }).click();
  await expect(panel(page).locator('.my-terms-feedback')).toContainText('少于原文');
  await expectEditorValue(page, '#review-target', "First: Jinhsi Energy Regen +10%.\n\nLast: ATK +30%.");

  // Now clear target and run incremental translation on identical 3-paragraph source:
  // all 3 segments reuse from verified TM with 0 /api/translations calls, 1 Layer 1 structure check, and non-text receipt!
  await fillEditor(page, '#review-target', '');
  await page.getByRole('button', { name: m.review.translateIdle, exact: true }).click();
  await expectEditorValue(
    page,
    '#review-target',
    'First: Jinhsi Energy Regen +10%.\n\nMiddle: CRIT Rate +20%.\n\nLast: ATK +30%.',
  );
  expect(traffic.translations).toHaveLength(0);
  expect(traffic.structureChecks).toBe(1);
  await openInspectorTab(page, 'review');
  const receipt = page.getByTestId('tm-run-receipt');
  await expect(receipt).toBeVisible();
  await expect(receipt).toHaveAttribute('data-reused', '3');
  await expect(receipt).toHaveAttribute('data-model-calls', '0');
  await expect(receipt).toHaveAttribute('data-structure-status', 'passed');
  const receiptText = await receipt.innerText();
  expect(receiptText).not.toContain('今汐');
  expect(receiptText).not.toContain('Jinhsi');
  expect(await storage(page)).toEqual({ local: 0, session: 0, idb: 0 });
});
