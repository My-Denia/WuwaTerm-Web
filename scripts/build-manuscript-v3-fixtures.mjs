// Generates contracts/manuscript-v3/. Default: check the committed bytes. --write: rewrite them.
// All text is synthetic; hashes, revisions and ids are computed, never typed.
// The contract is contracts/manuscript-v3/SPEC.md; this file only produces fixtures for it.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// The frozen Web 0.2.0 writer: the generator's v1/v2 bytes stay independent of lib/manuscript.js (which writes v3 too).
import { makeChoice, serializeWorkfile } from '../tests/legacy/web-0.2.0/manuscript.js';
import { pairSegments } from '../lib/segmentation.ts';
import { buildFixtures as buildV2Fixtures } from './build-manuscript-v2-fixtures.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'contracts', 'manuscript-v3');

export const V3_FORMAT = 'wuwaterm-manuscript-v3';
export const MAX_V3_BYTES = 46_137_344;
export const MAX_V2_BYTES = 1_048_576;
export const REVIEW_MAX_JSON_BYTES = 65_536;
export const CODES = [
  'workfile_not_json', 'workfile_too_large', 'workfile_too_deep', 'workfile_too_many_entries', 'workfile_too_many_fields',
  'workfile_forbidden_field', 'workfile_unsupported_format', 'workfile_invalid_content', 'workfile_duplicate_choices',
  'workfile_segment_invalid', 'workfile_segment_order', 'workfile_segment_anchor_invalid', 'workfile_progress_invalid',
];
export const LIMITS = {
  file_bytes: MAX_V3_BYTES, legacy_file_bytes: MAX_V2_BYTES, text_scalars: 46_137_344, array_items: 512, object_fields: 32, depth: 16,
  segments: 512, findings_per_result: 32, candidates_per_finding: 8, choices_per_record: 32, offered_per_choice: 8,
  segment_choice_history: 512, progress_completed: 512, core_scalars: 2000, choices: 32, history: 2, alignments: 64,
  semantic_decisions: 128, semantic_texts: 16, semantic_history: 2, semantic_history_segments: 64,
};

const UNSUPPORTED = 'workfile_unsupported_format';
const sha = label => createHash('sha256').update(label, 'utf8').digest('hex');
const bytesOf = text => Buffer.byteLength(text, 'utf8');
const scalars = text => Array.from(text);
const scalarSlice = (text, start, end) => scalars(text).slice(start, end).join('');
const failWith = code => Object.assign(new Error(code), { code });
// A v3 file is minified JSON with no trailing newline (SPEC "Canonical bytes").
const minify = value => JSON.stringify(value);

// ---- alignment input (SPEC "Segment request") ----

const asScalars = x => (typeof x === 'string' ? Array.from(x) : x);
const clip = (span, from, to) => {
  const start = Math.max(span.start, from);
  const end = Math.min(span.end, to);
  return start < end ? { start, end } : null;
};

/**
 * The `alignments` list that a segment request sends for the record's cores, or null when the manuscript's alignments is null (the
 * request then omits `alignments`). Each alignment is clipped to the cores, rebased to them, and its text is the core slice; an
 * alignment whose source or (non-null) target does not intersect its core is left out. `record` needs source_start, source_end,
 * target_start and target_end. source and target are the saved texts, as strings or scalar arrays.
 */
export function alignmentList(alignments, source, target, record) {
  if (alignments === null) return null;
  const s = asScalars(source);
  const t = asScalars(target);
  const list = [];
  for (const item of alignments) {
    const sourceRange = clip(item.source, record.source_start, record.source_end);
    if (sourceRange === null) continue;
    let targetSide = null;
    if (item.target !== null) {
      const targetRange = clip(item.target, record.target_start, record.target_end);
      if (targetRange === null) continue;
      targetSide = { start: targetRange.start - record.target_start, end: targetRange.end - record.target_start, text: t.slice(targetRange.start, targetRange.end).join('') };
    }
    list.push({
      source: { start: sourceRange.start - record.source_start, end: sourceRange.end - record.source_start, text: s.slice(sourceRange.start, sourceRange.end).join('') },
      target: targetSide,
    });
  }
  return list;
}

/** `"automatic"` for null alignments; otherwise the SHA-256 (lowercase hex) of the minified JSON of the request's alignments list. */
export function alignmentInput(alignments, source, target, record) {
  const list = alignmentList(alignments, source, target, record);
  return list === null ? 'automatic' : sha(JSON.stringify(list));
}

