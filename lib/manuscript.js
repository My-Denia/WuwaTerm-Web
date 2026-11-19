// Device-local workfiles hold user intent. A saved v3/v4 segment result is reused only when the content hashes, the request inputs and a
// live basis all match (contracts/manuscript-v3/SPEC.md, design note); v1/v2 reports and choices stay history, never certification.
// v4 (contracts/manuscript-v4/SPEC.md) lifts the per-list caps from 32 to 128 and lets a not_evaluated finding carry a reason.
import { highlightSegments } from './review-report.js';
import { SEMANTIC_CATEGORIES, SEMANTIC_REVIEW_VERSION, validSemanticReviewResponse } from './semantic-review.js';

export const WORKFILE_FORMAT = 'wuwaterm-manuscript-v1';
export const WORKFILE_FORMAT_V2 = 'wuwaterm-manuscript-v2';
export const WORKFILE_FORMAT_V3 = 'wuwaterm-manuscript-v3';
export const WORKFILE_FORMAT_V4 = 'wuwaterm-manuscript-v4';
export const MAX_SEMANTIC_DECISIONS = 128;
export const MAX_SEMANTIC_TEXTS = 16;
export const MAX_SEMANTIC_HISTORY = 2;
export const MAX_WORKFILE_BYTES = 1_048_576; // v1 and v2
export const MAX_V3_WORKFILE_BYTES = 46_137_344; // v3: 44 MiB
export const MAX_V4_WORKFILE_BYTES = 46_137_344; // v4: the same 44 MiB
export const MAX_SEGMENTS = 512;
export const MAX_SEGMENT_HISTORY = 512;
export const MAX_CHOICES = 32; // v1, v2 and v3: choices, resolutions and findings per list
export const MAX_V4_CHOICES = 128; // v4: the same lists
export const MAX_HISTORY = 2;
/** Why Core did not evaluate a finding (review-v2 `reason`, only on `not_evaluated`). Everything that reads or labels one imports this list. */
export const REASON_VALUES = Object.freeze(['not_a_term', 'ordinary_word', 'no_target_region', 'found_outside_region', 'ambiguous_repeat']);
/** @typedef {{items: number, reason: boolean}} ReportLimits The findings cap of a list, and whether a not_evaluated finding may carry a reason. */
/** @type {Readonly<ReportLimits>} v1, v2 and v3 readers: at most 32 per list, no reason */
const LIMITS = Object.freeze({ items: MAX_CHOICES, reason: false });
/** @type {Readonly<ReportLimits>} */
const LIMITS_V4 = Object.freeze({ items: MAX_V4_CHOICES, reason: true });
/** The limits of a v4 report, for a reader that accepts the dense, reason-carrying shape (Web BFF response, v4 files). */
export const REPORT_V4 = LIMITS_V4;
const V2 = 'review-v2';
const FINDING_FIELDS = ['id', 'rule_id', 'verdict', 'source_span', 'target_span', 'candidates', 'candidates_truncated'];
const HEX = /^[a-f0-9]{64}$/u;
const HEX32 = /^[a-f0-9]{32}$/u;
const VERDICTS = ['verified_constraint', 'confirmed_conflict', 'needs_review', 'not_evaluated'];

