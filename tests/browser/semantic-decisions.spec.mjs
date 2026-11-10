import { test, expect } from '@playwright/test';
import { S, fill, openWorkbench, fillPair, blurFocus, rng, semanticResponse, TRIO, trioResponse } from '../helpers/semantic-routes.mjs';

const target = page => page.locator('#review-target');
const card = page => page.locator('.semantic-card');
const act = (page, name) => card(page).getByRole('button', { name, exact: true });
const notice = page => page.locator('.notice-state');
const filter = (page, name, n) => page.getByRole('button', { name: `${name} ${n}`, exact: true });

async function reviewTrio(page, overrides) {
  const rec = await openWorkbench(page, { respond: trioResponse(overrides) });
  await fillPair(page, TRIO.source, TRIO.target);
  await page.getByRole('button', { name: S.start, exact: true }).click();
  await expect(page.locator('.semantic-item')).toHaveCount(3);
  return rec;
}

test('accept, adjust and ignore each rewrite or record, jump to the next open issue and count as handled', async ({ page }) => {
  await reviewTrio(page);
  await expect(card(page)).toContainText(S.categories.quantity_change);
  await act(page, S.accept).click();
  await expect(target(page)).toHaveValue('She saw three birds. He came. We leave today.');
  await expect(notice(page)).toHaveText(S.notices.accepted);
  await expect(card(page)).toContainText(S.categories.negation_change);
  await expect(filter(page, S.statusPending, 2)).toBeVisible();
  await expect(filter(page, S.statusHandled, 1)).toBeVisible();

  await act(page, S.adjust).click();
  await page.locator('.semantic-adjust textarea').fill('was absent');
  await card(page).getByRole('button', { name: S.adjustApply, exact: true }).click();
  await expect(target(page)).toHaveValue('She saw three birds. He was absent. We leave today.');
  await expect(notice(page)).toHaveText(S.notices.adjusted);
  await expect(card(page)).toContainText(S.categories.meaning_shift);

  await act(page, S.ignore).click();
  await expect(target(page)).toHaveValue('She saw three birds. He was absent. We leave today.');
  // The last open issue: the notice says everything under the filter is handled.
  await expect(notice(page)).toHaveText(S.notices.allHandled);
  await expect(filter(page, S.statusHandled, 3)).toBeVisible();
  await expect(filter(page, S.statusPending, 0)).toBeVisible();
  await expect(page.getByRole('group', { name: S.overviewAria })).toContainText(fill(S.overviewSemantic, { n: 3, pending: 0 }));
  await filter(page, S.statusHandled, 3).click();
  await expect(page.locator('.semantic-item .semantic-state')).toHaveText([S.statuses.accepted, S.statuses.adjusted, S.statuses.ignored]);
});

test('undo this restores the translation after an accept and reopens an ignored issue', async ({ page }) => {
  await reviewTrio(page);
  await act(page, S.accept).click();
  await expect(target(page)).toHaveValue('She saw three birds. He came. We leave today.');
  await page.locator('.semantic-last').getByRole('button', { name: S.undoDecision, exact: true }).click();
  await expect(target(page)).toHaveValue(TRIO.target);
  await expect(filter(page, S.statusPending, 3)).toBeVisible();
  await expect(card(page)).toContainText(S.categories.quantity_change);

  await act(page, S.ignore).click();
  await expect(filter(page, S.statusHandled, 1)).toBeVisible();
  await filter(page, S.statusHandled, 1).click();
  await act(page, S.undoDecision).click();
  await expect(filter(page, S.statusPending, 3)).toBeVisible();
  await expect(target(page)).toHaveValue(TRIO.target);
});

