import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  BOUNDARY_PUNCTUATION,
  HARD_CUT_WINDOW,
  SEGMENTATION_VERSION,
  SEGMENT_LIMIT,
  WHITESPACE,
  guardPairForRequest,
  pairSegments,
  segmentText,
} from '../../lib/segmentation.js';

const root = process.env.WUWATERM_BACKEND_ROOT;
assert.ok(root, 'Set WUWATERM_BACKEND_ROOT to the pinned backend checkout');
const fixture = JSON.parse(readFileSync(join(root, 'contracts', 'segmentation-v1.json'), 'utf8'));

const join_ = (text, spans) => {
  const chars = Array.from(text);
  return spans.map(([a, b]) => chars.slice(a, b).join('')).join('');
};

test('constants match the fixture', () => {
  assert.equal(SEGMENTATION_VERSION, fixture.version);
  assert.equal(SEGMENT_LIMIT, fixture.limit);
  assert.equal(HARD_CUT_WINDOW, fixture.hard_cut_window);
  assert.equal(BOUNDARY_PUNCTUATION, fixture.boundary_punctuation);
  assert.deepEqual([...WHITESPACE].sort((a, b) => a - b), [...fixture.whitespace].sort((a, b) => a - b));
});

test('segment cases match', () => {
  assert.equal(fixture.segment_cases.length, 20);
  for (const c of fixture.segment_cases) {
    const got = segmentText(c.text, fixture.limit);
    assert.deepEqual(got, c.segments, c.name);
    assert.equal(join_(c.text, got.map(s => [s.start, s.end])), c.text, c.name);
  }
});

test('pair cases match', () => {
  assert.equal(fixture.pair_cases.length, 20);
  for (const c of fixture.pair_cases) {
    const got = pairSegments(c.source, c.target, fixture.limit, c.alignments ?? null);
    assert.deepEqual(got, c.pairs, c.name);
    for (const pair of got) {
      if (pair.status !== 'ready') continue;
      for (const side of [pair.source, pair.target]) {
        const len = side.core_end - side.core_start;
        assert.ok(len > 0 && len <= fixture.limit, `${c.name}: ready core length`);
      }
      assert.equal(guardPairForRequest(pair, fixture.limit), pair, c.name);
    }
    if (got.length) {
      assert.equal(join_(c.source, got.map(p => [p.source.start, p.source.end])), c.source, c.name);
      assert.equal(join_(c.target, got.map(p => [p.target.start, p.target.end])), c.target, c.name);
    }
  }
});
