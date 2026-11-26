import { test, expect } from '@playwright/test';
import { msg } from '../../lib/messages.ts';
import { S, fillPair, openManuscript, openWorkbench, rng, semanticResponse } from '../helpers/semantic-routes.mjs';
import { camellyaManuscript, termGroupReport } from '../helpers/term-group-fixture.mjs';
import { dictionary, echo, FRESH_MATCHER_REVISION, hash } from '../fixtures/manuscript.mjs';

const M = msg('zh');
const BASE = process.env.WUWATERM_BROWSER_URL ?? '';
const POOL = {
  status: 'available', translation_enabled: true,
  terms: { used: 0, limit: 100, remaining: 100 },
  translations: { used: 0, limit: 100, remaining: 100 },
  characters: { used: 0, limit: 10000, remaining: 10000 },
  reviews: { used: 0, limit: 60, remaining: 60 },
  reset_at: '2099-01-01T00:00:00Z',
};

const storageState = page => page.evaluate(async () => ({
  local: localStorage.length,
  session: sessionStorage.length,
  idb: typeof indexedDB?.databases === 'function' ? (await indexedDB.databases()).length : 0,
}));

async function openQuick(page) {
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/capabilities') return route.fulfill({ json: { capabilities: ['translation-context-v1'], request_id: 'synthetic' } });
    if (path === '/api/pool') return route.fulfill({ json: POOL });
    throw new Error(`Unexpected API request: ${path}`);
  });
  await page.goto(BASE + '/');
  await expect(page.locator('.pool-strip')).toContainText('100', { timeout: 30_000 });
}

for (const [label, viewport] of [
  ['desktop', { width: 1440, height: 900 }],
  ['mobile', { width: 390, height: 844 }],
]) {
  test.describe(`visual vs DOM order (${label})`, () => {
    test.use({ viewport });

    test('zero CSS order inversion; visual reading order matches DOM and focus order in quick mode', async ({ page }) => {
      await openQuick(page);
      const audit = await page.evaluate(() => {
        const ordered = [];
        for (const el of document.querySelectorAll('.topbar, .topbar *, .document-workspace, .document-workspace *')) {
          const order = getComputedStyle(el).order;
          if (order && order !== '0') ordered.push({ tag: el.tagName, cls: el.className, order });
        }
        const rect = sel => {
          const r = document.querySelector(sel).getBoundingClientRect();
          return { x: r.x, y: r.y, bottom: r.bottom, right: r.right };
        };
        const follows = (a, b) => !!(document.querySelector(a).compareDocumentPosition(document.querySelector(b)) & Node.DOCUMENT_POSITION_FOLLOWING);
        return {
          ordered,
          brand: rect('.brand'),
          pills: rect('.section-pills'),
          lang: rect('.nav-links'),
          editor: rect('.manuscript-editor-pane'),
          side: rect('.workspace-side'),
          status: rect('.runtime-status'),
          source: rect('#review-source'),
          submit: rect('.manuscript-editor-pane form button[type="submit"]'),
          editorBeforeSide: follows('.manuscript-editor-pane', '.workspace-side'),
          sideBeforeStatus: follows('.workspace-side', '.runtime-status'),
          brandBeforePills: follows('.brand', '.section-pills'),
          pillsBeforeNav: follows('.section-pills', '.nav-links'),
        };
      });

      expect(audit.ordered).toEqual([]);
      expect(audit.editorBeforeSide).toBe(true);
      expect(audit.sideBeforeStatus).toBe(true);
      expect(audit.brandBeforePills).toBe(true);
      expect(audit.pillsBeforeNav).toBe(true);

      if (label === 'desktop') {
        // Desktop 2-column grid: editors left, side tools right, status below.
        expect(audit.editor.x).toBeLessThan(audit.side.x);
        expect(audit.status.y).toBeGreaterThanOrEqual(Math.min(audit.editor.bottom, audit.side.bottom) - 1);
      } else {
        // Mobile 390x844: editors first within first screen, side tools below, status after.
        expect(audit.source.bottom).toBeLessThanOrEqual(844);
        expect(audit.submit.bottom).toBeLessThanOrEqual(844);
        expect(audit.editor.bottom).toBeLessThanOrEqual(audit.side.y + 1);
        expect(audit.side.bottom).toBeLessThanOrEqual(audit.status.y + 1);
        expect(audit.brand.bottom).toBeLessThanOrEqual(audit.pills.y + 1);
        expect(audit.pills.x).toBeLessThan(audit.lang.x);
      }
      expect(await storageState(page)).toEqual({ local: 0, session: 0, idb: 0 });
    });
  });
}

