// Generates contracts/manuscript-v3/. Default: check the committed bytes. --write: rewrite them.
// All text is synthetic; hashes, revisions and ids are computed, never typed.
// The contract is contracts/manuscript-v3/SPEC.md; this file only produces fixtures for it.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeChoice, serializeWorkfile } from '../lib/manuscript.js';
import { pairSegments } from '../lib/segmentation.js';
import { buildFixtures as buildV2Fixtures } from './build-manuscript-v2-fixtures.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'contracts', 'manuscript-v3');

export const V3_FORMAT = 'wuwaterm-manuscript-v3';
export const MAX_V3_BYTES = 16_777_216;
export const MAX_V2_BYTES = 1_048_576;
export const CODES = [
  'workfile_not_json', 'workfile_too_large', 'workfile_too_deep', 'workfile_too_many_entries', 'workfile_too_many_fields',
  'workfile_forbidden_field', 'workfile_unsupported_format', 'workfile_invalid_content', 'workfile_duplicate_choices',
  'workfile_segment_invalid', 'workfile_segment_order', 'workfile_segment_hash_mismatch', 'workfile_segment_basis_mismatch',
  'workfile_segment_anchor_invalid', 'workfile_progress_invalid',
];
export const LIMITS = {
  file_bytes: MAX_V3_BYTES, legacy_file_bytes: MAX_V2_BYTES, text_scalars: 16_777_216, array_items: 128, object_fields: 32, depth: 16,
  segments: 128, choices_per_record: 32, offered_per_choice: 8, segment_choice_history: 128, progress_completed: 128,
  core_scalars: 2000, choices: 32, history: 2, alignments: 64, semantic_decisions: 128, semantic_texts: 16, semantic_history: 2,
  semantic_history_segments: 64,
};

const UNSUPPORTED = 'workfile_unsupported_format';
const sha = label => createHash('sha256').update(label, 'utf8').digest('hex');
const bytesOf = text => Buffer.byteLength(text, 'utf8');
const scalars = text => Array.from(text);
const scalarSlice = (text, start, end) => scalars(text).slice(start, end).join('');
const failWith = code => Object.assign(new Error(code), { code });
const emit = value => JSON.stringify(value, null, 2);

export function padContent(content, bytes) {
  const missing = bytes - bytesOf(content);
  assert.ok(missing >= 0, `file is already over ${bytes} bytes`);
  return content + ' '.repeat(missing);
}

// ---- reference canonical writer (SPEC "Writing") ----

const orderSpan = s => ({ start: s.start, end: s.end, text: s.text });
const orderBasis = b => ({
  rule_version: b.rule_version,
  dictionary: { schema_version: b.dictionary.schema_version, source_commit: b.dictionary.source_commit, term_count: b.dictionary.term_count, revision: b.dictionary.revision },
  matcher_revision: b.matcher_revision,
});
const orderChoiceCandidate = c => (c === null ? null : { candidate_id: c.candidate_id, zh: c.zh, en: c.en, category: c.category });
const orderChoice = c => ({ source_span: orderSpan(c.source_span), choice: c.choice, candidate: orderChoiceCandidate(c.candidate), offered: [...c.offered], basis: orderBasis(c.basis) });
const orderHistoryEntry = c => ({ source_hash: c.source_hash, ...orderChoice(c) });
const orderReportCandidate = c => ({
  zh: c.zh, en: c.en, category: c.category, sources: c.sources.map(s => ({ source_file: s.source_file, source_id: s.source_id })), candidate_id: c.candidate_id,
});
const orderFinding = f => ({
  id: f.id, rule_id: f.rule_id, verdict: f.verdict, source_span: orderSpan(f.source_span), target_span: f.target_span === null ? null : orderSpan(f.target_span),
  candidates: f.candidates.map(orderReportCandidate), candidates_truncated: f.candidates_truncated,
});
const orderReport = r => ({
  request_id: r.request_id, source_revision: r.source_revision, target_revision: r.target_revision, rule_version: r.rule_version,
  matcher_revision: r.matcher_revision,
  dictionary: { schema_version: r.dictionary.schema_version, source_commit: r.dictionary.source_commit, term_count: r.dictionary.term_count, revision: r.dictionary.revision },
  coverage: { evaluated: r.coverage.evaluated, not_evaluated: r.coverage.not_evaluated, rules: [...r.coverage.rules] },
  findings: r.findings.map(orderFinding), truncated: r.truncated,
});
const orderRecord = r => ({
  index: r.index, segmentation_version: r.segmentation_version, source_start: r.source_start, source_end: r.source_end,
  target_start: r.target_start, target_end: r.target_end, source_hash: r.source_hash, target_hash: r.target_hash, status: r.status,
  basis: r.basis === null ? null : orderBasis(r.basis), report: r.report === null ? null : orderReport(r.report), choices: r.choices.map(orderChoice),
});

