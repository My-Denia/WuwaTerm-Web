import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { WORKFILE_FORMAT_V2, parseWorkfile } from '../lib/manuscript.js';
import { revisionOf } from '../lib/review-report.js';
import { pairSegments } from '../lib/segmentation.js';
import {
  MAX_V3_BYTES, MODEL_KINDS, REVIEW_MAX_JSON_BYTES, V3_FORMAT, budgetManuscript, buildFixtures, canonicalV3, padContent,
} from '../scripts/build-manuscript-v3-fixtures.mjs';

const dir = new URL('../contracts/manuscript-v3/', import.meta.url);
const v2dir = new URL('../contracts/manuscript-v2/', import.meta.url);
const read = (name, base = dir) => readFileSync(new URL(name, base), 'utf8');
const cases = JSON.parse(read('cases.json'));
const contentOf = c => (c.pad_to_bytes ? padContent(read(c.file), c.pad_to_bytes) : read(c.file));
const MiB = 1_048_576;

// ---- reference reader: SPEC "Reading", steps 1 to 10 ----

const HEX = /^[a-f0-9]{64}$/u;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const fail = code => Object.assign(new Error(code), { code });
const invalid = () => fail('workfile_segment_invalid');
const tooMany = () => fail('workfile_too_many_entries');
const isObject = x => !!x && typeof x === 'object' && !Array.isArray(x);
const exactKeys = (x, keys) => isObject(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
const hex = x => typeof x === 'string' && HEX.test(x);
const int = x => Number.isSafeInteger(x);
const text = (x, max, nonEmpty) => typeof x === 'string' && (!nonEmpty || x.length > 0) && Array.from(x).length <= max && !LONE_SURROGATE.test(x);

const V3_KEYS = ['format', 'source', 'target', 'direction', 'alignments', 'choices', 'history', 'semantic_decisions', 'semantic_texts', 'semantic_history', 'segments', 'segment_choice_history', 'progress'];
const V2_PART_KEYS = ['source', 'target', 'direction', 'alignments', 'choices', 'history', 'semantic_decisions', 'semantic_texts', 'semantic_history'];
const RECORD_KEYS = ['index', 'segmentation_version', 'source_start', 'source_end', 'target_start', 'target_end', 'source_hash', 'target_hash', 'status', 'basis', 'result', 'choices'];
const RESULT_KEYS = ['truncated', 'evaluated', 'not_evaluated', 'findings'];
const FINDING_KEYS = ['verdict', 'source', 'target', 'candidates', 'candidates_truncated'];
const CHOICE_KEYS = ['source_span', 'choice', 'candidate', 'offered', 'confirmed'];
const HISTORY_KEYS = ['source_hash', 'source_span', 'choice', 'candidate', 'offered'];
const VERDICTS = ['verified_constraint', 'confirmed_conflict', 'needs_review', 'not_evaluated'];

function checkTree(x, depth = 0) {
  if (depth > 16) throw fail('workfile_too_deep');
  if (Array.isArray(x)) {
    if (x.length > 128) throw tooMany();
    x.forEach(v => checkTree(v, depth + 1));
  } else if (isObject(x)) {
    const keys = Object.keys(x);
    if (keys.length > 32) throw fail('workfile_too_many_fields');
    for (const key of keys) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw fail('workfile_forbidden_field');
      checkTree(x[key], depth + 1);
    }
  }
}

// A v3 basis: nothing is null or missing.
function basisValid(b) {
  return exactKeys(b, ['rule_version', 'dictionary', 'matcher_revision']) && b.rule_version === 'review-v2'
    && exactKeys(b.dictionary, ['schema_version', 'source_commit', 'term_count', 'revision'])
    && text(b.dictionary.schema_version, 4096, true) && text(b.dictionary.source_commit, 4096, true)
    && int(b.dictionary.term_count) && b.dictionary.term_count >= 0 && hex(b.dictionary.revision) && hex(b.matcher_revision);
}

const pairShape = x => Array.isArray(x) && x.length === 2 && int(x[0]) && int(x[1]) && x[0] >= 0 && x[0] < x[1];
const candidateShape = k => exactKeys(k, ['candidate_id', 'zh', 'en', 'category']) && hex(k.candidate_id) && text(k.zh, 2000, true) && text(k.en, 2000, true) && text(k.category, 256, true);
const spanShape = s => exactKeys(s, ['start', 'end', 'text']) && int(s.start) && int(s.end) && s.start >= 0 && s.end > s.start
  && text(s.text, 2000, true) && s.end - s.start === Array.from(s.text).length;

