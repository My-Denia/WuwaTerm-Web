// Generates contracts/manuscript-v5/ (every file but schema.json, which `npm run generate:contracts` cuts from
// contracts/schemas/manuscript.schema.json). Default: check the committed bytes. --write: rewrite them.
// All text is synthetic or public game text; hashes, revisions and ids are computed, never typed.
// The contract is contracts/manuscript-v5/SPEC.md (a delta to contracts/manuscript-v4/SPEC.md); this file only produces fixtures for it.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// The frozen Web 0.4.5 reader (the last reader without v5) stands for every client that predates this contract.
import { makeChoice, parseWorkfile as parseWeb045 } from '../tests/legacy/web-0.4.5/manuscript.js';
import { pairSegments, pairSegmentsWithGaps } from '../lib/segmentation.ts';
import { padContent } from './build-manuscript-v3-fixtures.mjs';
import { CODES, MAX_V2_BYTES, REASON_VALUES as V4_REASONS, buildFixtures as buildV4Fixtures, canonicalV4 } from './build-manuscript-v4-fixtures.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'contracts', 'manuscript-v5');

export const V4_FORMAT = 'wuwaterm-manuscript-v4';
export const V5_FORMAT = 'wuwaterm-manuscript-v5';
export const MAX_V5_BYTES = 46_137_344;
export const AMBIGUOUS_MENTION = 'ambiguous_mention';
export const REASON_VALUES = [...V4_REASONS, AMBIGUOUS_MENTION];
export const REVIEW_FEATURES = ['ambiguous-mention-v1'];
export const SEGMENTATION_VERSIONS = ['segmentation-v1', 'segmentation-v1-gaps'];
export { CODES };
// The v4 limits, unchanged, and the one list v5 adds.
export const LIMITS = { file_bytes: MAX_V5_BYTES, legacy_file_bytes: MAX_V2_BYTES, findings_per_result: 128, choices_per_record: 128, choices: 128, review_features: 8 };

const sha = label => createHash('sha256').update(label, 'utf8').digest('hex');
const bytesOf = text => Buffer.byteLength(text, 'utf8');
const scalars = text => Array.from(text);
const scalarSlice = (text, start, end) => scalars(text).slice(start, end).join('');
const minify = value => JSON.stringify(value);
const hasReason = f => Object.hasOwn(f, 'reason');
const ambiguous = f => f.reason === AMBIGUOUS_MENTION;

// ---- reference canonical writer (v5 SPEC "Writing") ----

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
  candidates_truncated: f.candidates_truncated, ...(hasReason(f) ? { reason: f.reason } : {}),
});
const orderResult = r => ({ truncated: r.truncated, evaluated: r.evaluated, not_evaluated: r.not_evaluated, findings: r.findings.map(orderFinding) });
const orderRecord = r => ({
  index: r.index, segmentation_version: r.segmentation_version, source_start: r.source_start, source_end: r.source_end,
  target_start: r.target_start, target_end: r.target_end, source_hash: r.source_hash, target_hash: r.target_hash, status: r.status,
  direction: r.direction, alignment_input: r.alignment_input, basis: r.basis === null ? null : orderBasis(r.basis),
  result: r.result === null ? null : orderResult(r.result), choices: r.choices.map(orderChoice),
});

/**
 * The `review_features` a writer gives a parsed payload: the file's own features when any record is `done` (those results were made
 * under them), and `ambiguous-mention-v1` whenever a written finding has the `ambiguous_mention` reason; sorted.
 */
export function fileFeatures(payload) {
  const tokens = new Set();
  if ((payload.segments ?? []).some(r => r.status === 'done')) (payload.review_features ?? []).forEach(t => tokens.add(t));
  const found = (payload.history ?? []).slice(-2).some(h => h.report.findings.some(ambiguous))
    || (payload.segments ?? []).some(r => r.result?.findings.some(ambiguous));
  if (found) tokens.add(REVIEW_FEATURES[0]);
  return [...tokens].sort();
}
/** v5 holds the payload only when it records review features or gap-tolerant records; otherwise the lower format does. */
export function needsV5(payload) {
  return fileFeatures(payload).length > 0 || (payload.segments ?? []).some(r => r.segmentation_version !== 'segmentation-v1');
}