test('J and K switch the current issue and Enter selects its translation text', async ({ page }) => {
  await reviewTrio(page);
  const position = page.locator('.finding-position').last();
  await expect(position).toHaveText(fill(S.position, { i: 1, n: 3 }));
  const select = async needle => {
    const [start, end] = rng(TRIO.target, needle);
    await expect.poll(() => target(page).evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual([start, end]);
  };
  await blurFocus(page);
  await page.keyboard.press('j');
  await expect(position).toHaveText(fill(S.position, { i: 2, n: 3 }));
  await expect(card(page)).toContainText(S.categories.negation_change);
  await page.keyboard.press('Enter');
  await select('came');
  await blurFocus(page);
  await page.keyboard.press('j');
  await expect(position).toHaveText(fill(S.position, { i: 3, n: 3 }));
  await page.keyboard.press('Enter');
  await select('today');
  await blurFocus(page);
  await page.keyboard.press('k');
  await page.keyboard.press('k');
  await expect(position).toHaveText(fill(S.position, { i: 1, n: 3 }));
  await page.keyboard.press('Enter');
  await select('two');
});

test('choosing the alternative replaces the text with the alternative wording', async ({ page }) => {
  await reviewTrio(page);
  await card(page).getByRole('radio', { name: S.alternative }).check();
  await expect(card(page).locator('.semantic-suggestion ins')).toHaveText('several');
  await act(page, S.accept).click();
  await expect(target(page)).toHaveValue('She saw several birds. He came. We leave today.');
});

test('a withheld suggestion offers no accept, only a manual adjustment or ignore, and effects are explained', async ({ page }) => {
  await reviewTrio(page, [{ withheld: 'span_too_long' }, { term_effect: 'alters_official_match' }]);
  await expect(card(page)).toContainText(S.withheld);
  await expect(act(page, S.accept)).toHaveCount(0);
  await act(page, S.adjust).click();
  await page.locator('.semantic-adjust textarea').fill('three');
  await card(page).getByRole('button', { name: S.adjustApply, exact: true }).click();
  await expect(target(page)).toHaveValue('She saw three birds. He came. We leave today.');
  await expect(card(page)).toContainText(S.categories.negation_change);
  await expect(card(page).locator('.term-effect')).toHaveText(S.termEffects.alters_official_match);
  await expect(act(page, S.accept)).toBeVisible();
  await act(page, S.ignore).click();
  await expect(filter(page, S.statusHandled, 2)).toBeVisible();
});

test('re-reviewing a segment keeps an earlier ignore', async ({ page }) => {
  // Old spans are only followed inside an identical line, so the issue sits on line 1 and the edit lands on line 3.
  const lines = { source: TRIO.source.replace(/。/g, '。\n').trim(), target: TRIO.target.replace(/\. /g, '.\n') };
  const rec = await openWorkbench(page, { respond: trioResponse() });
  await fillPair(page, lines.source, lines.target);
  await page.getByRole('button', { name: S.start, exact: true }).click();
  await expect(page.locator('.semantic-item')).toHaveCount(3);
  await act(page, S.ignore).click();
  await expect(filter(page, S.statusHandled, 1)).toBeVisible();
  // Edit the text away from every issue, then review the same segment again.
  await target(page).press('Control+End');
  await target(page).pressSequentially(' Extra.');
  await page.locator('.segment-chip').first().getByRole('button', { name: S.segReview, exact: true }).click();
  await expect.poll(() => rec.semantic.length).toBe(2);
  await expect(filter(page, S.statusHandled, 1)).toBeVisible();
  await expect(filter(page, S.statusPending, 2)).toBeVisible();
  await filter(page, S.statusHandled, 1).click();
  await expect(page.locator('.semantic-item .semantic-state')).toHaveText([S.statuses.ignored]);
  await expect(page.locator('.semantic-item')).toContainText(S.categories.quantity_change);
});

test('re-reviewing a segment flags a place where a suggestion was applied and the issue is still reported', async ({ page }) => {
  // An omission has no target text, so its fingerprint survives the rewrite that accepting it makes.
  const rec = await openWorkbench(page, {
    respond: async request => {
      const target = rng(request.target, request.target.includes('did not come') ? 'did not come' : 'came');
      return semanticResponse(request, [{ category: 'omission', source: rng(request.source, '没有'), target: null, suggestion: { target, replacement: 'did not come' } }]);
    },
  });
  await fillPair(page, TRIO.source, TRIO.target);
  await page.getByRole('button', { name: S.start, exact: true }).click();
  await expect(page.locator('.semantic-item')).toHaveCount(1);
  await act(page, S.accept).click();
  await expect(target(page)).toHaveValue('She saw two birds. He did not come. We leave today.');
  await target(page).press('Control+End');
  await target(page).pressSequentially(' Extra.');
  await page.locator('.segment-chip').first().getByRole('button', { name: S.segReview, exact: true }).click();
  await expect.poll(() => rec.semantic.length).toBe(2);
  await expect(page.locator('.semantic-item .semantic-state')).toHaveText([S.statuses.previously_applied]);
  await expect(card(page)).toContainText(fill(S.reference, { d: S.statuses.accepted }));
});