/** The bytes a conforming writer produces from a parsed manuscript. Over maxBytes it throws workfile_too_large. */
export function canonicalV3(payload, { maxBytes = MAX_V3_BYTES } = {}) {
  const segments = payload.segments ?? [];
  const historyChoices = payload.segment_choice_history ?? [];
  if (segments.length === 0 && historyChoices.length === 0) {
    try { return serializeWorkfile(payload); } catch (error) { if (error.code !== 'workfile_too_large') throw error; }
  }
  const decisions = payload.semantic_decisions ?? [];
  const needed = new Set(decisions.filter(d => d.decision === 'ignored').flatMap(d => [d.source_revision, d.target_revision]));
  const seen = new Set();
  const texts = (payload.semantic_texts ?? []).filter(t => needed.has(t.revision) && !seen.has(t.revision) && seen.add(t.revision));
  const semanticHistory = (payload.semantic_history ?? []).slice(-2);
  const write = () => emit({
    format: V3_FORMAT, source: payload.source, target: payload.target, direction: payload.direction, alignments: payload.alignments,
    choices: payload.choices, history: payload.history.slice(-2), semantic_decisions: decisions, semantic_texts: texts, semantic_history: semanticHistory,
    segments: segments.map(orderRecord), segment_choice_history: historyChoices.map(orderHistoryEntry),
    progress: { current: payload.progress.current, completed: [...payload.progress.completed] },
  });
  let content = write();
  while (semanticHistory.length > 0 && bytesOf(content) > maxBytes) { semanticHistory.shift(); content = write(); }
  if (bytesOf(content) > maxBytes) throw failWith('workfile_too_large');
  return content;
}

// ---- synthetic building blocks ----

const basisOf = (tag, termCount) => ({
  rule_version: 'review-v2',
  dictionary: { schema_version: '2', source_commit: `synthetic-commit-${tag}`, term_count: termCount, revision: sha(`dictionary-revision-${tag}`) },
  matcher_revision: sha('matcher-revision-synthetic'),
});
const B = basisOf('current', 1204);
const B_OLD = basisOf('previous', 1187);

const TERMS = {
  name: { zh: '示例名', en: 'Sample Name', category: 'character' },
  itemA: { zh: '示例物', en: 'Sample Item', category: 'item' },
  itemB: { zh: '示例物', en: 'Sample Object', category: 'item' },
  place: { zh: '示例地', en: 'Sample Place', category: 'place' },
  city: { zh: '示例城', en: 'Sample City', category: 'place' },
};
function candidateOf(term, tag = 'current') {
  const id = sha(`candidate:${tag}:${term.zh}:${term.en}:${term.category}`);
  return {
    zh: term.zh, en: term.en, category: term.category, candidate_id: id,
    sources: [{ source_file: 'Synthetic/Terms.json', source_id: `term_${id.slice(0, 8)}` }, { source_file: 'Synthetic/Labels.json', source_id: `label_${id.slice(0, 8)}` }],
  };
}

function spanOf(text, needle, nth = 0) {
  let at = -1;
  for (let i = 0; i <= nth; i++) {
    at = text.indexOf(needle, at + 1);
    assert.ok(at >= 0, `occurrence ${nth} of ${needle} is missing`);
  }
  const start = scalars(text.slice(0, at)).length;
  return { start, end: start + scalars(needle).length, text: needle };
}

function findingAt(core, targetCore, { text, nth = 0, verdict, targetText = null, candidates }) {
  const span = spanOf(core, text, nth);
  return {
    id: `${span.start}:${span.end}:${span.text}`, rule_id: 'review.term_pair', verdict, source_span: span,
    target_span: targetText === null ? null : spanOf(targetCore, targetText), candidates, candidates_truncated: false,
  };
}

