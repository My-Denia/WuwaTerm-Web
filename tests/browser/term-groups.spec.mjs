// The long-manuscript term view (MY-359 banner, term groups, per-place edits, not_evaluated reasons, review-v2 features).
// Synthetic text and public game terms; the routes are local fakes (tests/helpers/term-group-fixture.mjs).
import { test, expect } from '@playwright/test';
import { msg } from '../../lib/messages.ts';
import { parseWorkfile } from '../../lib/manuscript.js';
import { S, downloadFrom, fill, fillPair, openWorkbench } from '../helpers/semantic-routes.mjs';
import { camellyaManuscript, denseManuscript, termGroupReport, tunerManuscript } from '../helpers/term-group-fixture.mjs';

const M = msg('zh');
const chips = page => page.locator('.segment-chip');
const runButton = page => page.locator('.long-tools .long-terms button');
const status = page => page.locator('.run-phase');
const groups = page => page.locator('.term-group');
const groupOf = (page, surface) => page.locator(`.term-group[data-group-surface="${surface}"]`);
const filterButton = (page, id) => page.locator(`[data-group-filter="${id}"]`);
const summary = page => page.locator('.group-filter-summary');
const places = group => group.locator('article.long-term');
const target = page => page.locator('#review-target');
const open = (page, options = {}) => openWorkbench(page, { capabilities: [], reviewReport: termGroupReport, ...options });

async function load(page, manuscript, ready) {
  await page.getByLabel(M.review.directionAria).selectOption(manuscript.direction);
  await fillPair(page, manuscript.source, manuscript.target);
  await expect(chips(page)).toHaveCount(ready);
}
async function check(page, rec, requests) {
  await runButton(page).click();
  await expect.poll(() => rec.reviews.length).toBe(requests);
  await expect(status(page)).toHaveAttribute('data-run-state', 'done');
}

