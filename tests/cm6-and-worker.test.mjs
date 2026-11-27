import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  applyDomChangesToRaw,
  domOffset,
  domUtf16ToScalar,
  normalizeLineBreaks,
  rawOffset,
  rawSpanFromDomRange,
  scalarToDomUtf16,
} from '../lib/editor-coords.ts';
import {
  createCanonicalComputer,
  shouldOffloadCanonicalToWorker,
  WORKER_OFFLOAD_CHAR_THRESHOLD,
} from '../lib/canonical-worker-client.ts';
import { canonicalOf, createWorkbenchController, EMPTY_DRAFT } from '../lib/workbench-controller.ts';
import { serializeWorkfile } from '../lib/manuscript.js';
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

test('applyDomChangesToRaw preserves CRLF bytes on untouched paragraphs and keeps all 3 alignments intact', async () => {
  const rawSource = '甲一。\r\n\r\n甲二。\r\n\r\n甲三。';
  const rawTarget = 'One.\r\n\r\nTwo.\r\n\r\nThree.';
  const s1 = { start: 0, end: 3, text: '甲一。' };
  const s2 = { start: 7, end: 10, text: '甲二。' };
  const s3 = { start: 14, end: 17, text: '甲三。' };
  const t1 = { start: 0, end: 4, text: 'One.' };
  const t2 = { start: 8, end: 12, text: 'Two.' };
  const t3 = { start: 16, end: 22, text: 'Three.' };

  // Appending '!' at the end of the LF-normalized CM6 document must keep every untouched \r\n\r\n intact.
  const domEnd = normalizeLineBreaks(rawSource).length;
  const nextRaw = applyDomChangesToRaw(rawSource, [{ fromA: domEnd, toA: domEnd, inserted: '!' }]);
  assert.equal(nextRaw, '甲一。\r\n\r\n甲二。\r\n\r\n甲三。!');

  // Applying that edit through the workbench controller keeps all 3 alignments and preserves CRLF on save.
  const doc = createWorkbenchController({ onPoolRefresh: () => {} });
  const workfile = serializeWorkfile({
    source: rawSource,
    target: rawTarget,
    direction: 'en',
    alignments: [
      { source: s1, target: t1 },
      { source: s2, target: t2 },
      { source: s3, target: t3 },
    ],
    choices: [],
    history: [],
  });
  await doc.importFile({ name: 'crlf.json', size: Buffer.byteLength(workfile), arrayBuffer: async () => Buffer.from(workfile) });
  assert.equal(doc.getSnapshot().draft.alignments.length, 3);
  doc.editText('source', nextRaw);
  const after = doc.getSnapshot();
  assert.equal(after.draft.source, '甲一。\r\n\r\n甲二。\r\n\r\n甲三。!');
  assert.equal(after.draft.alignments.length, 3);
  const saved = JSON.parse(doc.save().content);
  assert.equal(saved.source, '甲一。\r\n\r\n甲二。\r\n\r\n甲三。!');
  assert.equal(saved.alignments.length, 3);
  doc.dispose();
});

test('createCanonicalComputer keeps small drafts off Worker and falls back to synchronous canonicalOf on async Worker error', async () => {
  const smallInput = {
    draft: { ...EMPTY_DRAFT, source: '今汐。', target: 'Jinhsi.' },
    choices: [],
    reports: [],
    semantic: emptySemantic(),
    basis: null,
  };
  assert.equal(shouldOffloadCanonicalToWorker(smallInput), false);

  let spawned = 0;
  let errorListener = null;
  let terminated = 0;
  const mockWorker = {
    addEventListener(type, fn) {
      if (type === 'error') errorListener = fn;
    },
    postMessage() {
      // Simulate async worker script/runtime failure while request is in flight.
      queueMicrotask(() => errorListener?.(new Event('error')));
    },
    terminate() {
      terminated += 1;
    },
  };

  const computer = createCanonicalComputer({
    workerFactory: () => {
      spawned += 1;
      return mockWorker;
    },
  });

  // Small draft must NOT spawn a Worker (zero static worker network fetch in quick mode).
  const expectedSmall = canonicalOf(smallInput.draft, smallInput.choices, smallInput.reports, smallInput.semantic, smallInput.basis);
  assert.equal(computer.computeSync(smallInput), expectedSmall);
  assert.equal(await computer.compute(smallInput), expectedSmall);
  assert.equal(spawned, 0);

  // Large draft crosses offload threshold -> spawns Worker; async Worker `error` must
  // resolve the in-flight promise with real canonicalOf() (never null!).
  const largeInput = {
    draft: { ...EMPTY_DRAFT, source: '今汐。'.repeat(Math.ceil(WORKER_OFFLOAD_CHAR_THRESHOLD / 3) + 10), target: 'Jinhsi. '.repeat(200) },
    choices: [],
    reports: [],
    semantic: emptySemantic(),
    basis: null,
  };
  assert.equal(shouldOffloadCanonicalToWorker(largeInput), true);
  const expectedLarge = canonicalOf(largeInput.draft, largeInput.choices, largeInput.reports, largeInput.semantic, largeInput.basis);
  assert.notEqual(expectedLarge, null);
  const resolved = await computer.compute(largeInput);
  assert.equal(resolved, expectedLarge);
  assert.equal(spawned, 1);
  assert.equal(terminated, 1);

  // Subsequent call uses fallback without spawning a second broken Worker.
  assert.equal(await computer.compute(largeInput), expectedLarge);
  assert.equal(spawned, 1);

  computer.dispose();
  assert.equal(await computer.compute(smallInput), null);
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
