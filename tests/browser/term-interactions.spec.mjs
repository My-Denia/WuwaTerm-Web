import { test, expect } from '@playwright/test';
import { fixture, freshApiReport } from '../fixtures/manuscript.mjs';

const BASE = process.env.WUWATERM_BROWSER_URL ?? '';

const POOL = {
  status: 'available',
  translation_enabled: true,
  terms: { used: 0, limit: 100, remaining: 100 },
  translations: { used: 0, limit: 100, remaining: 100 },
  characters: { used: 0, limit: 10000, remaining: 10000 },
  reviews: { used: 0, limit: 60, remaining: 60 },
  reset_at: '2099-01-01T00:00:00Z',
};
const DEFAULT_MATCHES = [
  { zh: '今汐', en: 'Jinhsi', category: 'character', reason: 'exact', score: 100 },
  { zh: '今汐（白夜）', en: 'Jinhsi', category: 'character', reason: 'fuzzy', score: 85 },
];

async function open(page, query = '', matches = DEFAULT_MATCHES) {
  const requests = { terms: 0, reviews: 0 };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/pool') return route.fulfill({ json: POOL });
    if (path === '/api/terms') {
      requests.terms += 1;
      return route.fulfill({ json: {
        request_id: 'terms-test-req',
        matches,
      } });
    }
    if (path === '/api/reviews') {
      requests.reviews += 1;
      const body = route.request().postDataJSON();
      return route.fulfill({ json: freshApiReport(fixture(body.source, body.target, body.direction).report) });
    }
    throw new Error(`Unexpected API request: ${path}`);
  });
  await page.goto(BASE + '/' + (query ? `?q=${encodeURIComponent(query)}` : ''));
  await expect(page.locator('.pool-strip')).toContainText('100', { timeout: 30_000 });
  return requests;
}

test('term results retain the response order and duplicate rows', async ({ page }) => {
  const matches = [
    { zh: '声骸', en: 'Echo', category: 'item', reason: 'fuzzy', score: 40 },
    { zh: '今汐', en: 'Jinhsi', category: 'character', reason: 'exact', score: 100 },
    { zh: '声骸', en: 'Echo', category: 'item', reason: 'fuzzy', score: 40 },
    { zh: '穗波', en: 'Baizhi', category: 'character', reason: 'fuzzy', score: 72 },
  ];
  const requests = await open(page, '', matches);
  await page.locator('#term-query').fill('候选');
  await page.locator('.terms-card').getByRole('button', { name: '查术语', exact: true }).click();
  const rows = page.locator('.terms-results .term-result');
  await expect(rows).toHaveCount(matches.length);
  await expect(rows.locator('.term-pair strong')).toHaveText(matches.map(match => match.zh));
  await expect(rows.locator('.term-pair span')).toHaveText(matches.map(match => match.en));
  await expect(rows.locator('dl > div:nth-child(3) dd')).toHaveText(matches.map(match => String(match.score)));
  expect(requests.terms).toBe(1);
});

test('moving a no-match query stops the old translation and ignores a late result', async ({ page }) => {
  await page.addInitScript(() => {
    const originalFetch = window.fetch;
    window.fetch = (input, init) => {
      if (new URL(String(input), location.href).pathname === '/api/translations') {
        window.oldTranslationSignal = init.signal;
        return originalFetch(input, { ...init, signal: undefined });
      }
      return originalFetch(input, init);
    };
  });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await open(page, '', []);
  await page.route('**/api/translations', async route => {
    await held;
    await route.fulfill({ json: {
      kind: 'llm', text: 'Old result', direction: 'en', dictionary_miss: true, request_id: 'old-translation',
    } });
  });
  try {
    await page.locator('#translation-source').fill('旧输入');
    await page.getByRole('button', { name: '翻译整句', exact: true }).click();
    await expect(page.getByRole('button', { name: '翻译中…', exact: true })).toBeVisible();
    await page.locator('#term-query').fill('新查询');
    await page.locator('.terms-card').getByRole('button', { name: '查术语', exact: true }).click();
    await page.getByRole('button', { name: '转到整句翻译', exact: true }).click();
    expect(await page.evaluate(() => window.oldTranslationSignal.aborted)).toBe(true);
    await expect(page.locator('#translation-source')).toHaveValue('新查询');
    const response = page.waitForResponse('**/api/translations');
    release();
    await (await response).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.locator('#translation-source')).toHaveValue('新查询');
    await expect(page.locator('.translated-text')).toHaveCount(0);
  } finally {
    release();
  }
});

