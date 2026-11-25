import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCHEMA_PATH = join(ROOT, 'contracts', 'schemas', 'manuscript.schema.json');
const TS_OUT_PATH = join(ROOT, 'lib', 'generated', 'manuscript-contract.ts');
const PY_OUT_PATH = join(ROOT, 'contracts', 'generated', 'manuscript_contract.py');
const TERMBASE_SCHEMA_PATH = join(ROOT, 'contracts', 'termbase-v1', 'schema.json');
const TERMBASE_TS_OUT_PATH = join(ROOT, 'lib', 'generated', 'termbase-contract.ts');
const TERMBASE_PY_OUT_PATH = join(ROOT, 'contracts', 'generated', 'termbase_contract.py');
// The standalone v5 schema for consumers that read only v5 (the Windows client): ManuscriptV5 and every definition it reaches,
// cut from manuscript.schema.json, so the two can never disagree.
const V5_SCHEMA_OUT_PATH = join(ROOT, 'contracts', 'manuscript-v5', 'schema.json');

const ENUM_DEFS = [
  ['DIRECTION_VALUES', 'Direction'],
  ['VERDICT_VALUES', 'Verdict'],
  ['REASON_VALUES', 'ReasonValue'],
  ['REASON_VALUES_V5', 'ReasonValueV5'],
  ['REVIEW_FEATURE_VALUES', 'ReviewFeature'],
  ['SEGMENTATION_VERSION_V5_VALUES', 'SegmentationVersionV5'],
  ['CHOICE_KIND_VALUES', 'ChoiceKind'],
  ['RECORD_STATUS_VALUES', 'RecordStatus'],
  ['SEMANTIC_CATEGORY_VALUES', 'SemanticCategory'],
  ['SEMANTIC_ORIGIN_VALUES', 'SemanticOrigin'],
  ['SEMANTIC_CONFIDENCE_VALUES', 'SemanticConfidence'],
  ['TERM_EFFECT_VALUES', 'TermEffect'],
  ['SUGGESTION_WITHHELD_REASON_VALUES', 'SuggestionWithheldReason'],
  ['TRUNCATED_REASON_VALUES', 'TruncatedReason'],
  ['SEMANTIC_RESPONSE_STATUS_VALUES', 'SemanticResponseStatus'],
  ['SEMANTIC_DECISION_KIND_VALUES', 'SemanticDecisionKind'],
  ['WORKFILE_FORMAT_VALUES', 'WorkfileFormat'],
];

const DTO_DEFS = [
  ['Span', 'ContractSpan'],
  ['Alignment', 'ContractAlignment'],
  ['CandidateSource', 'ContractCandidateSource'],
  ['CompactCandidate', 'ContractCompactCandidate'],
  ['CandidateV1', 'ContractCandidateV1'],
  ['CandidateV2', 'ContractCandidateV2'],
  ['DictionaryV1', 'ContractDictionaryV1'],
  ['DictionaryV2', 'ContractDictionaryV2'],
  ['StrictDictionaryV3', 'ContractStrictDictionaryV3'],
  ['ReviewCoverage', 'ContractReviewCoverage'],
  ['FindingV1', 'ContractFindingV1'],
  ['FindingV2', 'ContractFindingV2'],
  ['FindingV4', 'ContractFindingV4'],
  ['FindingV5', 'ContractFindingV5'],
  ['ReportV1', 'ContractReportV1'],
  ['ReportV2', 'ContractReportV2'],
  ['ReportV4', 'ContractReportV4'],
  ['ReportV5', 'ContractReportV5'],
  ['ChoiceBasis', 'ContractChoiceBasis'],
  ['DocumentChoice', 'ContractDocumentChoice'],
  ['Resolution', 'ContractResolution'],
  ['HistorySnapshotV1toV3', 'ContractHistorySnapshotV1toV3'],
  ['HistorySnapshotV4', 'ContractHistorySnapshotV4'],
  ['HistorySnapshotV5', 'ContractHistorySnapshotV5'],
  ['SemanticTermBasis', 'ContractSemanticTermBasis'],
  ['SemanticDecisionBasis', 'ContractSemanticDecisionBasis'],
  ['SemanticDecision', 'ContractSemanticDecision'],
  ['SemanticText', 'ContractSemanticText'],
  ['SemanticSuggestion', 'ContractSemanticSuggestion'],
  ['SemanticAlternative', 'ContractSemanticAlternative'],
  ['SemanticIssue', 'ContractSemanticIssue'],
  ['SemanticReport', 'ContractSemanticReport'],
  ['SemanticHistorySegment', 'ContractSemanticHistorySegment'],
  ['SemanticHistorySnapshot', 'ContractSemanticHistorySnapshot'],
  ['V3Basis', 'ContractV3Basis'],
  ['CompactFindingV3', 'ContractCompactFindingV3'],
  ['CompactFindingV4', 'ContractCompactFindingV4'],
  ['CompactFindingV5', 'ContractCompactFindingV5'],
  ['CompactResultV3', 'ContractCompactResultV3'],
  ['CompactResultV4', 'ContractCompactResultV4'],
  ['CompactResultV5', 'ContractCompactResultV5'],
  ['SegmentChoice', 'ContractSegmentChoice'],
  ['PendingSegmentChoice', 'ContractPendingSegmentChoice'],
  ['SegmentHistoryEntry', 'ContractSegmentHistoryEntry'],
  ['SegmentRecordV3', 'ContractSegmentRecordV3'],
  ['SegmentRecordV4', 'ContractSegmentRecordV4'],
  ['SegmentRecordV5', 'ContractSegmentRecordV5'],
  ['Progress', 'ContractProgress'],
  ['ManuscriptV1', 'ContractManuscriptV1'],
  ['ManuscriptV2', 'ContractManuscriptV2'],
  ['ManuscriptV3', 'ContractManuscriptV3'],
  ['ManuscriptV4', 'ContractManuscriptV4'],
  ['ManuscriptV5', 'ContractManuscriptV5'],
];