function choiceAt(core, text, nth, kind, offered, picked, basis) {
  return {
    source_span: spanOf(core, text, nth), choice: kind, candidate: kind === 'official_pair' ? orderChoiceCandidate(picked) : null,
    offered: offered.map(c => c.candidate_id).sort(), basis: structuredClone(basis),
  };
}

function reportOf(sourceCore, targetCore, basis, findings, tag) {
  return {
    request_id: sha(`request:${tag}`).slice(0, 32), source_revision: sha(sourceCore), target_revision: sha(targetCore),
    rule_version: basis.rule_version, matcher_revision: basis.matcher_revision, dictionary: structuredClone(basis.dictionary),
    coverage: { evaluated: findings.length, not_evaluated: 0, rules: ['review.term_pair'] }, findings, truncated: false,
  };
}

const FILLER = n => `Filler line ${String(n).padStart(3, '0')} keeps this paragraph long.`;
function longParagraph(lead, goal) {
  let text = lead;
  let n = 1;
  while (scalars(text).length + 1 + scalars(FILLER(n)).length <= goal) { text += ` ${FILLER(n)}`; n++; }
  return text;
}

const STANDARD_MIDDLE = '示例名遇见了示例物，示例名又回到示例城。';
const MANY_MIDDLE = `${Array.from({ length: 32 }, () => '示例名').join('、')}。`;
const OLD_CORE = '示例旧段落里的示例名。';

/** Three paragraphs of the long-mode manuscript. `variant` only changes the middle paragraph. */
function documentPayload(variant = 'standard') {
  const middle = variant === 'many' ? MANY_MIDDLE : STANDARD_MIDDLE;
  const sources = ['示例地很安静。', middle, '示例物静静地躺着。'];
  const targets = [
    longParagraph('The Sample Place was quiet.', 1000),
    longParagraph('Sample Name met the Sample Item, and Sample Name returned to the Sample City.', 1000),
    longParagraph('The Sample Item lay still.', 900),
  ];
  const source = sources.join('\n\n');
  const target = targets.join('\n\n');
  assert.ok(scalars(target).length > 2000, 'the target must be long enough for long mode');
  const pairs = pairSegments(source, target);
  assert.equal(pairs.length, 3);
  assert.ok(pairs.every(p => p.status === 'ready' && !p.hard_cut));
  pairs.forEach((p, i) => {
    assert.equal(scalarSlice(source, p.source.core_start, p.source.core_end), sources[i]);
    assert.equal(scalarSlice(target, p.target.core_start, p.target.core_end), targets[i]);
  });
  assert.ok(!source.includes(OLD_CORE));
  const shell = (i, status, basis, report, choices) => ({
    index: i, segmentation_version: 'segmentation-v1', source_start: pairs[i].source.core_start, source_end: pairs[i].source.core_end,
    target_start: pairs[i].target.core_start, target_end: pairs[i].target.core_end, source_hash: sha(sources[i]), target_hash: sha(targets[i]),
    status, basis, report, choices,
  });

  const name = candidateOf(TERMS.name);
  const itemA = candidateOf(TERMS.itemA);
  const itemB = candidateOf(TERMS.itemB);
  const place = candidateOf(TERMS.place);
  const oldCity = candidateOf(TERMS.city, 'previous');
  const oldName = candidateOf(TERMS.name, 'previous');

  const pending = shell(0, 'pending', null, null, [choiceAt(sources[0], '示例地', 0, 'not_a_term', [place], null, B)]);

  let findings; let choices;
  if (variant === 'many') {
    findings = Array.from({ length: 32 }, (_, k) => findingAt(middle, targets[1], { text: '示例名', nth: k, verdict: 'needs_review', candidates: [name] }));
    choices = Array.from({ length: 32 }, (_, k) => choiceAt(middle, '示例名', k, k % 2 === 0 ? 'official_pair' : 'not_a_term', [name], k % 2 === 0 ? name : null, B));
  } else {
    findings = [
      findingAt(middle, targets[1], { text: '示例名', nth: 0, verdict: 'verified_constraint', targetText: 'Sample Name', candidates: [name] }),
      findingAt(middle, targets[1], { text: '示例物', nth: 0, verdict: 'needs_review', candidates: [itemA, itemB] }),
      findingAt(middle, targets[1], { text: '示例名', nth: 1, verdict: 'needs_review', candidates: [name] }),
    ];
    choices = [
      choiceAt(middle, '示例名', 0, 'official_pair', [name], name, B),
      choiceAt(middle, '示例物', 0, 'not_a_term', [itemA, itemB], null, B),
      // Made under the previous dictionary at an occurrence the current report no longer has: needs reconfirmation.
      choiceAt(middle, '示例城', 0, 'official_pair', [oldCity], oldCity, B_OLD),
    ];
  }
  const done = shell(1, 'done', structuredClone(B), reportOf(middle, targets[1], B, findings, `${variant}-1`), choices);

  const staleFindings = [findingAt(sources[2], targets[2], { text: '示例物', verdict: 'needs_review', candidates: [candidateOf(TERMS.itemA, 'previous')] })];
  const stale = shell(2, 'stale', structuredClone(B_OLD), reportOf(sources[2], targets[2], B_OLD, staleFindings, `${variant}-2`),
    [choiceAt(sources[2], '示例物', 0, 'official_pair', [candidateOf(TERMS.itemA, 'previous')], candidateOf(TERMS.itemA, 'previous'), B_OLD)]);

  return {
    format: V3_FORMAT, source, target, direction: 'en', alignments: null, choices: [], history: [],
    semantic_decisions: [], semantic_texts: [], semantic_history: [],
    segments: [pending, done, stale],
    segment_choice_history: [{ source_hash: sha(OLD_CORE), ...choiceAt(OLD_CORE, '示例名', 0, 'official_pair', [oldName], oldName, B_OLD) }],
    progress: { current: 0, completed: [1] },
  };
}