function checkResultShape(result) {
  if (!exactKeys(result, RESULT_KEYS) || typeof result.truncated !== 'boolean' || !int(result.evaluated) || result.evaluated < 0
    || !int(result.not_evaluated) || result.not_evaluated < 0 || !Array.isArray(result.findings)) throw invalid();
  if (result.findings.length > 32) throw tooMany();
  for (const f of result.findings) {
    if (!exactKeys(f, FINDING_KEYS) || !VERDICTS.includes(f.verdict) || !pairShape(f.source) || (f.target !== null && !pairShape(f.target))
      || typeof f.candidates_truncated !== 'boolean' || !Array.isArray(f.candidates)) throw invalid();
    if (f.candidates.length > 8) throw tooMany();
    if (!f.candidates.every(candidateShape) || new Set(f.candidates.map(k => k.candidate_id)).size !== f.candidates.length) throw invalid();
  }
}

// Structure of a record choice (step 6) or a history choice (step 9).
function checkChoiceShape(c, history) {
  if (!exactKeys(c, history ? HISTORY_KEYS : CHOICE_KEYS) || (history && !hex(c.source_hash)) || !spanShape(c.source_span)) throw invalid();
  if (c.choice === 'official_pair') {
    if (!candidateShape(c.candidate)) throw invalid();
  } else if (c.choice !== 'not_a_term' || c.candidate !== null) throw invalid();
  if (!Array.isArray(c.offered)) throw invalid();
  if (c.offered.length > 8) throw tooMany();
  const ascending = c.offered.every((id, i) => hex(id) && (i === 0 || c.offered[i - 1] < id));
  if (c.choice === 'official_pair' ? c.offered.length !== 0 : !ascending) throw invalid();
  if (!history && typeof c.confirmed !== 'boolean') throw invalid();
}

function checkRecordShape(r, sourceLength, targetLength) {
  if (!exactKeys(r, RECORD_KEYS)) throw invalid();
  const range = (a, b, length) => int(a) && int(b) && a >= 0 && a <= b && b <= length;
  if (!int(r.index) || r.segmentation_version !== 'segmentation-v1' || !range(r.source_start, r.source_end, sourceLength)
    || !range(r.target_start, r.target_end, targetLength) || !hex(r.source_hash) || !hex(r.target_hash)
    || !['pending', 'done', 'stale'].includes(r.status)) throw invalid();
  if (r.status === 'pending' ? r.basis !== null || r.result !== null : r.basis === null || r.result === null) throw invalid();
  if (r.basis !== null && !basisValid(r.basis)) throw invalid();
  if (r.result !== null) checkResultShape(r.result);
  if (!Array.isArray(r.choices)) throw invalid();
  if (r.choices.length > 32) throw tooMany();
  r.choices.forEach(c => checkChoiceShape(c, false));
  if (r.status === 'pending' && r.choices.some(c => c.confirmed)) throw invalid();
}

function checkRecordContent(r, sourceScalars, targetScalars) {
  const sourceCore = sourceScalars.slice(r.source_start, r.source_end);
  const targetCore = targetScalars.slice(r.target_start, r.target_end);
  const live = r.status !== 'pending';
  if (live) {
    const inRange = core => core.length >= 1 && core.length <= 2000;
    if (!inRange(sourceCore) || !inRange(targetCore)) throw invalid();
    const sources = new Set();
    for (const f of r.result.findings) {
      if (f.source[1] > sourceCore.length || (f.target !== null && f.target[1] > targetCore.length) || sources.has(f.source.join(':'))) throw invalid();
      sources.add(f.source.join(':'));
    }
  }
  const anchor = () => fail('workfile_segment_anchor_invalid');
  for (const c of r.choices) {
    const { start, end, text: surface } = c.source_span;
    if (end > sourceCore.length || sourceCore.slice(start, end).join('') !== surface) throw anchor();
    if (!live || !c.confirmed) continue;
    const finding = r.result.findings.find(f => f.source[0] === start && f.source[1] === end);
    if (!finding) throw anchor();
    if (c.choice === 'official_pair') {
      if (!finding.candidates.some(k => k.candidate_id === c.candidate.candidate_id && k.zh === c.candidate.zh && k.en === c.candidate.en && k.category === c.candidate.category)) throw anchor();
    } else {
      const ids = finding.candidates.map(k => k.candidate_id).sort();
      if (ids.length !== c.offered.length || ids.some((id, i) => id !== c.offered[i])) throw anchor();
    }
  }
  if (new Set(r.choices.map(c => `${c.source_span.start}:${c.source_span.end}`)).size !== r.choices.length) throw fail('workfile_duplicate_choices');
}