/** The bytes a conforming writer produces from a parsed manuscript: v5 when needed, else what the v4 contract writes. */
export function canonicalV5(payload, { maxBytes = MAX_V5_BYTES } = {}) {
  const features = fileFeatures(payload);
  const own = [...(payload.review_features ?? [])].sort();
  const same = own.length === features.length && own.every((x, i) => x === features[i]);
  // A done record's results were made under the file's features; under any other set they are written stale.
  const segments = (payload.segments ?? []).map(r => (r.status === 'done' && !same ? { ...r, status: 'stale' } : r));
  const next = { ...payload, segments, review_features: features };
  if (!needsV5(next)) return canonicalV4(next, { maxBytes });
  const decisions = next.semantic_decisions ?? [];
  const needed = new Set(decisions.filter(d => d.decision === 'ignored').flatMap(d => [d.source_revision, d.target_revision]));
  const seen = new Set();
  const texts = (next.semantic_texts ?? []).filter(t => needed.has(t.revision) && !seen.has(t.revision) && seen.add(t.revision));
  const semanticHistory = (next.semantic_history ?? []).slice(-2);
  const write = () => minify({
    format: V5_FORMAT, source: next.source, target: next.target, direction: next.direction, alignments: next.alignments,
    choices: next.choices, history: next.history.slice(-2), semantic_decisions: decisions, semantic_texts: texts, semantic_history: semanticHistory,
    segments: segments.map(orderRecord), segment_choice_history: (next.segment_choice_history ?? []).map(orderHistoryEntry),
    progress: { current: next.progress.current, completed: [...next.progress.completed] }, review_features: features,
  });
  let content = write();
  while (semanticHistory.length > 0 && bytesOf(content) > maxBytes) { semanticHistory.shift(); content = write(); }
  if (bytesOf(content) > maxBytes) throw Object.assign(new Error('workfile_too_large'), { code: 'workfile_too_large' });
  return content;
}

// ---- synthetic building blocks: public Wuthering Waves terms ----

const DICTIONARY = { schema_version: '2', source_commit: 'synthetic-commit-v5', term_count: 1204, revision: sha('dictionary-revision-v5') };
const MATCHER = sha('matcher-revision-v5');
const B = { rule_version: 'review-v2', dictionary: { ...DICTIONARY }, matcher_revision: MATCHER };
const TERMS = {
  camellya: { zh: '椿', en: 'Camellya', category: 'resonator' },
  jinhsi: { zh: '今汐', en: 'Jinhsi', category: 'resonator' },
  shorekeeper: { zh: '守岸人', en: 'Shorekeeper', category: 'resonator' },
  echo: { zh: '声骸', en: 'Echo', category: 'item' },
};
const candidateOf = term => ({ candidate_id: sha(`candidate:v5:${term.zh}:${term.en}:${term.category}`), zh: term.zh, en: term.en, category: term.category });

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
function resultOf(findings) {
  const notEvaluated = findings.filter(f => f.verdict === 'not_evaluated').length;
  return { truncated: false, evaluated: findings.length - notEvaluated, not_evaluated: notEvaluated, findings };
}
function compactFinding(sourceCore, targetCore, { needle, nth = 0, verdict, targetText = null, candidates, reason }) {
  const span = spanOf(sourceCore, needle, nth);
  const target = targetText === null ? null : spanOf(targetCore, targetText);
  return orderFinding({
    verdict, source: [span.start, span.end], target: target === null ? null : [target.start, target.end], candidates: candidates.map(orderCandidate),
    candidates_truncated: false, ...(reason === undefined ? {} : { reason }),
  });
}
const emptyParts = { semantic_decisions: [], semantic_texts: [], semantic_history: [] };

