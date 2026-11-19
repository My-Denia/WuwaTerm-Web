import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  MAX_CHOICES, MAX_V4_CHOICES, MAX_V4_WORKFILE_BYTES, MAX_V3_WORKFILE_BYTES, REASON_VALUES, REPORT_V4, WORKFILE_FORMAT_V3, WORKFILE_FORMAT_V4,
  canonicalManuscript, parseWorkfile, serializeWorkfile, validReport,
} from '../lib/manuscript.js';
import { padContent } from '../scripts/build-manuscript-v3-fixtures.mjs';
import { REASON_VALUES as REFERENCE_REASONS } from '../scripts/build-manuscript-v4-fixtures.mjs';

// The real lib/manuscript.js against the shared v4 fixtures. tests/manuscript-v4.test.mjs checks the fixtures with the frozen Web 0.3.1
// reader and a reference writer; this file checks that the shipped reader and writer agree with contracts/manuscript-v4/SPEC.md.

const dir = new URL('../contracts/manuscript-v4/', import.meta.url);
const v3dir = new URL('../contracts/manuscript-v3/', import.meta.url);
const read = (name, base = dir) => readFileSync(new URL(name, base), 'utf8');
const cases = JSON.parse(read('cases.json'));
const contentOf = c => (c.pad_to_bytes ? padContent(read(c.file), c.pad_to_bytes) : read(c.file));
const codeOf = fn => { try { fn(); return null; } catch (error) { return error.code ?? error; } };
const hasReason = f => Object.hasOwn(f, 'reason');
// The message of each code, from the v3 SPEC "Error codes" table: v4 adds no code and changes no message.
const specMessages = Object.fromEntries(read('SPEC.md', v3dir).split('\n').filter(line => /^\| `workfile_/u.test(line))
  .map(line => { const cells = line.split(' | '); return [cells[0].slice(3, -1), cells.at(-1).replace(/ \|$/u, '')]; }));
const reverseKeys = x => {
  if (Array.isArray(x)) return x.map(reverseKeys);
  return x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).reverse().map(([k, v]) => [k, reverseKeys(v)])) : x;
};

test('lib: exports the v4 format, the 128 limit, the 44 MiB cap and the reason values; the v1 to v3 limit stays 32', () => {
  assert.equal(WORKFILE_FORMAT_V4, 'wuwaterm-manuscript-v4');
  assert.equal(MAX_V4_CHOICES, 128);
  assert.equal(MAX_CHOICES, 32);
  assert.equal(MAX_V4_WORKFILE_BYTES, 44 * 1_048_576);
  assert.equal(MAX_V4_WORKFILE_BYTES, MAX_V3_WORKFILE_BYTES);
  assert.deepEqual([...REASON_VALUES], REFERENCE_REASONS);
  assert.deepEqual({ ...REPORT_V4 }, { items: 128, reason: true });
});

test('lib: parseWorkfile reads every case of the v4 contract with its code and the v3 SPEC message', () => {
  for (const c of cases.valid) assert.doesNotThrow(() => parseWorkfile(contentOf(c)), c.file);
  for (const c of cases.invalid) {
    let error;
    try { parseWorkfile(contentOf(c)); } catch (cause) { error = cause; }
    assert.equal(error?.code, c.error, c.file);
    assert.equal(error.message, specMessages[c.error], `${c.file} message`);
  }
  assert.equal(Object.keys(specMessages).length, 13);
});

test('lib: serializeWorkfile and canonicalManuscript write every valid case\'s canonical bytes, whatever the input key order', () => {
  for (const c of cases.valid) {
    const parsed = parseWorkfile(contentOf(c));
    const canonical = read(c.canonical);
    assert.equal(serializeWorkfile(parsed), canonical, c.file);
    assert.equal(canonicalManuscript(parsed), canonical, `${c.file} canonicalManuscript`);
    if (parsed.format !== WORKFILE_FORMAT_V4) continue;
    // Record parts are rebuilt in the SPEC order: reversed input keys, and fields the SPEC does not know, change nothing.
    const extra = r => ({ ...r, report: { runtime: true }, sent: 'x', prior: null });
    const shuffled = Object.fromEntries(Object.entries({
      ...parsed, segments: reverseKeys(parsed.segments.map(extra)), segment_choice_history: reverseKeys(parsed.segment_choice_history), progress: reverseKeys(parsed.progress),
    }).reverse());
    assert.equal(serializeWorkfile(shuffled), canonical, `${c.file} (reversed key order)`);
  }
});

test('lib: the writer picks the lowest format that holds the payload (v1/v2, then v3, then v4)', () => {
  const dense = parseWorkfile(read('valid-v4-document-dense.json'));
  const format = payload => JSON.parse(serializeWorkfile(payload)).format;
  const plain = { source: '示例', target: 'Sample', direction: 'en', alignments: null, choices: [], history: [] };
  assert.equal(format(plain), 'wuwaterm-manuscript-v1');
  // 32 choices fit v1, 33 need v4 (document mode, no segment state).
  const choices = dense.choices;
  assert.equal(format({ ...dense, choices: choices.slice(0, 32), history: [] }), 'wuwaterm-manuscript-v1');
  assert.equal(format({ ...dense, choices: choices.slice(0, 33), history: [] }), WORKFILE_FORMAT_V4);
  // A history report: 32 findings and 32 resolutions stay v1; 33 findings, or 33 resolutions, or any reason, are v4.
  const snap = dense.history[0];
  const without = f => { const { reason, ...rest } = f; void reason; return rest; };
  const report = n => ({ ...snap.report, findings: snap.report.findings.filter(f => !hasReason(f)).slice(0, n).map(without) });
  const at = (n, resolutions = n) => ({ ...dense, choices: [], history: [{ ...snap, report: report(n), resolutions: snap.resolutions.slice(0, resolutions) }] });
  assert.equal(format(at(32)), 'wuwaterm-manuscript-v1');
  assert.equal(format(at(33)), WORKFILE_FORMAT_V4);
  assert.equal(format(at(32, 33)), WORKFILE_FORMAT_V4);
  assert.equal(format({ ...dense, choices: [], history: [{ ...snap, report: { ...snap.report, findings: snap.report.findings.slice(30) } }] }), WORKFILE_FORMAT_V4, 'a reason alone');
  // Only the last two history entries are written, so only they count.
  const heavy = { ...snap, report: report(40), resolutions: snap.resolutions };
  const light = { ...snap, report: report(2), resolutions: snap.resolutions.slice(0, 2) };
  assert.equal(format({ ...dense, choices: [], history: [heavy, light, light] }), 'wuwaterm-manuscript-v1');
  // Segment state: v3 while every record is within 32 and without a reason, v4 once one is not.
  const v3 = parseWorkfile(read('valid-v3-from-v4.json'));
  assert.equal(v3.format, WORKFILE_FORMAT_V3);
  assert.equal(format(v3), WORKFILE_FORMAT_V3);
  const segments = parseWorkfile(read('valid-v4-segments-dense.json'));
  assert.equal(format(segments), WORKFILE_FORMAT_V4);
  // Only the choices of a record are over 32: 32 findings without a reason, 33 choices (the last one unconfirmed).
  const choicesOnly = structuredClone(segments);
  for (const record of choicesOnly.segments) {
    if (record.result) record.result.findings = record.result.findings.filter(f => !hasReason(f)).slice(0, 32);
    record.choices = record.choices.slice(0, record.status === 'done' ? 33 : 32);
    if (record.status === 'done') record.choices[32].confirmed = false;
  }
  choicesOnly.segments[1].choices = choicesOnly.segments[1].choices.slice(0, 33);
  assert.equal(choicesOnly.segments[1].choices.length, 33);
  assert.equal(format(choicesOnly), WORKFILE_FORMAT_V4);
  choicesOnly.segments[1].choices.pop();
  assert.equal(format(choicesOnly), WORKFILE_FORMAT_V3);
  const reasoned = structuredClone(v3);
  Object.assign(reasoned.segments[1].result.findings[2], { verdict: 'not_evaluated', target: null, reason: 'ambiguous_repeat' });
  assert.equal(format(reasoned), WORKFILE_FORMAT_V4);
  // A file over 1 MiB that fits v3 is v3; one that does not is v4.
  const bigSource = 'a'.repeat(MAX_V3_WORKFILE_BYTES / 40);
  assert.equal(format({ ...plain, source: 'a'.repeat(1_048_576) }), WORKFILE_FORMAT_V3);
  assert.equal(format({ ...dense, source: dense.source, choices: choices.slice(0, 33), history: [] }), WORKFILE_FORMAT_V4);
  void bigSource;
});

test('lib: v1, v2 and v3 keep their 32-item limits and refuse a reason, whatever the content', () => {
  const dense = parseWorkfile(read('valid-v4-document-dense.json'));
  const relabel = (x, format, drop = []) => { const y = { ...x, format }; for (const key of drop) delete y[key]; return JSON.stringify(y); };
  const noSegments = ['segments', 'segment_choice_history', 'progress'];
  // v2: 33 choices (invalid content), and a reason in a history report (an extra key).
  assert.equal(codeOf(() => parseWorkfile(relabel({ ...dense, history: [] }, 'wuwaterm-manuscript-v2', noSegments))), 'workfile_invalid_content');
  assert.equal(codeOf(() => parseWorkfile(relabel({ ...dense, choices: [] }, 'wuwaterm-manuscript-v2', noSegments))), 'workfile_invalid_content');
  // v3: 33 findings or resolutions in a document report, 40 choices, and a reason.
  assert.equal(codeOf(() => parseWorkfile(relabel({ ...dense, history: [] }, WORKFILE_FORMAT_V3))), 'workfile_invalid_content');
  assert.equal(codeOf(() => parseWorkfile(relabel({ ...dense, choices: [] }, WORKFILE_FORMAT_V3))), 'workfile_invalid_content');
  // The report's own validity at each limit.
  const report = dense.history[0].report;
  assert.equal(validReport(report, dense.source, dense.target), false, 'default limits: 40 findings and reasons');
  assert.equal(validReport(report, dense.source, dense.target, REPORT_V4), true);
  assert.equal(validReport({ ...report, findings: report.findings.filter(f => !hasReason(f)).slice(0, 32) }, dense.source, dense.target), true);
  assert.equal(validReport({ ...report, findings: report.findings.filter(f => !hasReason(f)) }, dense.source, dense.target), false, '35 findings');
  assert.equal(validReport({ ...report, findings: report.findings.filter(f => !hasReason(f)) }, dense.source, dense.target, { items: 32, reason: true }), false);
  assert.equal(validReport({ ...report, findings: report.findings.filter(f => !hasReason(f)) }, dense.source, dense.target, { items: 128, reason: false }), true);
  // reason: allowed only where the limits say so, only on not_evaluated, only with a known value.
  const reasoned = report.findings.find(hasReason);
  const swap = f => ({ ...report, findings: [f] });
  assert.equal(validReport(swap(reasoned), dense.source, dense.target, { items: 128, reason: false }), false);
  assert.equal(validReport(swap({ ...reasoned, verdict: 'needs_review' }), dense.source, dense.target, REPORT_V4), false);
  assert.equal(validReport(swap({ ...reasoned, reason: null }), dense.source, dense.target, REPORT_V4), false);
  assert.equal(validReport(swap({ ...reasoned, reason: 'unknown' }), dense.source, dense.target, REPORT_V4), false);
  for (const reason of REASON_VALUES) assert.equal(validReport(swap({ ...reasoned, reason }), dense.source, dense.target, REPORT_V4), true, reason);
  const { reason, ...bare } = reasoned; void reason;
  assert.equal(validReport(swap(bare), dense.source, dense.target, REPORT_V4), true, 'a not_evaluated finding without a reason stays valid');
});

test('lib: a v4 file at the 44 MiB cap, and a byte over', () => {
  const padded = cases.valid.find(c => c.pad_to_bytes === 1_048_577);
  assert.equal(parseWorkfile(contentOf(padded)).format, WORKFILE_FORMAT_V4);
  const base = read('valid-v4-document-dense.json');
  assert.doesNotThrow(() => parseWorkfile(padContent(base, MAX_V4_WORKFILE_BYTES)));
  assert.equal(codeOf(() => parseWorkfile(padContent(base, MAX_V4_WORKFILE_BYTES + 1))), 'workfile_too_large');
});