/** n pending records over n short paragraphs. The ranges are paragraph ranges, not a segmentation-v1 result. */
function pendingPayload(n) {
  const sources = Array.from({ length: n }, (_, i) => `示例段${String(i + 1).padStart(3, '0')}。`);
  const targets = Array.from({ length: n }, (_, i) => `Short paragraph ${String(i + 1).padStart(3, '0')}.`);
  const source = sources.join('\n\n');
  const target = targets.join('\n\n');
  let sourcePos = 0; let targetPos = 0;
  const segments = sources.map((core, i) => {
    const record = {
      index: i, segmentation_version: 'segmentation-v1', source_start: sourcePos, source_end: sourcePos + scalars(core).length,
      target_start: targetPos, target_end: targetPos + scalars(targets[i]).length, source_hash: sha(core), target_hash: sha(targets[i]),
      status: 'pending', basis: null, report: null, choices: [],
    };
    sourcePos = record.source_end + 2;
    targetPos = record.target_end + 2;
    return record;
  });
  return {
    format: V3_FORMAT, source, target, direction: 'en', alignments: null, choices: [], history: [],
    semantic_decisions: [], semantic_texts: [], semantic_history: [], segments, segment_choice_history: [], progress: { current: 0, completed: [] },
  };
}

function historyChoices(n) {
  return Array.from({ length: n }, (_, i) => {
    const core = `示例旧段落${i}里的示例名。`;
    const old = candidateOf(TERMS.name, `previous-${i}`);
    return { source_hash: sha(core), ...choiceAt(core, '示例名', 0, 'official_pair', [old], old, B_OLD) };
  });
}

function validV1() {
  const source = '示例名来到示例地。';
  const target = 'Sample Name came to the Sample Place.';
  const name = candidateOf(TERMS.name);
  const findings = [
    findingAt(source, target, { text: '示例名', verdict: 'verified_constraint', targetText: 'Sample Name', candidates: [name] }),
    findingAt(source, target, { text: '示例地', verdict: 'verified_constraint', targetText: 'Sample Place', candidates: [candidateOf(TERMS.place)] }),
  ];
  const report = reportOf(source, target, B, findings, 'v1');
  const choice = makeChoice({ source, direction: 'en', alignments: null, report, finding: findings[0], candidate: findings[0].candidates[0] });
  return serializeWorkfile({ source, target, direction: 'en', alignments: null, choices: [choice], history: [{ source, target, direction: 'en', alignments: null, report }] });
}

// ---- size models (SPEC "Size arithmetic") ----

const MODEL_SEGMENTS = 128;
const MODEL_REPORT_CAP = 65_536;
const CJK_DIGITS = '〇一二三四五六七八九';

function modelCores(i) {
  const source = Array.from({ length: 1800 }, () => '示');
  const target = Array.from({ length: 1800 }, () => 'x');
  for (let k = 0; k < 32; k++) {
    source.splice(k * 50, 4, ...'示例名称');
    target.splice(k * 55, 20, ...'Sample Official Name');
  }
  source.splice(1700, 3, ...Array.from(String(i).padStart(3, '0'), d => CJK_DIGITS[Number(d)]));
  target.splice(1780, 3, ...String(i).padStart(3, '0'));
  return { source: source.join(''), target: target.join('') };
}

