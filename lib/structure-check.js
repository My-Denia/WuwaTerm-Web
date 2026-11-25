// @ts-check
// structure-check-v1 (Core ADR 0022, `POST /v1/structure-checks`): the wire rules the Web BFF enforces, and the pure Layer 1 helpers
// the workbench uses: request batching, whole-text placement of findings and the rule by which a Layer 1 finding takes precedence
// over a semantic (Layer 2) issue that describes the same break. Browser-safe; every length is in Unicode scalars, as Core counts.
// Nothing here is stored: structure findings never enter a manuscript file (ADR 0022 "Deterministic and stateless").

export const CAPABILITY_STRUCTURE_CHECK = 'structure-check-v1';
export const STRUCTURE_CHECK_VERSION = 'structure-check-v1';
/** Every rule_id Core can return, in Core's order (findings are sorted by rule, then by offset). */
export const STRUCTURE_RULES = Object.freeze(/** @type {const} */ ([
  'empty_target', 'paragraph_count_mismatch', 'line_count_mismatch', 'placeholder_missing', 'placeholder_unexpected',
  'tag_unbalanced', 'number_missing', 'number_unexpected',
]));
/** The checks a response lists as run. */
export const STRUCTURE_CHECKS = Object.freeze(/** @type {const} */ (['empty_target', 'numbers', 'placeholders', 'paragraphs']));
export const STRUCTURE_LIMITS = Object.freeze({
  segments: 64,
  side: 2000,
  total: 20_000,
  findings: 16,
  // Core's body limit is 64 KiB; a client batch stays under 60 KiB so the BFF's own 64 KiB cap is never the one that answers.
  batchBytes: 61_440,
  requestBytes: 65_536,
  // 1,024 findings measured 124 KB (ADR 0022); every other endpoint keeps the 64 KiB upstream bound.
  responseBytes: 262_144,
});

/** Every wire object's key set, named as Core's OpenAPI names it; the contract suite compares them with the pinned Core. */
export const STRUCTURE_WIRE_KEYS = Object.freeze({
  StructureCheckRequestBody: Object.freeze(['check_version', 'segments']),
  StructureCheckSegmentBody: Object.freeze(['segment_id', 'source', 'target']),
  StructureCheckResponseBody: Object.freeze(['request_id', 'check_version', 'checks', 'segments']),
  StructureSegmentResultBody: Object.freeze(['index', 'segment_id', 'findings', 'omitted_findings', 'layout']),
  StructureFindingBody: Object.freeze(['rule_id', 'source_span', 'target_span']),
  StructureLayoutBody: Object.freeze(['source_paragraphs', 'target_paragraphs', 'source_lines', 'target_lines']),
  StructureSpanBody: Object.freeze(['start', 'end', 'text']),
});
const K = STRUCTURE_WIRE_KEYS;
const SEGMENT_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const ISOLATED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;

/** @param {unknown} x @returns {x is Record<string, any>} */
const plain = x => !!x && typeof x === 'object' && !Array.isArray(x);
/** @param {Record<string, unknown>} x @param {readonly string[]} keys */
const exactKeys = (x, keys) => Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
/** @param {unknown} x @returns {x is number} */
const count = x => Number.isSafeInteger(x) && /** @type {number} */ (x) >= 0;
/** @param {string} text */
const scalarCount = text => Array.from(text).length;

/**
 * A request the BFF forwards: exactly `check_version` and `segments`; 1 to 64 segments of `source`, `target` and an optional
 * `segment_id` (unique, `^[A-Za-z0-9._:-]{1,128}$`, or null); each side at most 2,000 scalars and 20,000 across the request, with
 * no isolated surrogate. Core gives the same answers (400 or 422); the BFF refuses first so no malformed request costs quota.
 * @param {unknown} value
 * @returns {boolean}
 */
