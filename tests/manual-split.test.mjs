import assert from 'node:assert/strict';
import test from 'node:test';

import { insertParagraphBreak, mergeParagraphs, pairShape, splitLayout } from '../lib/manual-split.js';
import { pairSegments } from '../lib/segmentation.js';

const LIMIT = 100;
const statuses = pairs => pairs.map(p => p.status);
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

const EN = [
  'The first synthetic paragraph describes a quiet harbor at dawn. Boats rest by the pier.',
  'The second paragraph lists invented cargo. Crates of blue lanterns wait on the dock.',
  'The third paragraph ends the sample. Nobody is in a hurry.',
];
const ZH_A = '第一段是合成的内容，描写黎明时安静的港口。船只停在码头边。';
const ZH_B = '第二段列出虚构的货物。成箱的蓝色灯笼在码头上等待。';
const ZH_C = '第三段结束这个样例。没有人着急。';

test('splitLayout reports paragraphs, cores and sentences in whole-text scalar coordinates', () => {
  const text = `  ${ZH_A}\n\n${ZH_B}  `;
  const layout = splitLayout(text, { start: 0, end: Array.from(text).length });
  assert.equal(layout.length, 2);
  assert.equal(Array.from(text).slice(layout[0].coreStart, layout[0].coreEnd).join(''), ZH_A);
  assert.equal(layout[0].length, Array.from(ZH_A).length);
  assert.equal(layout[0].sentences.length, 2);
  assert.equal(Array.from(text).slice(layout[1].coreStart, layout[1].coreEnd).join(''), ZH_B);
  assert.equal(layout[1].end, Array.from(text).length);
  // A sub-region keeps whole-text coordinates.
  const second = splitLayout(text, { start: layout[1].start, end: layout[1].end });
  assert.equal(second[0].coreStart, layout[1].coreStart);
});

test('inserting a break turns needs_manual_split into ready pairs', () => {
  const source = EN.join('\n\n');
  const target = `${ZH_A}\n\n${ZH_B}${ZH_C}`;
  assert.deepEqual(statuses(pairSegments(source, target, LIMIT)), ['needs_manual_split']);
  const layout = splitLayout(target, { start: 0, end: Array.from(target).length });
  assert.equal(layout.length, 2);
  const at = layout[1].sentences[2].start;
  const result = insertParagraphBreak(target, at);
  assert.ok(result);
  assert.equal(result.text, `${ZH_A}\n\n${ZH_B}\n\n${ZH_C}`);
  const pairs = pairSegments(source, result.text, LIMIT);
  assert.equal(pairs.length, 3);
  assert.deepEqual(statuses(pairs), ['ready', 'ready', 'ready']);
  assert.deepEqual(pairShape(source, result.text, pairs[2]).targetParagraphs, 1);
});

test('merging a gap turns needs_manual_split into ready pairs', () => {
  const source = ['Short one here.', 'Short two here.', 'The last sample paragraph is a little longer than the others, still fine.'].join('\n\n');
  const target = '这里是第一小段。\n\n这里是第二小段。第三段稍长一些，但是依然合适。';
  assert.deepEqual(statuses(pairSegments(source, target, 80)), ['needs_manual_split']);
  const layout = splitLayout(source, { start: 0, end: Array.from(source).length });
  const merged = mergeParagraphs(source, layout[0].coreEnd, layout[1].coreStart);
  assert.ok(merged);
  assert.equal(merged.text.startsWith('Short one here. Short two here.'), true);
  const pairs = pairSegments(merged.text, target, 80);
  assert.deepEqual(statuses(pairs), ['ready', 'ready']);
});

test('merge joins with nothing next to CJK, a space otherwise, and refuses a plain line break', () => {
  assert.equal(mergeParagraphs('你好。\n\n世界。', 3, 5).text, '你好。世界。');
  assert.equal(mergeParagraphs('Hello.\n\nWorld.', 6, 8).text, 'Hello. World.');
  assert.equal(mergeParagraphs('Hello.\n\n世界。', 6, 8).text, 'Hello.世界。');
  assert.equal(mergeParagraphs('Hello.\nWorld.', 6, 7), null);
  assert.equal(mergeParagraphs('Hello.\n\nWorld.', 5, 8), null);
  const { splice } = mergeParagraphs('Hello.\n\nWorld.', 6, 8);
  assert.deepEqual(splice, { start: 6, oldEnd: 8, newEnd: 7 });
});

