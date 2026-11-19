import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { parseWorkfile as parseWeb031 } from './legacy/web-0.3.1/manuscript.js';
import {
  CODES, LIMITS, MAX_V2_BYTES, MAX_V4_BYTES, REASON_VALUES, V4_FORMAT, buildFixtures, canonicalV4, fitsV3,
} from '../scripts/build-manuscript-v4-fixtures.mjs';
import { padContent } from '../scripts/build-manuscript-v3-fixtures.mjs';

// The fixtures and the reference writer of contracts/manuscript-v4/SPEC.md. The reference side here is independent of
// lib/manuscript.js: the frozen Web 0.3.1 reader stands for old clients, and the lists below are checked on the parsed JSON itself.
// tests/manuscript-v4-lib.test.mjs checks the shipped reader and writer against the same fixtures.

const dir = new URL('../contracts/manuscript-v4/', import.meta.url);
const v3dir = new URL('../contracts/manuscript-v3/', import.meta.url);
const read = (name, base = dir) => readFileSync(new URL(name, base), 'utf8');
const cases = JSON.parse(read('cases.json'));
const contentOf = c => (c.pad_to_bytes ? padContent(read(c.file), c.pad_to_bytes) : read(c.file));
const legacyCode = content => { try { parseWeb031(content); return null; } catch (error) { return error.code; } };
const hasReason = f => Object.hasOwn(f, 'reason');

test('a. the generator output equals the committed bytes and cases.json indexes every file once', async () => {
  const files = await buildFixtures();
  for (const [name, content] of files) assert.equal(read(name), content, name);
  const onDisk = readdirSync(dir).filter(n => n.endsWith('.json') && n !== 'cases.json').sort();
  const listed = [...cases.valid, ...cases.invalid].filter(c => !c.pad_to_bytes).map(c => c.file).sort();
  assert.deepEqual(listed, onDisk);
  assert.equal(new Set(listed).size, listed.length);
  for (const c of [...cases.valid, ...cases.invalid].filter(c => c.pad_to_bytes)) assert.ok(listed.includes(c.file), c.file);
  assert.deepEqual([...files.keys()].filter(n => n !== 'cases.json').sort(), onDisk);
  for (const c of cases.valid) assert.ok(onDisk.includes(c.canonical), `${c.file}: canonical ${c.canonical}`);
});

test('b. the codes are the 13 of v3, every listed code is in the v3 SPEC, and the SPEC names every reason value', () => {
  const spec = read('SPEC.md');
  const v3spec = read('SPEC.md', v3dir);
  assert.equal(cases.codes.length, 13);
  assert.deepEqual(cases.codes, CODES);
  for (const code of cases.codes) assert.ok(v3spec.includes(`\`${code}\``), code);
  const used = new Set([...cases.valid, ...cases.invalid].flatMap(c => [c.error, c.legacy_error]).filter(Boolean));
  for (const code of used) assert.ok(cases.codes.includes(code), code);
  for (const reason of REASON_VALUES) assert.ok(spec.includes(`\`${reason}\``), reason);
  assert.deepEqual(REASON_VALUES, ['not_a_term', 'ordinary_word', 'no_target_region', 'found_outside_region', 'ambiguous_repeat']);
  assert.deepEqual(cases.limits, LIMITS);
  assert.equal(LIMITS.file_bytes, 44 * 1_048_576);
  assert.equal(MAX_V4_BYTES, 46_137_344);
});

test('c. the frozen Web 0.3.1 reader gives every case its legacy_error: unsupported up to 1 MiB, too large over it', () => {
  for (const c of [...cases.valid, ...cases.invalid]) assert.equal(legacyCode(contentOf(c)), c.legacy_error, c.file);
  for (const c of cases.valid.filter(x => JSON.parse(read(x.file)).format === V4_FORMAT)) {
    const bytes = Buffer.byteLength(contentOf(c), 'utf8');
    assert.equal(legacyCode(contentOf(c)), bytes > MAX_V2_BYTES ? 'workfile_too_large' : 'workfile_unsupported_format', c.file);
  }
  assert.ok(cases.valid.some(c => c.pad_to_bytes === MAX_V2_BYTES + 1 && c.legacy_error === 'workfile_too_large'), 'a valid v4 file over 1 MiB');
  assert.ok(cases.valid.some(c => !c.pad_to_bytes && c.legacy_error === 'workfile_unsupported_format'), 'a valid v4 file under 1 MiB');
});