test('term match actions: copy, insert to translation, and send to review', async ({ page }) => {
  await open(page);
  await page.locator('#term-query').fill('今汐');
  await page.locator('.terms-card').getByRole('button', { name: '查术语', exact: true }).click();
  const first = page.locator('.terms-results .term-result').first();
  await expect(first).toContainText('今汐');
  await expect(first).toContainText('Jinhsi');

  // Term actions exist and meet >= 40px touch height
  const insertBtn = first.getByRole('button', { name: '填入翻译', exact: true });
  const reviewBtn = first.getByRole('button', { name: '送去审校', exact: true });
  await expect(insertBtn).toBeVisible();
  await expect(reviewBtn).toBeVisible();
  const chipBox = await insertBtn.boundingBox();
  expect(chipBox?.height).toBeGreaterThanOrEqual(40);

  // Test insert to translation
  await insertBtn.click();
  await expect(page.locator('#translation-source')).toHaveValue('今汐');
  await expect(page.locator('#translation-source')).toBeFocused();

  // Test send to review
  await reviewBtn.click();
  await expect(page.locator('#review-source')).toHaveValue('今汐');
  await expect(page.locator('#review-target')).toHaveValue('Jinhsi');
  await expect(page.locator('#review-source')).toBeFocused();
});

test('query clear button resets input and results on demand without form button override', async ({ page }) => {
  await open(page);
  await page.locator('#term-query').fill('今汐');
  const clearBtn = page.locator('.clear-input');
  await expect(clearBtn).toBeVisible();
  const box = await clearBtn.boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(40);
  expect(box?.width).toBeGreaterThanOrEqual(40);
  await clearBtn.click();
  await expect(page.locator('#term-query')).toHaveValue('');
  await expect(clearBtn).toBeHidden();
  await expect(page.locator('.terms-results')).toHaveCount(0);

  // Erasing query with backspace removes q from URL
  await page.locator('#term-query').fill('今汐');
  await page.locator('.terms-card').getByRole('button', { name: '查术语', exact: true }).click();
  await expect(page).toHaveURL(/\/\?q=%E4%BB%8A%E6%B1%90/);
  await page.locator('#term-query').fill('');
  await expect(page).toHaveURL(/^http:\/\/[^/?]+(?:\/)?$/);
});

test('URL parameter ?q=... initializes and triggers term lookup on mount', async ({ page }) => {
  const requests = await open(page, '今汐');
  await expect(page.locator('#term-query')).toHaveValue('今汐');
  await expect(page.locator('.terms-results')).toBeVisible();
  await expect(page.locator('.terms-results .term-result').first()).toContainText('Jinhsi');
  expect(requests.terms).toBe(1);

  // Refresh re-runs the URL-carried term lookup, matching the product note
  // ("a refresh re-runs the term lookup carried in the URL").
  await page.reload();
  await expect(page.locator('#term-query')).toHaveValue('今汐');
  await expect(page.locator('.terms-results .term-result').first()).toContainText('Jinhsi');
  expect(requests.terms).toBe(2);
});

test('editing a submitted nonempty query drops q so return cannot rerun the stale lookup', async ({ page }) => {
  const requests = await open(page);
  await page.locator('#term-query').fill('今汐');
  await page.locator('.terms-card').getByRole('button', { name: '查术语', exact: true }).click();
  await expect(page).toHaveURL(/\/\?q=%E4%BB%8A%E6%B1%90/);
  await expect(page.locator('.terms-results .term-result').first()).toContainText('Jinhsi');

  // Editing to a different nonempty query invalidates the submitted lookup:
  // q leaves the URL and the cleared results cannot be resurrected by navigation.
  await page.locator('#term-query').fill('声骸');
  await expect(page).toHaveURL(/^http:\/\/[^/?]+(?:\/?)$/);
  await expect(page.locator('.terms-results')).toHaveCount(0);

  // Internal links stop carrying the stale query
  await expect(page.locator('.pool-notice a')).toHaveAttribute('href', '/limits');

  // Round trip through /limits restores neither the stale query nor its results
  await page.locator('.nav-links a[href*="/limits"]').click();
  await expect(page).toHaveURL(/\/limits$/);
  await page.locator('.document-top .back-link').click();
  await expect(page).toHaveURL(/^http:\/\/[^/?]+(?:\/?)$/);
  await expect(page.locator('#term-query')).toHaveValue('');
  await expect(page.locator('.terms-results')).toHaveCount(0);
  expect(requests.terms).toBe(1);
});

