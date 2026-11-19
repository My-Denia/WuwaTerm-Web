// Generates contracts/manuscript-v4/. Default: check the committed bytes. --write: rewrite them.
// All text is synthetic or public game text; hashes, revisions and ids are computed, never typed.
// The contract is contracts/manuscript-v4/SPEC.md (a delta to contracts/manuscript-v3/SPEC.md); this file only produces fixtures for it.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// The frozen Web 0.3.1 reader and writer: the generator stays independent of lib/manuscript.js, which writes v4 now.
import { makeChoice, parseWorkfile as parseWeb031 } from '../tests/legacy/web-0.3.1/manuscript.js';
import { pairSegments } from '../lib/segmentation.js';
import { buildFixtures as buildV3Fixtures, canonicalV3, padContent } from './build-manuscript-v3-fixtures.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'contracts', 'manuscript-v4');

export const V3_FORMAT = 'wuwaterm-manuscript-v3';
export const V4_FORMAT = 'wuwaterm-manuscript-v4';
export const MAX_V4_BYTES = 46_137_344;
export const MAX_V2_BYTES = 1_048_576;
export const REASON_VALUES = ['not_a_term', 'ordinary_word', 'no_target_region', 'found_outside_region', 'ambiguous_repeat'];
export const CODES = [
  'workfile_not_json', 'workfile_too_large', 'workfile_too_deep', 'workfile_too_many_entries', 'workfile_too_many_fields',
  'workfile_forbidden_field', 'workfile_unsupported_format', 'workfile_invalid_content', 'workfile_duplicate_choices',
  'workfile_segment_invalid', 'workfile_segment_order', 'workfile_segment_anchor_invalid', 'workfile_progress_invalid',
];
export const LIMITS = {
  file_bytes: MAX_V4_BYTES, legacy_file_bytes: MAX_V2_BYTES, text_scalars: 46_137_344, array_items: 512, v1_v2_part_array_items: 128,
  object_fields: 32, depth: 16, segments: 512, segment_choice_history: 512, progress_completed: 512, core_scalars: 2000,
  findings_per_result: 128, candidates_per_finding: 8, choices_per_record: 128, offered_per_choice: 8, choices: 128,
  resolutions_per_history_snapshot: 128, findings_per_history_report: 128, history: 2, alignments: 64, semantic_decisions: 128,
  semantic_texts: 16, semantic_history: 2, semantic_history_segments: 64, v1_v3_items_per_list: 32,
};

const sha = label => createHash('sha256').update(label, 'utf8').digest('hex');
const bytesOf = text => Buffer.byteLength(text, 'utf8');
const scalars = text => Array.from(text);
const scalarSlice = (text, start, end) => scalars(text).slice(start, end).join('');
const minify = value => JSON.stringify(value);
const hasReason = f => Object.hasOwn(f, 'reason');

// ---- reference canonical writer (SPEC "Writing") ----

const orderSpan = s => ({ start: s.start, end: s.end, text: s.text });
const orderBasis = b => ({
  rule_version: b.rule_version,
  dictionary: { schema_version: b.dictionary.schema_version, source_commit: b.dictionary.source_commit, term_count: b.dictionary.term_count, revision: b.dictionary.revision },
  matcher_revision: b.matcher_revision,
});
const orderCandidate = c => (c === null ? null : { candidate_id: c.candidate_id, zh: c.zh, en: c.en, category: c.category });
const orderChoice = c => ({ source_span: orderSpan(c.source_span), choice: c.choice, candidate: orderCandidate(c.candidate), offered: [...c.offered], confirmed: c.confirmed });
const orderHistoryEntry = c => ({
  source_hash: c.source_hash, source_span: orderSpan(c.source_span), choice: c.choice, candidate: orderCandidate(c.candidate), offered: [...c.offered],
});
// `reason` is the last key, and only a finding that has one writes it.
const orderFinding = f => ({
  verdict: f.verdict, source: [...f.source], target: f.target === null ? null : [...f.target], candidates: f.candidates.map(orderCandidate),
  candidates_truncated: f.candidates_truncated, ...(hasReason(f) ? { reason: f.reason } : {}),
});
const orderResult = r => ({ truncated: r.truncated, evaluated: r.evaluated, not_evaluated: r.not_evaluated, findings: r.findings.map(orderFinding) });
const orderRecord = r => ({
  index: r.index, segmentation_version: r.segmentation_version, source_start: r.source_start, source_end: r.source_end,
  target_start: r.target_start, target_end: r.target_end, source_hash: r.source_hash, target_hash: r.target_hash, status: r.status,
  direction: r.direction, alignment_input: r.alignment_input, basis: r.basis === null ? null : orderBasis(r.basis),
  result: r.result === null ? null : orderResult(r.result), choices: r.choices.map(orderChoice),
});

