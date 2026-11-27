import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  applyDomChangesToRaw,
  diffDomChange,
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

test('applyDomChangesToRaw holds normalizeLineBreaks(result) === expectedDom across all CR/LF/CRLF boundaries', () => {
  const applyDom = (dom, changes) => {
    let out = '';
    let cur = 0;
    for (const c of changes) {
      out += dom.slice(cur, c.fromA) + c.inserted;
      cur = c.toA;
    }
    return out + dom.slice(cur);
  };

  // Explicit standalone-CR regression cases:
  // 1) Pressing Enter right after standalone \r in "A\rB" must not fuse into \r\n.
  const crEnter = applyDomChangesToRaw('A\rB', [{ fromA: 2, toA: 2, inserted: '\n' }]);
  assert.equal(normalizeLineBreaks(crEnter), 'A\n\nB');
  // 2) Deleting 'x' between \r and \n in "A\rx\nB" must not fuse into \r\n.
  const crDel = applyDomChangesToRaw('A\rx\nB', [{ fromA: 2, toA: 3, inserted: '' }]);
  assert.equal(normalizeLineBreaks(crDel), 'A\n\nB');
  // 3) Inserting '\n' after intact CRLF preserves the CRLF bytes and adds one newline.
  const crlfEnter = applyDomChangesToRaw('A\r\nB', [{ fromA: 2, toA: 2, inserted: '\n' }]);
  assert.equal(crlfEnter, 'A\r\n\nB');
  assert.equal(normalizeLineBreaks(crlfEnter), 'A\n\nB');

  // Combinatorial sweep over mixed \r / \n / \r\n / emoji texts with inserts, Enter, deletes, and multi-edits.
  const samples = [
    'A\rB',
    'A\nB',
    'A\r\nB',
    '\r\n',
    '\r\r\n\n',
    'A\rx\nB\r\nC\rD',
    '😀\r\n今汐\rx\n声骸\r',
  ];
  const inserts = ['', '!', '\n', '\n\n', 'x\n', '\nx'];
  for (const raw of samples) {
    const dom = normalizeLineBreaks(raw);
    assert.equal(diffDomChange(dom, dom), null);
    for (let fromA = 0; fromA <= dom.length; fromA += 1) {
      for (let toA = fromA; toA <= dom.length; toA += 1) {
        for (const inserted of inserts) {
          const changes = [{ fromA, toA, inserted }];
          const expectedDom = applyDom(dom, changes);
          const actualRaw = applyDomChangesToRaw(raw, changes);
          assert.notEqual(actualRaw, null);
          assert.equal(
            normalizeLineBreaks(actualRaw),
            expectedDom,
            `invariant violated for raw=${JSON.stringify(raw)} change=${JSON.stringify(changes)} -> ${JSON.stringify(actualRaw)}`,
          );
        }
      }
    }
  }
});

test('deferred compositionend commit (ni -> 你 and cross-line replacement) is a single undo step', () => {
  const doc = createWorkbenchController({ onPoolRefresh: () => {} });

  // 1) Deferred ni -> 你 commit at compositionend.
  doc.editText('source', 'Alpha');
  doc.editText('source', 'Alphan', { composing: true });
  doc.editText('source', 'Alphani', { composing: true });
  // Final commit arrives after compositionend via deferred updateListener with composing: false.
  doc.editText('source', 'Alpha你', { composing: false });
  assert.equal(doc.getSnapshot().draft.source, 'Alpha你');
  doc.undo();
  assert.equal(doc.getSnapshot().draft.source, 'Alpha');

  // 2) Cross-line selection deletion starts inside composition, followed by n -> ni -> 你.
  doc.editText('source', 'Line1\nLine2');
  doc.editText('source', '', { composing: true });
  doc.editText('source', 'n', { composing: true });
  doc.editText('source', 'ni', { composing: true });
  doc.editText('source', '你', { composing: false });
  assert.equal(doc.getSnapshot().draft.source, '你');
  doc.undo();
  assert.equal(doc.getSnapshot().draft.source, 'Line1\nLine2');
  doc.dispose();
});

test('createCanonicalComputer keeps small drafts off Worker (before and after Worker spawn) and falls back on async Worker error', async () => {
  const smallInput = {
    draft: { ...EMPTY_DRAFT, source: '今汐。', target: 'Jinhsi.' },
    choices: [],
    reports: [],
    semantic: emptySemantic(),
    basis: null,
  };
  assert.equal(shouldOffloadCanonicalToWorker(smallInput), false);

  let spawned = 0;
  let posted = 0;
  let messageListener = null;
  let errorListener = null;
  let terminated = 0;
  let failNextPost = false;
  const mockWorker = {
    addEventListener(type, fn) {
      if (type === 'message') messageListener = fn;
      if (type === 'error') errorListener = fn;
    },
    postMessage(payload) {
      posted += 1;
      if (failNextPost) {
        queueMicrotask(() => errorListener?.(new Event('error')));
        return;
      }
      const canonical = canonicalOf(payload.draft, payload.choices, payload.reports, payload.semantic, payload.basis);
      queueMicrotask(() => messageListener?.({ data: { id: payload.id, canonical } }));
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
  assert.equal(posted, 0);

  // Large draft crosses offload threshold -> spawns Worker and posts once.
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
  assert.equal(await computer.compute(largeInput), expectedLarge);
  assert.equal(spawned, 1);
  assert.equal(posted, 1);

  // Returning to a small draft after Worker creation must bypass postMessage and run locally.
  assert.equal(await computer.compute(smallInput), expectedSmall);
  assert.equal(posted, 1);

  // Async Worker `error` while a large request is in flight must resolve with real canonicalOf() (never null!).
  failNextPost = true;
  const resolved = await computer.compute(largeInput);
  assert.equal(resolved, expectedLarge);
  assert.equal(spawned, 1);
  assert.equal(posted, 2);
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