export function validStructureCheckRequest(value) {
  if (!plain(value) || !exactKeys(value, K.StructureCheckRequestBody) || value.check_version !== STRUCTURE_CHECK_VERSION) return false;
  const segments = value.segments;
  if (!Array.isArray(segments) || segments.length < 1 || segments.length > STRUCTURE_LIMITS.segments) return false;
  const ids = new Set();
  let total = 0;
  for (const segment of segments) {
    if (!plain(segment)) return false;
    const keys = Object.hasOwn(segment, 'segment_id') ? K.StructureCheckSegmentBody : ['source', 'target'];
    if (!exactKeys(segment, keys)) return false;
    for (const side of [segment.source, segment.target]) {
      if (typeof side !== 'string' || ISOLATED_SURROGATE.test(side)) return false;
      const length = scalarCount(side);
      if (length > STRUCTURE_LIMITS.side) return false;
      total += length;
    }
    const id = segment.segment_id;
    if (id !== undefined && id !== null) {
      if (typeof id !== 'string' || !SEGMENT_ID.test(id) || ids.has(id)) return false;
      ids.add(id);
    }
  }
  return total <= STRUCTURE_LIMITS.total;
}

/** @param {unknown} span @param {readonly string[]} side @returns {boolean} */
function validSpan(span, side) {
  if (span === null) return true;
  return plain(span) && exactKeys(span, K.StructureSpanBody) && count(span.start) && count(span.end)
    && span.start < span.end && span.end <= side.length && typeof span.text === 'string'
    && side.slice(span.start, span.end).join('') === span.text;
}

/**
 * The response of Core for `input`, strictly: the four top-level keys, the checks it ran (known names, no repeats), and one segment
 * per request segment in request order with its index, its echoed segment_id (or null), at most 16 findings of a known rule whose
 * spans are the exact text of the submitted side, `omitted_findings` and the four layout counts.
 * @param {unknown} body
 * @param {{segments: Array<{source: string, target: string, segment_id?: string | null}>}} input
 * @returns {boolean}
 */
export function validStructureCheckResponse(body, input) {
  if (!plain(body) || !exactKeys(body, K.StructureCheckResponseBody)) return false;
  if (typeof body.request_id !== 'string' || !body.request_id.trim() || body.request_id.length > 256 || CONTROL.test(body.request_id)) return false;
  if (body.check_version !== STRUCTURE_CHECK_VERSION || !Array.isArray(body.checks) || new Set(body.checks).size !== body.checks.length
    || !body.checks.every(name => /** @type {readonly unknown[]} */ (STRUCTURE_CHECKS).includes(name))) return false;
  if (!Array.isArray(body.segments) || body.segments.length !== input.segments.length) return false;
  return body.segments.every((segment, index) => {
    const sent = input.segments[index];
    if (!plain(segment) || !exactKeys(segment, K.StructureSegmentResultBody)) return false;
    if (segment.index !== index || segment.segment_id !== (sent.segment_id ?? null) || !count(segment.omitted_findings)) return false;
    const layout = segment.layout;
    if (!plain(layout) || !exactKeys(layout, K.StructureLayoutBody)
      || ![layout.source_paragraphs, layout.target_paragraphs, layout.source_lines, layout.target_lines].every(count)) return false;
    if (!Array.isArray(segment.findings) || segment.findings.length > STRUCTURE_LIMITS.findings) return false;
    const source = Array.from(sent.source);
    const target = Array.from(sent.target);
    return segment.findings.every(finding => plain(finding) && exactKeys(finding, K.StructureFindingBody)
      && /** @type {readonly unknown[]} */ (STRUCTURE_RULES).includes(finding.rule_id)
      && validSpan(finding.source_span, source) && validSpan(finding.target_span, target));
  });
}

/** @param {Record<string, any> | null} span */
const copySpan = span => (span === null ? null : { start: span.start, end: span.end, text: span.text });

/**
 * The validated response rebuilt from whitelists, so no key the validator did not read reaches the browser.
 * @param {Record<string, any>} body
 */
export function projectStructureCheckResponse(body) {
  return {
    request_id: body.request_id,
    check_version: body.check_version,
    checks: [...body.checks],
    segments: body.segments.map((/** @type {Record<string, any>} */ segment) => ({
      index: segment.index,
      segment_id: segment.segment_id,
      findings: segment.findings.map((/** @type {Record<string, any>} */ f) => ({ rule_id: f.rule_id, source_span: copySpan(f.source_span), target_span: copySpan(f.target_span) })),
      omitted_findings: segment.omitted_findings,
      layout: {
        source_paragraphs: segment.layout.source_paragraphs,
        target_paragraphs: segment.layout.target_paragraphs,
        source_lines: segment.layout.source_lines,
        target_lines: segment.layout.target_lines,
      },
    })),
  };
}