/** Whether every list of the payload is within the v1-v3 limits of 32 and no finding carries a reason: then v1, v2 or v3 holds it. */
export function fitsV3(payload) {
  const history = (payload.history ?? []).slice(-2);
  return payload.choices.length <= 32
    && history.every(h => (h.resolutions?.length ?? 0) <= 32 && h.report.findings.length <= 32 && h.report.findings.every(f => !hasReason(f)))
    && (payload.segments ?? []).every(r => r.choices.length <= 32 && (r.result === null || (r.result.findings.length <= 32 && r.result.findings.every(f => !hasReason(f)))));
}

/** The bytes a conforming writer produces from a parsed manuscript: the lowest of v1/v2, v3 and v4 that holds it. */
export function canonicalV4(payload, { maxBytes = MAX_V4_BYTES } = {}) {
  if (fitsV3(payload)) return canonicalV3(payload, { maxBytes });
  const decisions = payload.semantic_decisions ?? [];
  const needed = new Set(decisions.filter(d => d.decision === 'ignored').flatMap(d => [d.source_revision, d.target_revision]));
  const seen = new Set();
  const texts = (payload.semantic_texts ?? []).filter(t => needed.has(t.revision) && !seen.has(t.revision) && seen.add(t.revision));
  const semanticHistory = (payload.semantic_history ?? []).slice(-2);
  const write = () => minify({
    format: V4_FORMAT, source: payload.source, target: payload.target, direction: payload.direction, alignments: payload.alignments,
    choices: payload.choices, history: payload.history.slice(-2), semantic_decisions: decisions, semantic_texts: texts, semantic_history: semanticHistory,
    segments: (payload.segments ?? []).map(orderRecord), segment_choice_history: (payload.segment_choice_history ?? []).map(orderHistoryEntry),
    progress: { current: payload.progress.current, completed: [...payload.progress.completed] },
  });
  let content = write();
  while (semanticHistory.length > 0 && bytesOf(content) > maxBytes) { semanticHistory.shift(); content = write(); }
  if (bytesOf(content) > maxBytes) throw Object.assign(new Error('workfile_too_large'), { code: 'workfile_too_large' });
  return content;
}

// ---- synthetic building blocks: public Wuthering Waves terms ----

const DICTIONARY = {
  schema_version: '2', source_commit: 'synthetic-commit-v4', term_count: 1204, revision: sha('dictionary-revision-v4'),
};
const MATCHER = sha('matcher-revision-v4');
const basis = (tag = 'current') => ({
  rule_version: 'review-v2',
  dictionary: { ...DICTIONARY, source_commit: `synthetic-commit-v4-${tag}`, revision: sha(`dictionary-revision-v4-${tag}`) },
  matcher_revision: MATCHER,
});
const B = basis('current');
const B_OLD = basis('previous');

const TERMS = {
  camellya: { zh: '椿', en: 'Camellya', category: 'character' },
  jinhsi: { zh: '今汐', en: 'Jinhsi', category: 'character' },
  echo: { zh: '声骸', en: 'Echo', category: 'item' },
  tuner: { zh: '调谐器', en: 'Tuner', category: 'item' },
  hsin: { zh: '心大人', en: 'Lady Hsin', category: 'character' },
};
const candidateOf = (term, tag = 'v4') => ({ candidate_id: sha(`candidate:${tag}:${term.zh}:${term.en}:${term.category}`), zh: term.zh, en: term.en, category: term.category });