test('insertParagraphBreak trims blanks, reuses a line break, keeps CRLF and refuses existing blank lines', () => {
  assert.equal(insertParagraphBreak('One. Two.', 5).text, 'One.\n\nTwo.');
  assert.equal(insertParagraphBreak('One.\nTwo.', 5).text, 'One.\n\nTwo.');
  assert.equal(insertParagraphBreak('One.\n\nTwo.', 5), null);
  assert.equal(insertParagraphBreak('One.\n\nTwo.', 6), null);
  assert.equal(insertParagraphBreak('One.', 0), null);
  assert.equal(insertParagraphBreak('One.', 4), null);
  assert.equal(insertParagraphBreak('One.', 99), null);
  const crlf = insertParagraphBreak('One.\r\nTwo. Three.\r\nFour.', 11);
  assert.equal(crlf.text, 'One.\r\nTwo.\r\n\r\nThree.\r\nFour.');
  assert.equal(/(?<!\r)\n/u.test(crlf.text), false);
  assert.equal(insertParagraphBreak('A\tB', 2).text, 'A\n\nB');
});

test('scalar offsets never cut an emoji or surrogate pair', () => {
  const text = '😀😀 Hi. 😀 Bye.';
  const chars = Array.from(text);
  const at = chars.indexOf('😀', 3);
  const result = insertParagraphBreak(text, at);
  assert.equal(result.text, '😀😀 Hi.\n\n😀 Bye.');
  assert.equal(LONE.test(result.text), false);
  const layout = splitLayout(result.text, { start: 0, end: Array.from(result.text).length });
  assert.deepEqual(layout.map(p => Array.from(result.text).slice(p.coreStart, p.coreEnd).join('')), ['😀😀 Hi.', '😀 Bye.']);
  assert.equal(layout[0].length, 6);
  const merged = mergeParagraphs(result.text, layout[0].coreEnd, layout[1].coreStart);
  assert.equal(merged.text, '😀😀 Hi. 😀 Bye.');
  assert.equal(LONE.test(merged.text), false);
});

test('pairShape counts paragraphs, sentences and core lengths for a pair', () => {
  const source = 'One. Two.\n\nThree.';
  const target = '一。二。\n\n三。';
  const [pair] = pairSegments(source, target);
  const shape = pairShape(source, target, pair);
  assert.deepEqual(shape, { sourceParagraphs: 2, targetParagraphs: 2, sourceSentences: 3, targetSentences: 3,
    sourceLength: Array.from(source).length, targetLength: Array.from(target).length });
});

test('linesToParagraphs turns single breaks into blank lines and keeps words and line endings', async () => {
  const { linesToParagraphs, singleBreaks } = await import('../lib/manual-split.js');
  const { pairSegments } = await import('../lib/segmentation.js');
  assert.equal(linesToParagraphs('one\n\ntwo'), null);
  const lf = linesToParagraphs('one\ntwo  \n three\n\nfour');
  assert.deepEqual(lf, { text: 'one\n\ntwo  \n\n three\n\nfour', count: 2 });
  const crlf = linesToParagraphs('a\r\nb\r\n\r\nc');
  assert.deepEqual(crlf, { text: 'a\r\n\r\nb\r\n\r\nc', count: 1 });
  assert.equal(singleBreaks('x\ny\nz'), 2);
  // Lines on one side, blank-line paragraphs on the other: pairing works after the edit.
  const source = Array.from({ length: 3 }, (_, i) => `Line ${i} ${'word '.repeat(150)}`).join('\n\n');
  const target = Array.from({ length: 3 }, (_, i) => `行${i}${'字'.repeat(700)}`).join('\n');
  assert.equal(pairSegments(source, target).some(p => p.status === 'needs_manual_split'), true);
  const fixed = linesToParagraphs(target).text;
  assert.equal(pairSegments(source, fixed).every(p => p.status === 'ready'), true);
});