// The lists of a parsed file, as the SPEC "Limits" table names them.
const reportsOf = x => x.history.map(h => h.report);
const recordFindings = x => x.segments.flatMap(r => (r.result ? r.result.findings : []));
const allFindings = x => [...reportsOf(x).flatMap(r => r.findings), ...recordFindings(x)];

test('d. every valid v4 case keeps each list within 128 and a reason only on not_evaluated with one of the five values', () => {
  for (const c of cases.valid) {
    const x = JSON.parse(contentOf(c));
    if (x.format !== V4_FORMAT) continue;
    assert.ok(x.choices.length <= 128, c.file);
    for (const h of x.history) assert.ok((h.resolutions?.length ?? 0) <= 128 && h.report.findings.length <= 128, c.file);
    for (const r of x.segments) assert.ok(r.choices.length <= 128 && (r.result?.findings.length ?? 0) <= 128, c.file);
    for (const f of allFindings(x).filter(hasReason)) {
      assert.equal(f.verdict, 'not_evaluated', c.file);
      assert.ok(REASON_VALUES.includes(f.reason), c.file);
    }
  }
});

test('e. the reference writer reproduces every canonical file, and picks the lowest format', () => {
  for (const c of cases.valid) {
    const x = JSON.parse(contentOf(c));
    const canonical = read(c.canonical);
    const written = canonicalV4(x);
    assert.equal(written, canonical, c.file);
    const label = JSON.parse(canonical).format;
    // v4 only when something is over the v1-v3 limits or carries a reason; otherwise the lower format.
    assert.equal(label === V4_FORMAT, !fitsV3(x), c.file);
  }
  // A canonical v4 file is minified, has no trailing newline and writes `reason` last.
  const dense = read('valid-v4-segments-dense.json');
  assert.equal(dense.includes('\n'), false);
  const record = JSON.parse(dense).segments[1];
  const reasons = record.result.findings.filter(hasReason);
  assert.deepEqual([...new Set(reasons.map(f => f.reason))].sort(), [...REASON_VALUES].sort());
  for (const f of record.result.findings) {
    const keys = Object.keys(f);
    assert.deepEqual(keys, hasReason(f) ? ['verdict', 'source', 'target', 'candidates', 'candidates_truncated', 'reason'] : ['verdict', 'source', 'target', 'candidates', 'candidates_truncated']);
  }
});

test('f. the dense fixtures are as dense as the SPEC says', () => {
  const document = JSON.parse(read('valid-v4-document-dense.json'));
  assert.equal(document.choices.length, 40);
  assert.equal(document.history[0].report.findings.length, 40);
  assert.equal(document.history[0].resolutions.length, 40);
  assert.deepEqual(document.history[0].report.findings.filter(hasReason).map(f => f.reason), REASON_VALUES);
  for (const f of document.history[0].report.findings.filter(hasReason)) {
    assert.deepEqual(Object.keys(f), ['id', 'rule_id', 'verdict', 'source_span', 'target_span', 'candidates', 'candidates_truncated', 'reason']);
  }
  for (const f of document.history[0].report.findings.filter(f => !hasReason(f))) {
    assert.deepEqual(Object.keys(f), ['id', 'rule_id', 'verdict', 'source_span', 'target_span', 'candidates', 'candidates_truncated']);
  }
  const segments = JSON.parse(read('valid-v4-segments-dense.json'));
  assert.deepEqual(segments.segments.map(r => [r.status, r.result?.findings.length ?? 0, r.choices.length]), [['pending', 0, 1], ['done', 128, 128], ['stale', 33, 33]]);
  assert.equal(segments.segments[1].result.findings.filter(hasReason).length, 5);
});

test('g. the v3 contract still lists its format-v4 case, and every v3 and v1 file this contract writes back is its own valid case', () => {
  const v3cases = JSON.parse(read('cases.json', v3dir));
  const v4label = v3cases.invalid.find(c => c.file === 'invalid-v3-format-v4.json');
  assert.equal(v4label.error, 'workfile_unsupported_format');
  assert.equal(JSON.parse(read('invalid-v3-format-v4.json', v3dir)).format, V4_FORMAT);
  for (const name of ['valid-v3-from-v4.json', 'valid-v1-from-v4.json']) {
    const c = cases.valid.find(x => x.file === name);
    assert.equal(c.canonical, name);
    assert.equal(c.legacy_error, null);
  }
});
