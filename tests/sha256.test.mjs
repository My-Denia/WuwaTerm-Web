import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { revisionOf } from '../lib/review-report.js';
import { sha256Hex } from '../lib/sha256.js';

const reference = text => createHash('sha256').update(text, 'utf8').digest('hex');

test('sha256Hex equals node:crypto for ASCII, CJK and 4-byte scalars, at every length around the block boundaries', () => {
  for (const text of ['abc', 'The Sample Item lay still.', '示例名遇见了示例物。', '😀\u{10FFFF}\u{20000}x', 'mixed 示例 😀 text']) assert.equal(sha256Hex(text), reference(text), text);
  // 55, 56 and 64 bytes are where the padding needs a second block.
  for (let n = 0; n <= 130; n++) assert.equal(sha256Hex('a'.repeat(n)), reference('a'.repeat(n)), `${n} bytes`);
  for (let n = 0; n <= 45; n++) assert.equal(sha256Hex('示'.repeat(n)), reference('示'.repeat(n)), `${n} CJK scalars`);
});

test('sha256Hex of the empty string and of [] are the digests SPEC.md states', () => {
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex('[]'), '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945');
});

test('sha256Hex of a multi-block 100k-scalar text equals node:crypto and revisionOf, lone surrogates included', async () => {
  const units = ['示', 'a', '😀', 'é', ' '];
  const text = Array.from({ length: 100_000 }, (_, i) => units[(i * 7) % units.length]).join('');
  assert.equal(Array.from(text).length, 100_000);
  assert.equal(sha256Hex(text), reference(text));
  assert.equal(sha256Hex(text), await revisionOf(text));
  // TextEncoder, crypto.subtle and node's utf8 all encode a lone surrogate as U+FFFD.
  assert.equal(sha256Hex('a\uD800b'), await revisionOf('a\uD800b'));
  assert.equal(sha256Hex('a\uD800b'), reference('a\uD800b'));
});

test('sha256Hex hashes 512 cores of 1,800 CJK scalars synchronously', () => {
  const cores = Array.from({ length: 512 }, (_, i) => `${String(i).padStart(3, '0')}${'示例文字内容段落名称'.repeat(180)}`.slice(0, 1800));
  const started = performance.now();
  const hashes = cores.map(sha256Hex);
  const ms = performance.now() - started;
  console.log(`sha256Hex: 512 cores of 1,800 CJK scalars (${(512 * 5400 / 1_048_576).toFixed(2)} MiB) in ${ms.toFixed(1)} ms`);
  assert.equal(new Set(hashes).size, 512);
  assert.equal(hashes[511], reference(cores[511]));
  assert.ok(ms < 5000, `${ms} ms`);
});