/** Takes the file's text; returns the parsed value or throws an error with a `code`. */
function readV3(content) {
  if (Buffer.byteLength(content, 'utf8') > MAX_V3_BYTES) throw fail('workfile_too_large');
  let x; let json = true;
  try { x = JSON.parse(content); } catch { json = false; }
  if (!json || !isObject(x) || x.format !== V3_FORMAT) return parseWorkfile(content);
  checkTree(x);
  if (!exactKeys(x, V3_KEYS)) throw fail('workfile_unsupported_format');
  const projection = JSON.stringify({ format: WORKFILE_FORMAT_V2, ...Object.fromEntries(V2_PART_KEYS.map(k => [k, x[k]])) });
  if (Buffer.byteLength(projection, 'utf8') > MiB) throw new Error('the reference reader cannot check a v1/v2 part over 1 MiB');
  parseWorkfile(projection);
  if (!Array.isArray(x.segments)) throw invalid();
  const sourceScalars = Array.from(x.source);
  const targetScalars = Array.from(x.target);
  x.segments.forEach(r => checkRecordShape(r, sourceScalars.length, targetScalars.length));
  x.segments.forEach((r, i) => {
    const previous = x.segments[i - 1];
    if (r.index !== i || (previous && (r.source_start < previous.source_end || r.target_start < previous.target_end))) throw fail('workfile_segment_order');
  });
  x.segments.forEach(r => checkRecordContent(r, sourceScalars, targetScalars));
  if (!Array.isArray(x.segment_choice_history)) throw invalid();
  x.segment_choice_history.forEach(c => checkChoiceShape(c, true));
  const p = x.progress;
  const progress = () => fail('workfile_progress_invalid');
  if (!exactKeys(p, ['current', 'completed'])) throw progress();
  if (p.current !== null && !(int(p.current) && p.current >= 0 && p.current < x.segments.length)) throw progress();
  if (!Array.isArray(p.completed) || !p.completed.every((n, i) => int(n) && (i === 0 || p.completed[i - 1] < n) && x.segments[n]?.status === 'done')) throw progress();
  return x;
}

const legacyCode = content => { try { parseWorkfile(content); return null; } catch (error) { return error.code; } };

// ---- assertions a to h ----

test('a. the generator output equals the committed bytes and cases.json indexes every file once', async () => {
  const files = await buildFixtures();
  for (const [name, content] of files) assert.equal(read(name), content, name);
  assert.equal(files.get('valid-v2-all-parts.json'), read('valid-all-parts.json', v2dir));
  const onDisk = readdirSync(dir).filter(n => n.endsWith('.json') && n !== 'cases.json').sort();
  const listed = [...cases.valid, ...cases.invalid].filter(c => !c.pad_to_bytes).map(c => c.file).sort();
  assert.deepEqual(listed, onDisk);
  assert.equal(new Set(listed).size, listed.length);
  for (const c of [...cases.valid, ...cases.invalid].filter(c => c.pad_to_bytes)) assert.ok(listed.includes(c.file), c.file);
  assert.deepEqual([...files.keys()].filter(n => n !== 'cases.json').sort(), onDisk);
});

test('b. the codes in cases.json are listed and every listed code is in SPEC.md', () => {
  const spec = read('SPEC.md');
  assert.equal(cases.codes.length, 13);
  for (const code of cases.codes) assert.ok(spec.includes(`\`${code}\``), code);
  const used = new Set([...cases.valid, ...cases.invalid].flatMap(c => [c.error, c.legacy_error]).filter(Boolean));
  for (const code of used) assert.ok(cases.codes.includes(code), code);
});

const reverseKeys = x => {
  if (Array.isArray(x)) return x.map(reverseKeys);
  return isObject(x) ? Object.fromEntries(Object.entries(x).reverse().map(([k, v]) => [k, reverseKeys(v)])) : x;
};

test('c. every valid case is accepted and the reference writer reproduces its canonical bytes', () => {
  for (const c of cases.valid) {
    const parsed = readV3(contentOf(c));
    const canonical = read(c.canonical);
    assert.equal(canonicalV3(parsed), canonical, c.file);
    if (parsed.format !== V3_FORMAT) continue;
    // Key order in the input must not leak into the output: v3 parts and the top level are rebuilt in the SPEC order.
    const shuffled = Object.fromEntries(Object.entries({
      ...parsed, segments: reverseKeys(parsed.segments), segment_choice_history: reverseKeys(parsed.segment_choice_history), progress: reverseKeys(parsed.progress),
    }).reverse());
    assert.equal(canonicalV3(shuffled), canonical, `${c.file} (reversed key order)`);
  }
});