function object(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
function keys(x, required) {
  return object(x) && Object.keys(x).length === required.length && required.every(k => Object.hasOwn(x, k));
}
// Same count as Array.from(x).length, without allocating an array: a v3 text can be tens of MiB.
function scalarLength(x) {
  let n = x.length;
  for (let i = 0; i < x.length - 1; i++) {
    const high = x.charCodeAt(i);
    if (high >= 0xD800 && high <= 0xDBFF) {
      const low = x.charCodeAt(i + 1);
      if (low >= 0xDC00 && low <= 0xDFFF) { n--; i++; }
    }
  }
  return n;
}
function text(x, max = 2000, empty = true) {
  return typeof x === 'string' && (empty || x.length > 0) && scalarLength(x) <= max
    && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(x);
}
function direction(x) { return x === 'en' || x === 'zh'; }
export function validSpan(span, content) {
  return keys(span, ['start', 'end', 'text']) && Number.isInteger(span.start) && Number.isInteger(span.end)
    && span.start >= 0 && span.end > span.start && text(span.text, 2000, false)
    && highlightSegments(content, span) !== null;
}
export function validAlignments(items, source, target) {
  if (items === null) return true;
  if (!Array.isArray(items) || items.length > 64) return false;
  let sourceEnd = 0; let targetEnd = 0;
  for (const item of items) {
    if (!keys(item, ['source', 'target']) || !validSpan(item.source, source)
      || (item.target !== null && !validSpan(item.target, target)) || item.source.start < sourceEnd) return false;
    sourceEnd = item.source.end;
    if (item.target !== null) {
      if (item.target.start < targetEnd) return false;
      targetEnd = item.target.end;
    }
  }
  return true;
}
function validDictionary(x, version) {
  const fields = ['schema_version', 'source_commit', 'term_count'];
  if (version === V2) fields.push('revision');
  return keys(x, fields) && (x.schema_version === null || text(x.schema_version, 4096))
    && (x.source_commit === null || text(x.source_commit, 4096)) && Number.isSafeInteger(x.term_count) && x.term_count >= 0
    && (version !== V2 || HEX.test(x.revision));
}
function validCandidate(x, version) {
  const fields = ['zh', 'en', 'category', 'sources'];
  if (version === V2) fields.push('candidate_id');
  return keys(x, fields) && text(x.zh, 2000, false) && text(x.en, 2000, false) && text(x.category, 256, false)
    && Array.isArray(x.sources) && x.sources.length <= 8
    && x.sources.every(s => keys(s, ['source_file', 'source_id']) && text(s.source_file, 4096, false) && text(s.source_id, 1024, false))
    && (version !== V2 || HEX.test(x.candidate_id));
}
/**
 * A review report with its findings valid for the text it was made for. `limits`: the findings cap and whether a not_evaluated finding
 * may carry a `reason` (default: the v1-v3 shape, 32 and no reason).
 * @param {any} x @param {any} source @param {any} target @param {ReportLimits} [limits]
 */
export function validReport(x, source, target, limits = LIMITS) {
  if (!object(x)) return false;
  const fields = ['request_id', 'source_revision', 'target_revision', 'rule_version', 'dictionary', 'coverage', 'findings', 'truncated'];
  if (Object.hasOwn(x, 'matcher_revision')) fields.push('matcher_revision');
  return keys(x, fields)
    && text(x.request_id, 256, false) && HEX.test(x.source_revision) && HEX.test(x.target_revision)
    && ['review-v1', V2].includes(x.rule_version) && validDictionary(x.dictionary, x.rule_version)
    && (!Object.hasOwn(x, 'matcher_revision') || HEX.test(x.matcher_revision))
    && keys(x.coverage, ['evaluated', 'not_evaluated', 'rules'])
    && Number.isSafeInteger(x.coverage.evaluated) && x.coverage.evaluated >= 0
    && Number.isSafeInteger(x.coverage.not_evaluated) && x.coverage.not_evaluated >= 0
    && Array.isArray(x.coverage.rules) && x.coverage.rules.length <= 16 && x.coverage.rules.every(r => text(r, 256, false))
    && typeof x.truncated === 'boolean' && Array.isArray(x.findings) && x.findings.length <= limits.items
    && new Set(x.findings.map(f => f?.id)).size === x.findings.length
    && x.findings.every(f => keys(f, withReason(f, limits))
      && text(f.id, 8192, false) && text(f.rule_id, 256, false) && VERDICTS.includes(f.verdict)
      && validSpan(f.source_span, source) && f.id === mentionId(f.source_span)
      && (f.target_span === null || validSpan(f.target_span, target))
      && typeof f.candidates_truncated === 'boolean' && Array.isArray(f.candidates) && f.candidates.length <= 8
      && f.candidates.every(c => validCandidate(c, x.rule_version)));
}
// A finding's keys: the seven, plus `reason` only where the limits allow it and only on not_evaluated with a known reason (anything else
// is a wrong key set, so the report is invalid).
function withReason(f, limits) {
  return object(f) && Object.hasOwn(f, 'reason') && limits.reason && f.verdict === 'not_evaluated' && REASON_VALUES.includes(f.reason)
    ? [...FINDING_FIELDS, 'reason'] : FINDING_FIELDS;
}
export function basisOf(report) {
  const basis = { rule_version: report.rule_version, dictionary: { ...report.dictionary } };
  if (Object.hasOwn(report, 'matcher_revision')) basis.matcher_revision = report.matcher_revision;
  return basis;
}
function matcherId(basis) {
  if (!basis || !Object.hasOwn(basis, 'matcher_revision')) return null;
  return HEX.test(basis.matcher_revision) ? basis.matcher_revision : false;
}
export function sameBasis(a, b) {
  const left = matcherId(a);
  const right = matcherId(b);
  return !!a && !!b && a.rule_version === V2 && b.rule_version === V2
    && text(a.dictionary?.schema_version, 4096, false) && text(b.dictionary?.schema_version, 4096, false)
    && text(a.dictionary?.source_commit, 4096, false) && text(b.dictionary?.source_commit, 4096, false)
    && HEX.test(a.dictionary?.revision) && a.dictionary.revision === b.dictionary?.revision
    && a.dictionary.source_commit === b.dictionary.source_commit
    && a.dictionary.schema_version === b.dictionary.schema_version && a.dictionary.term_count === b.dictionary.term_count
    && left !== false && right !== false && left === right;
}
export function mentionId(span) { return `${span.start}:${span.end}:${span.text}`; }
export function scopeOf(alignments, span) {
  if (alignments === null) return 'positional';
  const region = alignments.find(a => a.source.start <= span.start && a.source.end >= span.end);
  return region ? JSON.stringify(region) : 'unmapped';
}
function sourceBlocks(source) {
  let start = 0;
  return source.split('\n').map(value => {
    const block = { start, end: start + Array.from(value).length, text: value };
    start = block.end + 1;
    return block;
  });
}
// Relocation is permitted only inside an identical, unique, complete source block.
export function recoverSpan(oldSource, span, source) {
  if (!validSpan(span, oldSource)) return null;
  if (oldSource === source) return { ...span };
  const oldBlocks = sourceBlocks(oldSource); const newBlocks = sourceBlocks(source);
  const block = oldBlocks.find(b => b.start <= span.start && b.end >= span.end);
  if (!block || oldBlocks.filter(b => b.text === block.text).length !== 1) return null;
  const matches = newBlocks.filter(b => b.text === block.text);
  if (matches.length !== 1) return null;
  const start = matches[0].start + span.start - block.start;
  const recovered = { start, end: start + span.end - span.start, text: span.text };
  return validSpan(recovered, source) ? recovered : null;
}
export function makeChoice({ source, direction, alignments, report, finding, candidate }) {
  return {
    source, direction, source_span: { ...finding.source_span }, scope: scopeOf(alignments, finding.source_span),
    choice: candidate ? 'official_pair' : 'not_a_term',
    candidate: candidate ? { candidate_id: candidate.candidate_id, zh: candidate.zh, en: candidate.en, category: candidate.category } : null,
    basis: basisOf(report),
  };
}
function validBasis(x) {
  if (!object(x)) return false;
  const fields = ['rule_version', 'dictionary'];
  if (Object.hasOwn(x, 'matcher_revision')) fields.push('matcher_revision');
  return keys(x, fields) && x.rule_version === V2 && validDictionary(x.dictionary, V2)
    && (!Object.hasOwn(x, 'matcher_revision') || HEX.test(x.matcher_revision));
}
function validChoice(x) {
  return keys(x, ['source', 'direction', 'source_span', 'scope', 'choice', 'candidate', 'basis'])
    && text(x.source) && direction(x.direction) && validSpan(x.source_span, x.source) && text(x.scope, 20000)
    && validBasis(x.basis)
    && (x.choice === 'not_a_term' ? x.candidate === null : x.choice === 'official_pair'
      && keys(x.candidate, ['candidate_id', 'zh', 'en', 'category']) && HEX.test(x.candidate.candidate_id)
      && text(x.candidate.zh, 2000, false) && text(x.candidate.en, 2000, false) && text(x.candidate.category, 256, false));
}
function validSnapshot(x, limits) {
  const fields = ['source', 'target', 'direction', 'alignments', 'report'];
  if (object(x) && Object.hasOwn(x, 'resolutions')) fields.push('resolutions');
  return keys(x, fields) && text(x.source) && text(x.target)
    && direction(x.direction) && validAlignments(x.alignments, x.source, x.target) && validReport(x.report, x.source, x.target, limits)
    && (!Object.hasOwn(x, 'resolutions') || validSubmittedResolutions(x.resolutions, limits.items));
}
function validSubmittedResolutions(items, max) {
  return Array.isArray(items) && items.length <= max
    && new Set(items.map(item => item?.mention_id)).size === items.length
    && items.every(item => object(item) && text(item.mention_id, 8192, false)
      && (item.choice === 'not_a_term' ? keys(item, ['mention_id', 'choice'])
        : item.choice === 'official_pair' && keys(item, ['mention_id', 'choice', 'candidate_id']) && HEX.test(item.candidate_id)));
}
// Localized UIs render reason codes from lib/messages.ts; the Chinese strings
// stay the canonical data form (result JSON keeps them verbatim).
const MESSAGES = {
  workfile_not_json: '无法读取 JSON 稿件文件。',
  workfile_too_large: '稿件文件超过大小上限（v1/v2 为 1 MiB，v3 为 44 MiB）；请把稿件拆成较小的几份。',
  workfile_too_deep: '稿件文件嵌套过深。',
  workfile_too_many_entries: '稿件文件条目过多；超过 512 段的稿件请拆成几份保存，选择历史过多时请先移除部分记录。',
  workfile_too_many_fields: '稿件文件字段过多。',
  workfile_forbidden_field: '稿件文件含不支持的字段。',
  workfile_unsupported_format: '不支持此稿件格式或版本。请导入“保存稿件”生成的文件。',
  workfile_invalid_content: '稿件内容、选择或位置依据无效；当前稿件未被替换。',
  workfile_duplicate_choices: '稿件包含同一位置的重复选择，未导入。',
  workfile_segment_invalid: '稿件的分段记录无效；当前稿件未被替换。',
  workfile_segment_order: '稿件的分段顺序或位置无效；当前稿件未被替换。',
  workfile_segment_anchor_invalid: '稿件的逐段术语选择位置无效；当前稿件未被替换。',
  workfile_progress_invalid: '稿件的进度记录无效；当前稿件未被替换。',
};
function fail(code) {
  return Object.assign(new Error(MESSAGES[code]), { code });
}
// v1/v2 arrays hold at most 128 items; a v3 file at most 512 (SPEC "Limits"). The other tree caps are the same.
function safeTree(x, maxItems, depth = 0) {
  if (depth > 16) throw fail('workfile_too_deep');
  if (Array.isArray(x)) {
    if (x.length > maxItems) throw fail('workfile_too_many_entries');
    x.forEach(v => safeTree(v, maxItems, depth + 1));
  } else if (object(x)) {
    if (Object.keys(x).length > 32) throw fail('workfile_too_many_fields');
    for (const [key, value] of Object.entries(x)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw fail('workfile_forbidden_field');
      safeTree(value, maxItems, depth + 1);
    }
  }
}
// Whether the UTF-8 encoding is longer than max bytes. A UTF-16 unit takes one to three bytes, which decides most inputs without encoding.
function bytesOver(content, max) {
  if (content.length > max) return true;
  if (content.length * 3 <= max) return false;
  return new TextEncoder().encode(content).length > max;
}
/** Reads a v1, v2, v3 or v4 manuscript (SPEC "Reading"). Throws an Error with a `code`; returns the parsed value. */
export function parseWorkfile(content) {
  if (typeof content !== 'string' || bytesOver(content, MAX_V3_WORKFILE_BYTES)) throw fail('workfile_too_large');
  return readWorkfile(content, true);
}
// `limited` false skips the byte caps; canonicalManuscript uses that to give an over-cap draft its canonical string.
function readWorkfile(content, limited) {
  let x;
  try { x = JSON.parse(content); } catch {
    if (limited && bytesOver(content, MAX_WORKFILE_BYTES)) throw fail('workfile_too_large');
    throw fail('workfile_not_json');
  }
  if (object(x) && x.format === WORKFILE_FORMAT_V3) return readSegmentFile(x, LIMITS);
  if (object(x) && x.format === WORKFILE_FORMAT_V4) return readSegmentFile(x, LIMITS_V4);
  // Every other input is read exactly as the v2 reader did, starting with its 1 MiB check.
  if (limited && bytesOver(content, MAX_WORKFILE_BYTES)) throw fail('workfile_too_large');
  return readV2(x);
}
const V1_KEYS = ['format', 'source', 'target', 'direction', 'alignments', 'choices', 'history'];
const V2_KEYS = [...V1_KEYS, 'semantic_decisions', 'semantic_texts', 'semantic_history'];

function plainSpan(span) {
  return keys(span, ['start', 'end', 'text']) && Number.isSafeInteger(span.start) && Number.isSafeInteger(span.end)
    && span.start >= 0 && span.end > span.start && text(span.text, 2000, false)
    && span.end - span.start === Array.from(span.text).length;
}
function validDecision(x) {
  return keys(x, ['issue_id', 'fingerprint', 'category', 'segment_index', 'source_revision', 'target_revision',
    'source_span', 'target_span', 'decision', 'applied_text', 'basis'])
    && HEX32.test(x.issue_id) && HEX32.test(x.fingerprint) && SEMANTIC_CATEGORIES.includes(x.category)
    && Number.isSafeInteger(x.segment_index) && x.segment_index >= 0
    && HEX.test(x.source_revision) && HEX.test(x.target_revision)
    && (x.source_span === null || plainSpan(x.source_span)) && (x.target_span === null || plainSpan(x.target_span))
    && !(x.source_span === null && x.target_span === null)
    && ['accepted', 'adjusted', 'ignored'].includes(x.decision)
    && (x.decision === 'ignored' ? x.applied_text === null : text(x.applied_text, 2000))
    && keys(x.basis, ['review_version', 'term_basis']) && x.basis.review_version === SEMANTIC_REVIEW_VERSION
    && keys(x.basis.term_basis, ['dictionary_revision', 'matcher_revision'])
    && HEX.test(x.basis.term_basis.dictionary_revision) && HEX.test(x.basis.term_basis.matcher_revision);
}
function occurrenceKey(d) {
  const range = s => (s === null ? null : [s.start, s.end]);
  return JSON.stringify([d.category, d.source_revision, d.target_revision, range(d.source_span), range(d.target_span)]);
}
function validSemanticText(x, textMax) {
  return keys(x, ['revision', 'text']) && HEX.test(x.revision) && text(x.text, textMax);
}
function validRange(item, prefix, length) {
  const a = item[`${prefix}_start`]; const b = item[`${prefix}_end`];
  return Number.isSafeInteger(a) && Number.isSafeInteger(b) && a >= 0 && a <= b && b <= length;
}
function validHistorySnapshot(x, textMax) {
  if (!keys(x, ['source', 'target', 'direction', 'segments']) || !text(x.source, textMax)
    || !text(x.target, textMax) || !direction(x.direction) || !Array.isArray(x.segments) || x.segments.length > 64) return false;
  const source = Array.from(x.source); const target = Array.from(x.target);
  return x.segments.every(item => keys(item, ['segment_index', 'source_start', 'source_end', 'target_start', 'target_end', 'report'])
    && Number.isSafeInteger(item.segment_index) && item.segment_index >= 0
    && validRange(item, 'source', source.length) && validRange(item, 'target', target.length)
    && validSemanticReviewResponse(item.report, source.slice(item.source_start, item.source_end).join(''),
      target.slice(item.target_start, item.target_end).join('')));
}
function validSemantic(x, textMax) {
  const decisions = x.semantic_decisions; const texts = x.semantic_texts; const history = x.semantic_history;
  if (!Array.isArray(decisions) || decisions.length > MAX_SEMANTIC_DECISIONS || !decisions.every(validDecision)
    || !Array.isArray(texts) || texts.length > MAX_SEMANTIC_TEXTS || !texts.every(t => validSemanticText(t, textMax))
    || !Array.isArray(history) || history.length > MAX_SEMANTIC_HISTORY || !history.every(h => validHistorySnapshot(h, textMax))) return false;
  return new Set(texts.map(t => t.revision)).size === texts.length;
}

// The v1 and v2 parts. Their text limit follows the file size: 1 Mi scalars in a v1/v2 file, 44 Mi in a v3 file.
function checkV1V2Part(x, v2, textMax, limits) {
  if (!text(x.source, textMax) || !text(x.target, textMax) || !direction(x.direction) || !validAlignments(x.alignments, x.source, x.target)
    || !Array.isArray(x.choices) || x.choices.length > limits.items || !x.choices.every(validChoice)
    || !Array.isArray(x.history) || x.history.length > MAX_HISTORY || !x.history.every(h => validSnapshot(h, limits))
    || (v2 && !validSemantic(x, textMax))) {
    throw fail('workfile_invalid_content');
  }
  const recoveredIds = x.choices.map(c => recoverSpan(c.source, c.source_span, x.source)).filter(Boolean).map(mentionId);
  const originalIds = x.choices.map(c => JSON.stringify([c.source, c.direction, mentionId(c.source_span)]));
  const semanticKeys = v2 ? x.semantic_decisions.map(occurrenceKey) : [];
  if (new Set(recoveredIds).size !== recoveredIds.length || new Set(originalIds).size !== originalIds.length
    || new Set(semanticKeys).size !== semanticKeys.length) throw fail('workfile_duplicate_choices');
}

function readV2(x) {
  safeTree(x, 128);
  const v2 = object(x) && x.format === WORKFILE_FORMAT_V2;
  if (!keys(x, v2 ? V2_KEYS : V1_KEYS) || (!v2 && x.format !== WORKFILE_FORMAT)) throw fail('workfile_unsupported_format');
  // Saving work is independent of the per-request review limit. The complete
  // file remains bounded by MAX_WORKFILE_BYTES, including long translations.
  checkV1V2Part(x, v2, MAX_WORKFILE_BYTES, LIMITS);
  // No runtime trust or active flags come from the file.
  return x;
}

// ---- v3: segment records, segment choice history and progress (SPEC "Reading", steps 3 to 10) ----

const V3_KEYS = [...V2_KEYS, 'segments', 'segment_choice_history', 'progress'];
const RECORD_KEYS = ['index', 'segmentation_version', 'source_start', 'source_end', 'target_start', 'target_end', 'source_hash', 'target_hash',
  'status', 'direction', 'alignment_input', 'basis', 'result', 'choices'];
const RESULT_KEYS = ['truncated', 'evaluated', 'not_evaluated', 'findings'];
const FINDING_KEYS = ['verdict', 'source', 'target', 'candidates', 'candidates_truncated'];
const CHOICE_KEYS = ['source_span', 'choice', 'candidate', 'offered', 'confirmed'];
const HISTORY_KEYS = ['source_hash', 'source_span', 'choice', 'candidate', 'offered'];
const REASON_KEYS = [...FINDING_KEYS, 'reason'];
const MAX_CANDIDATES = 8;
const MAX_CORE_SCALARS = 2000;

// v3 code is stricter than the v2 helpers above: a hash is a real string (HEX.test would accept a one-item array) and nothing is null.
const hex = x => typeof x === 'string' && HEX.test(x);
const int = x => Number.isSafeInteger(x);
const invalid = () => fail('workfile_segment_invalid');
const tooMany = () => fail('workfile_too_many_entries');

function validV3Basis(b) {
  return keys(b, ['rule_version', 'dictionary', 'matcher_revision']) && b.rule_version === V2
    && keys(b.dictionary, ['schema_version', 'source_commit', 'term_count', 'revision'])
    && text(b.dictionary.schema_version, 4096, false) && text(b.dictionary.source_commit, 4096, false)
    && int(b.dictionary.term_count) && b.dictionary.term_count >= 0 && hex(b.dictionary.revision) && hex(b.matcher_revision);
}
const pairShape = x => Array.isArray(x) && x.length === 2 && int(x[0]) && int(x[1]) && x[0] >= 0 && x[0] < x[1];
const candidateShape = k => keys(k, ['candidate_id', 'zh', 'en', 'category']) && hex(k.candidate_id)
  && text(k.zh, 2000, false) && text(k.en, 2000, false) && text(k.category, 256, false);

function checkResultShape(result, limits) {
  if (!keys(result, RESULT_KEYS) || typeof result.truncated !== 'boolean' || !int(result.evaluated) || result.evaluated < 0
    || !int(result.not_evaluated) || result.not_evaluated < 0 || !Array.isArray(result.findings)) throw invalid();
  if (result.findings.length > limits.items) throw tooMany();
  for (const f of result.findings) {
    // `reason` only on not_evaluated with a known reason, and only where the limits allow it (v4); any other `reason` is an extra key.
    const fields = limits.reason && object(f) && Object.hasOwn(f, 'reason') && f.verdict === 'not_evaluated' && REASON_VALUES.includes(f.reason) ? REASON_KEYS : FINDING_KEYS;
    if (!keys(f, fields) || !VERDICTS.includes(f.verdict) || !pairShape(f.source) || (f.target !== null && !pairShape(f.target))
      || typeof f.candidates_truncated !== 'boolean' || !Array.isArray(f.candidates)) throw invalid();
    if (f.candidates.length > MAX_CANDIDATES) throw tooMany();
    if (!f.candidates.every(candidateShape) || new Set(f.candidates.map(k => k.candidate_id)).size !== f.candidates.length) throw invalid();
  }
}

// Structure of a record choice (step 6) or a history choice (step 9, `history`).
function checkChoiceShape(c, history) {
  if (!keys(c, history ? HISTORY_KEYS : CHOICE_KEYS) || (history && !hex(c.source_hash)) || !plainSpan(c.source_span)) throw invalid();
  if (c.choice === 'official_pair') {
    if (!candidateShape(c.candidate)) throw invalid();
  } else if (c.choice !== 'not_a_term' || c.candidate !== null) throw invalid();
  if (!Array.isArray(c.offered)) throw invalid();
  if (c.offered.length > MAX_CANDIDATES) throw tooMany();
  const ascending = c.offered.every((id, i) => hex(id) && (i === 0 || c.offered[i - 1] < id));
  if (c.choice === 'official_pair' ? c.offered.length !== 0 : !ascending) throw invalid();
  if (!history && typeof c.confirmed !== 'boolean') throw invalid();
}

function checkRecordShape(r, sourceLength, targetLength, limits) {
  if (!keys(r, RECORD_KEYS)) throw invalid();
  const range = (a, b, length) => int(a) && int(b) && a >= 0 && a <= b && b <= length;
  if (!int(r.index) || r.segmentation_version !== 'segmentation-v1' || !range(r.source_start, r.source_end, sourceLength)
    || !range(r.target_start, r.target_end, targetLength) || !hex(r.source_hash) || !hex(r.target_hash)
    || !['pending', 'done', 'stale'].includes(r.status)) throw invalid();
  // direction, alignment_input, basis and result are null exactly when the record is pending.
  const live = r.status !== 'pending';
  if (['direction', 'alignment_input', 'basis', 'result'].some(k => (r[k] === null) === live)) throw invalid();
  if (live && (!direction(r.direction) || !(r.alignment_input === 'automatic' || hex(r.alignment_input)))) throw invalid();
  if (r.basis !== null && !validV3Basis(r.basis)) throw invalid();
  if (r.result !== null) checkResultShape(r.result, limits);
  if (!Array.isArray(r.choices)) throw invalid();
  if (r.choices.length > limits.items) throw tooMany();
  r.choices.forEach(c => checkChoiceShape(c, false));
  if (r.status === 'pending' && r.choices.some(c => c.confirmed)) throw invalid();
}

// Scalar-indexed reads of a text. Array.from only when the text has surrogates; the common case slices the string itself.
function scalarView(value) {
  if (!/[\uD800-\uDFFF]/.test(value)) return { length: value.length, slice: (a, b) => value.slice(a, b) };
  const scalars = Array.from(value);
  return { length: scalars.length, slice: (a, b) => scalars.slice(a, b).join('') };
}

function checkRecordContent(r, source) {
  const sourceLength = r.source_end - r.source_start;
  const targetLength = r.target_end - r.target_start;
  const live = r.status !== 'pending';
  if (live) {
    const inRange = length => length >= 1 && length <= MAX_CORE_SCALARS;
    if (!inRange(sourceLength) || !inRange(targetLength)) throw invalid();
    const sources = new Set();
    for (const f of r.result.findings) {
      if (f.source[1] > sourceLength || (f.target !== null && f.target[1] > targetLength) || sources.has(f.source.join(':'))) throw invalid();
      sources.add(f.source.join(':'));
    }
  }
  const anchor = () => fail('workfile_segment_anchor_invalid');
  for (const c of r.choices) {
    const { start, end, text: surface } = c.source_span;
    if (end > sourceLength || source.slice(r.source_start + start, r.source_start + end) !== surface) throw anchor();
    if (!live || !c.confirmed) continue;
    const finding = r.result.findings.find(f => f.source[0] === start && f.source[1] === end);
    if (!finding) throw anchor();
    if (c.choice === 'official_pair') {
      if (!finding.candidates.some(k => k.candidate_id === c.candidate.candidate_id && k.zh === c.candidate.zh && k.en === c.candidate.en
        && k.category === c.candidate.category)) throw anchor();
    } else {
      const ids = finding.candidates.map(k => k.candidate_id).sort();
      if (ids.length !== c.offered.length || ids.some((id, i) => id !== c.offered[i])) throw anchor();
    }
  }
  if (new Set(r.choices.map(c => `${c.source_span.start}:${c.source_span.end}`)).size !== r.choices.length) throw fail('workfile_duplicate_choices');
}

// The v3 and v4 reader (SPEC "Reading", steps 3 to 10): the two formats differ only in the limits.
function readSegmentFile(x, limits) {
  safeTree(x, MAX_SEGMENTS);
  if (!keys(x, V3_KEYS)) throw fail('workfile_unsupported_format');
  // Step 5: the v1 and v2 parts keep the v2 array cap of 128 items (workfile_too_many_entries, as in a v2 file) before their content checks.
  for (const key of V2_KEYS) if (key !== 'format') safeTree(x[key], 128, 1);
  checkV1V2Part(x, true, MAX_V3_WORKFILE_BYTES, limits);
  if (!Array.isArray(x.segments)) throw invalid();
  const source = scalarView(x.source);
  const target = scalarView(x.target);
  x.segments.forEach(r => checkRecordShape(r, source.length, target.length, limits));
  x.segments.forEach((r, i) => {
    const previous = x.segments[i - 1];
    if (r.index !== i || (previous && (r.source_start < previous.source_end || r.target_start < previous.target_end))) throw fail('workfile_segment_order');
  });
  x.segments.forEach(r => checkRecordContent(r, source));
  if (!Array.isArray(x.segment_choice_history)) throw invalid();
  if (x.segment_choice_history.length > MAX_SEGMENT_HISTORY) throw tooMany();
  x.segment_choice_history.forEach(c => checkChoiceShape(c, true));
  const p = x.progress;
  const bad = () => fail('workfile_progress_invalid');
  if (!keys(p, ['current', 'completed'])) throw bad();
  if (p.current !== null && !(int(p.current) && p.current >= 0 && p.current < x.segments.length)) throw bad();
  if (!Array.isArray(p.completed) || !p.completed.every((n, i) => int(n) && (i === 0 || p.completed[i - 1] < n) && ['done', 'stale'].includes(x.segments[n]?.status))) throw bad();
  // No runtime trust comes from the file: parsing computes no hashes and sends nothing (SPEC "Reading", end).
  return x;
}

/** Semantic parts of a parsed manuscript; empty for v1. */
export function semanticPartsOf(parsed) {
  return {
    semantic_decisions: parsed?.semantic_decisions ?? [],
    semantic_texts: parsed?.semantic_texts ?? [],
    semantic_history: parsed?.semantic_history ?? [],
  };
}
function hasSemantic(payload) {
  return (payload.semantic_decisions?.length ?? 0) > 0 || (payload.semantic_history?.length ?? 0) > 0;
}
function prettyManuscript({ source, target, direction, alignments, choices, history }) {
  return JSON.stringify({ format: WORKFILE_FORMAT, source, target, direction, alignments, choices, history: history.slice(-MAX_HISTORY) }, null, 2);
}
function prettyV2(payload, semanticHistory) {
  const decisions = payload.semantic_decisions ?? [];
  const needed = new Set(decisions.filter(d => d.decision === 'ignored').flatMap(d => [d.source_revision, d.target_revision]));
  const seen = new Set();
  const texts = (payload.semantic_texts ?? []).filter(t => needed.has(t.revision) && !seen.has(t.revision) && seen.add(t.revision));
  const { source, target, direction, alignments, choices, history } = payload;
  return JSON.stringify({ format: WORKFILE_FORMAT_V2, source, target, direction, alignments, choices, history: history.slice(-MAX_HISTORY),
    semantic_decisions: decisions, semantic_texts: texts, semantic_history: semanticHistory }, null, 2);
}
// Semantic decisions are user work and are never trimmed; history is untrusted
// reference data and goes oldest-first until the file fits.
function writeV1V2(payload) {
  if (!hasSemantic(payload)) return prettyManuscript(payload);
  const history = (payload.semantic_history ?? []).slice(-MAX_SEMANTIC_HISTORY);
  let content = prettyV2(payload, history);
  while (history.length > 0 && bytesOver(content, MAX_WORKFILE_BYTES)) {
    history.shift();
    content = prettyV2(payload, history);
  }
  return content;
}

// The v3 parts are rebuilt from these whitelists in the SPEC key order, so neither the input key order nor a caller's runtime fields
// (a cached report, bookkeeping) reach the file.
const orderSpan = s => ({ start: s.start, end: s.end, text: s.text });
const orderBasis = b => ({
  rule_version: b.rule_version,
  dictionary: { schema_version: b.dictionary.schema_version, source_commit: b.dictionary.source_commit, term_count: b.dictionary.term_count, revision: b.dictionary.revision },
  matcher_revision: b.matcher_revision,
});
const orderCandidate = c => (c === null ? null : { candidate_id: c.candidate_id, zh: c.zh, en: c.en, category: c.category });
const orderChoice = c => ({
  source_span: orderSpan(c.source_span), choice: c.choice, candidate: orderCandidate(c.candidate), offered: [...c.offered], confirmed: c.confirmed,
});
const orderHistoryEntry = c => ({
  source_hash: c.source_hash, source_span: orderSpan(c.source_span), choice: c.choice, candidate: orderCandidate(c.candidate), offered: [...c.offered],
});
const orderFinding = f => ({
  verdict: f.verdict, source: [...f.source], target: f.target === null ? null : [...f.target], candidates: f.candidates.map(orderCandidate),
  candidates_truncated: f.candidates_truncated,
  // Last, and only where the finding has one: the writer picks v4 for any finding that does (see writeWorkfile).
  ...(Object.hasOwn(f, 'reason') ? { reason: f.reason } : {}),
});
const orderResult = r => ({ truncated: r.truncated, evaluated: r.evaluated, not_evaluated: r.not_evaluated, findings: r.findings.map(orderFinding) });
const orderRecord = r => ({
  index: r.index, segmentation_version: r.segmentation_version, source_start: r.source_start, source_end: r.source_end,
  target_start: r.target_start, target_end: r.target_end, source_hash: r.source_hash, target_hash: r.target_hash, status: r.status,
  direction: r.direction, alignment_input: r.alignment_input, basis: r.basis === null ? null : orderBasis(r.basis),
  result: r.result === null ? null : orderResult(r.result), choices: r.choices.map(orderChoice),
});

// Canonical v3 or v4 bytes (`format` says which): minified JSON, no trailing newline. Only semantic_history is ever dropped (oldest
// first), and only while over the cap.
function writeSegmentFile(payload, format) {
  const decisions = payload.semantic_decisions ?? [];
  const needed = new Set(decisions.filter(d => d.decision === 'ignored').flatMap(d => [d.source_revision, d.target_revision]));
  const seen = new Set();
  const texts = (payload.semantic_texts ?? []).filter(t => needed.has(t.revision) && !seen.has(t.revision) && seen.add(t.revision));
  const history = (payload.semantic_history ?? []).slice(-MAX_SEMANTIC_HISTORY);
  let segments; let historyChoices; let progress;
  try {
    segments = (payload.segments ?? []).map(orderRecord);
    historyChoices = (payload.segment_choice_history ?? []).map(orderHistoryEntry);
    const given = payload.progress ?? { current: null, completed: [] };
    progress = { current: given.current, completed: [...given.completed] };
  } catch { throw fail('workfile_segment_invalid'); } // a record that is not even shaped like one
  const write = () => JSON.stringify({
    format, source: payload.source, target: payload.target, direction: payload.direction, alignments: payload.alignments,
    choices: payload.choices, history: payload.history.slice(-MAX_HISTORY), semantic_decisions: decisions, semantic_texts: texts, semantic_history: history,
    segments, segment_choice_history: historyChoices, progress,
  });
  let content = write();
  while (history.length > 0 && bytesOver(content, MAX_V3_WORKFILE_BYTES)) {
    history.shift();
    content = write();
  }
  return content;
}

// Whether the document-mode parts fit the v1-v3 limits: at most 32 choices, resolutions and findings per list, and no finding `reason`.
// Only the history that is written (the last two reports) counts.
function documentFitsV3(payload) {
  try {
    return (payload.choices?.length ?? 0) <= MAX_CHOICES
      && (payload.history ?? []).slice(-MAX_HISTORY).every(h => (h.resolutions?.length ?? 0) <= MAX_CHOICES && h.report.findings.length <= MAX_CHOICES
        && h.report.findings.every(f => !Object.hasOwn(f, 'reason')));
  } catch { return true; } // not shaped like a report: the reader rejects it with its own code
}
// A segment record that does not fit v3 is not decided here: the writer's own shape checks fail it as workfile_segment_invalid.
function segmentsFitV3(payload) {
  try {
    return (payload.segments ?? []).every(r => r.choices.length <= MAX_CHOICES
      && (r.result === null || (r.result.findings.length <= MAX_CHOICES && r.result.findings.every(f => !Object.hasOwn(f, 'reason')))));
  } catch { return true; }
}
// The lowest format that holds the payload (SPEC "Writing", contracts/manuscript-v4/SPEC.md): the v1/v2 bytes when there is no segment
// state, nothing over the v1-v3 limits and they fit 1 MiB; else v3 when nothing is over the v1-v3 limits; else v4.
function writeWorkfile(payload) {
  const fitsV3 = documentFitsV3(payload) && segmentsFitV3(payload);
  if (fitsV3 && (payload.segments?.length ?? 0) === 0 && (payload.segment_choice_history?.length ?? 0) === 0) {
    const content = writeV1V2(payload);
    if (!bytesOver(content, MAX_WORKFILE_BYTES)) return content;
  }
  return writeSegmentFile(payload, fitsV3 ? WORKFILE_FORMAT_V3 : WORKFILE_FORMAT_V4);
}
/** The manuscript file for a payload: v1/v2 fields plus optional `segments`, `segment_choice_history` and `progress`. Throws workfile_too_large over the cap. */
export function serializeWorkfile(payload) {
  const content = writeWorkfile(payload);
  parseWorkfile(content);
  return content;
}

/** The string serializeWorkfile writes for a valid manuscript. Save still rejects a string over the size cap;
 *  this returns that string so an imported file can stay the restore baseline. */
export function canonicalManuscript(payload) {
  try {
    const content = writeWorkfile(payload);
    readWorkfile(content, false);
    return content;
  } catch { return null; }
}

export function recoverableWorkPresent({ source, target, choices, alignments, reports }) {
  return source.length > 0 || target.length > 0 || choices.length > 0 || alignments !== null || reports.length > 0;
}

export function manuscriptSaveView({ holdsWork, canonical, importedCanonical, downloadedCanonical }) {
  if (!holdsWork) return 'empty';
  if (canonical == null) return 'not-serializable';
  if (importedCanonical != null && canonical === importedCanonical) return 'matches-import';
  if (downloadedCanonical != null && canonical === downloadedCanonical) return 'matches-download';
  if (importedCanonical != null || downloadedCanonical != null) return 'diverged';
  return 'page-only';
}

/** A matching download does not turn this off: the page never saw the file reach disk. */
export function leaveGuardActive({ view, checkInFlight = false }) {
  if (checkInFlight) return true;
  return view === 'page-only' || view === 'matches-download' || view === 'diverged' || view === 'not-serializable';
}

/** A fresh report can recover intent; only a later request can check that decision. */
export function reconcileChoice(choice, draft, fresh, imported = false) {
  const span = recoverSpan(choice.source, choice.source_span, draft.source);
  const pending = (reason, code) => ({ status: 'pending', reason, code, span, resolution: null });
  if (choice.direction !== draft.direction) return pending('翻译方向已变化，请重新选择', 'direction_changed');
  if (!span) return pending('原文段落已改变、删除或重复，不能迁移位置', 'source_block_changed');
  if (choice.scope !== scopeOf(draft.alignments, span)) return pending('分段对应已变化，请重新确认', 'scope_changed');
  if (!fresh || fresh.source !== draft.source || fresh.direction !== draft.direction || !fresh.trusted) return pending('等待当前原文的新依据', 'awaiting_fresh_basis');
  if (!sameBasis(choice.basis, basisOf(fresh.report))) return pending('词典或规则依据已变化，请重新确认', 'basis_changed');
  const finding = fresh.report.findings.find(f => f.id === mentionId(span));
  if (!finding || fresh.report.truncated) return pending('本次发现缺失或报告截断，请重新确认', 'finding_missing_or_truncated');
  if (choice.choice === 'not_a_term') {
    if (imported) return pending('文件中的“不是术语”是历史决定，请重新确认', 'imported_not_a_term');
    return { status: 'applicable', reason: '用户决定；此处不评估术语', code: 'user_not_a_term', span, resolution: { mention_id: finding.id, choice: 'not_a_term' } };
  }
  const candidate = finding.candidates.find(c => c.candidate_id === choice.candidate.candidate_id
    && c.zh === choice.candidate.zh && c.en === choice.candidate.en && c.category === choice.candidate.category);
  if (!candidate) return pending('原词对或其来源已不在当前候选中', 'candidate_gone');
  return { status: 'applicable', reason: finding.candidates_truncated ? '展示来源不完整；具体词对身份与当前依据一致，提交时由服务端复核' : '位置与当前官方候选依据一致',
    code: finding.candidates_truncated ? 'candidate_partial_visible' : 'position_basis_match', span,
    resolution: { mention_id: finding.id, choice: 'official_pair', candidate_id: candidate.candidate_id } };
}

/** @returns {Array<ReturnType<typeof reconcileChoice>>} */
export function reconcileChoices(choices, draft, fresh, importedChoices = []) {
  const results = choices.map(c => reconcileChoice(c, draft, fresh, importedChoices.includes(c)));
  const counts = new Map();
  for (const result of results) if (result.span) counts.set(mentionId(result.span), (counts.get(mentionId(result.span)) ?? 0) + 1);
  return results.map(result => result.span && counts.get(mentionId(result.span)) > 1
    ? { ...result, status: 'pending', reason: '多份历史选择汇聚到同一位置，请移除冲突记录后重新选择', code: 'duplicate_position', resolution: null } : result);
}

function positionalSourceRegion(snapshot, span) {
  const ranges = [];
  const chars = Array.from(snapshot.source);
  let start = 0;
  for (let i = 0; i < chars.length; i++) {
    const decimal = chars[i] === '.' && /[0-9]/u.test(chars[i - 1] ?? '') && /[0-9]/u.test(chars[i + 1] ?? '');
    if (!decimal && /[。．.！？!?\n]/u.test(chars[i])) {
      const region = chars.slice(start, i + 1).join('');
      if (/[^。．.！？!?\n\s]/u.test(region)) ranges.push({ start, end: i + 1, text: region });
      start = i + 1;
    }
  }
  if (start < chars.length) ranges.push({ start, end: chars.length, text: chars.slice(start).join('') });
  return ranges.find(r => r.start <= span.start && r.end >= span.end)?.text ?? null;
}

function comparableScope(previous, beforeSpan, current, span) {
  if (previous.alignments === null && current.alignments === null) {
    const before = positionalSourceRegion(previous, beforeSpan);
    return before !== null && before === positionalSourceRegion(current, span);
  }
  return scopeOf(previous.alignments, beforeSpan) === scopeOf(current.alignments, span);
}

function submittedDecision(snapshot, finding) {
  if (!Array.isArray(snapshot.resolutions)) return { descriptor: null, candidate: null };
  const item = snapshot.resolutions.find(r => r.mention_id === finding.id);
  if (!item) return { descriptor: 'automatic', candidate: null };
  return {
    descriptor: JSON.stringify([item.choice, item.candidate_id ?? null]),
    candidate: item.choice === 'official_pair' ? finding.candidates.find(c => c.candidate_id === item.candidate_id) ?? null : null,
  };
}

export function compareReports(previous, current) {
  const result = { new: [], resolved: [], pending: [], incomparable: [] };
  if (!previous) return result;
  const oldFindings = previous.report.findings;
  const newFindings = current.report.findings;
  const compatible = previous.trusted && current.trusted && previous.direction === current.direction
    && sameBasis(basisOf(previous.report), basisOf(current.report)) && !previous.report.truncated && !current.report.truncated;
  const seen = new Set();
  for (const before of oldFindings) {
    const span = recoverSpan(previous.source, before.source_span, current.source);
    const after = span && newFindings.find(f => f.id === mentionId(span) && f.rule_id === before.rule_id);
    const scopesMatch = span && comparableScope(previous, before.source_span, current, span);
    const oldDecision = submittedDecision(previous, before);
    const newDecision = after ? submittedDecision(current, after) : { descriptor: null, candidate: null };
    const decisionsMatch = oldDecision.descriptor !== null && oldDecision.descriptor === newDecision.descriptor;
    const sameExplicitCandidate = decisionsMatch && oldDecision.candidate && newDecision.candidate
      && oldDecision.candidate.candidate_id === newDecision.candidate.candidate_id
      && oldDecision.candidate.zh === newDecision.candidate.zh && oldDecision.candidate.en === newDecision.candidate.en
      && oldDecision.candidate.category === newDecision.candidate.category;
    if (after) seen.add(after.id);
    const mention = { text: before.source_span.text, start: (span ?? before.source_span).start, historical: !span };
    const label = `${before.source_span.text}（${span ? '原文' : '历史原文'} ${(span ?? before.source_span).start + 1}）`;
    if (!compatible || !after || !scopesMatch || !decisionsMatch
      || ((before.candidates_truncated || after.candidates_truncated) && !sameExplicitCandidate)
      || before.verdict === 'not_evaluated' || after.verdict === 'not_evaluated') {
      result.incomparable.push({ label, mention, reason: !previous.trusted ? '导入的历史报告未经本次验证'
        : !decisionsMatch ? '前后选择不同或选择记录未知，不能视为同一约束已解决' : '位置、依据、覆盖或对应范围不可比；消失不代表解决',
        code: !previous.trusted ? 'imported_history_unverified' : !decisionsMatch ? 'decision_changed_or_unknown' : 'scope_position_incomparable' });
    } else if (['needs_review', 'confirmed_conflict'].includes(before.verdict) && after.verdict === 'verified_constraint') {
      result.resolved.push({ label, mention, reason: '同一可比位置的新检查确认术语约束已满足，未评估句意', code: 'resolved_same_constraint' });
    } else if (['needs_review', 'confirmed_conflict'].includes(after.verdict)) {
      result.pending.push({ label, mention, reason: '本次仍需人工核对', code: 'still_needs_review' });
    }
  }
  for (const finding of newFindings) {
    if (!seen.has(finding.id)) result.new.push({ label: `${finding.source_span.text}（原文 ${finding.source_span.start + 1}）`,
      mention: { text: finding.source_span.text, start: finding.source_span.start, historical: false },
      reason: '本次发现；没有可比的旧位置', code: 'new_finding' });
  }
  return result;
}