function modelFinding(k, candidateCount, sourceCount) {
  return {
    id: `${k * 50}:${k * 50 + 4}:示例名称`, rule_id: 'review.term_pair', verdict: 'needs_review',
    source_span: { start: k * 50, end: k * 50 + 4, text: '示例名称' }, target_span: { start: k * 55, end: k * 55 + 20, text: 'Sample Official Name' },
    candidates: Array.from({ length: candidateCount }, (_, j) => ({
      zh: `示例名称${j}`, en: `Sample Official Name ${j}`, category: 'character',
      sources: Array.from({ length: sourceCount }, (_, s) => ({ source_file: 'TextMap/zh-Hans/MultiText.json', source_id: `ItemInfo_Synthetic_Name_${String(s).padStart(6, '0')}` })),
      candidate_id: sha(`model-candidate:${k}:${j}`),
    })),
    candidates_truncated: false,
  };
}

function modelFindings(kind) {
  if (kind === 'typical') return Array.from({ length: 16 }, (_, k) => modelFinding(k, k % 4 === 0 ? 2 : 1, 2));
  if (kind === 'dense') return Array.from({ length: 32 }, (_, k) => modelFinding(k, 2, 2));
  const size = findings => bytesOf(JSON.stringify(reportOf('', '', B, findings, 'model')));
  const findings = [];
  while (findings.length < 32) {
    const next = modelFinding(findings.length, 8, 8);
    if (size([...findings, next]) > MODEL_REPORT_CAP) break;
    findings.push(next);
  }
  for (let sources = 7; sources >= 1 && findings.length < 32; sources--) {
    const next = modelFinding(findings.length, 8, sources);
    if (size([...findings, next]) <= MODEL_REPORT_CAP) { findings.push(next); break; }
  }
  return findings;
}

/** A model manuscript: 128 done records, each with a full-size report and its choices. It need not pass a reader. */
export function budgetManuscript(kind) {
  const [choiceCount, offeredCount] = { typical: [4, 1], dense: [8, 2], extreme: [32, 8] }[kind];
  const findings = modelFindings(kind);
  const choices = Array.from({ length: choiceCount }, (_, j) => {
    const finding = findings[j % findings.length];
    const offered = finding.candidates.slice(0, offeredCount);
    return {
      source_span: { start: j * 50, end: j * 50 + 4, text: '示例名称' }, choice: 'official_pair', candidate: orderChoiceCandidate(offered[0]),
      offered: offered.map(c => c.candidate_id).sort(), basis: B,
    };
  });
  const sources = []; const targets = []; const segments = [];
  let position = 0;
  for (let i = 0; i < MODEL_SEGMENTS; i++) {
    const cores = modelCores(i);
    sources.push(cores.source); targets.push(cores.target);
    segments.push({
      index: i, segmentation_version: 'segmentation-v1', source_start: position, source_end: position + 1800, target_start: position, target_end: position + 1800,
      source_hash: sha(cores.source), target_hash: sha(cores.target), status: 'done', basis: B,
      report: reportOf(cores.source, cores.target, B, findings, `model-${kind}-${i}`), choices,
    });
    position += 1802;
  }
  return {
    format: V3_FORMAT, source: sources.join('\n\n'), target: targets.join('\n\n'), direction: 'en', alignments: null, choices: [], history: [],
    semantic_decisions: [], semantic_texts: [], semantic_history: [], segments, segment_choice_history: [], progress: { current: 0, completed: [] },
  };
}

// ---- fixtures ----

function replaceOnce(text, from, to) {
  const at = text.indexOf(from);
  assert.ok(at >= 0 && text.indexOf(from, at + 1) < 0, `expected exactly one ${from}`);
  return text.replace(from, () => to);
}

