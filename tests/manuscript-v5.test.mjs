import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { parseWorkfile as parseWeb045 } from './legacy/web-0.4.5/manuscript.js';
import {
  MAX_V5_WORKFILE_BYTES, REASON_AMBIGUOUS_MENTION, REASON_VALUES, REASON_VALUES_V5, REPORT_V4, REPORT_V5, REVIEW_FEATURE_VALUES,
  SEGMENTATION_VERSIONS_V5, WORKFILE_FORMAT_V4, WORKFILE_FORMAT_V5, parseWorkfile, serializeWorkfile, validReport,
} from '../lib/manuscript.js';
import { GAP_SEGMENTATION_VERSION, SEGMENTATION_VERSION } from '../lib/segmentation.ts';
import {
  REASON_VALUES_V5 as GENERATED_REASONS_V5, REVIEW_FEATURE_VALUES as GENERATED_FEATURES, SEGMENTATION_VERSION_V5_VALUES,
} from '../lib/generated/manuscript-contract.ts';
import {
  CODES, LIMITS, MAX_V5_BYTES, REASON_VALUES as REFERENCE_REASONS, REVIEW_FEATURES, SEGMENTATION_VERSIONS, V5_FORMAT,
  buildFixtures, canonicalV5, needsV5,
} from '../scripts/build-manuscript-v5-fixtures.mjs';
import { padContent } from '../scripts/build-manuscript-v3-fixtures.mjs';
import { validateJsonSchema } from '../scripts/validate-json-schema.mjs';

// contracts/manuscript-v5/SPEC.md: the fixtures, the reference writer, the shipped reader and writer, the frozen Web 0.4.5 reader that
// stands for every older client, and both JSON Schemas (the v1-v5 one and the standalone v5 one cut from it).

const dir = new URL('../contracts/manuscript-v5/', import.meta.url);
const read = name => readFileSync(new URL(name, dir), 'utf8');
const cases = JSON.parse(read('cases.json'));
const contentOf = c => (c.pad_to_bytes ? padContent(read(c.file), c.pad_to_bytes) : read(c.file));
const codeOf = (parse, content) => { try { parse(content); return null; } catch (error) { return error.code; } };
const fullSchema = JSON.parse(readFileSync(new URL('../contracts/schemas/manuscript.schema.json', import.meta.url), 'utf8'));
const v5Schema = JSON.parse(read('schema.json'));
const v4Only = { ...fullSchema, oneOf: undefined, $ref: '#/$defs/ManuscriptV4' };
delete v4Only.oneOf;
const small = c => !c.pad_to_bytes || c.pad_to_bytes <= 2 * 1_048_576;

test('a. the generator output equals the committed bytes and cases.json indexes every fixture once', async () => {
  const files = await buildFixtures();
  for (const [name, content] of files) assert.equal(read(name), content, name);
  const onDisk = readdirSync(dir).filter(n => n.endsWith('.json') && !['cases.json', 'schema.json'].includes(n)).sort();
  const listed = [...cases.valid, ...cases.invalid].filter(c => !c.pad_to_bytes).map(c => c.file).sort();
  assert.deepEqual(listed, onDisk);
  assert.equal(new Set(listed).size, listed.length);
  for (const c of cases.valid) assert.ok(onDisk.includes(c.canonical), `${c.file}: canonical ${c.canonical}`);
});

test('b. constants: six reasons, one recorded feature, two segmentation labels, the v4 codes and 44 MiB, the same in code, SPEC and schema', () => {
  const spec = read('SPEC.md');
  assert.deepEqual(cases.codes, CODES);
  assert.deepEqual(cases.limits, LIMITS);
  assert.deepEqual([...REASON_VALUES_V5], REFERENCE_REASONS);
  assert.deepEqual([...GENERATED_REASONS_V5], REFERENCE_REASONS);
  assert.deepEqual([...REASON_VALUES_V5], [...REASON_VALUES, REASON_AMBIGUOUS_MENTION]);
  assert.deepEqual([...REVIEW_FEATURE_VALUES], REVIEW_FEATURES);
  assert.deepEqual([...GENERATED_FEATURES], REVIEW_FEATURES);
  assert.deepEqual([...SEGMENTATION_VERSIONS_V5], SEGMENTATION_VERSIONS);
  assert.deepEqual([...SEGMENTATION_VERSION_V5_VALUES], SEGMENTATION_VERSIONS);
  assert.deepEqual([SEGMENTATION_VERSION, GAP_SEGMENTATION_VERSION], SEGMENTATION_VERSIONS);
  assert.equal(WORKFILE_FORMAT_V5, V5_FORMAT);
  assert.equal(MAX_V5_WORKFILE_BYTES, MAX_V5_BYTES);
  for (const token of [...REFERENCE_REASONS, ...REVIEW_FEATURES, ...SEGMENTATION_VERSIONS, V5_FORMAT]) assert.ok(spec.includes(`\`${token}\``), token);
  const used = new Set([...cases.valid, ...cases.invalid].flatMap(c => [c.error, c.legacy_error]).filter(Boolean));
  for (const code of used) assert.ok(CODES.includes(code), code);
});

