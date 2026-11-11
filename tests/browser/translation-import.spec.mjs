import { test, expect } from '@playwright/test';

// TranslationWorkbench source-file import: a read that resolves after the user
// has moved on must lose to the newer edit, term insert, query move or
// translation. File.arrayBuffer is delayed/rejected at the browser boundary;
// the component state and generation guard are the code under test, not mocked.
const BASE = process.env.WUWATERM_BROWSER_URL ?? '';
const NEW = { source: '今汐。', target: 'Jinhsi.' };
const NEXT = { source: '声骸。', target: 'Echo.' };
const STALE = '迟到文件原文。';

const POOL = {
  status: 'available',
  translation_enabled: true,
  terms: { used: 0, limit: 100, remaining: 100 },
  translations: { used: 0, limit: 100, remaining: 100 },
  characters: { used: 0, limit: 10000, remaining: 10000 },
  reviews: { used: 0, limit: 60, remaining: 60 },
  reset_at: '2099-01-01T00:00:00Z',
};
const MATCH = { zh: '今汐', en: 'Jinhsi', category: 'character', reason: 'exact', score: 100 };

async function open(page) {
  const translations = [];
  const held = [];
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === '/api/capabilities') return route.fulfill({ json: { capabilities: [], request_id: 'synthetic' } });
    if (path === '/api/pool') return route.fulfill({ json: POOL });
    if (path === '/api/terms') {
      const query = url.searchParams.get('q') ?? '';
      return route.fulfill({ json: { query, matches: query === '今汐' ? [MATCH] : [], request_id: 'synthetic-terms' } });
    }
    if (path === '/api/translations') {
      const body = route.request().postDataJSON();
      translations.push(body);
      const gate = held.shift();
      if (gate) await gate;
      const text = body.text === NEW.source ? NEW.target : body.text === NEXT.source ? NEXT.target : `T(${body.text})`;
      return route.fulfill({ json: { kind: 'exact', text, direction: body.to ?? 'en', dictionary_miss: false, request_id: 'synthetic-translation' } });
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto(BASE + '/');
  await expect(page.locator('.pool-strip')).toContainText('100', { timeout: 30_000 });
  return { translations, held };
}

// One pending read per selected file; the test decides when (and how) it ends.
async function delayedReads(page) {
  await page.addInitScript(() => {
    const original = File.prototype.arrayBuffer;
    window.__fileReads = [];
    File.prototype.arrayBuffer = function () {
      const name = this.name;
      return new Promise((resolve, reject) => {
        window.__fileReads.push({
          name,
          resolve: async () => resolve(await original.call(this)),
          reject: (message) => reject(new Error(message || 'read error')),
        });
      });
    };
    window.__takeRead = (name) => {
      const index = window.__fileReads.findIndex(read => read.name === name);
      if (index === -1) throw new Error(`no pending read for ${name}`);
      return window.__fileReads.splice(index, 1)[0];
    };
    window.__resolveRead = async (name) => { await window.__takeRead(name).resolve(); };
    window.__rejectRead = (name, message) => { window.__takeRead(name).reject(message); };
    window.__pendingReads = () => window.__fileReads.map(read => read.name);
  });
}

function hold(held) {
  let release;
  held.push(new Promise(resolve => { release = resolve; }));
  return () => release();
}

const pendingReads = page => page.evaluate(() => window.__pendingReads());

test('a late file read loses to a newer edit, term insert or query move', async ({ page }) => {
  await delayedReads(page);
  await open(page);
  const source = page.locator('#translation-source');
  const fileInput = page.getByLabel('选择原稿文本文件');
  const fileStatus = page.locator('.translation-file-status');

  await fileInput.setInputFiles({ name: 'stale-edit.md', mimeType: 'text/markdown', buffer: Buffer.from(STALE) });
  await expect.poll(() => pendingReads(page)).toContain('stale-edit.md');
  await source.fill('新编辑。');
  await page.evaluate(() => window.__resolveRead('stale-edit.md'));
  await expect(source).toHaveValue('新编辑。');
  await expect(fileStatus).toHaveCount(0);

  await page.locator('#term-query').fill('今汐');
  await page.locator('.terms-card').getByRole('button', { name: '查术语', exact: true }).click();
  await expect(page.locator('.terms-results .term-result')).toHaveCount(1);
  await fileInput.setInputFiles({ name: 'stale-insert.md', mimeType: 'text/markdown', buffer: Buffer.from(STALE) });
  await expect.poll(() => pendingReads(page)).toContain('stale-insert.md');
  await page.locator('.terms-results').getByRole('button', { name: '填入翻译', exact: true }).click();
  await expect(source).toHaveValue('新编辑。 今汐');
  await page.evaluate(() => window.__resolveRead('stale-insert.md'));
  await expect(source).toHaveValue('新编辑。 今汐');
  await expect(fileStatus).toHaveCount(0);

  await page.locator('#translation-source').fill('');
  await page.locator('#term-query').fill('未见词');
  await page.locator('.terms-card').getByRole('button', { name: '查术语', exact: true }).click();
  await expect(page.getByRole('button', { name: '转到整句翻译', exact: true })).toBeVisible();
  await fileInput.setInputFiles({ name: 'stale-move.md', mimeType: 'text/markdown', buffer: Buffer.from(STALE) });
  await expect.poll(() => pendingReads(page)).toContain('stale-move.md');
  await page.getByRole('button', { name: '转到整句翻译', exact: true }).click();
  await expect(source).toHaveValue('未见词');
  await page.evaluate(() => window.__resolveRead('stale-move.md'));
  await expect(source).toHaveValue('未见词');
  await expect(fileStatus).toHaveCount(0);
});