// ---- document mode: a review-v2 report sent with ambiguous-mention-v1 ----

/**
 * Core's own enumeration case: 今汐 and 守岸人 are judged, 椿 (in 椿姐) is an ambiguous one-character name, reported not_evaluated with
 * the reason `ambiguous_mention` and its official candidate, after the judged findings. The user adopted that candidate, so one
 * choice waits for the next check (which sends it as a resolution, and Core judges the name then).
 */
function documentPayload() {
  const source = '今汐、椿姐、守岸人一起出发。';
  const target = 'Jinhsi, Camellya and the Shorekeeper set out.';
  const live = (term, n) => ({ ...candidateOf(term), sources: [{ source_file: 'synthetic/terms.json', source_id: `term-${n}` }] });
  const finding = (needle, targetText, verdict, term, reason) => {
    const span = spanOf(source, needle);
    return {
      id: `${span.start}:${span.end}:${span.text}`, rule_id: 'review.term_pair', verdict, source_span: span,
      target_span: targetText === null ? null : spanOf(target, targetText), candidates: [live(term, 1)], candidates_truncated: false,
      ...(reason === undefined ? {} : { reason }),
    };
  };
  const findings = [
    finding('今汐', 'Jinhsi', 'verified_constraint', TERMS.jinhsi),
    finding('守岸人', 'Shorekeeper', 'verified_constraint', TERMS.shorekeeper),
    finding('椿', null, 'not_evaluated', TERMS.camellya, AMBIGUOUS_MENTION),
  ];
  const report = {
    request_id: 'req-v5-document', source_revision: sha(source), target_revision: sha(target), rule_version: 'review-v2', matcher_revision: MATCHER,
    dictionary: { ...DICTIONARY }, coverage: { evaluated: 2, not_evaluated: 1, rules: ['review.term_pair', 'review.sentence_meaning'] },
    findings, truncated: false,
  };
  const draft = { source, target, direction: 'en', alignments: null };
  const picked = findings[2].candidates[0];
  const choice = makeChoice({ ...draft, report, finding: findings[2], candidate: { candidate_id: picked.candidate_id, zh: picked.zh, en: picked.en, category: picked.category } });
  return {
    format: V5_FORMAT, ...draft, choices: [choice], history: [{ ...draft, report }], ...emptyParts,
    segments: [], segment_choice_history: [], progress: { current: null, completed: [] }, review_features: [...REVIEW_FEATURES],
  };
}

// ---- long mode: records whose results were made with ambiguous-mention-v1 ----