test('c. the shipped reader accepts every valid case and writes back its canonical bytes; it gives every invalid case its code', () => {
  for (const c of cases.valid) {
    const parsed = parseWorkfile(contentOf(c));
    assert.equal(serializeWorkfile(parsed), read(c.canonical), c.file);
  }
  for (const c of cases.invalid) assert.equal(codeOf(parseWorkfile, contentOf(c)), c.error, c.file);
});

test('d. the reference writer reproduces every canonical file and picks v5 only for recorded features or gap-tolerant records', () => {
  for (const c of cases.valid) {
    const x = JSON.parse(contentOf(c));
    const canonical = read(c.canonical);
    assert.equal(canonicalV5(x), canonical, c.file);
    assert.equal(JSON.parse(canonical).format === V5_FORMAT, needsV5(x), c.file);
  }
});

test('e. the frozen Web 0.4.5 reader rejects every v5 file: unsupported up to 1 MiB, too large over it; and gives every case its legacy_error', () => {
  for (const c of [...cases.valid, ...cases.invalid]) assert.equal(codeOf(parseWeb045, contentOf(c)), c.legacy_error, c.file);
  for (const c of cases.valid.filter(x => JSON.parse(read(x.file)).format === V5_FORMAT)) {
    const bytes = Buffer.byteLength(contentOf(c), 'utf8');
    assert.equal(c.legacy_error, bytes > 1_048_576 ? 'workfile_too_large' : 'workfile_unsupported_format', c.file);
  }
  for (const name of ['valid-v4-from-v5.json', 'valid-v3-from-v5.json', 'valid-v1-from-v5.json']) {
    assert.equal(cases.valid.find(c => c.file === name).legacy_error, null, `${name}: an older client opens what a v5 writer writes back`);
  }
});

test('f. the v4 schema and a v4 label reject v5 content; the v1-v5 and the standalone v5 schemas accept every valid v5 file', () => {
  for (const c of cases.valid.filter(small)) {
    const x = JSON.parse(contentOf(c));
    assert.equal(validateJsonSchema(fullSchema, x).valid, true, `${c.file}: v1-v5 schema`);
    if (x.format !== V5_FORMAT) continue;
    assert.equal(validateJsonSchema(v5Schema, x).valid, true, `${c.file}: v5 schema`);
    assert.equal(validateJsonSchema(v4Only, x).valid, false, `${c.file}: the v4 schema rejects a v5 file`);
    assert.equal(validateJsonSchema(v4Only, { ...x, format: WORKFILE_FORMAT_V4 }).valid, false, `${c.file}: and the same content under the v4 label`);
  }
  // A v4 label with v5 content: the shipped v4 reader rejects each of the three things v5 adds.
  for (const name of ['invalid-v5-v4-format-ambiguous-document.json', 'invalid-v5-v4-format-ambiguous-segment.json', 'invalid-v5-v4-format-gaps.json', 'invalid-v5-v4-format-review-features.json']) {
    const content = read(name);
    assert.equal(JSON.parse(content).format, WORKFILE_FORMAT_V4, name);
    assert.notEqual(codeOf(parseWorkfile, content), null, name);
    assert.equal(validateJsonSchema(v4Only, JSON.parse(content)).valid, false, `${name}: v4 schema`);
  }
  // The standalone schema is exactly the ManuscriptV5 part of the v1-v5 schema.
  for (const [key, value] of Object.entries(v5Schema.$defs)) assert.deepEqual(value, fullSchema.$defs[key], key);
});

test('g. a review report validates its reason against the limits it is read with: ambiguous_mention only under the v5 limits', () => {
  const x = JSON.parse(read('valid-v5-document-ambiguous.json'));
  const { report, source, target } = x.history[0];
  assert.equal(validReport(report, source, target, REPORT_V5), true);
  assert.equal(validReport(report, source, target, REPORT_V4), false);
  assert.equal(report.findings.at(-1).reason, REASON_AMBIGUOUS_MENTION);
});

test('h. the writer records the features of done results, and writes a done result made under other features stale', () => {
  const x = parseWorkfile(read('valid-v5-features-without-ambiguous.json'));
  assert.deepEqual(x.review_features, ['ambiguous-mention-v1']);
  assert.deepEqual(x.segments.map(r => r.status), ['done', 'stale', 'pending']);
  const withFeatures = (r, features, status = r.status) => Object.defineProperty({ ...r, status }, 'features', { value: features, enumerable: false });
  // Two done results made under different feature sets: the file records the union, and the one made without the feature is stale.
  const mixed = [withFeatures(x.segments[0], ['ambiguous-mention-v1']), withFeatures(x.segments[1], [], 'done'), x.segments[2]];
  const written = JSON.parse(serializeWorkfile({ ...x, segments: mixed }));
  assert.equal(written.format, V5_FORMAT);
  assert.deepEqual(written.review_features, ['ambiguous-mention-v1']);
  assert.deepEqual(written.segments.map(r => r.status), ['done', 'stale', 'pending']);
  // No done result made with the feature and no ambiguous finding: nothing needs the list, so the same state is a lower format,
  // and the done result made without the feature stays done.
  const none = [withFeatures(x.segments[0], []), x.segments[1], x.segments[2]];
  const lower = JSON.parse(serializeWorkfile({ ...x, segments: none }));
  assert.notEqual(lower.format, V5_FORMAT);
  assert.deepEqual(lower.segments.map(r => r.status), ['done', 'stale', 'pending']);
});
