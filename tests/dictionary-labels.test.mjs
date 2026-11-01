import assert from 'node:assert/strict';
import test from 'node:test';

import { categoryLabel, reasonLabel } from '../lib/dictionary-labels.ts';
import { renderMarkdownReport, markdownStructure } from '../lib/markdown-report.ts';
import { fixture } from './fixtures/manuscript.mjs';

test('English labels are the planned words, and only an exact key is translated', () => {
  const englishCategories = {
    core_term: 'Core term',
    resonator: 'Resonator',
    weapon: 'Weapon',
    echo: 'Echo',
    skill: 'Skill',
    sonata_effect: 'Sonata effect',
    location: 'Location',
    item: 'Item',
    speaker: 'Speaker',
  };
  for (const [key, text] of Object.entries(englishCategories)) {
    assert.equal(categoryLabel('en', key), text);
    assert.notEqual(text, key);
  }
  assert.equal(reasonLabel('en', 'pinyin-abbrev'), 'Pinyin abbreviation');
  assert.equal(reasonLabel('zh', 'pinyin-abbrev'), '拼音缩写');
  for (const value of [' item ', '<b>cat</b>', 'character', 'Echo', 'not_a_reason']) {
    assert.equal(categoryLabel('zh', value), value);
    assert.equal(categoryLabel('en', value), value);
    assert.equal(reasonLabel('zh', value), value);
    assert.equal(reasonLabel('en', value), value);
  }
});

function inputFor(latest) {
  return {
    draft: { source: latest.source, target: latest.target, direction: 'en' },
    latest, previous: null, currency: 'current', choices: [], reconciled: [], comparison: null,
  };
}

test('Markdown labels known categories and still escapes unknown ones', () => {
  const base = fixture('声骸。', 'Echo.', 'en');
  const report = structuredClone(base.report);
  report.findings[0].candidates[0].category = 'item';
  report.findings[0].candidates.push({
    ...report.findings[0].candidates[0],
    candidate_id: 'e'.repeat(64),
    zh: ' 声骸 ',
    en: ' Echo ',
    category: ' item ',
  });
  report.findings[0].candidates.push({
    ...report.findings[0].candidates[0],
    candidate_id: 'f'.repeat(64),
    zh: '声骸',
    en: 'Echo',
    category: '<b>cat</b>',
  });
  const latest = { source: base.source, target: base.target, direction: 'en', report, resolutions: null };
  const zh = renderMarkdownReport(inputFor(latest), 'zh');
  assert.equal(zh.includes('类别：`物品`'), true);
  assert.equal(zh.includes('`  item  `'), true);
  assert.equal(zh.includes('<b>cat</b>'), true);
  assert.equal(markdownStructure(zh).htmlTags, 0);
  const en = renderMarkdownReport(inputFor(latest), 'en');
  assert.equal(en.includes('Category: `Item`'), true);
  assert.equal(en.includes('`  item  `'), true);
  assert.equal(en.includes('类别：'), false);
});