function spanOf(text, needle, nth = 0) {
  let at = -1;
  for (let i = 0; i <= nth; i++) {
    at = text.indexOf(needle, at + 1);
    assert.ok(at >= 0, `occurrence ${nth} of ${needle} is missing`);
  }
  const start = scalars(text.slice(0, at)).length;
  return { start, end: start + scalars(needle).length, text: needle };
}

const FILLER = n => `Filler line ${String(n).padStart(3, '0')} keeps this paragraph long.`;
function longParagraph(lead, goal) {
  let text = lead;
  let n = 1;
  while (scalars(text).length + 1 + scalars(FILLER(n)).length <= goal) { text += ` ${FILLER(n)}`; n++; }
  return text;
}

// ---- document mode: a dense history report (40 findings) with reasons, and more than 32 choices ----

// The review-v2 report as the Web BFF returns it, with a finding's `reason` last.
function liveReport(source, target, findings, requestId) {
  const notEvaluated = findings.filter(f => f.verdict === 'not_evaluated').length;
  return {
    request_id: requestId, source_revision: sha(source), target_revision: sha(target), rule_version: 'review-v2', matcher_revision: MATCHER,
    dictionary: { ...DICTIONARY },
    coverage: { evaluated: findings.length - notEvaluated, not_evaluated: notEvaluated, rules: ['review.term_pair', 'review.sentence_meaning'] },
    findings, truncated: false,
  };
}
const liveCandidate = (c, n) => ({ zh: c.zh, en: c.en, category: c.category, candidate_id: c.candidate_id, sources: [{ source_file: 'synthetic/terms.json', source_id: `term-${n}` }] });
const liveFinding = (span, target, verdict, candidate, reason) => ({
  id: `${span.start}:${span.end}:${span.text}`, rule_id: 'review.term_pair', verdict, source_span: span, target_span: target,
  candidates: [liveCandidate(candidate, 1)], candidates_truncated: false, ...(reason === undefined ? {} : { reason }),
});
const lineStarts = lines => { let at = 0; return lines.map(line => { const start = at; at += scalars(line).length + 1; return start; }); };

/**
 * Document mode, 40 lines: 35 verified `椿` / Camellya lines and five lines Core did not evaluate, one per reason code. The history
 * report has 40 findings and 40 resolutions, and there are 40 choices: over the 32 of v1 to v3, so only v4 holds it.
 */
function documentPayload() {
  const camellya = candidateOf(TERMS.camellya);
  const lines = []; const targetLines = [];
  for (let n = 1; n <= 35; n++) { lines.push(`第${n}行：椿。`); targetLines.push(`Line ${n}: Camellya.`); }
  const extras = [
    ['第36行：香椿。', 'Line 36: Toon sprouts.', '椿', TERMS.camellya, 'not_a_term'],
    ['第37行：红椿蕊。', 'Line 37: Red camellia stamen.', '椿', TERMS.camellya, 'ordinary_word'],
    ['第38行：调谐器。', 'Line 38: Tuner.', '调谐器', TERMS.tuner, 'no_target_region'],
    ['第39行：今汐。', 'Line 39: Jinhsi.', '今汐', TERMS.jinhsi, 'found_outside_region'],
    ['第40行：声骸。', 'Line 40: Echo.', '声骸', TERMS.echo, 'ambiguous_repeat'],
  ];
  for (const [line, targetLine] of extras) { lines.push(line); targetLines.push(targetLine); }
  const source = lines.join('\n');
  const target = targetLines.join('\n');
  const sources = lineStarts(lines); const targets = lineStarts(targetLines);
  assert.ok(scalars(source).length <= 2000 && scalars(target).length <= 2000);

  const findings = [];
  for (let n = 1; n <= 35; n++) {
    const start = sources[n - 1] + scalars(`第${n}行：`).length;
    const targetStart = targets[n - 1] + scalars(`Line ${n}: `).length;
    findings.push(liveFinding({ start, end: start + 1, text: '椿' }, { start: targetStart, end: targetStart + 8, text: 'Camellya' }, 'verified_constraint', camellya));
  }
  extras.forEach(([line, , needle, term, reason], i) => {
    const n = 36 + i;
    const start = sources[n - 1] + scalars(line.slice(0, line.indexOf(needle))).length;
    findings.push(liveFinding({ start, end: start + scalars(needle).length, text: needle }, null, 'not_evaluated', candidateOf(term), reason));
  });
  for (const f of findings) {
    assert.equal(scalarSlice(source, f.source_span.start, f.source_span.end), f.source_span.text);
    if (f.target_span) assert.equal(scalarSlice(target, f.target_span.start, f.target_span.end), f.target_span.text);
  }
  assert.equal(new Set(findings.map(f => f.id)).size, 40);
  const report = liveReport(source, target, findings, 'req-v4-document');

  // 40 choices at distinct places: an official pair for each verified finding, "not a term" for each one Core did not evaluate.
  const draft = { source, target, direction: 'en', alignments: null };
  const resolutions = [];
  const choices = findings.map(finding => {
    const picked = finding.verdict === 'verified_constraint' ? { ...finding.candidates[0] } : null;
    resolutions.push(picked ? { mention_id: finding.id, choice: 'official_pair', candidate_id: picked.candidate_id } : { mention_id: finding.id, choice: 'not_a_term' });
    return makeChoice({ ...draft, report, finding, candidate: picked });
  });
  return {
    format: V4_FORMAT, source, target, direction: 'en', alignments: null, choices,
    history: [{ source, target, direction: 'en', alignments: null, report, resolutions }],
    semantic_decisions: [], semantic_texts: [], semantic_history: [], segments: [], segment_choice_history: [],
    progress: { current: null, completed: [] },
  };
}