test('a late file read neither cancels a newer translation nor paints its stale error', async ({ page }) => {
  await delayedReads(page);
  const { translations, held } = await open(page);
  const source = page.locator('#translation-source');
  const fileInput = page.getByLabel('选择原稿文本文件');
  const fileStatus = page.locator('.translation-file-status');

  // Translation still pending while the older read resolves.
  await source.fill(NEW.source);
  await fileInput.setInputFiles({ name: 'stale-pending.md', mimeType: 'text/markdown', buffer: Buffer.from(STALE) });
  await expect.poll(() => pendingReads(page)).toContain('stale-pending.md');
  const release = hold(held);
  await page.getByRole('button', { name: '翻译整句', exact: true }).click();
  await expect(page.locator('.notice-state')).toContainText('正在翻译，请稍候');
  await page.evaluate(() => window.__resolveRead('stale-pending.md'));
  await expect(source).toHaveValue(NEW.source);
  await expect(page.locator('.notice-state')).toContainText('正在翻译，请稍候');
  release();
  await expect(page.locator('.translated-text')).toHaveText(NEW.target);
  expect(translations.at(-1)).toEqual({ text: NEW.source });

  // Translation already finished while the older read was still pending.
  await fileInput.setInputFiles({ name: 'stale-finished.md', mimeType: 'text/markdown', buffer: Buffer.from(STALE) });
  await expect.poll(() => pendingReads(page)).toContain('stale-finished.md');
  await source.fill(NEXT.source);
  await page.getByRole('button', { name: '翻译整句', exact: true }).click();
  await expect(page.locator('.translated-text')).toHaveText(NEXT.target);
  await page.evaluate(() => window.__resolveRead('stale-finished.md'));
  await expect(source).toHaveValue(NEXT.source);
  await expect(page.locator('.translated-text')).toHaveText(NEXT.target);
  await expect(fileStatus).toHaveCount(0);

  // A failed old read must not put its error on the newer text either.
  await fileInput.setInputFiles({ name: 'stale-reject.md', mimeType: 'text/markdown', buffer: Buffer.from(STALE) });
  await expect.poll(() => pendingReads(page)).toContain('stale-reject.md');
  await source.fill('失败后保留。');
  await page.evaluate(() => window.__rejectRead('stale-reject.md', 'File read error'));
  await expect(source).toHaveValue('失败后保留。');
  await expect(fileStatus).toHaveCount(0);
  await expect(page.locator('.error-panel')).toHaveCount(0);
});

test('normal import, strict UTF-8 and the real 1 MiB file limit still hold', async ({ page }) => {
  await open(page);
  const source = page.locator('#translation-source');
  const fileInput = page.getByLabel('选择原稿文本文件');
  const fileStatus = page.locator('.translation-file-status');

  // Normal .md import still applies, including a 2,005-character file: that is
  // the whole-sentence translation limit, not the 1 MiB file limit.
  const longText = '今'.repeat(2005);
  await fileInput.setInputFiles({ name: 'source.md', mimeType: 'text/markdown', buffer: Buffer.from(longText) });
  await expect(source).toHaveValue(longText);
  await expect(fileStatus.first()).toContainText('单次整句翻译限 2,000 字符');
  await expect(page.getByRole('button', { name: '翻译整句', exact: true })).toBeDisabled();
  await expect(page.locator('.translation-file-status[role="status"]', { hasText: '已从文件载入待翻译原文。' })).toHaveCount(1);

  // A real file over 1 MiB is rejected before any read starts.
  await fileInput.setInputFiles({ name: 'huge.md', mimeType: 'text/markdown', buffer: Buffer.alloc(1_048_577, 0x61) });
  await expect(page.locator('.translation-file-status[role="alert"]')).toContainText('原稿文件不能超过 1 MiB。');
  await expect(source).toHaveValue(longText);

  // Strict UTF-8 stays fatal.
  await fileInput.setInputFiles({ name: 'gbk.md', mimeType: 'text/markdown', buffer: Buffer.from([0xc4, 0xe3]) });
  await expect(page.locator('.translation-file-status[role="alert"]')).toContainText('请确认文件为 UTF-8 编码');
  await expect(source).toHaveValue(longText);

});

test('a later file selection still wins over the earlier one', async ({ page }) => {
  await delayedReads(page);
  await open(page);
  const source = page.locator('#translation-source');
  const fileInput = page.getByLabel('选择原稿文本文件');

  await fileInput.setInputFiles({ name: 'first.md', mimeType: 'text/markdown', buffer: Buffer.from('先选文件。') });
  await expect.poll(() => pendingReads(page)).toContain('first.md');
  await fileInput.setInputFiles({ name: 'second.md', mimeType: 'text/markdown', buffer: Buffer.from('后选文件。') });
  await expect.poll(() => pendingReads(page)).toContain('second.md');
  await page.evaluate(() => window.__resolveRead('second.md'));
  await expect(source).toHaveValue('后选文件。');
  await expect(page.locator('.translation-file-status[role="status"]', { hasText: '已从文件载入待翻译原文。' })).toHaveCount(1);
  await page.evaluate(() => window.__resolveRead('first.md'));
  await expect(source).toHaveValue('后选文件。');
});