test('synchronized scrolling syncs source and target by ratio, respects toggle OFF, and pauses during locate()', async ({ page }) => {
  await openWorkbench(page, { capabilities: [] });
  const lines = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}: 今汐与声骸`).join('\n');
  await fillPair(page, `今汐。\n${lines('原文行', 60)}\n声骸。`, `Jinhsi.\n${lines('Target line', 60)}\nEcho.`);

  const syncBtn = page.getByRole('button', { name: M.workspace.syncScroll, exact: true });
  await expect(syncBtn).toHaveAttribute('aria-pressed', 'true');

  // Scroll source to ~50% -> target follows to ~50%.
  await page.locator('#review-source').evaluate(el => {
    el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * 0.5);
    el.dispatchEvent(new Event('scroll'));
  });
  await expect.poll(async () => page.locator('#review-target').evaluate(el => {
    const max = el.scrollHeight - el.clientHeight;
    return max > 0 ? el.scrollTop / max : 0;
  })).toBeGreaterThan(0.4);

  // Turn sync OFF -> scrolling source to 0 leaves target where it was.
  await syncBtn.click();
  await expect(syncBtn).toHaveAttribute('aria-pressed', 'false');
  const targetBefore = await page.locator('#review-target').evaluate(el => el.scrollTop);
  await page.locator('#review-source').evaluate(el => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll'));
  });
  await page.waitForTimeout(100);
  expect(await page.locator('#review-target').evaluate(el => el.scrollTop)).toBe(targetBefore);

  // Turn sync ON -> locating a finding in target does NOT fight scroll sync / overwrite source scrollTop.
  await syncBtn.click();
  await expect(syncBtn).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: M.review.checkIdle, exact: true }).click();
  await page.getByRole('button', { name: /^全部 / }).click();
  await page.locator('#review-source').evaluate(el => { el.scrollTop = 0; });
  await page.locator('#review-target').evaluate(el => { el.scrollTop = 0; });
  const lastFinding = page.locator('.review-findings .term-result').last();
  await lastFinding.getByRole('button', { name: M.review.jumpTarget, exact: true }).click();
  await page.waitForTimeout(150);
  // Target scrolled down to Echo, while source stayed at top (sync suspended during reveal).
  expect(await page.locator('#review-target').evaluate(el => el.scrollTop)).toBeGreaterThan(50);
  expect(await page.locator('#review-source').evaluate(el => el.scrollTop)).toBe(0);
  expect(await storageState(page)).toEqual({ local: 0, session: 0, idb: 0 });
});

test('document mode and long mode hide confirmed checks by default with 1-click toggle to show all', async ({ page }) => {
  // Document mode: 1 verified + 1 conflict -> actionable default hides verified and shows 1-click show-all bar.
  await openWorkbench(page, {
    capabilities: [],
    reviewReport: body => ({
      request_id: 'hide-confirmed-doc',
      source_revision: hash(body.source),
      target_revision: hash(body.target),
      rule_version: 'review-v2',
      matcher_revision: FRESH_MATCHER_REVISION,
      dictionary,
      coverage: { evaluated: 2, not_evaluated: 0, rules: ['review.term_pair', 'review.sentence_meaning'] },
      findings: [
        {
          id: '0:2:今汐', rule_id: 'review.term_pair', verdict: 'verified_constraint',
          source_span: { start: 0, end: 2, text: '今汐' }, target_span: { start: 0, end: 6, text: 'Jinhsi' },
          candidates: [{ candidate_id: hash('jinhsi'), zh: '今汐', en: 'Jinhsi', category: 'resonator', sources: [] }],
          candidates_truncated: false,
        },
        {
          id: '3:5:声骸', rule_id: 'review.term_pair', verdict: 'confirmed_conflict',
          source_span: { start: 3, end: 5, text: '声骸' }, target_span: { start: 8, end: 13, text: 'Sound' },
          candidates: [{ ...echo, sources: [] }],
          candidates_truncated: false,
        },
      ],
      truncated: false,
    }),
  });
  await fillPair(page, '今汐与声骸。', 'Jinhsi, Sound.');
  await page.getByRole('button', { name: M.review.checkIdle, exact: true }).click();
  await expect(page.getByRole('button', { name: '待处理 1', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.review-findings .term-result')).toHaveCount(1);
  await expect(page.locator('.review-findings')).toContainText('声骸');
  await expect(page.locator('.hidden-confirmed-bar')).toContainText('已隐藏 1 条已核条目');
  await page.locator('.hidden-confirmed-bar').getByRole('button', { name: M.review.showAllConfirmed, exact: true }).click();
  await expect(page.getByRole('button', { name: '全部 2', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.review-findings .term-result')).toHaveCount(2);

  // Long mode: camellyaManuscript has 椿 (inconsistent), 声骸 (not_evaluated), 今汐 (confirmed).
  // Default 'unresolved' hides 今汐 and collapses confirmed places of 椿.
  const rec = await openWorkbench(page, { capabilities: [], reviewReport: termGroupReport });
  const manuscript = camellyaManuscript();
  await page.getByLabel(M.review.directionAria).selectOption(manuscript.direction);
  await fillPair(page, manuscript.source, manuscript.target);
  await page.locator('.long-tools .long-terms button').click();
  await expect.poll(() => rec.reviews.length).toBe(4);
  await expect(page.locator('[data-group-filter="unresolved"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.term-group')).toHaveCount(2);
  await expect(page.locator('.term-group[data-group-surface="今汐"]')).toHaveCount(0);
  await page.locator('[data-group-filter="all"]').click();
  await expect(page.locator('.term-group')).toHaveCount(3);
  await expect(page.locator('.term-group[data-group-surface="今汐"]')).toHaveCount(1);
});

test('promote term finding, semantic issue, and editor selection to in-memory personal termbase without modifying text or browser storage', async ({ page }) => {
  const source = '今汐与声骸一起出发。';
  const target = 'Jinhsi and Sound set out.';
  const rec = await openWorkbench(page, {
    capabilities: ['semantic-review-v1'],
    reviewReport: body => ({
      request_id: 'promote-doc',
      source_revision: hash(body.source),
      target_revision: hash(body.target),
      rule_version: 'review-v2',
      matcher_revision: FRESH_MATCHER_REVISION,
      dictionary,
      coverage: { evaluated: 1, not_evaluated: 0, rules: ['review.term_pair', 'review.sentence_meaning'] },
      findings: [
        {
          id: '3:5:声骸', rule_id: 'review.term_pair', verdict: 'confirmed_conflict',
          source_span: { start: 3, end: 5, text: '声骸' }, target_span: { start: 11, end: 16, text: 'Sound' },
          candidates: [{ ...echo, sources: [] }],
          candidates_truncated: false,
        },
      ],
      truncated: false,
    }),
    respond: req => semanticResponse(req, [
      {
        category: 'meaning_shift',
        source: rng(req.source, '一起出发'),
        target: rng(req.target, 'set out'),
        suggestion: { target: rng(req.target, 'set out'), replacement: 'set out together' },
        confidence: 'high',
        rationale: 'Missing together.',
      },
    ]),
  });

  await fillPair(page, source, target);
  await page.getByRole('button', { name: M.review.checkIdle, exact: true }).click();
  await expect(page.locator('.review-findings .term-result')).toHaveCount(1);

  // 1) Promote from term finding -> added as preferred_term; second click reports already present.
  const findingPromote = page.locator('.review-findings .term-result').first().getByRole('button', { name: M.termbase.promoteButton, exact: true });
  await findingPromote.click();
  await expect(page.locator('.termbase-promote-status')).toContainText('声骸 → Echo');
  await expect(page.getByTestId('my-terms-counts')).toContainText('1 条');
  // Target text was NOT auto-mutated (no auto-apply to homographs).
  await expect(page.locator('#review-target')).toHaveValue(target);

  const alreadyBtn = page.locator('.review-findings .term-result').first().getByRole('button', { name: M.termbase.alreadyInTermbase, exact: true });
  await expect(alreadyBtn).toBeVisible();
  await alreadyBtn.click();
  await expect(page.locator('.termbase-promote-status')).toContainText('已有相同条目');
  await expect(page.getByTestId('my-terms-counts')).toContainText('1 条');

  // 2) Promote from semantic issue -> uses suggested replacement.
  await page.getByRole('button', { name: S.start, exact: true }).click();
  await expect.poll(() => rec.semantic.length).toBe(1);
  await page.locator('.semantic-card').getByRole('button', { name: M.termbase.promoteButton, exact: true }).click();
  await expect(page.locator('.termbase-promote-status')).toContainText('一起出发 → set out together');
  await expect(page.getByTestId('my-terms-counts')).toContainText('2 条');

  // 3) Promote from editor selection (source + target selected).
  await page.locator('#review-source').evaluate(el => { el.focus(); el.setSelectionRange(0, 2); });
  await page.locator('#review-target').evaluate(el => { el.setSelectionRange(0, 6); });
  await page.getByRole('button', { name: M.termbase.promoteSelection, exact: true }).click();
  await expect(page.locator('.termbase-promote-status')).toContainText('今汐 → Jinhsi');
  await expect(page.getByTestId('my-terms-counts')).toContainText('3 条');

  // Expand MyTerms and verify all 3 entries are present as preferred_term with zero browser storage.
  await page.locator('.my-terms').getByRole('button', { name: M.workspace.lookupShow, exact: true }).click();
  await expect(page.locator('.my-terms-list li')).toHaveCount(3);
  await expect(page.locator('.my-terms-list')).toContainText(M.termbase.kinds.preferred_term);
  expect(await storageState(page)).toEqual({ local: 0, session: 0, idb: 0 });
});

test('Markdown reading preview renders formatting safely, neutralizes XSS, and preserves lossless textarea editing', async ({ page }) => {
  await openQuick(page);
  await openManuscript(page);
  const rawMd = [
    '# 鸣潮 2.4 攻略',
    '',
    '重点术语：**今汐**、*声骸*、`Resonance_Chain` 与 [官方公告](https://example.com/patch)。',
    '',
    '- 恶意脚本：<script>window.__xss=1</script>',
    '- 恶意链接：[点我](javascript:alert(1))',
  ].join('\n');
  const targetMd = [
    '# Wuthering Waves 2.4 Guide',
    '',
    'Key terms: **Jinhsi**, *Echo*, `Resonance_Chain` and [Official Notice](https://example.com/patch).',
  ].join('\n');
  await fillPair(page, rawMd, targetMd);

  const toggle = page.getByRole('button', { name: M.workspace.markdownPreview, exact: true });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#review-source')).toBeHidden();
  const previews = page.locator('.markdown-preview');
  await expect(previews).toHaveCount(2);

  // Formatting rendered as real React elements; no extra <h1>; XSS stays plain text.
  await expect(previews.first().locator('h3.md-h1')).toHaveText('鸣潮 2.4 攻略');
  await expect(previews.first().locator('strong')).toHaveText('今汐');
  await expect(previews.first().locator('em')).toHaveText('声骸');
  await expect(previews.first().locator('code')).toHaveText('Resonance_Chain');
  await expect(previews.first().locator('a')).toHaveCount(1);
  await expect(previews.first().locator('a')).toHaveAttribute('href', 'https://example.com/patch');
  await expect(previews.first().locator('script')).toHaveCount(0);
  await expect(previews.first()).toContainText('<script>window.__xss=1</script>');
  await expect(previews.first()).toContainText('[点我](javascript:alert(1))');
  expect(await page.evaluate(() => Boolean(window.__xss))).toBe(false);
  expect(await page.locator('h1').count()).toBe(1);

  // Toggle back to editing: exact raw Markdown preserved losslessly.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#review-source')).toBeVisible();
  await expect(page.locator('#review-source')).toHaveValue(rawMd);
  await expect(page.locator('#review-target')).toHaveValue(targetMd);
  expect(await storageState(page)).toEqual({ local: 0, session: 0, idb: 0 });
});