function segmentsPayload() {
  const camellya = candidateOf(TERMS.camellya);
  const jinhsi = candidateOf(TERMS.jinhsi);
  const shorekeeper = candidateOf(TERMS.shorekeeper);
  const sources = ['今汐、椿姐、守岸人一起出发。', '椿姐配队攻略：共鸣者椿姐和今汐一起出发。', '声骸会在战斗后出现。'];
  const targets = [
    longParagraph('Jinhsi, Camellya and the Shorekeeper set out.', 1100),
    longParagraph('Camellya team guide: Resonator Camellya set out with Jinhsi.', 1100),
    longParagraph('Echoes appear after a battle.', 1100),
  ];
  const source = sources.join('\n\n');
  const target = targets.join('\n\n');
  assert.ok(scalars(target).length > 2000, 'the target must be long enough for long mode');
  const pairs = pairSegments(source, target);
  assert.equal(pairs.length, 3);
  assert.ok(pairs.every(p => p.status === 'ready'));
  const shell = (i, status, record) => ({
    index: i, segmentation_version: 'segmentation-v1', source_start: pairs[i].source.core_start, source_end: pairs[i].source.core_end,
    target_start: pairs[i].target.core_start, target_end: pairs[i].target.core_end, source_hash: sha(sources[i]), target_hash: sha(targets[i]),
    status, direction: status === 'pending' ? null : 'en', alignment_input: status === 'pending' ? null : 'automatic',
    basis: status === 'pending' ? null : structuredClone(B), result: status === 'pending' ? null : record.result, choices: record.choices,
  });
  // Record 0: done; the judged names first, the ambiguous 椿 last (Core's order).
  const done = shell(0, 'done', {
    result: resultOf([
      compactFinding(sources[0], targets[0], { needle: '今汐', verdict: 'verified_constraint', targetText: 'Jinhsi', candidates: [jinhsi] }),
      compactFinding(sources[0], targets[0], { needle: '守岸人', verdict: 'verified_constraint', targetText: 'Shorekeeper', candidates: [shorekeeper] }),
      compactFinding(sources[0], targets[0], { needle: '椿', verdict: 'not_evaluated', candidates: [camellya], reason: AMBIGUOUS_MENTION }),
    ]),
    choices: [],
  });
  // Record 1: stale; the user adopted Camellya for the first ambiguous 椿, which waits for the next check.
  const first = spanOf(sources[1], '椿');
  const stale = shell(1, 'stale', {
    result: resultOf([
      compactFinding(sources[1], targets[1], { needle: '今汐', verdict: 'verified_constraint', targetText: 'Jinhsi', candidates: [jinhsi] }),
      compactFinding(sources[1], targets[1], { needle: '椿', verdict: 'not_evaluated', candidates: [camellya], reason: AMBIGUOUS_MENTION }),
    ]),
    choices: [{ source_span: first, choice: 'official_pair', candidate: orderCandidate(camellya), offered: [], confirmed: false }],
  });
  const pending = shell(2, 'pending', { choices: [] });
  return {
    format: V5_FORMAT, source, target, direction: 'en', alignments: null, choices: [], history: [], ...emptyParts,
    segments: [done, stale, pending], segment_choice_history: [], progress: { current: 1, completed: [0, 1] }, review_features: [...REVIEW_FEATURES],
  };
}

// ---- long mode: explicit alignments with a gap, paired gap-tolerantly ----

/**
 * Three aligned paragraphs, of which an edit invalidated the middle alignment: the kept list leaves the middle paragraph outside
 * every span. segmentation-v1 would make the whole manuscript one manual pair; the gap-tolerant pairing keeps both aligned
 * paragraphs as they were and makes the middle one a gap that needs a manual split. Records carry `segmentation-v1-gaps`.
 */
