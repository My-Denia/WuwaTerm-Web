import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  MAX_SEGMENTS, MAX_SEGMENT_HISTORY, MAX_V3_WORKFILE_BYTES, MAX_WORKFILE_BYTES, WORKFILE_FORMAT_V3, canonicalManuscript, parseWorkfile, serializeWorkfile,
} from '../lib/manuscript.js';
import { padContent } from '../scripts/build-manuscript-v3-fixtures.mjs';

// The real lib/manuscript.js against the shared fixtures. tests/manuscript-v3.test.mjs checks the fixtures with a reference reader and
// writer; this file checks that the shipped reader and writer agree with the contract.

const dir = new URL('../contracts/manuscript-v3/', import.meta.url);
const v2dir = new URL('../contracts/manuscript-v2/', import.meta.url);
const read = (name, base = dir) => readFileSync(new URL(name, base), 'utf8');
const cases = JSON.parse(read('cases.json'));
const contentOf = c => (c.pad_to_bytes ? padContent(read(c.file), c.pad_to_bytes) : read(c.file));
const codeOf = fn => { try { fn(); return null; } catch (error) { return error.code ?? error; } };

// The message of each code, from the SPEC "Error codes" table.
const specMessages = Object.fromEntries(read('SPEC.md').split('\n').filter(line => /^\| `workfile_/u.test(line))
  .map(line => { const cells = line.split(' | '); return [cells[0].slice(3, -1), cells.at(-1).replace(/ \|$/u, '')]; }));

const reverseKeys = x => {
  if (Array.isArray(x)) return x.map(reverseKeys);
  return x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).reverse().map(([k, v]) => [k, reverseKeys(v)])) : x;
};

test('lib: exports the v3 limits and keeps the v1/v2 limit', () => {
  assert.equal(WORKFILE_FORMAT_V3, 'wuwaterm-manuscript-v3');
  assert.equal(MAX_V3_WORKFILE_BYTES, 44 * 1_048_576);
  assert.equal(MAX_WORKFILE_BYTES, 1_048_576);
  assert.equal(MAX_SEGMENTS, 512);
  assert.equal(MAX_SEGMENT_HISTORY, 512);
  assert.equal(Object.keys(specMessages).length, 13);
});

// invalid-v3-format-v4.json is the v3 contract's "an unknown format version" case. lib/manuscript.js now reads that format
// (contracts/manuscript-v4/SPEC.md), and the file is a valid v4 payload, so the shipped reader accepts it; the frozen Web 0.3.1
// reader (tests/manuscript-v3.test.mjs and tests/legacy/web-0.3.1) still gives the v3 contract's code.
const READ_AS_V4 = new Set(['invalid-v3-format-v4.json']);

test('lib: parseWorkfile reads every case in cases.json as the contract says, with the SPEC message', () => {
  for (const c of cases.valid) assert.doesNotThrow(() => parseWorkfile(contentOf(c)), c.file);
  for (const c of cases.invalid) {
    let error;
    try { parseWorkfile(contentOf(c)); } catch (cause) { error = cause; }
    if (READ_AS_V4.has(c.file)) {
      assert.equal(error, undefined, `${c.file}: a valid v4 payload`);
      assert.equal(parseWorkfile(contentOf(c)).format, 'wuwaterm-manuscript-v4', c.file);
      continue;
    }
    assert.equal(error?.code, c.error, c.file);
    assert.equal(error.message, specMessages[c.error], `${c.file} message`);
  }
  // Entry points the cases do not reach.
  assert.equal(codeOf(() => parseWorkfile('{')), 'workfile_not_json');
  assert.equal(codeOf(() => parseWorkfile(' '.repeat(MAX_WORKFILE_BYTES + 1))), 'workfile_too_large');
  assert.equal(codeOf(() => parseWorkfile(' '.repeat(MAX_WORKFILE_BYTES))), 'workfile_not_json');
  assert.equal(codeOf(() => parseWorkfile(null)), 'workfile_too_large');
  assert.equal(codeOf(() => parseWorkfile(JSON.stringify({ format: WORKFILE_FORMAT_V3 }))), 'workfile_unsupported_format');
  assert.equal(codeOf(() => parseWorkfile('[]')), 'workfile_unsupported_format');
});

test('lib: serializeWorkfile and canonicalManuscript write every valid case\'s canonical bytes, whatever the input key order', () => {
  for (const c of cases.valid) {
    const parsed = parseWorkfile(contentOf(c));
    const canonical = read(c.canonical);
    assert.equal(serializeWorkfile(parsed), canonical, c.file);
    assert.equal(canonicalManuscript(parsed), canonical, `${c.file} canonicalManuscript`);
    if (parsed.format !== WORKFILE_FORMAT_V3) continue;
    // The v3 parts and the top level are rebuilt in the SPEC order: reversed input keys, and fields the SPEC does not know, change nothing.
    const extra = r => ({ ...r, report: { runtime: true }, sent: 'x', prior: null });
    const shuffled = Object.fromEntries(Object.entries({
      ...parsed, segments: reverseKeys(parsed.segments.map(extra)), segment_choice_history: reverseKeys(parsed.segment_choice_history), progress: reverseKeys(parsed.progress),
    }).reverse());
    assert.equal(serializeWorkfile(shuffled), canonical, `${c.file} (reversed key order)`);
  }
});

test('lib: every v2 case keeps its result under the v3 reader', () => {
  const v2cases = JSON.parse(read('cases.json', v2dir));
  for (const c of v2cases.valid) assert.doesNotThrow(() => parseWorkfile(read(c.file, v2dir)), c.file);
  for (const c of v2cases.invalid) assert.equal(codeOf(() => parseWorkfile(read(c.file, v2dir))), c.error, c.file);
});

test('lib: a v1/v2 array over 128 items is too_many_entries in a v3 file as in a v2 file; under 128 its own count gives invalid_content (SPEC "Reading", step 5)', () => {
  const v3 = JSON.parse(read('valid-v3-all-parts.json'));
  const v2 = JSON.parse(read('valid-all-parts.json', v2dir));
  // 129 decisions: the v2 array cap of 128 applies to the v1/v2 part of either format, so both report the same code.
  assert.equal(codeOf(() => parseWorkfile(JSON.stringify({ ...v2, semantic_decisions: Array(129).fill(v2.semantic_decisions[0]) }))), 'workfile_too_many_entries');
  assert.equal(codeOf(() => parseWorkfile(JSON.stringify({ ...v3, semantic_decisions: Array(129).fill(v2.semantic_decisions[0]) }))), 'workfile_too_many_entries');
  assert.equal(codeOf(() => parseWorkfile(JSON.stringify({ ...v3, history: Array(129).fill(null) }))), 'workfile_too_many_entries');
  assert.equal(codeOf(() => parseWorkfile(JSON.stringify({ ...v3, choices: Array(33).fill(null) }))), 'workfile_invalid_content');
  assert.equal(codeOf(() => parseWorkfile(JSON.stringify({ ...v3, semantic_decisions: Array(513).fill(null) }))), 'workfile_too_many_entries');
});

test('lib: hashes must be strings, and ranges count scalars, not UTF-16 units', () => {
  const v3 = JSON.parse(read('valid-v3-all-parts.json'));
  const withRecord = (index, change) => JSON.stringify({ ...v3, segments: v3.segments.map((r, i) => (i === index ? { ...r, ...change } : r)) });
  assert.equal(codeOf(() => parseWorkfile(withRecord(1, { source_hash: [v3.segments[1].source_hash] }))), 'workfile_segment_invalid');
  assert.equal(codeOf(() => parseWorkfile(withRecord(1, { source_hash: v3.segments[1].source_hash.toUpperCase() }))), 'workfile_segment_invalid');
  assert.equal(codeOf(() => parseWorkfile(withRecord(0, { index: 1 }))), 'workfile_segment_order');

  // Two astral scalars (two UTF-16 units each) before the choice's text: scalar offsets 2..5 read it, UTF-16 offsets 4..7 do not.
  const source = '\u{20BB7}\u{20BB7}示例名。';
  const choice = (start, end) => ({ source_span: { start, end, text: '示例名' }, choice: 'not_a_term', candidate: null, offered: [], confirmed: false });
  const astral = start => JSON.stringify({
    ...v3, source, target: 'Sample.', segments: [{
      ...v3.segments[0], index: 0, source_start: 0, source_end: 6, target_start: 0, target_end: 7, choices: [choice(start, start + 3)],
    }], segment_choice_history: [], progress: { current: 0, completed: [] },
  });
  assert.doesNotThrow(() => parseWorkfile(astral(2)));
  assert.equal(codeOf(() => parseWorkfile(astral(4))), 'workfile_segment_anchor_invalid');
  // The 2,000-scalar text limit counts scalars too: 2,000 astral scalars are 4,000 UTF-16 units.
  const entry = length => JSON.stringify({
    ...v3, segment_choice_history: [{ source_hash: v3.segments[1].source_hash, source_span: { start: 0, end: length, text: '\u{20BB7}'.repeat(length) },
      choice: 'not_a_term', candidate: null, offered: [] }],
  });
  assert.doesNotThrow(() => parseWorkfile(entry(2000)));
  assert.equal(codeOf(() => parseWorkfile(entry(2001))), 'workfile_segment_invalid');
});

test('lib: absent segments, history and progress mean empty, and the format follows SPEC "Writing"', () => {
  const v3 = parseWorkfile(read('valid-v3-all-parts.json'));
  // History choices without segment records stay v3, with the default progress.
  const noProgress = { ...v3, segments: [] };
  delete noProgress.progress;
  const content = serializeWorkfile(noProgress);
  assert.equal(JSON.parse(content).format, WORKFILE_FORMAT_V3);
  assert.deepEqual(parseWorkfile(content).progress, { current: null, completed: [] });
  assert.equal(parseWorkfile(content).segment_choice_history.length, 1);
  assert.equal(content.includes('\n'), false, 'minified');
  // No segment state: v1, however the absent parts are spelled.
  const plain = { source: '示例', target: 'Sample', direction: 'en', alignments: null, choices: [], history: [] };
  const v1 = serializeWorkfile(plain);
  assert.match(v1, /^\{\n {2}"format": "wuwaterm-manuscript-v1"/u);
  assert.equal(serializeWorkfile({ ...plain, segments: [], segment_choice_history: [] }), v1);
  // A payload whose v1 form is over 1 MiB is written as v3, which has no 1 MiB cap.
  const big = serializeWorkfile({ ...plain, source: 'a'.repeat(MAX_WORKFILE_BYTES) });
  assert.equal(JSON.parse(big).format, WORKFILE_FORMAT_V3);
  assert.ok(Buffer.byteLength(big, 'utf8') > MAX_WORKFILE_BYTES);
  assert.equal(parseWorkfile(big).source.length, MAX_WORKFILE_BYTES);
  assert.equal(serializeWorkfile(parseWorkfile(big)), big);
  // 513 records fail the save, with a message that says what to do.
  const full = parseWorkfile(read('valid-v3-512-segments.json'));
  const error = (() => { try { serializeWorkfile({ ...full, segments: [...full.segments, { ...full.segments[511], index: 512 }] }); } catch (cause) { return cause; } return null; })();
  assert.equal(error?.code, 'workfile_too_many_entries');
  assert.match(error.message, /512 段/u);
  // A record that is not shaped like one fails with a code, not a TypeError, and a draft with such a record has no canonical string.
  assert.equal(codeOf(() => serializeWorkfile({ ...full, segments: [{ index: 0 }] })), 'workfile_segment_invalid');
  assert.equal(canonicalManuscript({ ...full, segments: [{ index: 0 }] }), null);
});

test('lib: semantic_history is dropped oldest-first only above 44 MiB, then the save fails', () => {
  const snapshot = text => ({ source: text, target: '', direction: 'en', segments: [] });
  const payload = (sourceLength, history) => ({
    source: 'a'.repeat(sourceLength), target: '', direction: 'en', alignments: null, choices: [], history: [],
    semantic_decisions: [], semantic_texts: [], semantic_history: history,
  });
  const first = snapshot('b'.repeat(8_000_000));
  const second = snapshot('c'.repeat(8_000_000));
  // 38 + 8 + 8 million bytes is over the cap (46.1 million): the oldest snapshot goes, and 46 million fit. 30 + 8 + 8 fit as they are.
  assert.deepEqual(parseWorkfile(serializeWorkfile(payload(30_000_000, [first, second]))).semantic_history, [first, second]);
  assert.deepEqual(parseWorkfile(serializeWorkfile(payload(38_000_000, [first, second]))).semantic_history, [second]);
  assert.equal(codeOf(() => serializeWorkfile(payload(MAX_V3_WORKFILE_BYTES, [first, second]))), 'workfile_too_large');
  // The draft keeps a canonical string for the restore baseline even when the save would fail.
  assert.equal(typeof canonicalManuscript(payload(MAX_V3_WORKFILE_BYTES, [])), 'string');
});
