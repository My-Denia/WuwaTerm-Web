// The layered review in the document workspace: layer 1 structure checks (no model, never saved), layer 2 semantic issues bucketed
// by confidence and deduplicated against layer 1, the reserved layer 3, and ambiguous single characters (ambiguous-mention-v1)
// folded apart from the judged term findings. Public game terms; every /api route is a local fake.
import { test, expect } from '@playwright/test';
import { msg } from '../../lib/messages.ts';
import { parseWorkfile } from '../../lib/manuscript.js';
import { dictionary, hash } from '../fixtures/manuscript.mjs';
import { FRESH_MATCHER_REVISION } from '../fixtures/manuscript.mjs';
import { S, downloadFrom, fill, fillPair, openWorkbench, rng, semanticResponse } from '../helpers/semantic-routes.mjs';

const M = msg('zh');
const L = S.layers;
const CAPS = ['ambiguous-mention-v1', 'semantic-review-v1', 'structure-check-v1'];
const SOURCE = '今汐、椿姐、守岸人一起出发。途中获得 3 个声骸。';
const TARGET = 'Jinhsi, Camellya and the Shorekeeper set out. On the way they obtain Echoes.';

const spanOf = (text, needle) => { const [start, end] = rng(text, needle); return { start, end, text: needle }; };
const candidate = (zh, en, category) => ({ zh, en, category, candidate_id: hash(`candidate:${zh}`), sources: [{ source_file: 'Synthetic.json', source_id: `synthetic_${en}` }] });
const finding = (source, target, needle, rendering, verdict, term, reason) => {
  const s = spanOf(source, needle);
  return { id: `${s.start}:${s.end}:${needle}`, rule_id: 'review.term_pair', verdict, source_span: s, target_span: rendering ? spanOf(target, rendering) : null,
    candidates: [term], candidates_truncated: false, ...(reason ? { reason } : {}) };
};
// A review-v2 answer sent with ambiguous-mention-v1: three judged names, then the unsettled 椿 (after the judged ones, as Core sorts it).
function reviewReport(body) {
  const { source, target } = body;
  const judged = [
    finding(source, target, '今汐', 'Jinhsi', 'verified_constraint', candidate('今汐', 'Jinhsi', 'resonator')),
    finding(source, target, '守岸人', 'Shorekeeper', 'verified_constraint', candidate('守岸人', 'Shorekeeper', 'resonator')),
    finding(source, target, '声骸', 'Echoes', 'verified_constraint', candidate('声骸', 'Echo', 'item')),
  ].sort((a, b) => a.source_span.start - b.source_span.start);
  const ambiguous = finding(source, target, '椿', null, 'not_evaluated', candidate('椿', 'Camellya', 'resonator'), 'ambiguous_mention');
  return {
    request_id: 'synthetic-review', source_revision: hash(source), target_revision: hash(target), rule_version: 'review-v2', matcher_revision: FRESH_MATCHER_REVISION,
    dictionary, coverage: { evaluated: 3, not_evaluated: 1, rules: ['review.term_pair', 'review.sentence_meaning'] }, findings: [...judged, ambiguous], truncated: false,
  };
}
// Layer 1: the 3 of 3 个声骸 is missing from the translation.
const structure = body => ({
  request_id: 'synthetic-structure', check_version: 'structure-check-v1', checks: ['empty_target', 'numbers', 'placeholders', 'paragraphs'],
  segments: body.segments.map((segment, index) => ({
    index, segment_id: segment.segment_id, omitted_findings: 0, layout: { source_paragraphs: 1, target_paragraphs: 1, source_lines: 1, target_lines: 1 },
    findings: segment.source.includes('3') ? [{ rule_id: 'number_missing', source_span: spanOf(segment.source, '3'), target_span: null }] : [],
  })),
});
// Layer 2: a quantity change on that same number (layer 1 already shows it), a medium meaning shift and a low reference issue.
const semantic = request => semanticResponse(request, [
  { category: 'quantity_change', source: rng(request.source, '3 个声骸'), target: rng(request.target, 'Echoes'), confidence: 'high', rationale: 'The number of Echoes is missing.' },
  { category: 'meaning_shift', source: rng(request.source, '一起出发'), target: rng(request.target, 'set out'), confidence: 'medium', rationale: 'Together is not rendered.' },
  { category: 'reference_inconsistency', source: rng(request.source, '途中'), target: rng(request.target, 'On the way'), confidence: 'low', rationale: 'Possibly fine.' },
]);

const open = page => openWorkbench(page, { capabilities: CAPS, reviewReport, structure, respond: semantic });