function gapsPayload() {
  const echo = candidateOf(TERMS.echo);
  const jinhsi = candidateOf(TERMS.jinhsi);
  const sources = ['今汐在等候。', '这一段刚刚改过，还没有重新对齐。', '声骸会在战斗后出现。'];
  const targets = [
    longParagraph('Jinhsi waits.', 1100),
    longParagraph('This paragraph was just edited and is not aligned again yet.', 1100),
    longParagraph('Echoes appear after a battle.', 1100),
  ];
  const source = sources.join('\n\n');
  const target = targets.join('\n\n');
  const sStart = i => scalars(sources.slice(0, i).join('\n\n')).length + (i ? 2 : 0);
  const tStart = i => scalars(targets.slice(0, i).join('\n\n')).length + (i ? 2 : 0);
  const alignment = i => ({
    source: { start: sStart(i), end: sStart(i) + scalars(sources[i]).length, text: sources[i] },
    target: { start: tStart(i), end: tStart(i) + scalars(targets[i]).length, text: targets[i] },
  });
  const alignments = [alignment(0), alignment(2)];
  const { pairs, version } = pairSegmentsWithGaps(source, target, 1800, alignments);
  assert.equal(version, 'segmentation-v1-gaps');
  assert.deepEqual(pairs.map(p => p.status), ['ready', 'needs_manual_split', 'ready']);
  // The alignment input of a record: the SHA-256 of its clipped, rebased alignment list (v3 SPEC "Segment request").
  const inputOf = i => sha(minify([{ source: { start: 0, end: scalars(sources[i]).length, text: sources[i] }, target: { start: 0, end: scalars(targets[i]).length, text: targets[i] } }]));
  const shell = (i, status, record) => ({
    index: i, segmentation_version: version, source_start: pairs[i].source.core_start, source_end: pairs[i].source.core_end,
    target_start: pairs[i].target.core_start, target_end: pairs[i].target.core_end,
    source_hash: sha(scalarSlice(source, pairs[i].source.core_start, pairs[i].source.core_end)),
    target_hash: sha(scalarSlice(target, pairs[i].target.core_start, pairs[i].target.core_end)),
    status, direction: status === 'pending' ? null : 'en', alignment_input: status === 'pending' ? null : inputOf(i),
    basis: status === 'pending' ? null : structuredClone(B), result: status === 'pending' ? null : record.result, choices: record.choices,
  });
  pairs.forEach((p, i) => assert.equal(scalarSlice(source, p.source.core_start, p.source.core_end), sources[i]));
  const segments = [
    shell(0, 'done', { result: resultOf([compactFinding(sources[0], targets[0], { needle: '今汐', verdict: 'verified_constraint', targetText: 'Jinhsi', candidates: [jinhsi] })]), choices: [] }),
    shell(1, 'pending', { choices: [] }),
    shell(2, 'done', { result: resultOf([compactFinding(sources[2], targets[2], { needle: '声骸', verdict: 'verified_constraint', targetText: 'Echo', candidates: [echo] })]), choices: [] }),
  ];
  return {
    format: V5_FORMAT, source, target, direction: 'en', alignments, choices: [], history: [], ...emptyParts,
    segments, segment_choice_history: [], progress: { current: 1, completed: [0, 2] }, review_features: [],
  };
}

// ---- the cases ----

/** What the frozen Web 0.4.5 reader gives a file: the error code, or null when it accepts it. */
function legacyCode(content) {
  try { parseWeb045(content); return null; } catch (error) { return error.code; }
}

