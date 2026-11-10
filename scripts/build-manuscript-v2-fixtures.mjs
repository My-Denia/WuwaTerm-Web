// Generates contracts/manuscript-v2/. Default: check the committed bytes. --write: rewrite them.
// All text is synthetic; revisions and ids are computed, never typed.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializeWorkfile } from '../lib/manuscript.js';
import { revisionOf } from '../lib/review-report.js';
import { makeSemanticDecision } from '../lib/semantic-decisions.js';
import { semanticIssueId } from '../lib/semantic-review.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'contracts', 'manuscript-v2');
const CHECKED = ['omission', 'unsupported_addition', 'meaning_shift', 'negation_change', 'quantity_change', 'reference_inconsistency', 'term_sense'];
const TERM_BASIS = { dictionary_revision: 'd1'.repeat(32), matcher_revision: 'a2'.repeat(32) };
const FINGERPRINTS = ['11'.repeat(16), '22'.repeat(16), '33'.repeat(16)];

const scalarSlice = (text, start, end) => Array.from(text).slice(start, end).join('');
const span = (text, start, end) => ({ start, end, text: scalarSlice(text, start, end) });

async function semanticIssue(category, fingerprint, sourceRev, targetRev, sourceSpan, targetSpan, suggestion) {
  return {
    id: await semanticIssueId(category, sourceRev, targetRev, sourceSpan, targetSpan), fingerprint, category, origin: 'model', confidence: 'high',
    source_span: sourceSpan, target_span: targetSpan, source_excerpt: sourceSpan && sourceSpan.text, target_excerpt: targetSpan && targetSpan.text,
    rationale: 'Synthetic fixture rationale.', suggestion, suggestion_withheld: null, alternatives: [],
  };
}

async function validFile() {
  const source = '第三天到了。\n它很安静。';
  const oldTarget = 'It is the second day.\nIt is quiet.';
  const target = 'It is the third day.\nIt is quiet.';
  const sourceCore = scalarSlice(source, 0, 5); const targetCore = scalarSlice(oldTarget, 0, 21);
  const sourceCoreRev = await revisionOf(sourceCore); const targetCoreRev = await revisionOf(targetCore);
  const issueA = await semanticIssue('quantity_change', FINGERPRINTS[0], sourceCoreRev, targetCoreRev, span(sourceCore, 0, 3), span(targetCore, 7, 17),
    { target_span: span(targetCore, 7, 13), replacement: 'third', term_effect: 'none' });
  const report = {
    request_id: 'fixture-history', review_version: 'semantic-review-v1', source_revision: sourceCoreRev, target_revision: targetCoreRev,
    term_basis: TERM_BASIS, status: 'complete', status_reason: null, dropped_unanchored: 0, checked: CHECKED, issues: [issueA],
    truncated: false, truncated_reason: null, omitted_issues: 0,
  };
  const wholeA = { ...issueA, source_span: span(source, 0, 3), target_span: span(oldTarget, 7, 17) };
  const wholeB = { id: 'b'.repeat(32), fingerprint: FINGERPRINTS[1], category: 'omission', source_span: span(source, 7, 11), target_span: null };
  const wholeC = { id: 'c'.repeat(32), fingerprint: FINGERPRINTS[2], category: 'meaning_shift', source_span: null, target_span: span(oldTarget, 28, 33) };
  const decisions = [
    await makeSemanticDecision({ issue: wholeA, segmentIndex: 0, source, target: oldTarget, termBasis: TERM_BASIS, decision: 'accepted', appliedText: 'third' }),
    await makeSemanticDecision({ issue: wholeB, segmentIndex: 1, source, target: oldTarget, termBasis: TERM_BASIS, decision: 'ignored', appliedText: null }),
    await makeSemanticDecision({ issue: wholeC, segmentIndex: 1, source, target: oldTarget, termBasis: TERM_BASIS, decision: 'adjusted', appliedText: 'calm' }),
  ];
  for (const d of decisions) d.issue_id = await semanticIssueId(d.category, d.source_revision, d.target_revision, d.source_span, d.target_span);
  return {
    source, target, direction: 'en', alignments: null, choices: [], history: [], semantic_decisions: decisions,
    semantic_texts: [{ revision: await revisionOf(oldTarget), text: oldTarget }],
    semantic_history: [{ source, target: oldTarget, direction: 'en',
      segments: [{ segment_index: 0, source_start: 0, source_end: 5, target_start: 0, target_end: 21, report }] }],
  };
}

export async function buildFixtures() {
  const payload = await validFile();
  const valid = serializeWorkfile(payload);
  const base = JSON.parse(valid);
  const mutate = fn => { const x = structuredClone(base); fn(x); return JSON.stringify(x, null, 2); };
  const files = new Map();
  const cases = { valid: [], invalid: [] };
  files.set('valid-all-parts.json', valid);
  cases.valid.push({ file: 'valid-all-parts.json', note: 'accepted, ignored and adjusted decisions, one stored old text, one history snapshot' });
  const bad = (file, code, note, content) => { files.set(file, content); cases.invalid.push({ file, error: code, note }); };
  bad('invalid-both-spans-null.json', 'workfile_invalid_content', 'a decision with no source and no target span',
    mutate(x => { x.semantic_decisions[0].source_span = null; x.semantic_decisions[0].target_span = null; }));
  bad('invalid-ignored-with-text.json', 'workfile_invalid_content', 'an ignored decision must have applied_text null',
    mutate(x => { x.semantic_decisions[1].applied_text = 'text'; }));
  bad('invalid-duplicate-occurrence.json', 'workfile_duplicate_choices', 'two decisions for the same occurrence key',
    mutate(x => { x.semantic_decisions.push({ ...x.semantic_decisions[0], decision: 'ignored', applied_text: null }); }));
  const many = structuredClone(base);
  many.semantic_decisions = Array.from({ length: 129 }, (_, i) => ({ ...base.semantic_decisions[0], segment_index: i }));
  bad('invalid-129-decisions.json', 'workfile_too_many_entries', 'more than 128 decisions', JSON.stringify(many));
  bad('invalid-bad-hex.json', 'workfile_invalid_content', 'an uppercase revision is not lowercase hex',
    mutate(x => { x.semantic_decisions[0].source_revision = x.semantic_decisions[0].source_revision.toUpperCase(); }));
  bad('invalid-unknown-key.json', 'workfile_invalid_content', 'an unknown key inside a decision',
    mutate(x => { x.semantic_decisions[0].extra = true; }));
  cases.format = 'wuwaterm-manuscript-v2';
  files.set('cases.json', `${JSON.stringify(cases, null, 2)}\n`);
  return files;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const files = await buildFixtures();
  const write = process.argv.includes('--write');
  if (write) mkdirSync(root, { recursive: true });
  let stale = 0;
  for (const [name, content] of files) {
    if (write) { writeFileSync(join(root, name), content); continue; }
    let current = null;
    try { current = readFileSync(join(root, name), 'utf8'); } catch { /* missing */ }
    if (current !== content) { stale++; console.error(`stale: contracts/manuscript-v2/${name}`); }
  }
  if (stale) { console.error('Run: node scripts/build-manuscript-v2-fixtures.mjs --write'); process.exit(1); }
  console.log(write ? `wrote ${files.size} files` : `ok: ${files.size} files`);
}