/** A record with its request inputs set: null while pending, otherwise the manuscript's direction and the alignment input of its cores. */
function withInputs(record, { direction, alignments, source, target }) {
  const live = record.status !== 'pending';
  return { ...record, direction: live ? direction : null, alignment_input: live ? alignmentInput(alignments, source, target, record) : null };
}

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
const orderCandidate = c => (c === null ? null : { candidate_id: c.candidate_id, zh: c.zh, en: c.en, category: c.category });
const orderChoice = c => ({ source_span: orderSpan(c.source_span), choice: c.choice, candidate: orderCandidate(c.candidate), offered: [...c.offered], confirmed: c.confirmed });
const orderHistoryEntry = c => ({
  source_hash: c.source_hash, source_span: orderSpan(c.source_span), choice: c.choice, candidate: orderCandidate(c.candidate), offered: [...c.offered],
});
const orderFinding = f => ({
  verdict: f.verdict, source: [...f.source], target: f.target === null ? null : [...f.target], candidates: f.candidates.map(orderCandidate),
  candidates_truncated: f.candidates_truncated,
});
const orderResult = r => ({ truncated: r.truncated, evaluated: r.evaluated, not_evaluated: r.not_evaluated, findings: r.findings.map(orderFinding) });
const orderRecord = r => ({
  index: r.index, segmentation_version: r.segmentation_version, source_start: r.source_start, source_end: r.source_end,
  target_start: r.target_start, target_end: r.target_end, source_hash: r.source_hash, target_hash: r.target_hash, status: r.status,
  direction: r.direction, alignment_input: r.alignment_input, basis: r.basis === null ? null : orderBasis(r.basis), result: r.result === null ? null : orderResult(r.result), choices: r.choices.map(orderChoice),
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
  const write = () => minify({
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
  return { candidate_id: sha(`candidate:${tag}:${term.zh}:${term.en}:${term.category}`), zh: term.zh, en: term.en, category: term.category };
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

// A compact finding: core-relative [start, end] pairs, no id, rule id, span text or sources.
function findingOf(core, targetCore, { text, nth = 0, verdict, targetText = null, candidates, truncated = false }) {
  const span = spanOf(core, text, nth);
  const target = targetText === null ? null : spanOf(targetCore, targetText);
  return {
    verdict, source: [span.start, span.end], target: target === null ? null : [target.start, target.end],
    candidates: candidates.map(orderCandidate), candidates_truncated: truncated,
  };
}
const resultOf = findings => ({ truncated: false, evaluated: findings.length, not_evaluated: 0, findings });

function choiceAt(core, text, nth, kind, offered, picked, confirmed) {
  return {
    source_span: spanOf(core, text, nth), choice: kind, candidate: kind === 'official_pair' ? orderCandidate(picked) : null,
    offered: kind === 'official_pair' ? [] : offered.map(c => c.candidate_id).sort(), confirmed,
  };
}
const historyEntryOf = (core, text, kind, offered, picked) => orderHistoryEntry({ source_hash: sha(core), ...choiceAt(core, text, 0, kind, offered, picked, false) });

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

/**
 * Three paragraphs of the long-mode manuscript. `variant` only changes the middle paragraph. With `aligned`, the manuscript carries one
 * alignment per paragraph (each also covers the blank line after it), so the records' alignment inputs are non-trivial digests.
 */
function documentPayload(variant = 'standard', { aligned = false } = {}) {
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
  let alignments = null;
  if (aligned) {
    let sourcePos = 0; let targetPos = 0;
    alignments = sources.map((core, i) => {
      const tail = i === sources.length - 1 ? '' : '\n\n';
      const item = {
        source: { start: sourcePos, end: sourcePos + scalars(core + tail).length, text: core + tail },
        target: { start: targetPos, end: targetPos + scalars(targets[i] + tail).length, text: targets[i] + tail },
      };
      sourcePos = item.source.end;
      targetPos = item.target.end;
      return item;
    });
  }
  const pairs = pairSegments(source, target);
  assert.equal(pairs.length, 3);
  assert.ok(pairs.every(p => p.status === 'ready' && !p.hard_cut));
  pairs.forEach((p, i) => {
    assert.equal(scalarSlice(source, p.source.core_start, p.source.core_end), sources[i]);
    assert.equal(scalarSlice(target, p.target.core_start, p.target.core_end), targets[i]);
  });
  // The explicit alignments must keep the cores of the automatic pairing: only then are the records valid for both.
  assert.deepEqual(pairSegments(source, target, 1800, alignments), pairs);
  assert.ok(!source.includes(OLD_CORE));
  const inputs = { direction: 'en', alignments, source, target };
  const shell = (i, status, basis, result, choices) => withInputs({
    index: i, segmentation_version: 'segmentation-v1', source_start: pairs[i].source.core_start, source_end: pairs[i].source.core_end,
    target_start: pairs[i].target.core_start, target_end: pairs[i].target.core_end, source_hash: sha(sources[i]), target_hash: sha(targets[i]),
    status, direction: null, alignment_input: null, basis, result, choices,
  }, inputs);

  const name = candidateOf(TERMS.name);
  const itemA = candidateOf(TERMS.itemA);
  const itemB = candidateOf(TERMS.itemB);
  const place = candidateOf(TERMS.place);
  const oldCity = candidateOf(TERMS.city, 'previous');
  const oldName = candidateOf(TERMS.name, 'previous');
  const oldItem = candidateOf(TERMS.itemA, 'previous');

  // Pending: no result, so its choice waits for the next check and is not confirmed.
  const pending = shell(0, 'pending', null, null, [choiceAt(sources[0], '示例地', 0, 'not_a_term', [place], null, false)]);

  let findings; let choices;
  if (variant === 'many') {
    findings = Array.from({ length: 32 }, (_, k) => findingOf(middle, targets[1], { text: '示例名', nth: k, verdict: 'needs_review', candidates: [name] }));
    choices = Array.from({ length: 32 }, (_, k) => choiceAt(middle, '示例名', k, k % 2 === 0 ? 'official_pair' : 'not_a_term', [name], k % 2 === 0 ? name : null, true));
  } else {
    findings = [
      findingOf(middle, targets[1], { text: '示例名', nth: 0, verdict: 'verified_constraint', targetText: 'Sample Name', candidates: [name] }),
      // Its candidate list is truncated; the confirmed not_a_term below stays valid, because truncation plays no part in the check.
      findingOf(middle, targets[1], { text: '示例物', nth: 0, verdict: 'needs_review', candidates: [itemA, itemB], truncated: true }),
      findingOf(middle, targets[1], { text: '示例名', nth: 1, verdict: 'needs_review', candidates: [name] }),
    ];
    choices = [
      choiceAt(middle, '示例名', 0, 'official_pair', [name], name, true),
      choiceAt(middle, '示例物', 0, 'not_a_term', [itemA, itemB], null, true),
      // An old choice at an occurrence the current result has no finding for: it needs reconfirmation.
      choiceAt(middle, '示例城', 0, 'official_pair', [oldCity], oldCity, false),
    ];
  }
  const done = shell(1, 'done', structuredClone(B), resultOf(findings), choices);

  const staleFindings = [findingOf(sources[2], targets[2], { text: '示例物', verdict: 'needs_review', candidates: [oldItem] })];
  const stale = shell(2, 'stale', structuredClone(B_OLD), resultOf(staleFindings), [choiceAt(sources[2], '示例物', 0, 'official_pair', [oldItem], oldItem, true)]);

  return {
    format: V3_FORMAT, source, target, direction: 'en', alignments, choices: [], history: [],
    semantic_decisions: [], semantic_texts: [], semantic_history: [],
    segments: [pending, done, stale],
    segment_choice_history: [historyEntryOf(OLD_CORE, '示例名', 'official_pair', [oldName], oldName)],
    progress: { current: 0, completed: [1, 2] },
  };
}

// A core of exactly `length` scalars: it starts with `lead`, repeats `unit(n)` and ends with `last`.
function coreOf(lead, length, unit, last) {
  let chars = scalars(lead);
  for (let n = 1; chars.length < length; n++) chars.push(...scalars(unit(n)));
  chars = chars.slice(0, length);
  chars[length - 1] = last;
  return chars.join('');
}

/**
 * Boundary of "both cores have 1 to 2,000 scalars" (step 8.1). `exact`: a done record with 2,000-scalar cores and a confirmed
 * not_a_term choice that offers 8 candidates. `source-2001`: the same file with a 2,001-scalar source core. `empty-source`: a done
 * record with an empty source core and a result with no findings. In all three the hashes agree with the cores, so only the core
 * length can fail. The ranges are not a segmentation-v1 result (its cores stop at 1,800 scalars).
 */
function boundaryPayload(variant) {
  const sourceCore = variant === 'empty-source' ? '' : coreOf('示例名在示例城里停下了。', variant === 'source-2001' ? 2001 : 2000, () => '示例文字。', '。');
  const targetCore = coreOf('Sample Name met the Sample Item.', 2000, n => ` ${FILLER(n)}`, '.');
  const nextSource = '示例物静静地躺着。';
  const nextTarget = 'The Sample Item lay still.';
  const sourceLength = scalars(sourceCore).length;
  assert.equal(sourceLength, { exact: 2000, 'source-2001': 2001, 'empty-source': 0 }[variant]);
  assert.equal(scalars(targetCore).length, 2000);

  const candidates = Array.from({ length: 8 }, (_, k) => candidateOf({ zh: '示例名', en: `Sample Name ${k + 1}`, category: 'character' }, 'boundary'));
  const findings = variant === 'empty-source' ? [] : [findingOf(sourceCore, targetCore, { text: '示例名', verdict: 'needs_review', candidates })];
  const choices = variant === 'empty-source' ? [] : [choiceAt(sourceCore, '示例名', 0, 'not_a_term', candidates, null, true)];
  if (variant === 'exact') {
    assert.equal(findings[0].candidates.length, 8);
    assert.equal(choices[0].offered.length, 8);
  }

  const source = [sourceCore, nextSource].join('\n\n');
  const target = [targetCore, nextTarget].join('\n\n');
  const record = (i, start, core, targetStart, targetText, status, basis, result, choiceList) => withInputs({
    index: i, segmentation_version: 'segmentation-v1', source_start: start, source_end: start + scalars(core).length,
    target_start: targetStart, target_end: targetStart + scalars(targetText).length, source_hash: sha(core), target_hash: sha(targetText),
    status, direction: null, alignment_input: null, basis, result, choices: choiceList,
  }, { direction: 'en', alignments: null, source, target });
  return {
    format: V3_FORMAT, source, target, direction: 'en', alignments: null,
    choices: [], history: [], semantic_decisions: [], semantic_texts: [], semantic_history: [],
    segments: [
      record(0, 0, sourceCore, 0, targetCore, 'done', structuredClone(B), resultOf(findings), choices),
      record(1, sourceLength + 2, nextSource, 2002, nextTarget, 'pending', null, null, []),
    ],
    segment_choice_history: [], progress: { current: 0, completed: [0] },
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
      status: 'pending', direction: null, alignment_input: null, basis: null, result: null, choices: [],
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
    return historyEntryOf(core, '示例名', 'official_pair', [old], old);
  });
}

// A v1 file keeps the full review-v2 report (with sources and ids) in its history.
const withSources = c => ({
  zh: c.zh, en: c.en, category: c.category, candidate_id: c.candidate_id,
  sources: [{ source_file: 'Synthetic/Terms.json', source_id: `term_${c.candidate_id.slice(0, 8)}` }, { source_file: 'Synthetic/Labels.json', source_id: `label_${c.candidate_id.slice(0, 8)}` }],
});
function validV1() {
  const source = '示例名来到示例地。';
  const target = 'Sample Name came to the Sample Place.';
  const finding = (text, targetText, term) => {
    const span = spanOf(source, text);
    return {
      id: `${span.start}:${span.end}:${text}`, rule_id: 'review.term_pair', verdict: 'verified_constraint', source_span: span, target_span: spanOf(target, targetText),
      candidates: [withSources(candidateOf(term))], candidates_truncated: false,
    };
  };
  const findings = [finding('示例名', 'Sample Name', TERMS.name), finding('示例地', 'Sample Place', TERMS.place)];
  const report = {
    request_id: sha('request:v1').slice(0, 32), source_revision: sha(source), target_revision: sha(target), rule_version: B.rule_version,
    matcher_revision: B.matcher_revision, dictionary: structuredClone(B.dictionary),
    coverage: { evaluated: 2, not_evaluated: 0, rules: ['review.term_pair'] }, findings, truncated: false,
  };
  const choice = makeChoice({ source, direction: 'en', alignments: null, report, finding: findings[0], candidate: findings[0].candidates[0] });
  return serializeWorkfile({ source, target, direction: 'en', alignments: null, choices: [choice], history: [{ source, target, direction: 'en', alignments: null, report }] });
}

// ---- size models (SPEC "Size arithmetic") ----

const modelCandidate = (k, j, extraBoth = 0, extraEn = 0) => ({
  candidate_id: sha(`model-candidate:${k}:${j}`), zh: `示例名称${j}${'示'.repeat(extraBoth)}`,
  en: `Sample Official Name ${j}${'x'.repeat(extraBoth + extraEn)}`, category: 'character',
});
const modelFinding = (k, candidates, source = [k * 50, k * 50 + 4], target = [k * 50, k * 50 + 20]) => ({
  verdict: 'needs_review', source, target, candidates, candidates_truncated: false,
});

// Half of the choices are not_a_term with every candidate id of their finding offered; all are confirmed. `textAt(finding)` is the
// surface text of the finding's source span in the core.
function modelChoices(count, findings, textAt) {
  return Array.from({ length: count }, (_, j) => {
    const finding = findings[j];
    const notATerm = j % 2 === 0;
    return {
      source_span: { start: finding.source[0], end: finding.source[1], text: textAt(finding) }, choice: notATerm ? 'not_a_term' : 'official_pair',
      candidate: notATerm ? null : orderCandidate(finding.candidates[0]), offered: notATerm ? finding.candidates.map(c => c.candidate_id).sort() : [], confirmed: true,
    };
  });
}

// Findings of the extreme model: 32 findings x 8 candidates, the candidate strings lengthened until the minified result is as close
// to Core's 65,536-byte response cap as it can get without passing it. The compact result is a subset of the response.
function extremeFindings() {
  const build = (both, en, fine) => {
    let counter = 0;
    return Array.from({ length: 32 }, (_, k) => modelFinding(k, Array.from({ length: 8 }, (_, j) => modelCandidate(k, j, both, en + (counter++ < fine ? 1 : 0)))));
  };
  const size = findings => bytesOf(minify(resultOf(findings)));
  assert.ok(size(build(0, 0, 0)) <= REVIEW_MAX_JSON_BYTES, 'the extreme result must start under the cap');
  let both = 0; let en = 0; let fine = 0;
  while (size(build(both + 1, en, 0)) <= REVIEW_MAX_JSON_BYTES) both++;
  while (size(build(both, en + 1, 0)) <= REVIEW_MAX_JSON_BYTES) en++;
  while (size(build(both, en, fine + 1)) <= REVIEW_MAX_JSON_BYTES) fine++;
  return build(both, en, fine);
}

const CJK_DIGITS = '〇一二三四五六七八九';

// A 1,800-scalar CJK source core and a 1,800-scalar ASCII target core, each with the 32 term occurrences of the fixed-shape models.
function fixedCores(i, length) {
  const source = Array.from({ length }, () => '示');
  const target = Array.from({ length }, () => 'x');
  for (let k = 0; k < 32; k++) {
    source.splice(k * 50, 4, ...'示例名称');
    target.splice(k * 50, 20, ...'Sample Official Name');
  }
  source.splice(length - 8, 3, ...Array.from(String(i).padStart(3, '0'), d => CJK_DIGITS[Number(d)]));
  target.splice(length - 8, 3, ...String(i).padStart(3, '0'));
  return { source: source.join(''), target: target.join('') };
}

const FIXED_SHAPES = {
  dense: { choices: 8, findings: () => Array.from({ length: 32 }, (_, k) => modelFinding(k, [modelCandidate(k, 0), modelCandidate(k, 1)])) },
  limit: { choices: 32, findings: () => Array.from({ length: 32 }, (_, k) => modelFinding(k, Array.from({ length: 8 }, (_, j) => modelCandidate(k, j)))) },
  extreme: { choices: 32, findings: extremeFindings },
};

/** 512 done records of 1,800 + 1,800 scalars, all sharing one result and one choice list (the model measures size, not content). */
function fixedManuscript(shape, count = 512) {
  const length = 1800;
  const findings = FIXED_SHAPES[shape].findings();
  const result = resultOf(findings);
  const choices = modelChoices(FIXED_SHAPES[shape].choices, findings, () => '示例名称');
  const sources = []; const targets = []; const segments = [];
  let position = 0;
  for (let i = 0; i < count; i++) {
    const cores = fixedCores(i, length);
    sources.push(cores.source); targets.push(cores.target);
    segments.push({
      index: i, segmentation_version: 'segmentation-v1', source_start: position, source_end: position + length, target_start: position, target_end: position + length,
      source_hash: sha(cores.source), target_hash: sha(cores.target), status: 'done', direction: 'en', alignment_input: 'automatic', basis: B, result, choices,
    });
    position += length + 2;
  }
  return {
    format: V3_FORMAT, source: sources.join('\n\n'), target: targets.join('\n\n'), direction: 'en', alignments: null, choices: [], history: [],
    semantic_decisions: [], semantic_texts: [], semantic_history: [], segments, segment_choice_history: [], progress: { current: 0, completed: [] },
  };
}

// mulberry32: a small deterministic PRNG, so every run builds the same paragraphs.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const CJK_FILL = Array.from('示例文字内容段落名称物品地点城市故事');
const zhText = (length, seed) => Array.from({ length }, (_, j) => CJK_FILL[(seed + j) % CJK_FILL.length]).join('');
const enText = (length, seed) => Array.from({ length }, (_, j) => String.fromCharCode(97 + ((seed + j) % 26))).join('');

/**
 * Findings and choices for one source core, with the density of the size models: `count` findings spread evenly over the core, every
 * 4th with 2 candidates, and round(count / 4) confirmed choices. The term is 4 CJK scalars on the zh side and 20 ASCII scalars on the
 * en side. The text is BMP-only, so string indexes are scalar indexes.
 */
function termsFor(sourceCore, targetLength, direction, count) {
  const zhSource = direction === 'en';
  const sourceTerm = zhSource ? 4 : 20;
  const targetTerm = zhSource ? 20 : 4;
  const spread = (k, length, term) => (count === 1 ? 0 : Math.floor((k * (length - term)) / (count - 1)));
  const findings = Array.from({ length: count }, (_, k) => {
    const start = spread(k, sourceCore.length, sourceTerm);
    const targetStart = spread(k, targetLength, targetTerm);
    return modelFinding(k, Array.from({ length: k % 4 === 0 ? 2 : 1 }, (_, j) => modelCandidate(k, j)),
      [start, start + sourceTerm], [targetStart, targetStart + targetTerm]);
  });
  const choices = modelChoices(Math.round(count / 4), findings, f => sourceCore.slice(f.source[0], f.source[1]));
  return { result: resultOf(findings), choices };
}

/**
 * A manuscript of PRNG paragraphs: source lengths uniform in 20..400 scalars (the last one takes whatever is left of `scalarsTotal`),
 * target paragraph = round(ratio x source length). The records are the segments that pairSegments gives. `findingCount(index, sourceScalars)`
 * is the number of findings of a done record, or null for a pending one.
 */
function paragraphManuscript({ direction, ratio, scalarsTotal, seed = 20_261_116, findingCount, progress = { current: 0, completed: [] } }) {
  const next = prng(seed);
  const lengths = [];
  for (let total = 0; total < scalarsTotal;) {
    let length = 20 + Math.floor(next() * 381);
    if (total + length > scalarsTotal - 20) length = scalarsTotal - total;
    lengths.push(length);
    total += length;
  }
  const [sourceText, targetText] = direction === 'en' ? [zhText, enText] : [enText, zhText];
  const sources = lengths.map((n, i) => sourceText(n, i));
  const targets = lengths.map((n, i) => targetText(Math.round(ratio * n), i));
  const source = sources.join('\n\n');
  const target = targets.join('\n\n');
  assert.equal(source.length, Array.from(source).length, 'the model text must be BMP-only');
  assert.equal(Array.from(source.replaceAll('\n', '')).length, scalarsTotal);
  const pairs = pairSegments(source, target);
  assert.ok(pairs.every(p => p.status === 'ready' && !p.hard_cut));
  const inputs = { direction, alignments: null, source, target };
  const segments = pairs.map((p, i) => {
    const sourceCore = source.slice(p.source.core_start, p.source.core_end);
    const targetCore = target.slice(p.target.core_start, p.target.core_end);
    const count = findingCount(i, sourceCore.length);
    const terms = count === null ? { result: null, choices: [] } : termsFor(sourceCore, targetCore.length, direction, count);
    return withInputs({
      index: i, segmentation_version: 'segmentation-v1', source_start: p.source.core_start, source_end: p.source.core_end,
      target_start: p.target.core_start, target_end: p.target.core_end, source_hash: sha(sourceCore), target_hash: sha(targetCore),
      status: count === null ? 'pending' : 'done', direction: null, alignment_input: null, basis: count === null ? null : B, result: terms.result, choices: terms.choices,
    }, inputs);
  });
  return {
    format: V3_FORMAT, source, target, direction, alignments: null, choices: [], history: [], semantic_decisions: [], semantic_texts: [], semantic_history: [],
    segments, segment_choice_history: [], progress,
  };
}

const MODELS = {};
for (const [name, direction, ratio] of [['zh-en-x2', 'en', 2], ['zh-en-x3', 'en', 3], ['en-zh-half', 'zh', 1 / 2], ['en-zh-third', 'zh', 1 / 3]]) {
  for (const [label, scalarsTotal] of [['20k', 20_000], ['100k', 100_000]]) MODELS[`${name}-${label}`] = { paragraphs: { direction, ratio, scalarsTotal } };
}
for (const shape of Object.keys(FIXED_SHAPES)) MODELS[`${shape}-512`] = { shape };
export const MODEL_NAMES = Object.keys(MODELS);

/** A model manuscript: every record done, with a full-size result and choices. `name` is one of MODEL_NAMES. */
export function budgetManuscript(name) {
  const model = MODELS[name];
  assert.ok(model, `unknown model ${name}`);
  if (model.shape) return fixedManuscript(model.shape);
  return paragraphManuscript({ ...model.paragraphs, findingCount: (_, scalarsInCore) => Math.min(32, Math.round(scalarsInCore / 104)) });
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
  assert.equal(minify(base), valid);
  const mutate = fn => { const x = structuredClone(base); fn(x); return minify(x); };

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
  ok('valid-v3-all-parts.json', valid, 'three ready segments: pending with an unconfirmed choice, done with a verified and a needs_review finding (the latter has candidates_truncated and a confirmed not_a_term, which stays valid), stale under the previous basis; one history choice; progress with a done and a stale record completed', UNSUPPORTED);
  ok('valid-v3-integral-numbers.json', replaceOnce(replaceOnce(valid, '"index":1,', '"index":1.0,'), '"source_start":0,', '"source_start":0.0,'),
    'integer fields written as 1.0 and 0.0 are accepted; the canonical form writes plain integers', UNSUPPORTED, 'valid-v3-all-parts.json');
  const otherHash = sha('hash-not-current: other core');
  ok('valid-v3-hash-not-current.json', mutate(x => { x.segments[1].source_hash = otherHash; }),
    'record 1 source_hash differs from the current core: a valid file whose result the runtime treats as not current', UNSUPPORTED);
  const emptyListDigest = sha('[]');
  assert.equal(emptyListDigest, '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945');
  ok('valid-v3-inputs-not-current.json', mutate(x => {
    assert.equal(x.direction, 'en');
    assert.equal(x.alignments, null);
    x.segments[1].direction = 'zh';
    x.segments[2].alignment_input = emptyListDigest;
  }), 'record 1 has direction zh while the file has en, and record 2 has the alignment input of an empty list while the file has no alignments: a valid file whose two results the runtime treats as not current', UNSUPPORTED);
  const aligned = canonicalV3(documentPayload('standard', { aligned: true }));
  const alignedParsed = JSON.parse(aligned);
  assert.equal(alignedParsed.alignments.length, 3);
  for (const r of alignedParsed.segments.filter(r => r.status !== 'pending')) {
    assert.match(r.alignment_input, /^[a-f0-9]{64}$/u);
    assert.notEqual(r.alignment_input, emptyListDigest);
  }
  ok('valid-v3-explicit-alignments.json', aligned,
    'the manuscript has one alignment per paragraph (each also covers the blank line after it); pairSegments with them keeps the cores of the automatic pairing, so the records are the same, and the done and stale records have non-trivial alignment inputs', UNSUPPORTED);
  ok('valid-v3-with-semantic.json', mutate(x => {
    x.semantic_decisions = v2Parsed.semantic_decisions; x.semantic_texts = v2Parsed.semantic_texts; x.semantic_history = v2Parsed.semantic_history;
  }), 'segment state together with the v2 semantic decisions, stored text and history snapshot', UNSUPPORTED);
  const fromV2 = minify({
    format: V3_FORMAT, source: v2Parsed.source, target: v2Parsed.target, direction: v2Parsed.direction, alignments: v2Parsed.alignments,
    choices: v2Parsed.choices, history: v2Parsed.history, semantic_decisions: v2Parsed.semantic_decisions, semantic_texts: v2Parsed.semantic_texts,
    semantic_history: v2Parsed.semantic_history, segments: [], segment_choice_history: [], progress: { current: null, completed: [] },
  });
  ok('valid-v3-from-v2.json', fromV2, 'a v3 file without segment state; the writer emits it as the v2 file named in canonical', UNSUPPORTED, 'valid-v2-all-parts.json');
  ok('valid-v3-512-segments.json', canonicalV3(pendingPayload(512)), '512 pending records over 512 short paragraphs; the ranges are paragraph ranges, not a segmentation-v1 result',
    'workfile_too_many_entries');
  const many = canonicalV3(documentPayload('many'));
  const manyBase = JSON.parse(many);
  ok('valid-v3-32-choices.json', many, 'a done record with 32 findings and 32 confirmed choices', UNSUPPORTED);
  ok('valid-v3-512-history.json', mutate(x => { x.segment_choice_history = historyChoices(512); }), '512 history choices', 'workfile_too_many_entries');
  // zh to en, the target twice as long as the source: 240-odd records, 2 done with small results, the rest pending. The v1/v2 part alone is over 1 MiB.
  const overPayload = paragraphManuscript({
    direction: 'en', ratio: 2, scalarsTotal: 215_000, findingCount: i => (i < 2 ? 2 : null), progress: { current: 0, completed: [0] },
  });
  const over = canonicalV3(overPayload);
  const overProjection = JSON.stringify({ ...overPayload, format: 'wuwaterm-manuscript-v2', segments: undefined, segment_choice_history: undefined, progress: undefined });
  assert.ok(bytesOf(over) > MAX_V2_BYTES, 'the over-1-MiB fixture must be over 1 MiB');
  assert.ok(bytesOf(overProjection) > MAX_V2_BYTES, 'its v1/v2 part must be over 1 MiB too');
  assert.ok(overPayload.segments.length <= 512);
  assert.equal(overPayload.segments.filter(r => r.status === 'done').length, 2);
  ok('valid-v3-over-1mib.json', over, 'a zh to en manuscript with a target about twice the source, over 1 MiB, with records that match pairSegments: most pending, 2 done with small results; the v1/v2 part alone is over 1 MiB',
    'workfile_too_large');
  ok('valid-v3-2000-core-8-offered.json', canonicalV3(boundaryPayload('exact')),
    'a done record with 2,000-scalar cores and a confirmed not_a_term whose finding offers 8 candidates; not a segmentation-v1 result', UNSUPPORTED);
  ok('valid-v1.json', validV1(), 'a v1 file with one choice and one history report, as the v2 writer emits it', null);
  ok('valid-v2-all-parts.json', v2Valid, 'byte-identical to contracts/manuscript-v2/valid-all-parts.json', null);
  cases.valid.push({ file: 'valid-v3-all-parts.json', pad_to_bytes: MAX_V3_BYTES, canonical: 'valid-v3-all-parts.json', legacy_error: 'workfile_too_large',
    note: 'padded with spaces to exactly 44 MiB (46,137,344 bytes): accepted by a v3 reader; an old client stops at its 1 MiB check' });
  cases.valid.push({ file: 'valid-v2-all-parts.json', pad_to_bytes: MAX_V2_BYTES, canonical: 'valid-v2-all-parts.json', legacy_error: null,
    note: 'a v2 file padded with spaces to exactly 1 MiB is accepted' });

  // invalid: size and tree caps
  const tooLarge = (file, pad, note, legacy) => cases.invalid.push({ file, pad_to_bytes: pad, error: 'workfile_too_large', legacy_error: legacy, note });
  tooLarge('valid-v3-all-parts.json', MAX_V3_BYTES + 1, 'a v3 file one byte over 44 MiB (46,137,345 bytes)', 'workfile_too_large');
  tooLarge('valid-v2-all-parts.json', MAX_V2_BYTES + 1, 'a v2 file one byte over 1 MiB: non-v3 input keeps the 1 MiB cap', 'workfile_too_large');
  bad('invalid-v3-513-segments.json', canonicalV3(pendingPayload(513)), 'workfile_too_many_entries', '513 records: the v3 array cap is 512',
    'workfile_too_many_entries');
  bad('invalid-v3-33-choices.json', minify((() => { const x = structuredClone(manyBase); x.segments[1].choices.push(structuredClone(x.segments[1].choices[0])); return x; })()),
    'workfile_too_many_entries', '33 choices in one record (32 plus a repeat of the first)');
  bad('invalid-v3-33-findings.json', minify((() => {
    const x = structuredClone(manyBase);
    x.segments[1].result.findings.push({ verdict: 'needs_review', source: [0, 2], target: null, candidates: [], candidates_truncated: false });
    return x;
  })()), 'workfile_too_many_entries', '33 findings in one result (the 32-choices file plus one more at another span)');
  bad('invalid-v3-9-candidates.json', mutate(x => {
    const extra = Array.from({ length: 8 }, (_, k) => candidateOf({ zh: '示例名', en: `Sample Name extra ${k}`, category: 'character' }, 'extra'));
    x.segments[1].result.findings[2].candidates.push(...extra);
    assert.equal(x.segments[1].result.findings[2].candidates.length, 9);
  }), 'workfile_too_many_entries', 'a finding with 9 candidates (the finding has no choice)');
  bad('invalid-v3-513-history.json', mutate(x => { x.segment_choice_history = historyChoices(513); }), 'workfile_too_many_entries',
    '513 history choices: the v3 array cap is 512', 'workfile_too_many_entries');
  bad('invalid-v3-9-offered.json', mutate(x => {
    x.segments[0].choices[0].offered = Array.from({ length: 9 }, (_, i) => sha(`offered:${i}`)).sort();
  }), 'workfile_too_many_entries', 'a not_a_term choice offering 9 candidate ids, ascending and distinct');
  bad('invalid-v3-depth-17.json', mutate(x => {
    let nested = [];
    for (let i = 0; i < 15; i++) nested = [nested];
    x.progress.current = nested;
  }), 'workfile_too_deep', 'a value at depth 17 (progress.current holds 16 nested arrays)', 'workfile_too_deep');
  bad('invalid-v3-33-fields.json', mutate(x => {
    for (let i = 1; i <= 19; i++) x.segments[0][`extra_${String(i).padStart(2, '0')}`] = 0;
    assert.equal(Object.keys(x.segments[0]).length, 33);
  }), 'workfile_too_many_fields', 'a record with 33 fields (its 14 plus 19 extra)', 'workfile_too_many_fields');
  bad('invalid-v3-forbidden-key.json', replaceOnce(valid, '"index":0,', '"__proto__":0,"index":0,'), 'workfile_forbidden_field',
    'a record with a __proto__ key, inserted in the JSON text', 'workfile_forbidden_field');

  // invalid: top level and the v1/v2 parts
  bad('invalid-v3-unknown-top-key.json', mutate(x => { x.extra = true; }), 'workfile_unsupported_format', 'a 14th top-level key');
  bad('invalid-v3-missing-progress.json', mutate(x => { delete x.progress; }), 'workfile_unsupported_format', 'progress is missing, so the top-level keys are not the 13 v3 keys');
  bad('invalid-v3-format-v4.json', mutate(x => { x.format = 'wuwaterm-manuscript-v4'; }), 'workfile_unsupported_format', 'an unknown format version falls through to the v2 reader');
  bad('invalid-v3-v2-part.json', mutate(x => { x.direction = 'fr'; }), 'workfile_invalid_content', 'the v1/v2 part keeps its checks: direction must be en or zh');
  bad('invalid-v3-129-decisions.json', mutate(x => { x.semantic_decisions = Array.from({ length: 129 }, () => structuredClone(v2Parsed.semantic_decisions[0])); }),
    'workfile_too_many_entries', 'the v1/v2 part keeps the v2 array cap of 128 items: 129 semantic decisions (within the v3 tree cap of 512)', 'workfile_too_many_entries');

  // invalid: record structure (step 6)
  bad('invalid-v3-unknown-status.json', mutate(x => { x.segments[1].status = 'paused'; }), 'workfile_segment_invalid', 'status is not pending, done or stale');
  bad('invalid-v3-pending-with-result.json', mutate(x => { x.segments[1].status = 'pending'; }), 'workfile_segment_invalid', 'a pending record that still holds a direction, an alignment input, a basis and a result');
  bad('invalid-v3-pending-with-direction.json', mutate(x => { assert.equal(x.segments[0].status, 'pending'); x.segments[0].direction = 'en'; }), 'workfile_segment_invalid',
    'a pending record with a direction: direction, alignment_input, basis and result are all null in a pending record');
  bad('invalid-v3-done-null-direction.json', mutate(x => { assert.equal(x.segments[1].status, 'done'); x.segments[1].direction = null; }), 'workfile_segment_invalid',
    'a done record whose direction is null');
  bad('invalid-v3-bad-alignment-input.json', mutate(x => { x.segments[1].alignment_input = 'auto'; }), 'workfile_segment_invalid',
    'an alignment input that is neither "automatic" nor a 64-hex digest');
  bad('invalid-v3-done-without-result.json', mutate(x => { x.segments[1].result = null; }), 'workfile_segment_invalid', 'a done record whose result is null');
  bad('invalid-v3-segmentation-version.json', mutate(x => { x.segments[0].segmentation_version = 'segmentation-v2'; }), 'workfile_segment_invalid', 'an unknown segmentation version');
  bad('invalid-v3-hash-uppercase.json', mutate(x => {
    const upper = x.segments[0].source_hash.toUpperCase();
    assert.notEqual(upper, x.segments[0].source_hash);
    x.segments[0].source_hash = upper;
  }), 'workfile_segment_invalid', 'a content hash written in uppercase hex');
  bad('invalid-v3-range-beyond-text.json', mutate(x => { x.segments[2].target_end = scalars(x.target).length + 1; }), 'workfile_segment_invalid',
    'a target range that ends past the text; the first failure is the range');
  bad('invalid-v3-basis-no-matcher.json', mutate(x => { delete x.segments[1].basis.matcher_revision; }), 'workfile_segment_invalid', 'a record basis without matcher_revision');
  bad('invalid-v3-basis-null-schema.json', mutate(x => { x.segments[2].basis.dictionary.schema_version = null; }), 'workfile_segment_invalid', 'a record basis with a null schema_version');
  bad('invalid-v3-unknown-record-key.json', mutate(x => { x.segments[0].extra = true; }), 'workfile_segment_invalid', 'a record with an unknown key');
  bad('invalid-v3-unknown-verdict.json', mutate(x => { x.segments[1].result.findings[0].verdict = 'maybe'; }), 'workfile_segment_invalid', 'a finding with a verdict outside the four known ones');
  bad('invalid-v3-official-pair-offered.json', mutate(x => {
    assert.equal(x.segments[1].choices[0].choice, 'official_pair');
    x.segments[1].choices[0].offered = [x.segments[1].choices[0].candidate.candidate_id];
  }), 'workfile_segment_invalid', 'an official_pair with a non-empty offered: only a not_a_term lists offered ids');
  bad('invalid-v3-pending-confirmed-choice.json', mutate(x => { x.segments[0].choices[0].confirmed = true; }), 'workfile_segment_invalid',
    'a confirmed choice in a pending record: no choice is confirmed without a result');
  bad('invalid-v3-non-integral-index.json', mutate(x => { x.segments[1].index = 1.5; }), 'workfile_segment_invalid',
    'index 1.5 is not an integer; a later check fails too, the first failure is the type');
  bad('invalid-v3-history-bad-entry.json', mutate(x => { x.segment_choice_history[0].candidate = null; }), 'workfile_segment_invalid',
    'a history choice that is an official_pair without a candidate');

  // invalid: order, content, progress
  bad('invalid-v3-duplicate-index.json', mutate(x => { x.segments[1].index = 0; }), 'workfile_segment_order', 'two records with index 0');
  bad('invalid-v3-overlapping-ranges.json', mutate(x => { x.segments[0].source_end = x.segments[1].source_start + 2; }), 'workfile_segment_order',
    'record 0 ends after record 1 starts');
  bad('invalid-v3-core-2001.json', canonicalV3(boundaryPayload('source-2001')), 'workfile_segment_invalid',
    'valid-v3-2000-core-8-offered.json with a 2,001-scalar source core in a done record; the hashes agree with the cores, only the core length fails');
  bad('invalid-v3-done-empty-core.json', canonicalV3(boundaryPayload('empty-source')), 'workfile_segment_invalid',
    'a done record with an empty source core (start equals end, hash of the empty string, a result without findings): the ranges pass step 6, step 8.1 requires 1 to 2,000 scalars');
  bad('invalid-v3-result-span-outside-core.json', mutate(x => {
    const finding = x.segments[1].result.findings[2];
    assert.deepEqual(finding.source, [10, 13]);
    finding.source = [18, 25];
  }), 'workfile_segment_invalid', 'a finding source that ends beyond the 20-scalar source core; the finding has no choice');
  bad('invalid-v3-duplicate-finding.json', mutate(x => {
    const findings = x.segments[1].result.findings;
    findings[2].source = [...findings[0].source];
  }), 'workfile_segment_invalid', 'two findings with the same source span');
  bad('invalid-v3-choice-outside-core.json', mutate(x => { Object.assign(x.segments[0].choices[0].source_span, { start: 7, end: 10 }); }),
    'workfile_segment_anchor_invalid', 'a choice span that starts at the end of its core');
  bad('invalid-v3-choice-text-differs.json', mutate(x => { x.segments[0].choices[0].source_span.text = '示例乙'; }), 'workfile_segment_anchor_invalid',
    'a choice span whose text is not what the core holds there');
  bad('invalid-v3-confirmed-choice-not-reported.json', mutate(x => { x.segments[1].choices[2].confirmed = true; }),
    'workfile_segment_anchor_invalid', 'a confirmed choice at an occurrence the result has no finding for');
  bad('invalid-v3-duplicate-choice.json', mutate(x => { x.segments[0].choices.push(structuredClone(x.segments[0].choices[0])); }), 'workfile_duplicate_choices',
    'two choices with the same start and end in one record');
  bad('invalid-v3-progress-current-missing.json', mutate(x => { x.progress.current = 3; }), 'workfile_progress_invalid', 'progress.current names a record that does not exist');
  bad('invalid-v3-progress-completed-pending.json', mutate(x => { assert.equal(x.segments[0].status, 'pending'); x.progress.completed = [0, 1, 2]; }), 'workfile_progress_invalid',
    'completed is strictly ascending but names record 0, which is pending (records 1 and 2 are done and stale, which is allowed)');
  bad('invalid-v3-progress-completed-unsorted.json', mutate(x => { x.progress.completed = [1, 1]; }), 'workfile_progress_invalid',
    'completed repeats an index, so it is not strictly ascending (both entries name a done record)');

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
  // A fixture the generator no longer produces must not linger in the directory.
  for (const name of readdirSync(root).filter(n => n.endsWith('.json') && !files.has(n))) {
    if (write) unlinkSync(join(root, name)); else { stale++; console.error(`unexpected: contracts/manuscript-v3/${name}`); }
  }
  if (stale) { console.error('Run: node scripts/build-manuscript-v3-fixtures.mjs --write'); process.exit(1); }
  console.log(write ? `wrote ${files.size} files` : `ok: ${files.size} files`);
}