const DTO_MAP = new Map(DTO_DEFS);
const ENUM_MAP = new Map(ENUM_DEFS.map(([, name]) => [name, name]));

function refTargetName(ref) {
  const key = ref.slice('#/$defs/'.length);
  if (key === 'Hex64' || key === 'Hex32') return { ts: 'string', py: 'str' };
  if (key === 'SegmentationVersion') return { ts: "'segmentation-v1'", py: "Literal['segmentation-v1']" };
  if (key === 'CompactSpanTuple') return { ts: '[number, number]', py: 'tuple[int, int]' };
  if (ENUM_MAP.has(key)) return { ts: key, py: key };
  if (DTO_MAP.has(key)) {
    const out = DTO_MAP.get(key);
    return { ts: out, py: out };
  }
  throw new Error(`Unmapped schema $ref in codegen: ${ref}`);
}

function toTsType(node, defs) {
  if (Object.hasOwn(node, '$ref')) return refTargetName(node.$ref).ts;
  if (Object.hasOwn(node, 'const')) return JSON.stringify(node.const);
  if (Array.isArray(node.enum)) {
    return node.enum.map(v => (v === null ? 'null' : JSON.stringify(v))).join(' | ');
  }
  if (Array.isArray(node.oneOf)) return node.oneOf.map(s => toTsType(s, defs)).join(' | ');
  if (Array.isArray(node.allOf)) {
    const parts = node.allOf.filter(s => Object.hasOwn(s, 'oneOf') || Object.hasOwn(s, '$ref') || Object.hasOwn(s, 'properties'));
    return parts.map(s => toTsType(s, defs)).join(' & ');
  }
  if (Array.isArray(node.type)) return node.type.map(t => toTsType({ type: t }, defs)).join(' | ');
  if (node.type === 'null') return 'null';
  if (node.type === 'boolean') return 'boolean';
  if (node.type === 'string') return 'string';
  if (node.type === 'integer' || node.type === 'number') return 'number';
  if (node.type === 'array') {
    const item = node.items && typeof node.items === 'object' ? toTsType(node.items, defs) : 'unknown';
    return item.includes(' | ') ? `(${item})[]` : `${item}[]`;
  }
  if (node.type === 'object') {
    const required = new Set(node.required ?? []);
    const entries = Object.entries(node.properties ?? {}).map(([k, v]) => {
      const opt = required.has(k) ? '' : '?';
      return `${k}${opt}: ${toTsType(v, defs)}`;
    });
    return `{ ${entries.join('; ')} }`;
  }
  throw new Error(`Unsupported schema node for TS generation: ${JSON.stringify(node)}`);
}