test('clear draft in review workbench empties manuscript and undo restores it', async ({ page }) => {
  await open(page);
  await page.locator('#review-source').fill('测试原文');
  await page.locator('#review-target').fill('Test target');
  const clearBtn = page.getByRole('button', { name: '清空稿件', exact: true });
  await expect(clearBtn).toBeEnabled();
  await clearBtn.click();
  await expect(page.locator('#review-source')).toHaveValue('');
  await expect(page.locator('#review-target')).toHaveValue('');
  await expect(page.locator('.notice-state')).toContainText('已清空审校稿件与选择');

  // Undo restores the cleared draft
  const undoBtn = page.getByRole('button', { name: '撤销修订', exact: true });
  await expect(undoBtn).toBeEnabled();
  await undoBtn.click();
  await expect(page.locator('#review-source')).toHaveValue('测试原文');
  await expect(page.locator('#review-target')).toHaveValue('Test target');

  // Empty alignments array is also treated as clearable work
  await page.locator('.alignment-panel > summary').click();
  await page.getByRole('button', { name: '清空对应', exact: true }).click();
  await page.locator('#review-source').fill('');
  await page.locator('#review-target').fill('');
  await expect(clearBtn).toBeEnabled();
  await clearBtn.click();
  await expect(page.locator('.notice-state')).toContainText('已清空审校稿件与选择');

  // Whitespace-only manuscript is also treated as clearable work
  await page.locator('#review-source').fill('   \n  ');
  await expect(clearBtn).toBeEnabled();
  await clearBtn.click();
  await expect(page.locator('#review-source')).toHaveValue('');
});

test('section pills have at least 40px touch targets and allow direct navigation', async ({ page }) => {
  await open(page);
  const pills = page.locator('.section-pills .section-pill');
  await expect(pills).toHaveCount(4);
  for (let i = 0; i < 4; i += 1) {
    const box = await pills.nth(i).boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(40);
  }
  await expect(pills.nth(0)).toHaveAttribute('href', '#terms-title');
  await expect(pills.nth(1)).toHaveAttribute('href', '#translation-title');
  await expect(pills.nth(2)).toHaveAttribute('href', '#review-title');
  await expect(pills.nth(3)).toHaveAttribute('href', '#provenance-section');
});

test('document return link preserves query parameter across navigation', async ({ page }) => {
  await open(page);
  await page.locator('#term-query').fill('今汐');
  await page.locator('.terms-card').getByRole('button', { name: '查术语', exact: true }).click();
  await expect(page.locator('.terms-results .term-result').first()).toContainText('Jinhsi');

  // Verify pool-notice limits link carries ?q=
  const noticeLink = page.locator('.pool-notice a');
  await expect(noticeLink).toHaveAttribute('href', '/limits?q=%E4%BB%8A%E6%B1%90');

  // Navigate to limits via topbar link
  await page.locator('.nav-links a[href*="/limits"]').click();
  await expect(page).toHaveURL(/\/limits\?q=%E4%BB%8A%E6%B1%90/);

  // Limits footer link to privacy also carries ?q=
  const privacyFooterLink = page.locator('footer a[href*="/privacy"]');
  await expect(privacyFooterLink).toHaveAttribute('href', '/privacy?q=%E4%BB%8A%E6%B1%90');

  // Return via back link
  await page.locator('.document-top .back-link').click();
  await expect(page).toHaveURL(/\/\?q=%E4%BB%8A%E6%B1%90/);
  await expect(page.locator('#term-query')).toHaveValue('今汐');
  await expect(page.locator('.terms-results .term-result').first()).toContainText('Jinhsi');

  // Guarded leave with active draft also preserves ?q=
  await page.locator('#review-source').fill('草稿');
  await page.locator('.nav-links a[href*="/privacy"]').click();
  const leaveDialog = page.getByRole('dialog', { name: '离开审校页？' });
  await expect(leaveDialog).toBeVisible();
  await leaveDialog.getByRole('button', { name: '仍要离开', exact: true }).click();
  await expect(page).toHaveURL(/\/privacy\?q=%E4%BB%8A%E6%B1%90/);

  // Privacy document links to limits also carry ?q=
  const limitsLinks = page.locator('main a[href*="/limits"]');
  await expect(limitsLinks).not.toHaveCount(0);
  const count = await limitsLinks.count();
  for (let i = 0; i < count; i += 1) {
    await expect(limitsLinks.nth(i)).toHaveAttribute('href', '/limits?q=%E4%BB%8A%E6%B1%90');
  }

  await page.locator('.document-top .back-link').click();
  await expect(page).toHaveURL(/\/\?q=%E4%BB%8A%E6%B1%90/);
});

test('findings display excerpt labels and verdict badges', async ({ page }) => {
  await open(page);
  await page.locator('#review-source').fill('今汐在。');
  await page.locator('#review-target').fill('Jinhsi is here.');
  await page.getByRole('button', { name: '核对术语', exact: true }).click();
  await expect(page.locator('.review-findings .term-result')).toHaveCount(1);
  const finding = page.locator('.review-findings .term-result').first();
  await expect(finding.locator('.verdict-badge')).toBeVisible();
  await expect(finding.locator('.excerpt-tag').nth(0)).toHaveText('原文');
  await expect(finding.locator('.excerpt-tag').nth(1)).toHaveText('已有译文');
});
