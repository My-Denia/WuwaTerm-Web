import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MAX_WORKFILE_BYTES,
  REASON_VALUES,
  WORKFILE_FORMAT,
  WORKFILE_FORMAT_V2,
  WORKFILE_FORMAT_V3,
  WORKFILE_FORMAT_V4,
} from '../lib/manuscript.js';
import {
  SEMANTIC_CATEGORIES,
  SEMANTIC_CONFIDENCES,
  TERM_EFFECTS,
  TRUNCATED_REASONS,
  WITHHELD_REASONS,
} from '../lib/semantic-review.js';
import {
  REASON_VALUES as GENERATED_REASONS,
  SEMANTIC_CATEGORY_VALUES,
  SEMANTIC_CONFIDENCE_VALUES,
  TERM_EFFECT_VALUES,
  TRUNCATED_REASON_VALUES,
  WORKFILE_FORMAT_VALUES,
  SUGGESTION_WITHHELD_REASON_VALUES,
} from '../lib/generated/manuscript-contract.ts';
import { assertSupportedSchema, validateJsonSchema } from '../scripts/validate-json-schema.mjs';

const ROOT = process.cwd();
const schema = JSON.parse(readFileSync(join(ROOT, 'contracts', 'schemas', 'manuscript.schema.json'), 'utf8'));

test('generated TypeScript and Python contract artifacts match manuscript.schema.json cleanly', () => {
  execFileSync(process.execPath, ['scripts/generate-contract-types.mjs', '--check'], { cwd: ROOT, stdio: 'pipe' });
  const pyCheck = execFileSync('python3', [
    '-B',
    '-c',
    [
      'import importlib.util, sys, typing',
      'spec = importlib.util.spec_from_file_location("mc", "contracts/generated/manuscript_contract.py")',
      'mc = importlib.util.module_from_spec(spec)',
      'sys.modules["mc"] = mc',
      'spec.loader.exec_module(mc)',
      'assert typing.get_origin(typing.get_type_hints(mc.ContractFindingV4, include_extras=True)["reason"]) is typing.NotRequired',
      'assert typing.get_origin(typing.get_type_hints(mc.ContractCompactFindingV4, include_extras=True)["reason"]) is typing.NotRequired',
      'assert typing.get_origin(typing.get_type_hints(mc.ContractResolution, include_extras=True)["candidate_id"]) is typing.NotRequired',
      'assert "None | SuggestionWithheldReason | None" not in repr(mc.ContractSemanticIssue.__annotations__["suggestion_withheld"])',
      'assert typing.get_type_hints(mc.ContractSemanticIssue, include_extras=True)',
      'assert typing.get_type_hints(mc.ContractManuscriptV4, include_extras=True)',
    ].join('; '),
  ], { cwd: ROOT, stdio: 'pipe' });
  assert.equal(pyCheck.byteLength, 0);
});

test('generated contract enum constants match runtime module exports 1:1', () => {
  assert.deepEqual([...GENERATED_REASONS], [...REASON_VALUES]);
  assert.deepEqual([...SEMANTIC_CATEGORY_VALUES], [...SEMANTIC_CATEGORIES]);
  assert.deepEqual([...SEMANTIC_CONFIDENCE_VALUES], [...SEMANTIC_CONFIDENCES]);
  assert.deepEqual([...TERM_EFFECT_VALUES], [...TERM_EFFECTS]);
  assert.deepEqual([...SUGGESTION_WITHHELD_REASON_VALUES], [...WITHHELD_REASONS]);
  assert.deepEqual([...TRUNCATED_REASON_VALUES], [...TRUNCATED_REASONS]);
  assert.deepEqual([...WORKFILE_FORMAT_VALUES], [WORKFILE_FORMAT, WORKFILE_FORMAT_V2, WORKFILE_FORMAT_V3, WORKFILE_FORMAT_V4]);
});

test('manuscript JSON Schema accepts 100% of committed valid v1–v4 fixtures', () => {
  for (const versionDir of ['manuscript-v2', 'manuscript-v3', 'manuscript-v4']) {
    const dir = join(ROOT, 'contracts', versionDir);
    const cases = JSON.parse(readFileSync(join(dir, 'cases.json'), 'utf8'));
    for (const item of cases.valid) {
      if (item.pad_to_bytes && item.pad_to_bytes > MAX_WORKFILE_BYTES * 2) continue;
      const parsed = JSON.parse(readFileSync(join(dir, item.file), 'utf8'));
      const check = validateJsonSchema(schema, parsed);
      assert.equal(check.valid, true, `${versionDir}/${item.file} failed schema: ${JSON.stringify(check.errors.slice(0, 3))}`);
    }
  }
});