// ---- long mode: a dense record (128 findings, 128 choices, all five reasons) ----

function resultOf(findings, truncated = false) {
  const notEvaluated = findings.filter(f => f.verdict === 'not_evaluated').length;
  return { truncated, evaluated: findings.length - notEvaluated, not_evaluated: notEvaluated, findings };
}
function compactFinding(sourceCore, targetCore, { needle, nth = 0, verdict, targetText = null, targetNth = 0, candidates, reason }) {
  const span = spanOf(sourceCore, needle, nth);
  const target = targetText === null ? null : spanOf(targetCore, targetText, targetNth);
  return orderFinding({
    verdict, source: [span.start, span.end], target: target === null ? null : [target.start, target.end], candidates: candidates.map(orderCandidate),
    candidates_truncated: false, ...(reason === undefined ? {} : { reason }),
  });
}
function choiceAt(sourceCore, needle, nth, kind, offered, picked, confirmed) {
  return {
    source_span: spanOf(sourceCore, needle, nth), choice: kind, candidate: kind === 'official_pair' ? orderCandidate(picked) : null,
    offered: kind === 'official_pair' ? [] : offered.map(c => c.candidate_id).sort(), confirmed,
  };
}

/**
 * Long mode, three paragraphs. Record 1 is done and dense: 128 findings (123 on `椿`, one for each of the five reasons) and 128
 * confirmed choices, every finding with one. Record 2 is stale with 33 findings, one over the v3 limit. Record 0 is pending.
 */