export async function buildFixtures() {
  const v2Files = await buildV2Fixtures();
  const v2Valid = v2Files.get('valid-all-parts.json');
  const v2Parsed = JSON.parse(v2Valid);

  const valid = canonicalV3(documentPayload());
  const base = JSON.parse(valid);
  assert.equal(emit(base), valid);
  const mutate = fn => { const x = structuredClone(base); fn(x); return emit(x); };

  const files = new Map();
  const cases = { format: V3_FORMAT, spec: 'SPEC.md', codes: CODES, limits: LIMITS, valid: [], invalid: [] };
  const ok = (file, content, note, legacy, canonical = file) => {
    files.set(file, content);
    cases.valid.push({ file, canonical, legacy_error: legacy, note });
  };
  const bad = (file, content, code, note, legacy = UNSUPPORTED) => {
    files.set(file, content);
    cases.invalid.push({ file, error: code, legacy_error: legacy, note });
  };

  // valid
  ok('valid-v3-all-parts.json', valid, 'three ready segments: pending with a carried choice, done with a verified and a needs_review finding, stale under the previous basis; one history choice; progress', UNSUPPORTED);
  ok('valid-v3-integral-numbers.json', replaceOnce(replaceOnce(valid, '"index": 1,', '"index": 1.0,'), '"source_start": 0,', '"source_start": 0.0,'),
    'integer fields written as 1.0 and 0.0 are accepted; the canonical form writes plain integers', UNSUPPORTED, 'valid-v3-all-parts.json');
  const otherHash = sha('hash-not-current: other core');
  ok('valid-v3-hash-not-current.json', mutate(x => { x.segments[1].source_hash = otherHash; x.segments[1].report.source_revision = otherHash; }),
    'record 1 hash and report.source_revision agree but differ from the current core: a valid file whose result the runtime treats as not current', UNSUPPORTED);
  ok('valid-v3-with-semantic.json', mutate(x => {
    x.semantic_decisions = v2Parsed.semantic_decisions; x.semantic_texts = v2Parsed.semantic_texts; x.semantic_history = v2Parsed.semantic_history;
  }), 'segment state together with the v2 semantic decisions, stored text and history snapshot', UNSUPPORTED);
  const fromV2 = emit({
    format: V3_FORMAT, source: v2Parsed.source, target: v2Parsed.target, direction: v2Parsed.direction, alignments: v2Parsed.alignments,
    choices: v2Parsed.choices, history: v2Parsed.history, semantic_decisions: v2Parsed.semantic_decisions, semantic_texts: v2Parsed.semantic_texts,
    semantic_history: v2Parsed.semantic_history, segments: [], segment_choice_history: [], progress: { current: null, completed: [] },
  });
  ok('valid-v3-from-v2.json', fromV2, 'a v3 file without segment state; the writer emits it as the v2 file named in canonical', UNSUPPORTED, 'valid-v2-all-parts.json');
  const hundred = pendingPayload(128);
  ok('valid-v3-128-segments.json', canonicalV3(hundred), '128 pending records over 128 short paragraphs; the ranges are paragraph ranges, not a segmentation-v1 result', UNSUPPORTED);
  const many = canonicalV3(documentPayload('many'));
  const manyBase = JSON.parse(many);
  ok('valid-v3-32-choices.json', many, 'a done record with 32 findings and 32 confirmed choices', UNSUPPORTED);
  ok('valid-v3-128-history.json', mutate(x => { x.segment_choice_history = historyChoices(128); }), '128 history choices', UNSUPPORTED);
  ok('valid-v1.json', validV1(), 'a v1 file with one choice and one history report, as the v2 writer emits it', null);
  ok('valid-v2-all-parts.json', v2Valid, 'byte-identical to contracts/manuscript-v2/valid-all-parts.json', null);
  cases.valid.push({ file: 'valid-v3-all-parts.json', pad_to_bytes: MAX_V3_BYTES, canonical: 'valid-v3-all-parts.json', legacy_error: 'workfile_too_large',
    note: 'padded with spaces to exactly 16 MiB: accepted by a v3 reader; an old client stops at its 1 MiB check' });
  cases.valid.push({ file: 'valid-v2-all-parts.json', pad_to_bytes: MAX_V2_BYTES, canonical: 'valid-v2-all-parts.json', legacy_error: null,
    note: 'a v2 file padded with spaces to exactly 1 MiB is accepted' });

  // invalid: size and tree caps
  const tooLarge = (file, pad, note, legacy) => cases.invalid.push({ file, pad_to_bytes: pad, error: 'workfile_too_large', legacy_error: legacy, note });
  tooLarge('valid-v3-all-parts.json', MAX_V3_BYTES + 1, 'a v3 file one byte over 16 MiB', 'workfile_too_large');
  tooLarge('valid-v2-all-parts.json', MAX_V2_BYTES + 1, 'a v2 file one byte over 1 MiB: non-v3 input keeps the 1 MiB cap', 'workfile_too_large');
  bad('invalid-v3-129-segments.json', canonicalV3(pendingPayload(129)), 'workfile_too_many_entries', '129 records: the generic array cap is 128',
    'workfile_too_many_entries');
  bad('invalid-v3-33-choices.json', emit((() => { const x = structuredClone(manyBase); x.segments[1].choices.push(structuredClone(x.segments[1].choices[0])); return x; })()),
    'workfile_too_many_entries', '33 choices in one record (32 plus a repeat of the first)');
  bad('invalid-v3-129-history.json', mutate(x => { x.segment_choice_history = historyChoices(129); }), 'workfile_too_many_entries',
    '129 history choices: the generic array cap is 128', 'workfile_too_many_entries');
  bad('invalid-v3-9-offered.json', mutate(x => {
    x.segments[0].choices[0].offered = Array.from({ length: 9 }, (_, i) => sha(`offered:${i}`)).sort();
  }), 'workfile_too_many_entries', 'a choice offering 9 candidate ids, ascending and distinct');
  bad('invalid-v3-depth-17.json', mutate(x => {
    let nested = [];
    for (let i = 0; i < 15; i++) nested = [nested];
    x.progress.current = nested;
  }), 'workfile_too_deep', 'a value at depth 17 (progress.current holds 16 nested arrays)', 'workfile_too_deep');
  bad('invalid-v3-33-fields.json', mutate(x => {
    for (let i = 1; i <= 21; i++) x.segments[0][`extra_${String(i).padStart(2, '0')}`] = 0;
    assert.equal(Object.keys(x.segments[0]).length, 33);
  }), 'workfile_too_many_fields', 'a record with 33 fields', 'workfile_too_many_fields');
  bad('invalid-v3-forbidden-key.json', replaceOnce(valid, '"index": 0,', '"__proto__": 0,\n      "index": 0,'), 'workfile_forbidden_field',
    'a record with a __proto__ key, inserted in the JSON text', 'workfile_forbidden_field');

  // invalid: top level and the v1/v2 parts
  bad('invalid-v3-unknown-top-key.json', mutate(x => { x.extra = true; }), 'workfile_unsupported_format', 'a 14th top-level key');
  bad('invalid-v3-missing-progress.json', mutate(x => { delete x.progress; }), 'workfile_unsupported_format', 'progress is missing, so the top-level keys are not the 13 v3 keys');
  bad('invalid-v3-format-v4.json', mutate(x => { x.format = 'wuwaterm-manuscript-v4'; }), 'workfile_unsupported_format', 'an unknown format version falls through to the v2 reader');
  bad('invalid-v3-v2-part.json', mutate(x => { x.direction = 'fr'; }), 'workfile_invalid_content', 'the v1/v2 part keeps its checks: direction must be en or zh');

  // invalid: record structure (step 6)
  bad('invalid-v3-unknown-status.json', mutate(x => { x.segments[1].status = 'paused'; }), 'workfile_segment_invalid', 'status is not pending, done or stale');
  bad('invalid-v3-pending-with-report.json', mutate(x => { x.segments[1].status = 'pending'; }), 'workfile_segment_invalid', 'a pending record that still holds a basis and a report');
  bad('invalid-v3-done-without-report.json', mutate(x => { x.segments[1].report = null; }), 'workfile_segment_invalid', 'a done record whose report is null');
  bad('invalid-v3-segmentation-version.json', mutate(x => { x.segments[0].segmentation_version = 'segmentation-v2'; }), 'workfile_segment_invalid', 'an unknown segmentation version');
  bad('invalid-v3-hash-uppercase.json', mutate(x => {
    const upper = x.segments[0].source_hash.toUpperCase();
    assert.notEqual(upper, x.segments[0].source_hash);
    x.segments[0].source_hash = upper;
  }), 'workfile_segment_invalid', 'a content hash written in uppercase hex');
  bad('invalid-v3-range-beyond-text.json', mutate(x => { x.segments[2].target_end = scalars(x.target).length + 1; }), 'workfile_segment_invalid',
    'a target range that ends past the text; later checks fail too, the first failure is the range');
  bad('invalid-v3-basis-no-matcher.json', mutate(x => { delete x.segments[1].basis.matcher_revision; }), 'workfile_segment_invalid',
    'a record basis without matcher_revision; a later check would give basis_mismatch, the first failure is the basis shape');
  bad('invalid-v3-basis-null-schema.json', mutate(x => { x.segments[0].choices[0].basis.dictionary.schema_version = null; }), 'workfile_segment_invalid',
    'a choice basis with a null schema_version');
  bad('invalid-v3-unknown-record-key.json', mutate(x => { x.segments[0].extra = true; }), 'workfile_segment_invalid', 'a record with an unknown key');
  bad('invalid-v3-candidate-not-offered.json', mutate(x => { x.segments[1].choices[2].offered = [sha('candidate-not-offered: another candidate')]; }), 'workfile_segment_invalid',
    'an official_pair whose candidate id is not in offered');
  bad('invalid-v3-non-integral-index.json', mutate(x => { x.segments[1].index = 1.5; }), 'workfile_segment_invalid',
    'index 1.5 is not an integer; later checks fail too, the first failure is the type');
  bad('invalid-v3-report-span-mismatch.json', mutate(x => {
    const span = x.segments[1].report.findings[0].target_span;
    assert.equal(span.text, 'Sample Name');
    span.text = 'Sample Nome';
  }), 'workfile_segment_invalid', 'a finding target span that does not read the same in the target core: the report is not valid for its cores');
  bad('invalid-v3-history-bad-entry.json', mutate(x => { x.segment_choice_history[0].candidate = null; }), 'workfile_segment_invalid',
    'a history choice that is an official_pair without a candidate');

  // invalid: order, content, progress
  bad('invalid-v3-duplicate-index.json', mutate(x => { x.segments[1].index = 0; }), 'workfile_segment_order', 'two records with index 0');
  bad('invalid-v3-overlapping-ranges.json', mutate(x => { x.segments[0].source_end = x.segments[1].source_start + 2; }), 'workfile_segment_order',
    'record 0 ends after record 1 starts');
  bad('invalid-v3-report-revision-mismatch.json', mutate(x => { x.segments[1].report.target_revision = sha('report-revision-mismatch: other target'); }),
    'workfile_segment_hash_mismatch', 'the report target_revision differs from the record target_hash');
  bad('invalid-v3-basis-mismatch.json', mutate(x => { x.segments[1].basis.dictionary.revision = sha('basis-mismatch: other dictionary'); }),
    'workfile_segment_basis_mismatch', 'the record basis dictionary revision differs from the report dictionary revision');
  bad('invalid-v3-choice-outside-core.json', mutate(x => { Object.assign(x.segments[0].choices[0].source_span, { start: 7, end: 10 }); }),
    'workfile_segment_anchor_invalid', 'a choice span that starts at the end of its core');
  bad('invalid-v3-choice-text-differs.json', mutate(x => { x.segments[0].choices[0].source_span.text = '示例乙'; }), 'workfile_segment_anchor_invalid',
    'a choice span whose text is not what the core holds there');
  bad('invalid-v3-confirmed-choice-not-reported.json', mutate(x => { x.segments[1].choices[2].basis = structuredClone(x.segments[1].basis); }),
    'workfile_segment_anchor_invalid', 'a confirmed choice at an occurrence the report has no finding for');
  bad('invalid-v3-duplicate-choice.json', mutate(x => { x.segments[0].choices.push(structuredClone(x.segments[0].choices[0])); }), 'workfile_duplicate_choices',
    'two choices with the same start and end in one record');
  bad('invalid-v3-progress-current-missing.json', mutate(x => { x.progress.current = 3; }), 'workfile_progress_invalid', 'progress.current names a record that does not exist');
  bad('invalid-v3-progress-completed-not-done.json', mutate(x => { x.progress.completed = [1, 2]; }), 'workfile_progress_invalid', 'completed names record 2, which is stale');
  bad('invalid-v3-progress-completed-unsorted.json', mutate(x => { x.progress.completed = [1, 1]; }), 'workfile_progress_invalid',
    'completed repeats an index, so it is not strictly ascending (record 1 is the only done record)');

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
    if (current !== content) { stale++; console.error(`stale: contracts/manuscript-v3/${name}`); }
  }
  if (stale) { console.error('Run: node scripts/build-manuscript-v3-fixtures.mjs --write'); process.exit(1); }
  console.log(write ? `wrote ${files.size} files` : `ok: ${files.size} files`);
}