test('manuscript JSON Schema rejects structural invalid fixtures across v2, v3, and v4', () => {
  const structuralByDir = {
    'manuscript-v2': [
      'invalid-both-spans-null.json',
      'invalid-ignored-with-text.json',
      'invalid-129-decisions.json',
      'invalid-bad-hex.json',
      'invalid-unknown-key.json',
    ],
    'manuscript-v3': [
      'invalid-v3-513-segments.json',
      'invalid-v3-33-choices.json',
      'invalid-v3-33-findings.json',
      'invalid-v3-9-candidates.json',
      'invalid-v3-513-history.json',
      'invalid-v3-9-offered.json',
      'invalid-v3-depth-17.json',
      'invalid-v3-33-fields.json',
      'invalid-v3-forbidden-key.json',
      'invalid-v3-unknown-top-key.json',
      'invalid-v3-missing-progress.json',
      'invalid-v3-v2-part.json',
      'invalid-v3-129-decisions.json',
      'invalid-v3-unknown-status.json',
      'invalid-v3-pending-with-result.json',
      'invalid-v3-pending-with-direction.json',
      'invalid-v3-done-null-direction.json',
      'invalid-v3-bad-alignment-input.json',
      'invalid-v3-done-without-result.json',
      'invalid-v3-segmentation-version.json',
      'invalid-v3-hash-uppercase.json',
      'invalid-v3-basis-no-matcher.json',
      'invalid-v3-basis-null-schema.json',
      'invalid-v3-unknown-record-key.json',
      'invalid-v3-unknown-verdict.json',
      'invalid-v3-official-pair-offered.json',
      'invalid-v3-pending-confirmed-choice.json',
      'invalid-v3-non-integral-index.json',
      'invalid-v3-history-bad-entry.json',
    ],
    'manuscript-v4': [
      'invalid-v4-129-findings-document.json',
      'invalid-v4-129-resolutions.json',
      'invalid-v4-129-choices.json',
      'invalid-v4-129-findings-segment.json',
      'invalid-v4-129-segment-choices.json',
      'invalid-v4-reason-on-verified.json',
      'invalid-v4-reason-null.json',
      'invalid-v4-reason-unknown.json',
      'invalid-v4-segment-reason-on-verified.json',
      'invalid-v4-segment-reason-null.json',
      'invalid-v4-segment-reason-unknown.json',
      'invalid-v4-format-v5.json',
      'invalid-v4-v3-format-33-choices.json',
      'invalid-v4-v3-format-33-findings.json',
      'invalid-v4-v3-format-reason.json',
      'invalid-v4-v2-format-reason.json',
      'invalid-v4-v2-format-33-choices.json',
    ],
  };

  for (const [versionDir, files] of Object.entries(structuralByDir)) {
    const dir = join(ROOT, 'contracts', versionDir);
    const cases = JSON.parse(readFileSync(join(dir, 'cases.json'), 'utf8'));
    const indexed = new Set(cases.invalid.map(item => item.file));
    for (const file of files) {
      assert.ok(indexed.has(file), `${versionDir}/${file} missing from cases.json`);
      const parsed = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      const check = validateJsonSchema(schema, parsed);
      assert.equal(check.valid, false, `expected ${versionDir}/${file} to fail manuscript JSON Schema`);
    }
  }

  // `invalid-v3-format-v4.json` is valid under v4 but rejected specifically by the v3 schema.
  const v4Labeled = JSON.parse(readFileSync(join(ROOT, 'contracts', 'manuscript-v3', 'invalid-v3-format-v4.json'), 'utf8'));
  const v3OnlySchema = { $defs: schema.$defs, ...schema.$defs.ManuscriptV3 };
  assert.equal(validateJsonSchema(v3OnlySchema, v4Labeled).valid, false);
});

test('schema validator rejects unsupported Draft 2020-12 keywords and enforces codepoint lengths + structural uniqueness', () => {
  assert.doesNotThrow(() => assertSupportedSchema(schema));
  for (const [label, badSchema] of [
    ['root minProperties', { type: 'object', minProperties: 1 }],
    ['nested patternProperties', { type: 'object', properties: { x: { type: 'object', patternProperties: { '^a': { type: 'string' } } } } }],
    ['$defs dependentRequired', { $defs: { A: { type: 'object', dependentRequired: { a: ['b'] } } }, $ref: '#/$defs/A' }],
    ['oneOf if', { oneOf: [{ type: 'string', if: { const: 'x' } }] }],
    ['unevaluatedProperties', { type: 'object', unevaluatedProperties: false }],
    ['format', { type: 'string', format: 'uuid' }],
    ['exclusiveMinimum', { type: 'number', exclusiveMinimum: 0 }],
    ['missing $ref', { $ref: '#/$defs/DoesNotExist' }],
  ]) {
    assert.throws(() => validateJsonSchema(badSchema, {}), /Unsupported|Missing \$def/, `expected fail-closed throw for ${label}`);
  }

  // uniqueItems uses deep structural equality (not JSON.stringify key order) and lengths count Unicode scalars.
  const uniqSchema = { type: 'array', uniqueItems: true, items: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, additionalProperties: false } };
  assert.equal(validateJsonSchema(uniqSchema, [{ a: 1, b: 2 }, { b: 2, a: 1 }]).valid, false);
  const strSchema = { type: 'string', minLength: 1, maxLength: 1 };
  assert.equal(validateJsonSchema(strSchema, '🌊').valid, true);
  assert.equal(validateJsonSchema(strSchema, '🌊a').valid, false);
});