test('the term view groups findings by term: places, segments, the translation used, a status and a reason for what was not evaluated', async ({ page }) => {
  const rec = await open(page);
  await load(page, camellyaManuscript(), 5);
  await check(page, rec, 4);
  // Every term check asks for dense-128 and reason-v1, and nothing else changes in the request.
  expect(rec.reviewHeaders.every(h => h['x-wuwaterm-review-features'] === 'dense-128,reason-v1')).toBe(true);
  expect(rec.reviews.every(body => body.review_version === 'review-v2')).toBe(true);

  // Default view: grouped, most urgent first (an inconsistent term, one with something not evaluated, a confirmed one).
  await expect(page.getByRole('button', { name: S.termViewGroups, exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(groups(page)).toHaveCount(3);
  expect(await groups(page).evaluateAll(list => list.map(el => [el.getAttribute('data-group-surface'), el.getAttribute('data-group-status')])))
    .toEqual([['椿', 'inconsistent'], ['声骸', 'not_evaluated'], ['今汐', 'confirmed']]);
  const camellya = groupOf(page, '椿');
  await expect(camellya.locator('.term-group-meta')).toHaveText(fill(S.groupHead, { n: 5, segments: '1、2、3' }));
  // The translation used at each place: two Camellya and one place with no hit, and the two places Core did not evaluate (an ordinary
  // word, a homograph) counted apart: they are not a miss of the term.
  await expect(camellya.locator('.term-group-renderings')).toHaveText(fill(S.groupRenderings, { items: `Camellya ×2 · ${S.renderingNone} ×1 · ${S.renderingNotEvaluated} ×2` }));
  // The places of the group by state: one to check, two not evaluated, two checked.
  await expect(camellya.locator('.term-group-tally')).toHaveText([fill(S.groupTallyPending, { n: 1 }), fill(S.groupTallyNotEvaluated, { n: 2 }), fill(S.groupTallyConfirmed, { n: 2 })].join(' · '));
  await expect(places(camellya)).toHaveCount(5);
  expect(await places(camellya).evaluateAll(list => list.map(el => el.getAttribute('data-segment')))).toEqual(['0', '1', '1', '2', '2']);
  // The reason of what Core did not evaluate, in words, and the three ways a place can have no translation.
  const reason = code => fill(M.review.reasonLabel, { reason: M.review.reasons[code] });
  await expect(camellya.locator('.finding-reason[data-reason="not_a_term"]')).toHaveText(reason('not_a_term'));
  await expect(camellya.locator('.finding-reason[data-reason="ordinary_word"]')).toHaveText(reason('ordinary_word'));
  await expect(groupOf(page, '声骸').locator('.finding-reason[data-reason="no_target_region"]')).toHaveText(reason('no_target_region'));
  // Only the place that was evaluated and has no hit says so; a place Core did not evaluate has no "no matching word" line.
  await expect(camellya.locator('.occurrence-translation[data-hit="false"]')).toHaveCount(1);
  await expect(page.locator('article.long-term[data-verdict="not_evaluated"] .occurrence-translation')).toHaveCount(0);
  await expect(camellya.locator('article[data-verdict="needs_review"] .occurrence-translation')).toHaveText(S.occurrenceNoHit);
  // Context of the place: the hit marked, and for a place with no hit a sentence of that segment's translation, never a blank.
  const noHit = places(camellya).nth(1);
  await expect(noHit.locator('.excerpt-labeled').first().locator('mark')).toHaveText('椿');
  await expect(noHit.locator('.target-excerpt')).not.toBeEmpty();
  await expect(noHit.locator('.occurrence-translation')).toHaveText(S.occurrenceNoHit);

  // The status filter: each button counts the groups that hold a place of its kind, and what is shown is exactly that count.
  const counts = { all: 3, inconsistent: 1, pending: 1, not_evaluated: 2, confirmed: 1 };
  for (const [id, n] of Object.entries(counts)) {
    await filterButton(page, id).click();
    await expect(filterButton(page, id)).toHaveAttribute('data-group-count', String(n));
    await expect(filterButton(page, id)).toHaveText(`${S.groupFilters[id]} ${n}`);
    await expect(groups(page)).toHaveCount(n);
  }
  // 椿 has a place to check, so it is under "to do" with that place, though its status is inconsistent; the rest is one click away.
  await filterButton(page, 'pending').click();
  await expect(groups(page).first()).toHaveAttribute('data-group-surface', '椿');
  await expect(groups(page).first()).toHaveAttribute('data-group-status', 'inconsistent');
  await expect(places(camellya)).toHaveCount(1);
  await expect(places(camellya).first()).toHaveAttribute('data-verdict', 'needs_review');
  await expect(summary(page)).toHaveText(`${fill(S.groupFilterSummary, { label: S.groupFilters.pending, groups: 1, places: 1 })}${fill(S.groupHiddenInGroups, { n: 4 })}`);
  const rest = camellya.locator('.group-rest-toggle');
  await expect(rest).toHaveText(fill(S.groupShowRest, { n: 4 }));
  await rest.click();
  await expect(places(camellya)).toHaveCount(5);
  await expect(rest).toHaveText(fill(S.groupHideRest, { n: 4 }));
  await expect(summary(page)).toHaveText(fill(S.groupFilterSummary, { label: S.groupFilters.pending, groups: 1, places: 5 }));
  await rest.click();
  await expect(places(camellya)).toHaveCount(1);
  // Inconsistent shows the place that needs a decision, not every place of the group.
  await filterButton(page, 'inconsistent').click();
  await expect(groups(page)).toHaveCount(1);
  await expect(places(camellya)).toHaveCount(1);
  await expect(places(camellya).first()).toHaveAttribute('data-verdict', 'needs_review');
  // Not evaluated: the two places of 椿 that Core did not look at, and the one of 声骸.
  await filterButton(page, 'not_evaluated').click();
  expect(await groups(page).evaluateAll(list => list.map(el => [el.getAttribute('data-group-surface'), el.querySelectorAll('article.long-term').length]))).toEqual([['椿', 2], ['声骸', 1]]);
  await expect(page.locator('article.long-term:not([data-verdict="not_evaluated"])')).toHaveCount(0);
  // Settled groups: all their places.
  await filterButton(page, 'confirmed').click();
  expect(await groups(page).evaluateAll(list => list.map(el => el.getAttribute('data-group-surface')))).toEqual(['今汐']);
  await filterButton(page, 'all').click();
  await expect(groups(page)).toHaveCount(3);
  await expect(places(camellya)).toHaveCount(5);
  await expect(summary(page)).toHaveText(fill(S.groupFilterSummary, { label: S.groupFilters.all, groups: 3, places: 8 }));

  // One segment selected: the buttons count what that segment shows, and the lists follow.
  await chips(page).nth(1).getByRole('button').first().click();
  await expect(filterButton(page, 'pending')).toHaveAttribute('data-group-count', '1');
  await expect(filterButton(page, 'confirmed')).toHaveAttribute('data-group-count', '0');
  await expect(filterButton(page, 'all')).toHaveAttribute('data-group-count', '1');
  await filterButton(page, 'pending').click();
  await expect(groups(page)).toHaveCount(1);
  await expect(places(camellya)).toHaveCount(1);
  await chips(page).nth(1).getByRole('button').first().click();
  await filterButton(page, 'all').click();

  // The view toggle: the same places in segment order, without groups.
  await page.getByRole('button', { name: S.termViewSegments, exact: true }).click();
  await expect(groups(page)).toHaveCount(0);
  const order = await page.locator('.long-term-list article.long-term').evaluateAll(list => list.map(el => Number(el.getAttribute('data-segment'))));
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(order.length).toBe(8);
  // A filter still applies there; the places it leaves out are named, with the way back.
  await filterButton(page, 'pending').click();
  await expect(page.locator('.long-term-list article.long-term')).toHaveCount(1);
  await expect(summary(page)).toHaveText(`${fill(S.groupFilterSummary, { label: S.groupFilters.pending, groups: 1, places: 1 })}${fill(S.groupHiddenInSegments, { n: 4 })}`);
});

test('replace puts the official rendering into one place only; a word that stands elsewhere is left alone; one undo takes it back', async ({ page }) => {
  const rec = await open(page);
  const manuscript = tunerManuscript();
  await load(page, manuscript, 3);
  await check(page, rec, 3);
  const tuner = groupOf(page, 'Tuner');
  await expect(tuner).toHaveAttribute('data-group-status', 'inconsistent');
  await expect(tuner.locator('.term-group-renderings')).toHaveText(fill(S.groupRenderings, { items: '调谐器 ×2 · 调音师 ×1' }));
  const conflict = places(tuner).filter({ has: page.locator('.occurrence-translation', { hasText: '调音师' }) });
  await expect(conflict).toHaveCount(1);
  const before = await target(page).inputValue();
  expect(before.split('调音师').length - 1).toBe(2);
  // The places whose translation already is the official one offer no replacement; the conflicting one offers it.
  await expect(places(tuner).getByRole('button', { name: fill(S.occReplace, { term: '调谐器' }), exact: true })).toHaveCount(1);
  await conflict.getByRole('button', { name: fill(S.occReplace, { term: '调谐器' }), exact: true }).click();
  const after = await target(page).inputValue();
  expect(after.split('调音师').length - 1).toBe(1);
  expect(after.length).toBe(before.length - '调音师'.length + '调谐器'.length);
  expect(after.endsWith('后来调音师也来了。') || after.includes('后来调音师也来了。')).toBe(true);
  await expect(page.locator('.notice-state')).toHaveText(S.notices.longTargetReplaced);
  // The edited segment has no result until it is checked again, and the groups say so instead of reading as complete.
  await expect(page.locator('.groups-unchecked')).toHaveText(fill(S.groupsUnchecked, { n: 1 }));
  // The run no longer reads complete: a segment was edited and has no result. The Tuner is not confirmed across the manuscript either:
  // the two places left are checked, and the head names the segment that holds the term and waits for its check.
  await expect(status(page)).toHaveText(fill(S.phaseTermDoneRecheck, { n: 1 }));
  await expect(status(page)).not.toHaveText(S.phaseTermDone);
  await expect(runButton(page)).toHaveAttribute('data-recheck', 'true');
  await expect(tuner).toHaveAttribute('data-group-status', 'pending');
  await expect(tuner.locator('.term-group-unverified .group-status')).toHaveText(fill(S.groupUnverified, { list: 2 }));
  await expect(tuner.locator('.group-status').first()).not.toHaveText(S.groupStatuses.confirmed);
  await expect(tuner.locator('.term-group-renderings')).toHaveText(fill(S.groupRenderings, { items: '调谐器 ×2' }));
  await expect(filterButton(page, 'pending')).toHaveAttribute('data-group-count', '1');
  await expect(filterButton(page, 'confirmed')).toHaveAttribute('data-group-count', '0');
  // One undo step restores the text, and with it the complete run and the inconsistent group.
  await page.getByRole('button', { name: M.review.undo, exact: true }).click();
  await expect(target(page)).toHaveValue(before);
  await expect(page.locator('.groups-unchecked')).toHaveCount(0);
  await expect(status(page)).toHaveText(S.phaseTermDone);
  await expect(runButton(page)).not.toHaveAttribute('data-recheck', 'true');
  await expect(tuner).toHaveAttribute('data-group-status', 'inconsistent');
  await expect(tuner.locator('.term-group-unverified')).toHaveCount(0);
});

test('a place with no translation hit opens an editor for that one segment; applying changes only that segment and one undo takes it back', async ({ page }) => {
  const rec = await open(page);
  const manuscript = camellyaManuscript();
  await load(page, manuscript, 5);
  await check(page, rec, 4);
  const noHit = places(groupOf(page, '椿')).nth(1);
  await expect(noHit.getByRole('button', { name: S.occRevise, exact: true })).toBeVisible();
  // A place that has a translation hit offers no segment editor.
  await expect(places(groupOf(page, '椿')).nth(0).getByRole('button', { name: S.occRevise, exact: true })).toHaveCount(0);
  await noHit.getByRole('button', { name: S.occRevise, exact: true }).click();
  const editor = noHit.locator('.term-revise textarea');
  const segmentTarget = manuscript.target.split('\n\n')[1];
  await expect(editor).toHaveValue(segmentTarget);
  const apply = noHit.getByRole('button', { name: S.reviseApply, exact: true });
  await expect(apply).toBeDisabled();
  const revised = segmentTarget.replace('The traveler turned back.', 'Camellya turned back.');
  await editor.fill(revised);
  await expect(apply).toBeEnabled();
  await apply.click();
  const full = manuscript.target.split('\n\n');
  full[1] = revised;
  await expect(target(page)).toHaveValue(full.join('\n\n'));
  await expect(page.locator('.notice-state')).toHaveText(S.notices.longSegmentRevised);
  await expect(status(page)).toHaveText(fill(S.phaseTermDoneRecheck, { n: 1 }));
  await page.getByRole('button', { name: M.review.undo, exact: true }).click();
  await expect(status(page)).toHaveText(S.phaseTermDone);
  await expect(target(page)).toHaveValue(manuscript.target);
  // The editor closes with Cancel and changes nothing.
  await places(groupOf(page, '椿')).nth(1).getByRole('button', { name: S.occRevise, exact: true }).click();
  await places(groupOf(page, '椿')).nth(1).getByRole('button', { name: S.reviseCancel, exact: true }).click();
  await expect(page.locator('.term-revise')).toHaveCount(0);
  await expect(target(page)).toHaveValue(manuscript.target);
});

test('the banner counts the segments that were not paired, keeps the layout and jumps to the first one that needs a manual split', async ({ page }) => {
  const rec = await open(page);
  const manuscript = camellyaManuscript();
  const banner = page.locator('.mismatch-banner');
  await expect(banner).toHaveCount(0);
  await load(page, manuscript, 5);
  await expect(banner).toBeVisible();
  await expect(banner).toHaveAttribute('data-mismatch-count', '1');
  await expect(banner.locator('.mismatch-title')).toHaveText(fill(S.mismatchTitle, { n: 1 }));
  await expect(banner).toContainText(S.mismatchBody);
  await expect(banner.locator('.track-note')).toHaveText(fill(S.mismatchList, { list: '5' }));
  // Nothing was regrouped by force: the translation is exactly what was typed, and no request was sent.
  await expect(target(page)).toHaveValue(manuscript.target);
  expect(rec.reviews).toHaveLength(0);
  await expect(page.locator('.split-helper')).toHaveCount(0);
  await banner.getByRole('button', { name: S.mismatchJump, exact: true }).click();
  const helper = page.locator('.split-helper');
  await expect(helper).toBeVisible();
  await expect(helper).toBeFocused();
  await expect(page.locator('.segment-chip[data-current="true"]')).toHaveCount(1);
  await expect(chips(page).nth(4)).toHaveAttribute('data-current', 'true');
  // Resolving the mismatch (a blank line in the right place) is the user's edit, and the banner follows it.
  await expect(chips(page).nth(4).getByRole('button', { name: S.manualClose, exact: true })).toBeVisible();
});

test('a saved manuscript with not_evaluated reasons is a v4 file, and reopening it shows the groups and the reasons again', async ({ page, context }) => {
  const rec = await open(page);
  await load(page, camellyaManuscript({ withMismatch: false }), 4);
  await check(page, rec, 4);
  const saved = await downloadFrom(page, M.review.save);
  const file = parseWorkfile(saved.text);
  expect(file.format).toBe('wuwaterm-manuscript-v4');
  const reasons = file.segments.flatMap(r => (r.result ? r.result.findings : [])).filter(f => Object.hasOwn(f, 'reason')).map(f => f.reason).sort();
  expect(reasons).toEqual(['no_target_region', 'not_a_term', 'ordinary_word']);
  const again = await context.newPage();
  await open(again);
  await again.getByLabel('选择稿件文件').setInputFiles({ name: 'manuscript.json', mimeType: 'application/json', buffer: Buffer.from(saved.text) });
  await expect(again.locator('.notice-state')).toContainText('已在本地恢复稿件');
  await expect(groups(again)).toHaveCount(3);
  await expect(again.locator('.finding-reason')).toHaveCount(3);
  // Saved results wait for the service before they count as current.
  await expect(places(groupOf(again, '椿')).first()).toHaveAttribute('data-term-state', 'saved');
  // No group of a saved manuscript reads confirmed before the live basis arrives: the saved places are to do, the group says so, and
  // the to do filter holds all three groups while the confirmed filter holds none.
  expect(await groups(again).evaluateAll(list => list.map(el => [el.getAttribute('data-group-surface'), el.getAttribute('data-group-status')])))
    .toEqual([['椿', 'inconsistent'], ['声骸', 'pending'], ['今汐', 'pending']]);
  await expect(groupOf(again, '椿')).toHaveAttribute('data-group-saved', '5');
  await expect(groupOf(again, '今汐')).toHaveAttribute('data-group-saved', '1');
  await expect(groupOf(again, '今汐').locator('.term-group-saved')).toHaveText(S.groupSaved);
  await expect(groupOf(again, '今汐').locator('.term-group-tally')).toHaveAttribute('data-pending', '1');
  await expect(groupOf(again, '今汐').locator('.term-group-tally')).toHaveAttribute('data-confirmed', '0');
  await expect(filterButton(again, 'pending')).toHaveAttribute('data-group-count', '3');
  await expect(filterButton(again, 'confirmed')).toHaveAttribute('data-group-count', '0');
  await filterButton(again, 'pending').click();
  await expect(groups(again)).toHaveCount(3);
  await filterButton(again, 'confirmed').click();
  await expect(groups(again)).toHaveCount(0);
});

test('a segment with more than 32 findings is stored, grouped place by place and saved as a v4 file', async ({ page }) => {
  const rec = await open(page);
  await load(page, denseManuscript(), 3);
  await check(page, rec, 3);
  // One answer of 52 findings is a valid, stored result (the v3 cap of 32 would have refused it).
  await expect(page.locator('.error-panel')).toHaveCount(0);
  expect(await chips(page).evaluateAll(list => list.map(li => li.getAttribute('data-term-state')))).toEqual(['current', 'current', 'current']);
  const camellya = groupOf(page, '椿');
  await expect(camellya).toHaveAttribute('data-group-status', 'inconsistent');
  await expect(camellya.locator('.term-group-meta')).toHaveText(fill(S.groupHead, { n: 52, segments: '1' }));
  await expect(camellya.locator('.term-group-renderings')).toHaveText(fill(S.groupRenderings, { items: `Camellya ×48 · ${S.renderingNone} ×4` }));
  await expect(places(camellya)).toHaveCount(52);
  const saved = parseWorkfile((await downloadFrom(page, M.review.save)).text);
  // More than 32 findings alone make the file v4 (no reason is involved).
  expect(saved.format).toBe('wuwaterm-manuscript-v4');
  expect(saved.segments[0].result.findings).toHaveLength(52);
  expect(saved.segments[0].result.findings.some(f => Object.hasOwn(f, 'reason'))).toBe(false);
});

test('a truncated document report says why: the count (128) and the response size (64 KiB) and what to do', async ({ page }) => {
  await openWorkbench(page, { capabilities: [], reviewTruncated: () => true });
  await fillPair(page, '今汐。\n声骸。', 'Jinhsi.\nEcho.');
  await page.getByRole('button', { name: M.review.checkIdle, exact: true }).click();
  const note = page.locator('.review-truncated-note');
  await expect(note).toHaveText(M.review.truncatedNote);
  expect(M.review.truncatedNote).toContain('128');
  expect(M.review.truncatedNote).toContain('64 KiB');
});