function segmentsPayload() {
  const camellya = candidateOf(TERMS.camellya);
  const tuner = candidateOf(TERMS.tuner);
  const jinhsi = candidateOf(TERMS.jinhsi);
  const echo = candidateOf(TERMS.echo);
  const hsin = candidateOf(TERMS.hsin);
  const denseSource = `${Array.from({ length: 123 }, () => '椿。').join('')}香椿。红椿蕊。调谐器。今汐。声骸。`;
  const denseTarget = `${Array.from({ length: 123 }, () => 'Camellya,').join(' ')} Toon. Red camellia stamen. Tuner. Jinhsi. Echo.`;
  const sources = ['心大人在等候。', denseSource, `${Array.from({ length: 33 }, () => '椿。').join('')}`];
  const targets = [
    longParagraph('Lady Hsin waits.', 1000),
    denseTarget,
    `${Array.from({ length: 33 }, () => 'Camellya.').join(' ')} ${longParagraph('The rest.', 700)}`,
  ];
  const source = sources.join('\n\n');
  const target = targets.join('\n\n');
  assert.ok(scalars(target).length > 2000, 'the target must be long enough for long mode');
  assert.ok(scalars(targets[1]).length <= 1800);
  const pairs = pairSegments(source, target);
  assert.equal(pairs.length, 3);
  assert.ok(pairs.every(p => p.status === 'ready' && !p.hard_cut));
  pairs.forEach((p, i) => {
    assert.equal(scalarSlice(source, p.source.core_start, p.source.core_end), sources[i]);
    assert.equal(scalarSlice(target, p.target.core_start, p.target.core_end), targets[i]);
  });
  const shell = (i, status, record) => ({
    index: i, segmentation_version: 'segmentation-v1', source_start: pairs[i].source.core_start, source_end: pairs[i].source.core_end,
    target_start: pairs[i].target.core_start, target_end: pairs[i].target.core_end, source_hash: sha(sources[i]), target_hash: sha(targets[i]),
    status, direction: status === 'pending' ? null : 'en', alignment_input: status === 'pending' ? null : 'automatic',
    basis: status === 'pending' ? null : record.basis, result: status === 'pending' ? null : record.result, choices: record.choices,
  });

  // Record 0: pending, one unconfirmed choice that waits for the next check.
  const pending = shell(0, 'pending', { choices: [choiceAt(sources[0], '心大人', 0, 'not_a_term', [hsin], null, false)] });

  // Record 1: 123 verified findings, then one finding per reason (the target has no hit for the five).
  const dense = [];
  for (let n = 0; n < 123; n++) {
    dense.push(compactFinding(denseSource, denseTarget, { needle: '椿', nth: n, verdict: 'verified_constraint', targetText: 'Camellya', targetNth: n, candidates: [camellya] }));
  }
  dense.push(compactFinding(denseSource, denseTarget, { needle: '椿', nth: 123, verdict: 'not_evaluated', candidates: [camellya], reason: 'not_a_term' }));
  dense.push(compactFinding(denseSource, denseTarget, { needle: '椿', nth: 124, verdict: 'not_evaluated', candidates: [camellya], reason: 'ordinary_word' }));
  dense.push(compactFinding(denseSource, denseTarget, { needle: '调谐器', verdict: 'not_evaluated', candidates: [tuner], reason: 'no_target_region' }));
  dense.push(compactFinding(denseSource, denseTarget, { needle: '今汐', verdict: 'not_evaluated', candidates: [jinhsi], reason: 'found_outside_region' }));
  dense.push(compactFinding(denseSource, denseTarget, { needle: '声骸', verdict: 'not_evaluated', candidates: [echo], reason: 'ambiguous_repeat' }));
  assert.equal(dense.length, 128);
  assert.deepEqual([...new Set(dense.filter(hasReason).map(f => f.reason))].sort(), [...REASON_VALUES].sort());
  assert.equal(new Set(dense.map(f => f.source.join(':'))).size, 128);
  const denseChoices = dense.map(f => {
    const span = { start: f.source[0], end: f.source[1], text: scalarSlice(denseSource, f.source[0], f.source[1]) };
    const picked = f.verdict === 'verified_constraint' ? f.candidates[0] : null;
    return {
      source_span: span, choice: picked ? 'official_pair' : 'not_a_term', candidate: picked ? orderCandidate(picked) : null,
      offered: picked ? [] : f.candidates.map(c => c.candidate_id).sort(), confirmed: true,
    };
  });
  assert.equal(denseChoices.length, 128);
  const done = shell(1, 'done', { basis: structuredClone(B), result: resultOf(dense), choices: denseChoices });

  // Record 2: stale under the previous basis, 33 findings and 33 confirmed choices (one over the v3 limit of 32).
  const over = Array.from({ length: 33 }, (_, n) => compactFinding(sources[2], targets[2], { needle: '椿', nth: n, verdict: 'verified_constraint', targetText: 'Camellya', targetNth: n, candidates: [camellya] }));
  const overChoices = over.map(f => ({
    source_span: { start: f.source[0], end: f.source[1], text: '椿' }, choice: 'official_pair', candidate: orderCandidate(camellya), offered: [], confirmed: true,
  }));
  const stale = shell(2, 'stale', { basis: structuredClone(B_OLD), result: resultOf(over), choices: overChoices });

  return {
    format: V4_FORMAT, source, target, direction: 'en', alignments: null, choices: [], history: [],
    semantic_decisions: [], semantic_texts: [], semantic_history: [], segments: [pending, done, stale], segment_choice_history: [],
    progress: { current: 1, completed: [1, 2] },
  };
}