/**
 * Request bodies for paired segments, in order: each batch holds at most 64 segments and 20,000 scalars, and its JSON stays under
 * `maxBytes` UTF-8 bytes (Chinese text at the scalar limits is larger than Core's 64 KiB body limit, so bytes decide as well). A
 * segment with a side over 2,000 scalars, or alone over the byte cap, cannot be sent and is returned in `skipped`.
 * @param {Array<{id: string, source: string, target: string}>} items
 * @param {number} [maxBytes]
 * @returns {{batches: Array<{check_version: string, segments: Array<{segment_id: string, source: string, target: string}>}>, skipped: string[]}}
 */
export function structureCheckBatches(items, maxBytes = STRUCTURE_LIMITS.batchBytes) {
  const encoder = new TextEncoder();
  /** @param {Array<{segment_id: string, source: string, target: string}>} segments */
  const bytes = segments => encoder.encode(JSON.stringify({ check_version: STRUCTURE_CHECK_VERSION, segments })).length;
  /** @type {Array<{check_version: string, segments: Array<{segment_id: string, source: string, target: string}>}>} */
  const batches = [];
  /** @type {string[]} */
  const skipped = [];
  /** @type {Array<{segment_id: string, source: string, target: string}>} */
  let current = [];
  let scalars = 0;
  const flush = () => {
    if (current.length) batches.push({ check_version: STRUCTURE_CHECK_VERSION, segments: current });
    current = []; scalars = 0;
  };
  for (const item of items) {
    const segment = { segment_id: item.id, source: item.source, target: item.target };
    const length = scalarCount(item.source) + scalarCount(item.target);
    if (scalarCount(item.source) > STRUCTURE_LIMITS.side || scalarCount(item.target) > STRUCTURE_LIMITS.side || bytes([segment]) > maxBytes) {
      skipped.push(item.id);
      continue;
    }
    if (current.length >= STRUCTURE_LIMITS.segments || scalars + length > STRUCTURE_LIMITS.total || bytes([...current, segment]) > maxBytes) flush();
    current.push(segment);
    scalars += length;
  }
  flush();
  return { batches, skipped };
}

/**
 * The semantic categories a structure rule can restate, and the side on which their spans must meet. `empty_target` restates an
 * omission anywhere in its segment; layout counts and unbalanced tags restate no semantic category.
 */
const PRECEDENCE = Object.freeze({
  empty_target: { categories: ['omission'], side: null },
  number_missing: { categories: ['quantity_change', 'omission'], side: 'source' },
  number_unexpected: { categories: ['quantity_change', 'unsupported_addition'], side: 'target' },
  placeholder_missing: { categories: ['omission'], side: 'source' },
  placeholder_unexpected: { categories: ['unsupported_addition'], side: 'target' },
});

/** @param {{start: number, end: number} | null | undefined} a @param {{start: number, end: number} | null | undefined} b */
const meet = (a, b) => !!a && !!b && a.start < b.end && b.start < a.end;

/**
 * Whether a structure finding of the same segment describes the break of a semantic issue, so the Layer 1 finding is shown and the
 * issue is not shown again (ADR 0022 "Layer 1 wins an overlap"). Both carry whole-text spans. Same segment and a category the rule
 * restates are required; except for `empty_target`, the spans must also overlap on the rule's side.
 * @param {{category: string, source_span: {start: number, end: number} | null, target_span: {start: number, end: number} | null}} issue
 * @param {{rule_id: string, source_span: {start: number, end: number} | null, target_span: {start: number, end: number} | null}} finding
 * @returns {boolean}
 */
export function structureFindingCovers(issue, finding) {
  const rule = /** @type {Record<string, {categories: string[], side: 'source' | 'target' | null}>} */ (PRECEDENCE)[finding.rule_id];
  if (!rule || !rule.categories.includes(issue.category)) return false;
  if (rule.side === null) return true;
  return rule.side === 'source' ? meet(finding.source_span, issue.source_span) : meet(finding.target_span, issue.target_span);
}
