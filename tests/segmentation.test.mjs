import assert from 'node:assert/strict';
import test from 'node:test';
import { guardPairForRequest, pairSegments, segmentText } from '../lib/segmentation.js';

const sliceBy = (text, spans) => {
  const chars = Array.from(text);
  return spans.map(([a, b]) => chars.slice(a, b).join('')).join('');
};

test('segments partition text with emoji and CRLF', () => {
  const text = '你好😀世界。\r\n\r\nSecond 😀 paragraph.\r\n';
  const segments = segmentText(text, 10);
  assert.ok(segments.length > 1);
  assert.equal(sliceBy(text, segments.map(s => [s.start, s.end])), text);
  for (const s of segments) assert.ok(s.core_end - s.core_start <= 10);
});

test('empty input yields no segments or pairs', () => {
  assert.deepEqual(segmentText(''), []);
  assert.deepEqual(pairSegments('', ''), []);
  assert.deepEqual(pairSegments(' \n', '\t'), []);
});

test('pairs partition both sides and honour the limit', () => {
  const source = 'A 😀 b. C d. E f.';
  const target = '甲😀乙。丙丁。戊己。';
  const pairs = pairSegments(source, target, 8);
  assert.equal(sliceBy(source, pairs.map(p => [p.source.start, p.source.end])), source);
  assert.equal(sliceBy(target, pairs.map(p => [p.target.start, p.target.end])), target);
});

test('guardPairForRequest downgrades an oversized ready pair', () => {
  const region = (a, b) => ({ start: a, end: b, core_start: a, core_end: b });
  const ready = { index: 0, status: 'ready', hard_cut: false, source: region(0, 5), target: region(0, 5) };
  assert.equal(guardPairForRequest(ready, 5), ready);
  const guarded = guardPairForRequest(ready, 4);
  assert.equal(guarded.status, 'needs_manual_split');
  assert.equal(ready.status, 'ready');
  const manual = { ...ready, status: 'untranslated' };
  assert.equal(guardPairForRequest(manual, 1), manual);
});
