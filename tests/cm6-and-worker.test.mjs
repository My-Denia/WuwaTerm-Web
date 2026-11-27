import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  domOffset,
  domUtf16ToScalar,
  normalizeLineBreaks,
  rawOffset,
  rawSpanFromDomRange,
  scalarToDomUtf16,
} from '../lib/editor-coords.ts';
import { createCanonicalComputer } from '../lib/canonical-worker-client.ts';
import { canonicalOf, EMPTY_DRAFT } from '../lib/workbench-controller.ts';
import { emptySemantic } from '../lib/semantic-state.js';

test('editor-coords round-trips CRLF, CR, CJK, and astral emoji scalar/UTF-16/DOM coordinates losslessly', () => {
  const raw = '  😀前\r\n今汐。\r声骸。  ';
  assert.equal(normalizeLineBreaks(raw), '  😀前\n今汐。\n声骸。  ');

  // '今汐' starts after '  ' (2) + '😀' (1 scalar, 2 UTF-16) + '前' (1) + '\r' (1) + '\n' (1) = scalar 6
  const scalarStart = Array.from(raw.slice(0, raw.indexOf('今汐'))).length;
  const scalarEnd = scalarStart + 2;
  const domStart = scalarToDomUtf16(raw, scalarStart);
  const domEnd = scalarToDomUtf16(raw, scalarEnd);
  assert.notEqual(domStart, null);
  assert.notEqual(domEnd, null);
  assert.equal(normalizeLineBreaks(raw).slice(domStart, domEnd), '今汐');
  assert.equal(domUtf16ToScalar(raw, domStart), scalarStart);
  assert.equal(domUtf16ToScalar(raw, domEnd), scalarEnd);

  // Full range selection preserves raw CRLF and CR bytes
  const norm = normalizeLineBreaks(raw);
  const full = rawSpanFromDomRange(raw, 0, norm.length);
  assert.deepEqual(full, { start: 0, end: Array.from(raw).length, text: raw });

  // Boundary guards
  assert.equal(rawOffset(raw, -1), null);
  assert.equal(rawOffset(raw, norm.length + 1), null);
  assert.equal(rawSpanFromDomRange(raw, 3, 3), null);
  assert.equal(domOffset(raw, raw.indexOf('声骸')), norm.indexOf('声骸'));
});

test('createCanonicalComputer async fallback matches canonicalOf and cleans up on dispose', async () => {
  const computer = createCanonicalComputer();
  const input = {
    draft: { ...EMPTY_DRAFT, source: '今汐。', target: 'Jinhsi.' },
    choices: [],
    reports: [],
    semantic: emptySemantic(),
    basis: null,
  };
  const expected = canonicalOf(input.draft, input.choices, input.reports, input.semantic, input.basis);
  assert.equal(computer.computeSync(input), expected);
  assert.equal(await computer.compute(input), expected);
  computer.dispose();
  assert.equal(await computer.compute(input), null);
});

test('split workbench controller submodules and worker libs have zero React imports', () => {
  const files = [
    '../lib/workbench-controller.ts',
    '../lib/workbench-store.ts',
    '../lib/workbench-document-ops.ts',
    '../lib/workbench-long-ops.ts',
    '../lib/workbench-batch-runner.ts',
    '../lib/workbench-tm-translate.ts',
    '../lib/workbench-workfile-io.ts',
    '../lib/editor-coords.ts',
    '../lib/canonical.worker.ts',
    '../lib/canonical-worker-client.ts',
  ];
  for (const rel of files) {
    const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    assert.equal(/\bfrom\s+['"]react['"]/u.test(src), false, `${rel} must not import react`);
    assert.equal(/\brequire\(\s*['"]react['"]\s*\)/u.test(src), false, `${rel} must not require react`);
  }
});