test('d. every invalid case is rejected with its code, as the first failure', () => {
  for (const c of cases.invalid) assert.throws(() => readV3(contentOf(c)), { code: c.error }, c.file);
});

test('e. today\'s parseWorkfile (Web 0.2.0) gives every case its legacy_error', () => {
  for (const c of [...cases.valid, ...cases.invalid]) assert.equal(legacyCode(contentOf(c)), c.legacy_error, c.file);
});

test('f. every v2 case keeps its result under the reference reader', () => {
  const v2cases = JSON.parse(read('cases.json', v2dir));
  for (const c of v2cases.valid) assert.doesNotThrow(() => readV3(read(c.file, v2dir)), c.file);
  for (const c of v2cases.invalid) assert.throws(() => readV3(read(c.file, v2dir)), { code: c.error }, c.file);
});

test('g. hashes match the current cores and ranges match pairSegments', async () => {
  const hashesMatch = async (file, x, onlyIndex = null) => {
    const source = Array.from(x.source); const target = Array.from(x.target);
    for (const r of x.segments) {
      const sourceHash = await revisionOf(source.slice(r.source_start, r.source_end).join(''));
      const targetHash = await revisionOf(target.slice(r.target_start, r.target_end).join(''));
      if (r.index === onlyIndex) {
        // The point of valid-v3-hash-not-current.json: a valid file whose stored hash is not the current core's.
        assert.notEqual(r.source_hash, sourceHash, file);
        assert.equal(r.target_hash, targetHash, file);
      } else {
        assert.equal(r.source_hash, sourceHash, `${file} record ${r.index}`);
        assert.equal(r.target_hash, targetHash, `${file} record ${r.index}`);
      }
    }
  };
  for (const c of cases.valid.filter(c => c.file.startsWith('valid-v3-') && !c.pad_to_bytes)) {
    const x = readV3(read(c.file));
    if (x.segments.length === 0) continue;
    await hashesMatch(c.file, x, c.file === 'valid-v3-hash-not-current.json' ? 1 : null);
    // These ranges are not a segmentation-v1 result: 128 short paragraphs, and 2,000-scalar cores (segmentation stops at 1,800).
    if (['valid-v3-128-segments.json', 'valid-v3-2000-core-8-offered.json'].includes(c.file)) continue;
    const pairs = pairSegments(x.source, x.target, 1800, x.alignments);
    assert.equal(pairs.length, x.segments.length, c.file);
    pairs.forEach((p, i) => {
      assert.equal(p.status, 'ready');
      const r = x.segments[i];
      assert.deepEqual([r.source_start, r.source_end, r.target_start, r.target_end], [p.source.core_start, p.source.core_end, p.target.core_start, p.target.core_end], `${c.file} record ${i}`);
    });
  }
  // The two core-length boundary files are invalid, but their hashes agree with their cores, so only the core length can fail.
  for (const file of ['invalid-v3-core-2001.json', 'invalid-v3-done-empty-core.json']) await hashesMatch(file, JSON.parse(read(file)));
});

test('h. size models: the limit model keeps a 25% margin under the cap, and the extreme one fails or fits by its size', () => {
  const sizes = {};
  for (const kind of MODEL_KINDS) {
    const payload = budgetManuscript(kind);
    assert.equal(pairSegments(payload.source, payload.target).length, payload.segments.length, kind);
    const content = canonicalV3(payload, { maxBytes: Infinity });
    sizes[kind] = Buffer.byteLength(content, 'utf8');
    if (sizes[kind] > MAX_V3_BYTES) {
      assert.throws(() => canonicalV3(payload), { code: 'workfile_too_large' }, kind);
    } else {
      assert.equal(canonicalV3(payload), content, kind);
      assert.doesNotThrow(() => readV3(content), kind);
    }
  }
  const extremeResult = Buffer.byteLength(JSON.stringify(budgetManuscript('extreme').segments[0].result), 'utf8');
  assert.ok(extremeResult <= REVIEW_MAX_JSON_BYTES && extremeResult > REVIEW_MAX_JSON_BYTES - 64, `extreme result ${extremeResult} bytes`);
  console.log(`manuscript-v3 size models (MiB): ${MODEL_KINDS.map(kind => `${kind} ${(sizes[kind] / MiB).toFixed(2)}`).join(', ')}`);
  assert.ok(sizes.limit * 1.25 <= MAX_V3_BYTES);
});