function toPyType(node) {
  if (Object.hasOwn(node, '$ref')) return refTargetName(node.$ref).py;
  if (Object.hasOwn(node, 'const')) {
    if (node.const === null) return 'None';
    if (typeof node.const === 'boolean') return node.const ? 'Literal[True]' : 'Literal[False]';
    return `Literal[${JSON.stringify(node.const).replace(/"/g, "'")}]`;
  }
  if (Array.isArray(node.enum)) {
    const literals = node.enum.filter(v => v !== null).map(v => JSON.stringify(v).replace(/"/g, "'"));
    const parts = literals.length ? [`Literal[${literals.join(', ')}]`] : [];
    if (node.enum.includes(null)) parts.push('None');
    return parts.join(' | ');
  }
  if (Array.isArray(node.oneOf)) return node.oneOf.map(s => toPyType(s)).join(' | ');
  if (Array.isArray(node.type)) return node.type.map(t => toPyType({ type: t })).join(' | ');
  if (node.type === 'null') return 'None';
  if (node.type === 'boolean') return 'bool';
  if (node.type === 'string') return 'str';
  if (node.type === 'integer') return 'int';
  if (node.type === 'number') return 'float';
  if (node.type === 'array') {
    const item = node.items && typeof node.items === 'object' ? toPyType(node.items) : 'object';
    return `list[${item}]`;
  }
  throw new Error(`Unsupported nested Python type: ${JSON.stringify(node)}`);
}

function collapsePyBranches(branches) {
  const keys = [...new Set(branches.flatMap(b => Object.keys(b.properties)))];
  const lines = [];
  for (const k of keys) {
    const allReq = branches.every(b => (b.required ?? []).includes(k));
    const someOpt = branches.some(b => !Object.hasOwn(b.properties, k));
    const arms = branches.flatMap(b => (
      Object.hasOwn(b.properties, k) ? toPyType(b.properties[k]).split(' | ') : []
    ));
    const joined = [...new Set(arms)].join(' | ');
    lines.push(`    ${k}: ${allReq && !someOpt ? joined : `NotRequired[${joined}]`}`);
  }
  return lines;
}

function renderTs(schema) {
  const defs = schema.$defs;
  const out = [
    '// GENERATED FILE — DO NOT EDIT DIRECTLY.',
    '// Source: contracts/schemas/manuscript.schema.json (`npm run generate:contracts`).',
    '',
  ];
  for (const [constName, typeName] of ENUM_DEFS) {
    const values = defs[typeName].enum;
    const inline = values.map(v => `'${v}'`).join(', ');
    if (inline.length <= 80) {
      out.push(`export const ${constName} = [${inline}] as const;`);
    } else {
      out.push(`export const ${constName} = [`);
      for (const v of values) out.push(`  '${v}',`);
      out.push('] as const;');
    }
    out.push(`export type ${typeName} = (typeof ${constName})[number];`, '');
  }
  for (const [defName, exportName] of DTO_DEFS) {
    const def = defs[defName];
    if (defName === 'SemanticDecision' || defName === 'SemanticIssue') {
      const union = def.allOf.find(s => Array.isArray(s.oneOf));
      out.push(`export type ${exportName} = ${toTsType(union, defs)};`, '');
    } else {
      out.push(`export type ${exportName} = ${toTsType(def, defs)};`, '');
    }
  }
  out.push(
    'export type ContractManuscript =',
    '  | ContractManuscriptV1',
    '  | ContractManuscriptV2',
    '  | ContractManuscriptV3',
    '  | ContractManuscriptV4',
    '  | ContractManuscriptV5;',
    '',
  );
  return out.join('\n');
}

function renderPy(schema) {
  const defs = schema.$defs;
  const out = [
    '# GENERATED FILE — DO NOT EDIT DIRECTLY.',
    '# Source: contracts/schemas/manuscript.schema.json (`npm run generate:contracts`).',
    '',
    'from __future__ import annotations',
    '',
    'from typing import Literal, NotRequired, TypedDict',
    '',
  ];
  for (const [constName, typeName] of ENUM_DEFS) {
    const values = defs[typeName].enum;
    const pyLiterals = values.map(v => `"${v}"`).join(', ');
    out.push(`${constName}: tuple[str, ...] = (${pyLiterals},)`);
    out.push(`${typeName} = Literal[${pyLiterals}]`, '');
  }
  for (const [defName, exportName] of DTO_DEFS) {
    const def = defs[defName];
    if (def.type === 'object') {
      out.push(`class ${exportName}(TypedDict):`);
      const req = new Set(def.required ?? []);
      for (const [k, v] of Object.entries(def.properties)) {
        const ty = toPyType(v);
        out.push(`    ${k}: ${req.has(k) ? ty : `NotRequired[${ty}]`}`);
      }
      out.push('');
    } else if (Array.isArray(def.oneOf)) {
      out.push(`class ${exportName}(TypedDict):`);
      out.push(...collapsePyBranches(def.oneOf), '');
    } else if (defName === 'PendingSegmentChoice') {
      out.push(`class ${exportName}(TypedDict):`);
      const base = collapsePyBranches(defs.SegmentChoice.oneOf).map(line => (
        line.startsWith('    confirmed:') ? '    confirmed: Literal[False]' : line
      ));
      out.push(...base, '');
    } else if (Array.isArray(def.allOf)) {
      const union = def.allOf.find(s => Array.isArray(s.oneOf));
      out.push(`class ${exportName}(TypedDict):`);
      out.push(...collapsePyBranches(union.oneOf), '');
    }
  }
  out.push(
    'ContractManuscript = (',
    '    ContractManuscriptV1',
    '    | ContractManuscriptV2',
    '    | ContractManuscriptV3',
    '    | ContractManuscriptV4',
    '    | ContractManuscriptV5',
    ')',
    '',
  );
  return out.join('\n');
}

// The local user termbase has its own small schema; its constants and types are read from it by name, so a schema edit
// that renames or drops one of these fields fails here instead of silently drifting.
function termbaseParts(schema) {
  const defs = schema.$defs;
  const top = defs.TermbaseV1.properties;
  const entry = defs.Entry.properties;
  const limit = prop => ({ min: prop.minLength, max: prop.maxLength });
  return {
    format: top.format.const,
    schemaVersion: top.schema_version.const,
    directions: defs.Direction.enum,
    kinds: defs.Kind.enum,
    limits: { entries: top.entries.maxItems, id: limit(entry.id), source: limit(entry.source), target: limit(entry.target), note: limit(entry.note) },
  };
}

function renderTermbaseTs(schema) {
  const t = termbaseParts(schema);
  const range = r => `{ min: ${r.min}, max: ${r.max} }`;
  return [
    '// GENERATED FILE — DO NOT EDIT DIRECTLY.',
    '// Source: contracts/termbase-v1/schema.json (`npm run generate:contracts`).',
    '',
    `export const TERMBASE_FORMAT = '${t.format}' as const;`,
    `export const TERMBASE_SCHEMA_VERSION = ${t.schemaVersion} as const;`,
    `export const TERMBASE_DIRECTION_VALUES = [${t.directions.map(v => `'${v}'`).join(', ')}] as const;`,
    'export type TermbaseDirection = (typeof TERMBASE_DIRECTION_VALUES)[number];',
    'export const TERMBASE_KIND_VALUES = [',
    ...t.kinds.map(v => `  '${v}',`),
    '] as const;',
    'export type TermbaseKind = (typeof TERMBASE_KIND_VALUES)[number];',
    'export const TERMBASE_LIMITS = {',
    `  entries: ${t.limits.entries},`,
    `  id: ${range(t.limits.id)},`,
    `  source: ${range(t.limits.source)},`,
    `  target: ${range(t.limits.target)},`,
    `  note: ${range(t.limits.note)},`,
    '} as const;',
    '',
    'export type ContractTermbaseEntryV1 = {',
    '  id: string;',
    '  source: string;',
    '  target: string;',
    '  direction: TermbaseDirection;',
    '  kind: TermbaseKind;',
    '  note: string;',
    '  updated_at: string;',
    '};',
    '',
    'export type ContractTermbaseV1 = {',
    `  format: '${t.format}';`,
    `  schema_version: ${t.schemaVersion};`,
    '  updated_at: string;',
    '  entries: ContractTermbaseEntryV1[];',
    '};',
    '',
  ].join('\n');
}

function renderTermbasePy(schema) {
  const t = termbaseParts(schema);
  return [
    '# GENERATED FILE — DO NOT EDIT DIRECTLY.',
    '# Source: contracts/termbase-v1/schema.json (`npm run generate:contracts`).',
    '',
    'from __future__ import annotations',
    '',
    'from typing import Literal, TypedDict',
    '',
    `TERMBASE_FORMAT = "${t.format}"`,
    `TERMBASE_SCHEMA_VERSION = ${t.schemaVersion}`,
    `TERMBASE_DIRECTION_VALUES: tuple[str, ...] = (${t.directions.map(v => `"${v}"`).join(', ')},)`,
    `TermbaseDirection = Literal[${t.directions.map(v => `"${v}"`).join(', ')}]`,
    `TERMBASE_KIND_VALUES: tuple[str, ...] = (${t.kinds.map(v => `"${v}"`).join(', ')},)`,
    `TermbaseKind = Literal[${t.kinds.map(v => `"${v}"`).join(', ')}]`,
    `TERMBASE_MAX_ENTRIES = ${t.limits.entries}`,
    `TERMBASE_ID_SCALARS = (${t.limits.id.min}, ${t.limits.id.max})`,
    `TERMBASE_SOURCE_SCALARS = (${t.limits.source.min}, ${t.limits.source.max})`,
    `TERMBASE_TARGET_SCALARS = (${t.limits.target.min}, ${t.limits.target.max})`,
    `TERMBASE_NOTE_SCALARS = (${t.limits.note.min}, ${t.limits.note.max})`,
    '',
    '',
    'class ContractTermbaseEntryV1(TypedDict):',
    '    id: str',
    '    source: str',
    '    target: str',
    '    direction: TermbaseDirection',
    '    kind: TermbaseKind',
    '    note: str',
    '    updated_at: str',
    '',
    '',
    'class ContractTermbaseV1(TypedDict):',
    `    format: Literal["${t.format}"]`,
    `    schema_version: Literal[${t.schemaVersion}]`,
    '    updated_at: str',
    '    entries: list[ContractTermbaseEntryV1]',
    '',
  ].join('\n');
}

function renderV5Schema(schema) {
  const defs = schema.$defs;
  const needed = new Set();
  const visit = node => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== 'object') return;
    if (typeof node.$ref === 'string') {
      const key = node.$ref.slice('#/$defs/'.length);
      if (!Object.hasOwn(defs, key)) throw new Error(`Unknown $ref in v5 closure: ${node.$ref}`);
      if (!needed.has(key)) { needed.add(key); visit(defs[key]); }
    }
    Object.values(node).forEach(visit);
  };
  visit({ $ref: '#/$defs/ManuscriptV5' });
  const out = {
    $schema: schema.$schema,
    $id: 'https://wuwaterm.local/contracts/manuscript-v5/schema.json',
    title: 'WuwaTerm Manuscript Contract v5 (generated from contracts/schemas/manuscript.schema.json)',
    $ref: '#/$defs/ManuscriptV5',
    $defs: Object.fromEntries(Object.keys(defs).filter(key => needed.has(key)).map(key => [key, defs[key]])),
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}

const mode = process.argv.slice(2);
if (mode.length !== 1 || (mode[0] !== '--write' && mode[0] !== '--check')) {
  console.error('Usage: node scripts/generate-contract-types.mjs <--write|--check>');
  process.exit(2);
}

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
const termbaseSchema = JSON.parse(readFileSync(TERMBASE_SCHEMA_PATH, 'utf8'));
const expected = [
  [TS_OUT_PATH, renderTs(schema)],
  [PY_OUT_PATH, renderPy(schema)],
  [TERMBASE_TS_OUT_PATH, renderTermbaseTs(termbaseSchema)],
  [TERMBASE_PY_OUT_PATH, renderTermbasePy(termbaseSchema)],
  [V5_SCHEMA_OUT_PATH, renderV5Schema(schema)],
];

if (mode[0] === '--write') {
  for (const [filePath, content] of expected) {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, 'utf8');
  }
  console.log('Generated TypeScript and Python contract DTOs (manuscript and termbase) and the v5 schema.');
} else {
  const stale = expected.filter(([filePath, content]) => {
    try {
      return readFileSync(filePath, 'utf8') !== content;
    } catch {
      return true;
    }
  });
  if (stale.length) {
    console.error('Stale generated contract files:', stale.map(([p]) => p).join(', '));
    process.exit(1);
  }
  console.log('Contract DTOs and manuscript-v5/schema.json match manuscript.schema.json and termbase-v1/schema.json.');
}