export async function buildFixtures() {
  const files = new Map();
  const cases = {
    format: V5_FORMAT, spec: 'SPEC.md', schema: 'schema.json', codes: CODES, limits: LIMITS, reasons: REASON_VALUES,
    review_features: REVIEW_FEATURES, segmentation_versions: SEGMENTATION_VERSIONS, valid: [], invalid: [],
  };
  const v4 = await buildV4Fixtures();
  const ok = (file, content, note, canonical = file) => {
    files.set(file, content);
    cases.valid.push({ file, canonical, legacy_error: legacyCode(content), note });
  };
  const padded = (file, bytes, listing, extra) => listing.push({ file, pad_to_bytes: bytes, ...extra(padContent(files.get(file), bytes)) });
  const bad = (file, content, code, note) => {
    files.set(file, content);
    cases.invalid.push({ file, error: code, legacy_error: legacyCode(content), note });
  };
  const mutate = (base, fn) => { const x = JSON.parse(base); fn(x); return minify(x); };
  const invalidContent = 'workfile_invalid_content';
  const segmentInvalid = 'workfile_segment_invalid';
  const unsupported = 'workfile_unsupported_format';

  // ---- valid ----
  const documentContent = canonicalV5(documentPayload());
  ok('valid-v5-document-ambiguous.json', documentContent,
    'document mode: a review-v2 report sent with ambiguous-mention-v1 (two judged names, then one ambiguous_mention finding) and an adopted candidate that waits for the next check; review_features ["ambiguous-mention-v1"]');
  padded('valid-v5-document-ambiguous.json', MAX_V2_BYTES + 1, cases.valid, content => ({
    canonical: 'valid-v5-document-ambiguous.json', legacy_error: legacyCode(content),
    note: 'the same v5 file padded with spaces to 1 MiB plus one byte: a v5 reader accepts it (44 MiB cap); an older reader stops at its 1 MiB check',
  }));
  const segmentsContent = canonicalV5(segmentsPayload());
  ok('valid-v5-segments-ambiguous.json', segmentsContent,
    'long mode, three segments: done with an ambiguous_mention finding after two judged ones; stale with an unconfirmed adoption of the ambiguous candidate; pending');
  const withoutAmbiguous = mutate(segmentsContent, x => {
    for (const r of x.segments) {
      if (!r.result) continue;
      r.result.findings = r.result.findings.filter(f => !ambiguous(f));
      r.result.not_evaluated = r.result.findings.filter(f => f.verdict === 'not_evaluated').length;
      r.choices = [];
    }
  });
  ok('valid-v5-features-without-ambiguous.json', canonicalV5(JSON.parse(withoutAmbiguous)),
    'long mode: results made with ambiguous-mention-v1 that found no ambiguous name. Only review_features keeps them reusable under that feature, so the file stays v5');
  ok('valid-v5-gaps.json', canonicalV5(gapsPayload()),
    'long mode with explicit alignments that leave the middle paragraph uncovered: both aligned paragraphs keep their done records, the gap is a pending needs_manual_split record; every record says segmentation-v1-gaps; review_features []');

  // v5-labelled files that a lower format holds are written back in it.
  const v4reason = JSON.parse(v4.get('valid-v4-segment-reason-only.json'));
  const fitsV4 = { ...v4reason, format: V5_FORMAT, review_features: [] };
  ok('valid-v5-fits-v4.json', minify(fitsV4), 'a v5 file with no review feature and no gap-tolerant record, with a v4 reason: written back as v4 (valid-v4-from-v5.json)', 'valid-v4-from-v5.json');
  ok('valid-v4-from-v5.json', canonicalV5(fitsV4), 'the v4 bytes of valid-v5-fits-v4.json');
  const v1 = JSON.parse(v4.get('valid-v4-fits-v1.json'));
  const fitsV1 = { ...v1, format: V5_FORMAT, review_features: [] };
  ok('valid-v5-fits-v1.json', minify(fitsV1), 'a v5 file with no segment state, no review feature and nothing over the v1-v3 limits: written back as v1 (valid-v1-from-v5.json)', 'valid-v1-from-v5.json');
  ok('valid-v1-from-v5.json', canonicalV5(fitsV1), 'the v1 bytes of valid-v5-fits-v1.json');
  const unused = mutate(segmentsContent, x => {
    for (const r of x.segments) Object.assign(r, { status: 'pending', direction: null, alignment_input: null, basis: null, result: null, choices: [] });
    x.progress = { current: null, completed: [] };
  });
  ok('valid-v5-features-without-results.json', unused,
    'a v5 file that lists ambiguous-mention-v1 but holds no result made under it: no result needs the list, so a writer writes it back as v3 (valid-v3-from-v5.json)', 'valid-v3-from-v5.json');
  ok('valid-v3-from-v5.json', canonicalV5(JSON.parse(unused)), 'the v3 bytes of valid-v5-features-without-results.json');

  // ---- invalid: review_features ----
  bad('invalid-v5-missing-review-features.json', mutate(documentContent, x => { delete x.review_features; }), unsupported,
    'the v5 label with the 13 v4 keys: v5 has 14 top-level keys');
  bad('invalid-v5-feature-unknown.json', mutate(documentContent, x => { x.review_features = ['dense-128', 'ambiguous-mention-v1']; }), invalidContent,
    'review_features lists a token that is not a recorded review feature (dense-128 changes the page size, not what a result holds)');
  bad('invalid-v5-feature-repeated.json', mutate(documentContent, x => { x.review_features = ['ambiguous-mention-v1', 'ambiguous-mention-v1']; }), invalidContent,
    'review_features repeats a token');
  bad('invalid-v5-feature-null.json', mutate(documentContent, x => { x.review_features = null; }), invalidContent, 'review_features is null');
  bad('invalid-v5-ambiguous-without-feature-document.json', mutate(documentContent, x => { x.review_features = []; }), invalidContent,
    'a history finding with the ambiguous_mention reason in a file that does not record ambiguous-mention-v1');
  bad('invalid-v5-ambiguous-without-feature-segment.json', mutate(segmentsContent, x => { x.review_features = []; }), segmentInvalid,
    'a record finding with the ambiguous_mention reason in a file that does not record ambiguous-mention-v1');
  bad('invalid-v5-reason-unknown.json', mutate(segmentsContent, x => { x.segments[0].result.findings[2].reason = 'ambiguous'; }), segmentInvalid,
    'a record finding whose reason is not one of the six');
  bad('invalid-v5-ambiguous-on-verified.json', mutate(documentContent, x => { x.history[0].report.findings[0].reason = AMBIGUOUS_MENTION; }), invalidContent,
    'a verified history finding with a reason: a reason belongs to not_evaluated only');

  // ---- invalid: segmentation labels ----
  const gapsContent = files.get('valid-v5-gaps.json');
  bad('invalid-v5-segmentation-unknown.json', mutate(gapsContent, x => { for (const r of x.segments) r.segmentation_version = 'segmentation-v2'; }), segmentInvalid,
    'a record with a segmentation label that is neither segmentation-v1 nor segmentation-v1-gaps');
  bad('invalid-v5-segmentation-mixed.json', mutate(gapsContent, x => { x.segments[0].segmentation_version = 'segmentation-v1'; }), segmentInvalid,
    'records with two segmentation labels: one manuscript has one pairing');

  // ---- invalid: a v4 label never holds v5 content ----
  const asV4 = x => { x.format = V4_FORMAT; delete x.review_features; };
  bad('invalid-v5-v4-format-ambiguous-document.json', mutate(documentContent, asV4), invalidContent,
    'the v4 label with a history finding whose reason is ambiguous_mention: the v4 reasons are the five');
  bad('invalid-v5-v4-format-ambiguous-segment.json', mutate(segmentsContent, asV4), segmentInvalid,
    'the v4 label with a record finding whose reason is ambiguous_mention');
  bad('invalid-v5-v4-format-gaps.json', mutate(gapsContent, asV4), segmentInvalid, 'the v4 label with segmentation-v1-gaps records');
  bad('invalid-v5-v4-format-review-features.json', mutate(gapsContent, x => { x.format = V4_FORMAT; for (const r of x.segments) r.segmentation_version = 'segmentation-v1'; }), unsupported,
    'the v4 label with the 14 v5 keys');
  bad('invalid-v5-format-v6.json', mutate(documentContent, x => { x.format = 'wuwaterm-manuscript-v6'; }), unsupported, 'an unknown format version falls through to the v2 reader');
  padded('valid-v5-document-ambiguous.json', MAX_V5_BYTES + 1, cases.invalid, content => ({
    error: 'workfile_too_large', legacy_error: legacyCode(content), note: 'a v5 file one byte over 44 MiB (46,137,345 bytes)',
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
    if (current !== content) { stale++; console.error(`stale: contracts/manuscript-v5/${name}`); }
  }
  // A fixture the generator no longer produces must not linger in the directory; schema.json is the codegen's.
  let present = [];
  try { present = readdirSync(root).filter(n => n.endsWith('.json') && n !== 'schema.json' && !files.has(n)); } catch { /* not written yet */ }
  for (const name of present) {
    if (write) unlinkSync(join(root, name)); else { stale++; console.error(`unexpected: contracts/manuscript-v5/${name}`); }
  }
  if (stale) { console.error('Run: node scripts/build-manuscript-v5-fixtures.mjs --write'); process.exit(1); }
}