// ---- the cases ----

/**
 * What the frozen Web 0.3.1 reader gives a file (the last reader without v4): the error code, or null when it accepts it. Windows
 * 0.5.1, at the same contract level, gives the same code (tests/contracts/windows-manuscript.test.mjs asserts it for the pinned one).
 */
function legacyCode(content) {
  try { parseWeb031(content); return null; } catch (error) { return error.code; }
}

export async function buildFixtures() {
  const files = new Map();
  const cases = { format: V4_FORMAT, spec: 'SPEC.md', codes: CODES, limits: LIMITS, valid: [], invalid: [] };
  const v3 = await buildV3Fixtures();
  const text = name => v3.get(name);

  const ok = (file, content, note, canonical = file) => {
    files.set(file, content);
    cases.valid.push({ file, canonical, legacy_error: legacyCode(content), note });
  };
  // A case that reads an existing file padded with spaces (JSON whitespace: the parsed value is unchanged).
  const padded = (file, bytes, listing, extra) => {
    const content = padContent(files.get(file), bytes);
    listing.push({ file, pad_to_bytes: bytes, ...extra(content) });
  };
  const bad = (file, content, code, note) => {
    files.set(file, content);
    cases.invalid.push({ file, error: code, legacy_error: legacyCode(content), note });
  };
  const mutate = (base, fn) => { const x = JSON.parse(base); fn(x); return minify(x); };
  const noEntries = 'workfile_too_many_entries';
  const invalidContent = 'workfile_invalid_content';
  const segmentInvalid = 'workfile_segment_invalid';
  const withoutSegmentState = x => { for (const key of ['segments', 'segment_choice_history', 'progress']) delete x[key]; };

  // ---- valid ----
  const documentContent = canonicalV4(documentPayload());
  assert.equal(JSON.parse(documentContent).format, V4_FORMAT);
  ok('valid-v4-document-dense.json', documentContent,
    'document mode: a history report with 40 findings (five not_evaluated, one per reason code, each with `reason` last), 40 resolutions and 40 choices; every list is over the 32 of v1 to v3, so v4 is the lowest format that holds it');
  padded('valid-v4-document-dense.json', MAX_V2_BYTES + 1, cases.valid, content => ({
    canonical: 'valid-v4-document-dense.json', legacy_error: legacyCode(content),
    note: 'the same v4 file padded with spaces to 1 MiB plus one byte: a v4 reader accepts it (v4 has the 44 MiB cap); a v1 to v3 reader stops at its 1 MiB check',
  }));

  // One history finding carries a reason and nothing else is over 32: the reason alone makes it v4.
  const reasonDocument = documentPayload();
  const keep = reasonDocument.history[0].report.findings.filter((f, i) => i < 2 || hasReason(f)).slice(0, 4);
  const ids = new Set(keep.map(f => f.id));
  Object.assign(reasonDocument.history[0].report, { findings: keep, coverage: { ...reasonDocument.history[0].report.coverage, evaluated: 2, not_evaluated: 2 } });
  reasonDocument.history[0].resolutions = reasonDocument.history[0].resolutions.filter(r => ids.has(r.mention_id));
  reasonDocument.choices = reasonDocument.choices.filter(c => ids.has(`${c.source_span.start}:${c.source_span.end}:${c.source_span.text}`));
  assert.ok(keep.some(hasReason) && keep.length <= 32 && reasonDocument.choices.length === 4);
  ok('valid-v4-document-reason-only.json', canonicalV4(reasonDocument),
    'document mode, every list within 32, but two history findings are not_evaluated with a `reason`: the reason alone makes v4 the lowest format');

  const segments = segmentsPayload();
  const segmentsContent = canonicalV4(segments);
  ok('valid-v4-segments-dense.json', segmentsContent,
    'long mode, three ready segments: pending with an unconfirmed choice; done with 128 findings (123 verified, one not_evaluated per reason code in the rest) and 128 confirmed choices; stale with 33 findings and 33 choices');

  // A v3 manuscript with one record finding that carries a reason: nothing else is over 32, but the reason makes it v4.
  const reasonSegments = JSON.parse(text('valid-v3-all-parts.json'));
  reasonSegments.format = V4_FORMAT;
  const finding = reasonSegments.segments[1].result.findings[2];
  assert.equal(finding.verdict, 'needs_review');
  Object.assign(finding, { verdict: 'not_evaluated', target: null, reason: 'no_target_region' });
  reasonSegments.segments[1].result.evaluated -= 1;
  reasonSegments.segments[1].result.not_evaluated += 1;
  const reasonSegmentsContent = canonicalV4(reasonSegments);
  ok('valid-v4-segment-reason-only.json', reasonSegmentsContent, 'long mode, every list within 32, but one record finding is not_evaluated with a `reason`: v4');

  // v4-labelled files that fit v3 or v1 are written back in the lower format, like a v3 file that fits v2 (valid-v3-from-v2.json).
  const fitsV3Payload = JSON.parse(text('valid-v3-all-parts.json'));
  fitsV3Payload.format = V4_FORMAT;
  ok('valid-v4-fits-v3.json', minify(fitsV3Payload), 'a v4 file whose lists are all within 32 and without a reason: a writer writes it back as v3 (valid-v3-from-v4.json)', 'valid-v3-from-v4.json');
  ok('valid-v3-from-v4.json', canonicalV3(fitsV3Payload), 'the v3 bytes of valid-v4-fits-v3.json');
  const v1 = JSON.parse(text('valid-v1.json'));
  const fitsV1Payload = {
    format: V4_FORMAT, ...Object.fromEntries(['source', 'target', 'direction', 'alignments', 'choices', 'history'].map(k => [k, v1[k]])),
    semantic_decisions: [], semantic_texts: [], semantic_history: [], segments: [], segment_choice_history: [], progress: { current: null, completed: [] },
  };
  ok('valid-v4-fits-v1.json', minify(fitsV1Payload), 'a v4 file with no segment state, every list within 32 and no reason, under 1 MiB: a writer writes it back as v1 (valid-v1-from-v4.json)', 'valid-v1-from-v4.json');
  ok('valid-v1-from-v4.json', canonicalV3(fitsV1Payload), 'the v1 bytes of valid-v4-fits-v1.json');

  // ---- invalid: counts ----
  const reportOf = x => x.history[0].report;
  bad('invalid-v4-129-findings-document.json', mutate(documentContent, x => {
    while (reportOf(x).findings.length < 129) reportOf(x).findings.push({ ...structuredClone(reportOf(x).findings[0]), id: `${100000 + reportOf(x).findings.length}:1:椿` });
  }), noEntries, 'a history report with 129 findings: the v1/v2 part array cap is 128 (as for 129 decisions in v3), checked before the content');
  bad('invalid-v4-129-resolutions.json', mutate(documentContent, x => {
    while (x.history[0].resolutions.length < 129) x.history[0].resolutions.push({ mention_id: `${900000 + x.history[0].resolutions.length}:1:椿`, choice: 'not_a_term' });
  }), noEntries, 'a history snapshot with 129 resolutions');
  bad('invalid-v4-129-choices.json', mutate(documentContent, x => { while (x.choices.length < 129) x.choices.push(structuredClone(x.choices[0])); }), noEntries,
    '129 top-level choices: the same array cap of 128');
  bad('invalid-v4-129-findings-segment.json', mutate(segmentsContent, x => {
    const record = x.segments[1];
    while (record.result.findings.length < 129) record.result.findings.push(structuredClone(record.result.findings[0]));
  }), noEntries, 'a record result with 129 findings (the count is checked before the content)');
  bad('invalid-v4-129-segment-choices.json', mutate(segmentsContent, x => {
    const record = x.segments[1];
    while (record.choices.length < 129) record.choices.push(structuredClone(record.choices[0]));
  }), noEntries, 'a record with 129 choices');

  // ---- invalid: reason is only on not_evaluated, only a known code, never null ----
  const firstWithReason = x => reportOf(x).findings.find(hasReason);
  bad('invalid-v4-reason-on-verified.json', mutate(documentContent, x => { reportOf(x).findings[0].reason = 'not_a_term'; }), invalidContent,
    'a history finding that is verified_constraint with a `reason`: a reason belongs to not_evaluated only');
  bad('invalid-v4-reason-null.json', mutate(documentContent, x => { firstWithReason(x).reason = null; }), invalidContent,
    'a not_evaluated history finding with `reason: null`: an absent reason is no key, never null');
  bad('invalid-v4-reason-unknown.json', mutate(documentContent, x => { firstWithReason(x).reason = 'unknown_reason'; }), invalidContent,
    'a not_evaluated history finding whose reason is not one of the five codes');
  const recordFindings = x => x.segments[1].result.findings;
  bad('invalid-v4-segment-reason-on-verified.json', mutate(segmentsContent, x => { recordFindings(x)[0].reason = 'not_a_term'; }), segmentInvalid, 'a record finding that is verified_constraint with a `reason`');
  bad('invalid-v4-segment-reason-null.json', mutate(segmentsContent, x => { recordFindings(x).find(hasReason).reason = null; }), segmentInvalid, 'a not_evaluated record finding with `reason: null`');
  bad('invalid-v4-segment-reason-unknown.json', mutate(segmentsContent, x => { recordFindings(x).find(hasReason).reason = 'unknown_reason'; }), segmentInvalid,
    'a not_evaluated record finding whose reason is not one of the five codes');

  // ---- invalid: other formats keep their own limits ----
  bad('invalid-v4-format-v5.json', mutate(documentContent, x => { x.format = 'wuwaterm-manuscript-v5'; }), 'workfile_unsupported_format', 'an unknown format version falls through to the v2 reader');
  bad('invalid-v4-v3-format-33-choices.json', mutate(text('valid-v3-all-parts.json'), x => {
    while (x.segments[1].choices.length < 33) x.segments[1].choices.push(structuredClone(x.segments[1].choices[0]));
  }), noEntries, 'the v3 label keeps the v3 limits: a record with 33 choices');
  bad('invalid-v4-v3-format-33-findings.json', mutate(segmentsContent, x => { x.format = V3_FORMAT; x.segments[1].choices = []; }), noEntries,
    'the v3 label keeps the v3 limits: a record result with 128 findings');
  bad('invalid-v4-v3-format-reason.json', mutate(reasonSegmentsContent, x => { x.format = V3_FORMAT; }), segmentInvalid,
    'the v3 label rejects a finding `reason`: the finding has an extra key');
  bad('invalid-v4-v2-format-reason.json', mutate(documentContent, x => {
    x.format = 'wuwaterm-manuscript-v2';
    withoutSegmentState(x);
    x.choices = x.choices.slice(0, 3);
    x.history[0].report.findings = x.history[0].report.findings.filter(hasReason);
    x.history[0].resolutions = x.history[0].resolutions.slice(-5);
  }), invalidContent, 'the v2 label rejects a history finding `reason` (an extra key in a v1/v2 report)');
  bad('invalid-v4-v2-format-33-choices.json', mutate(documentContent, x => {
    x.format = 'wuwaterm-manuscript-v2';
    withoutSegmentState(x);
    x.history = [];
    x.choices = x.choices.slice(0, 33);
  }), invalidContent, 'the v2 label keeps the limit of 32 choices (33 choices, within the v2 array cap of 128)');
  padded('valid-v4-document-dense.json', MAX_V4_BYTES + 1, cases.invalid, content => ({
    error: 'workfile_too_large', legacy_error: legacyCode(content), note: 'a v4 file one byte over 44 MiB (46,137,345 bytes)',
  }));

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
    if (current !== content) { stale++; console.error(`stale: contracts/manuscript-v4/${name}`); }
  }
  // A fixture the generator no longer produces must not linger in the directory.
  let present = [];
  try { present = readdirSync(root).filter(n => n.endsWith('.json') && !files.has(n)); } catch { /* not written yet */ }
  for (const name of present) {
    if (write) unlinkSync(join(root, name)); else { stale++; console.error(`unexpected: contracts/manuscript-v4/${name}`); }
  }
  if (stale) { console.error('Run: node scripts/build-manuscript-v4-fixtures.mjs --write'); process.exit(1); }
  console.log(write ? `wrote ${files.size} files` : `ok: ${files.size} files`);
}