test('three layers: structure findings first, semantic issues bucketed and deduplicated, style reserved and off', async ({ page }) => {
  const rec = await open(page);
  await fillPair(page, SOURCE, TARGET);
  const layer1 = page.locator('.layer-structure');
  await expect(layer1.getByRole('heading', { name: L.l1Title })).toBeVisible();
  await layer1.getByRole('button', { name: fill(L.l1Run, { n: 1 }), exact: true }).click();
  await expect(layer1.locator('.structure-finding[data-rule="number_missing"]')).toContainText(L.rules.number_missing);
  await expect(layer1.locator('.structure-status')).toContainText(fill(L.l1Summary, { checked: 1, segments: 1, n: 1 }));
  expect(rec.structure).toHaveLength(1);
  expect(rec.structure[0].segments[0]).toEqual({ segment_id: 's0', source: SOURCE, target: TARGET });

  await page.getByRole('button', { name: S.start, exact: true }).click();
  const track = page.locator('.semantic-track');
  await expect(track.locator('.layer-kicker')).toHaveText(L.l2Title);
  // The quantity change restates layer 1's missing number: shown once, there.
  await expect(track.locator('.layer-covered')).toHaveText(fill(L.l2Covered, { n: 1 }));
  const items = track.locator('.semantic-items .semantic-item');
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText(S.categories.meaning_shift);
  const low = track.locator('.low-confidence-toggle');
  await expect(low).toHaveText(fill(L.l2LowShow, { n: 1 }));
  await low.click();
  await expect(items).toHaveCount(2);
  await expect(items.last()).toContainText(S.categories.reference_inconsistency);
  await low.click();
  await expect(items).toHaveCount(1);

  const layer3 = page.locator('.layer-style');
  const toggle = layer3.getByRole('checkbox', { name: L.l3Toggle });
  await expect(toggle).not.toBeChecked();
  await expect(layer3).toContainText(L.l3Off);
  const before = rec.semantic.length + rec.reviews.length + rec.structure.length + rec.translations.length;
  await toggle.check();
  await expect(layer3).toContainText(L.l3On);
  expect(rec.semantic.length + rec.reviews.length + rec.structure.length + rec.translations.length).toBe(before);
});

test('an ambiguous single character is folded after the judged findings, not counted, and can be adopted or ignored', async ({ page }) => {
  const rec = await open(page);
  await fillPair(page, SOURCE, TARGET);
  await page.getByRole('button', { name: M.review.checkIdle, exact: true }).click();
  await expect.poll(() => rec.reviews.length).toBe(1);
  expect(rec.reviewHeaders[0]['x-wuwaterm-review-features']).toBe('dense-128,reason-v1,ambiguous-mention-v1');
  const track = page.locator('.term-track');
  await expect(track.locator('.review-findings article.term-result')).toHaveCount(3);
  await expect(track.getByRole('button', { name: `${M.review.filters.all} 3`, exact: true })).toBeVisible();
  await expect(track.getByRole('button', { name: `${M.review.filters.not_evaluated} 0`, exact: true })).toBeVisible();
  const folded = track.locator('details.ambiguous-mentions');
  await expect(folded).toHaveAttribute('data-count', '1');
  await expect(folded).not.toHaveAttribute('open', '');
  await expect(folded.locator('summary')).toHaveText(fill(S.ambiguous.title, { n: 1 }));
  await folded.locator('summary').click();
  await folded.getByRole('button', { name: fill(S.ambiguous.adopt, { zh: '椿', en: 'Camellya' }), exact: true }).click();
  await expect(page.locator('.choice-records')).toContainText('椿');
  // The next check sends the adoption as a resolution, with the feature still asked for.
  await page.getByRole('button', { name: M.review.checkIdle, exact: true }).click();
  await expect.poll(() => rec.reviews.length).toBe(2);
  expect(rec.reviews[1].resolutions).toEqual([{ mention_id: `${rng(SOURCE, '椿')[0]}:${rng(SOURCE, '椿')[1]}:椿`, choice: 'official_pair', candidate_id: hash('candidate:椿') }]);
  expect(rec.reviewHeaders[1]['x-wuwaterm-review-features']).toBe('dense-128,reason-v1,ambiguous-mention-v1');

  // The saved file is v5: it records the feature, keeps the ambiguous finding and holds no structure finding.
  await page.locator('.layer-structure').getByRole('button', { name: fill(L.l1Run, { n: 1 }), exact: true }).click();
  await expect(page.locator('.structure-finding')).toHaveCount(1);
  const saved = await downloadFrom(page, M.review.save);
  const file = parseWorkfile(saved.text);
  expect(file.format).toBe('wuwaterm-manuscript-v5');
  expect(file.review_features).toEqual(['ambiguous-mention-v1']);
  expect(file.history.at(-1).report.findings.at(-1).reason).toBe('ambiguous_mention');
  expect(saved.text.includes('number_missing')).toBe(false);
  expect(saved.text.includes('structure-check')).toBe(false);
});

test('without the capabilities the layers stay out of the way: no layer 1 panel, no feature header', async ({ page }) => {
  const rec = await openWorkbench(page, { capabilities: ['semantic-review-v1'], reviewReport: body => {
    const report = reviewReport(body);
    return { ...report, findings: report.findings.filter(f => !f.reason), coverage: { ...report.coverage, not_evaluated: 0 } };
  } });
  await fillPair(page, SOURCE, TARGET);
  await expect(page.locator('.layer-structure')).toHaveCount(0);
  await expect(page.locator('.layer-style')).toBeVisible();
  await page.getByRole('button', { name: M.review.checkIdle, exact: true }).click();
  await expect.poll(() => rec.reviews.length).toBe(1);
  expect(rec.reviewHeaders[0]['x-wuwaterm-review-features']).toBe('dense-128,reason-v1');
  await expect(page.locator('details.ambiguous-mentions')).toHaveCount(0);
});

test('the layered review keeps nothing in browser storage', async ({ page }) => {
  await open(page);
  await fillPair(page, SOURCE, TARGET);
  await page.locator('.layer-structure').getByRole('button', { name: fill(L.l1Run, { n: 1 }), exact: true }).click();
  await expect(page.locator('.structure-finding')).toHaveCount(1);
  await page.locator('.layer-style').getByRole('checkbox', { name: L.l3Toggle }).check();
  const stored = await page.evaluate(async () => ({
    local: Object.keys(localStorage).length,
    session: Object.keys(sessionStorage).length,
    databases: typeof indexedDB.databases === 'function' ? (await indexedDB.databases()).length : 0,
  }));
  expect(stored).toEqual({ local: 0, session: 0, databases: 0 });
});
