// Generates contracts/termbase-v1/fixtures/ and contracts/termbase-v1/cases.json.
// Default: check the committed bytes. --write: rewrite them. All text is synthetic.
// The contract is contracts/termbase-v1/SPEC.md; this file only produces fixtures for it.
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'contracts', 'termbase-v1');
const dir = join(root, 'fixtures');

export const FORMAT = 'wuwaterm-termbase-v1';
export const MAX_BYTES = 1_048_576;
export const MAX_ENTRIES = 2000;
export const CODES = [
  'termbase_not_json', 'termbase_too_large', 'termbase_too_many_entries', 'termbase_duplicate_key', 'termbase_forbidden_key',
  'termbase_nul', 'termbase_surrogate', 'termbase_non_finite', 'termbase_invalid_content',
];
export const LIMITS = { file_bytes: MAX_BYTES, entries: MAX_ENTRIES, id_scalars: 64, source_scalars: 120, target_scalars: 160, note_scalars: 160 };

const STAMP = '2026-11-25T00:00:00Z';
const entry = (id, over = {}) => ({
  id, source: `source ${id}`, target: `target ${id}`, direction: 'en', kind: 'community_term', note: '', updated_at: STAMP, ...over,
});
const file = (entries = [entry('tb-001')], over = {}) => ({
  format: FORMAT, schema_version: 1, updated_at: STAMP, entries, ...over,
});
const pretty = value => JSON.stringify(value, null, 2) + '\n';
const rep = (unit, n) => unit.repeat(n);
// Raw text with one entry's fields replaced; used where the bytes themselves are the point.
const rawFile = (entryJson, head = `"format": "${FORMAT}", "schema_version": 1, "updated_at": "${STAMP}"`) =>
  `{ ${head}, "entries": [ ${entryJson} ] }\n`;
const ENTRY_JSON = '{ "id": "tb-001", "source": "a", "target": "b", "direction": "en", "kind": "community_term", "note": "", "updated_at": "2026-11-25T00:00:00Z" }';
const ENTRY_WITH_NOTE = note => `{ "id": "tb-001", "source": "a", "target": "b", "direction": "en", "kind": "community_term", "note": ${note}, "updated_at": "${STAMP}" }`;

const ASTRAL = '\u{20BB7}'; // one scalar, two UTF-16 units, four UTF-8 bytes

export function validFixtures() {
  return [
    { file: 'valid-empty.json', note: 'no entries', content: pretty(file([])), canonical: true },
    {
      file: 'valid-one-entry.json', note: 'one community term in the document example form',
      content: pretty(file([entry('tb-001', { source: '主C', target: 'main DPS', note: 'Community team role shorthand in guides.' })])), canonical: true,
    },
    {
      file: 'valid-all-kinds.json', note: 'both directions and all three kinds, a fractional-second timestamp, astral characters, an empty note',
      content: pretty(file([
        entry('tb-001', { source: '主C', target: 'main DPS', direction: 'en', kind: 'community_term', note: 'role shorthand' }),
        entry('tb-002', { source: 'burst window', target: '爆发窗口', direction: 'zh', kind: 'preferred_term' }),
        entry('tb-003', { source: 'DPS', target: 'DPS', direction: 'en', kind: 'do_not_translate', updated_at: '2026-11-25T08:30:15.123456Z' }),
        entry('tb-004', { source: `${ASTRAL}字`, target: `${ASTRAL} term`, direction: 'en', kind: 'preferred_term', note: `${ASTRAL}` }),
      ])),
      canonical: true,
    },
    {
      file: 'valid-max-length-fields.json', note: 'every string at its upper bound, counted in scalars (astral characters are 4 bytes each)',
      content: pretty(file([entry(rep('i', 63) + ASTRAL, {
        source: rep(ASTRAL, 120), target: rep(ASTRAL, 160), note: rep(ASTRAL, 160),
      })])),
      canonical: true,
    },
    {
      file: 'valid-escaped-astral-pair.json', note: 'a surrogate pair written as two \\u escapes is one scalar; not the canonical bytes',
      content: rawFile(ENTRY_WITH_NOTE('"\\ud83d\\ude00"')), canonical: false,
    },
    {
      file: 'valid-compact-spacing.json', note: 'minified with arbitrary insignificant whitespace; not the canonical bytes',
      content: `{"format":"${FORMAT}","schema_version":1,"updated_at":"${STAMP}","entries":[{"id":"tb-001","source":"a","target":"b","direction":"zh","kind":"preferred_term","note":"","updated_at":"${STAMP}"}]}`,
      canonical: false,
    },
  ];
}

const bad = (file, code, schema, note, content) => ({ file, code, schema, note, content });

export function invalidFixtures() {
  const e = over => pretty(file([entry('tb-001', over)]));
  const top = over => pretty(file([entry('tb-001')], over));
  const proto = key => rawFile(ENTRY_JSON, `"format": "${FORMAT}", "schema_version": 1, "updated_at": "${STAMP}", "${key}": {}`);
  return [
    bad('invalid-not-object.json', 'termbase_invalid_content', 'rejects', 'the top level is an array', '[]\n'),
    bad('invalid-unknown-top-key.json', 'termbase_invalid_content', 'rejects', 'an unknown top-level key', top({ extra: true })),
    bad('invalid-unknown-entry-key.json', 'termbase_invalid_content', 'rejects', 'an unknown entry key', e({ aliases: [] })),
    bad('invalid-wrong-format.json', 'termbase_invalid_content', 'rejects', 'format is not wuwaterm-termbase-v1', top({ format: 'wuwaterm-termbase-v2' })),
    bad('invalid-schema-version-2.json', 'termbase_invalid_content', 'rejects', 'schema_version is 2', top({ schema_version: 2 })),
    bad('invalid-schema-version-string.json', 'termbase_invalid_content', 'rejects', 'schema_version is the string "1"', top({ schema_version: '1' })),
    bad('invalid-missing-entries.json', 'termbase_invalid_content', 'rejects', 'no entries key',
      pretty({ format: FORMAT, schema_version: 1, updated_at: STAMP })),
    bad('invalid-entries-not-array.json', 'termbase_invalid_content', 'rejects', 'entries is an object', top({ entries: {} })),
    bad('invalid-entry-missing-note.json', 'termbase_invalid_content', 'rejects', 'an entry without note',
      rawFile('{ "id": "tb-001", "source": "a", "target": "b", "direction": "en", "kind": "community_term", "updated_at": "2026-11-25T00:00:00Z" }')),
    bad('invalid-timestamp-offset.json', 'termbase_invalid_content', 'rejects', 'a UTC offset instead of Z', top({ updated_at: '2026-11-25T08:00:00+08:00' })),
    bad('invalid-timestamp-lowercase.json', 'termbase_invalid_content', 'rejects', 'lowercase t and z', top({ updated_at: '2026-11-25t00:00:00z' })),
    bad('invalid-timestamp-date-only.json', 'termbase_invalid_content', 'rejects', 'a date without a time', e({ updated_at: '2026-11-25' })),
    bad('invalid-calendar-day.json', 'termbase_invalid_content', 'accepts', 'February 30th: the pattern allows it, the reader checks the month length',
      e({ updated_at: '2026-02-30T00:00:00Z' })),
    bad('invalid-direction-auto.json', 'termbase_invalid_content', 'rejects', 'direction is "auto"', e({ direction: 'auto' })),
    bad('invalid-kind-unknown.json', 'termbase_invalid_content', 'rejects', 'an unknown kind', e({ kind: 'official_term' })),
    bad('invalid-id-empty.json', 'termbase_invalid_content', 'rejects', 'id is empty', e({ id: '' })),
    bad('invalid-id-65-scalars.json', 'termbase_invalid_content', 'rejects', 'id has 65 scalars', e({ id: rep(ASTRAL, 65) })),
    bad('invalid-source-empty.json', 'termbase_invalid_content', 'rejects', 'source is empty', e({ source: '' })),
    bad('invalid-source-121-scalars.json', 'termbase_invalid_content', 'rejects', 'source has 121 scalars', e({ source: rep(ASTRAL, 121) })),
    bad('invalid-target-empty.json', 'termbase_invalid_content', 'rejects', 'target is empty', e({ target: '' })),
    bad('invalid-target-161-scalars.json', 'termbase_invalid_content', 'rejects', 'target has 161 scalars', e({ target: rep(ASTRAL, 161) })),
    bad('invalid-note-161-scalars.json', 'termbase_invalid_content', 'rejects', 'note has 161 scalars', e({ note: rep(ASTRAL, 161) })),
    bad('invalid-field-not-string.json', 'termbase_invalid_content', 'rejects', 'target is a number', e({ target: 7 })),
    bad('invalid-duplicate-id.json', 'termbase_invalid_content', 'accepts', 'two entries share an id; a schema cannot say unique by field',
      pretty(file([entry('tb-001'), entry('tb-001', { source: 'other' })]))),
    bad('invalid-too-deep.json', 'termbase_invalid_content', 'rejects', 'nesting deeper than the reader allows',
      `{ "format": "${FORMAT}", "schema_version": 1, "updated_at": "${STAMP}", "entries": ${rep('[', 40)}${rep(']', 40)} }\n`),
    bad('invalid-duplicate-key-top.json', 'termbase_duplicate_key', 'accepts', 'format appears twice (JSON.parse keeps the last)',
      `{ "format": "${FORMAT}", "format": "${FORMAT}", "schema_version": 1, "updated_at": "${STAMP}", "entries": [] }\n`),
    bad('invalid-duplicate-key-entry.json', 'termbase_duplicate_key', 'accepts', 'target appears twice in an entry',
      rawFile(`{ "id": "tb-001", "source": "a", "target": "b", "target": "c", "direction": "en", "kind": "community_term", "note": "", "updated_at": "${STAMP}" }`)),
    bad('invalid-proto-key-top.json', 'termbase_forbidden_key', 'rejects', '__proto__ at the top level', proto('__proto__')),
    bad('invalid-constructor-key-top.json', 'termbase_forbidden_key', 'rejects', 'constructor at the top level', proto('constructor')),
    bad('invalid-prototype-key-top.json', 'termbase_forbidden_key', 'rejects', 'prototype at the top level', proto('prototype')),
    bad('invalid-proto-key-entry.json', 'termbase_forbidden_key', 'rejects', '__proto__ inside an entry',
      rawFile(`{ "id": "tb-001", "source": "a", "target": "b", "direction": "en", "kind": "community_term", "note": "", "updated_at": "${STAMP}", "__proto__": { "x": 1 } }`)),
    bad('invalid-constructor-key-nested.json', 'termbase_forbidden_key', 'rejects', 'constructor inside a nested unknown value',
      rawFile(`{ "id": "tb-001", "source": "a", "target": "b", "direction": "en", "kind": "community_term", "note": "", "updated_at": "${STAMP}", "extra": { "constructor": {} } }`)),
    bad('invalid-nul-escape.json', 'termbase_nul', 'accepts', 'a note holding \\u0000', rawFile(ENTRY_WITH_NOTE('"a\\u0000b"'))),
    bad('invalid-nul-byte.json', 'termbase_nul', 'not-json', 'a raw 0x00 byte between tokens',
      Buffer.concat([Buffer.from('{ "format": "' + FORMAT + '", "schema_version": 1, '), Buffer.from([0]), Buffer.from(` "updated_at": "${STAMP}", "entries": [] }\n`)])),
    bad('invalid-lone-high-surrogate.json', 'termbase_surrogate', 'accepts', 'a note holding an isolated \\ud800', rawFile(ENTRY_WITH_NOTE('"\\ud800"'))),
    bad('invalid-lone-low-surrogate.json', 'termbase_surrogate', 'accepts', 'a note holding an isolated \\udc00', rawFile(ENTRY_WITH_NOTE('"\\udc00"'))),
    bad('invalid-reversed-surrogate-pair.json', 'termbase_surrogate', 'accepts', 'a low surrogate before a high one', rawFile(ENTRY_WITH_NOTE('"\\udc00\\ud800"'))),
    bad('invalid-nan.json', 'termbase_non_finite', 'not-json', 'schema_version is NaN',
      `{ "format": "${FORMAT}", "schema_version": NaN, "updated_at": "${STAMP}", "entries": [] }\n`),
    bad('invalid-infinity.json', 'termbase_non_finite', 'not-json', 'schema_version is Infinity',
      `{ "format": "${FORMAT}", "schema_version": Infinity, "updated_at": "${STAMP}", "entries": [] }\n`),
    bad('invalid-negative-infinity.json', 'termbase_non_finite', 'not-json', 'schema_version is -Infinity',
      `{ "format": "${FORMAT}", "schema_version": -Infinity, "updated_at": "${STAMP}", "entries": [] }\n`),
    bad('invalid-number-overflow.json', 'termbase_non_finite', 'rejects', 'schema_version 1e999 reads as Infinity',
      `{ "format": "${FORMAT}", "schema_version": 1e999, "updated_at": "${STAMP}", "entries": [] }\n`),
    bad('invalid-empty-file.json', 'termbase_not_json', 'not-json', 'zero bytes', ''),
    bad('invalid-trailing-comma.json', 'termbase_not_json', 'not-json', 'a trailing comma',
      `{ "format": "${FORMAT}", "schema_version": 1, "updated_at": "${STAMP}", "entries": [], }\n`),
    bad('invalid-comment.json', 'termbase_not_json', 'not-json', 'a comment',
      `{ /* c */ "format": "${FORMAT}", "schema_version": 1, "updated_at": "${STAMP}", "entries": [] }\n`),
    bad('invalid-single-quotes.json', 'termbase_not_json', 'not-json', 'single-quoted strings',
      `{ 'format': '${FORMAT}', 'schema_version': 1, 'updated_at': '${STAMP}', 'entries': [] }\n`),
    bad('invalid-leading-zero.json', 'termbase_not_json', 'not-json', 'schema_version 01',
      `{ "format": "${FORMAT}", "schema_version": 01, "updated_at": "${STAMP}", "entries": [] }\n`),
    bad('invalid-raw-control-char.json', 'termbase_not_json', 'not-json', 'a raw tab inside a string',
      rawFile(`{ "id": "tb-001", "source": "a\tb", "target": "b", "direction": "en", "kind": "community_term", "note": "", "updated_at": "${STAMP}" }`)),
    bad('invalid-text-after-value.json', 'termbase_not_json', 'not-json', 'a second value after the file',
      `{ "format": "${FORMAT}", "schema_version": 1, "updated_at": "${STAMP}", "entries": [] } {}\n`),
    bad('invalid-utf8-bom.json', 'termbase_not_json', 'not-json', 'a UTF-8 byte order mark',
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(pretty(file([])))])),
    bad('invalid-utf8-bytes.json', 'termbase_not_json', 'not-json', 'a lone 0xff byte',
      Buffer.concat([Buffer.from('{ "format": "'), Buffer.from([0xff]), Buffer.from('" }\n')])),
    bad('invalid-utf8-encoded-surrogate.json', 'termbase_not_json', 'not-json', 'a surrogate encoded as three UTF-8 bytes (ED A0 80)',
      Buffer.concat([Buffer.from('{ "format": "'), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from('" }\n')])),
  ];
}

// Fixtures too large to commit: the reader builds them from these descriptors.
export const GENERATED = [
  { file: 'valid-2000-entries.json', kind: 'entries', count: 2000, code: null, note: 'exactly 2,000 entries, canonical bytes' },
  { file: 'valid-exactly-1-mib.json', kind: 'bytes', bytes: MAX_BYTES, code: null, note: '2,000 entries padded with trailing spaces to exactly 1,048,576 bytes' },
  { file: 'invalid-2001-entries.json', kind: 'entries', count: 2001, code: 'termbase_too_many_entries', note: '2,001 entries' },
  { file: 'invalid-1-mib-plus-1.json', kind: 'bytes', bytes: MAX_BYTES + 1, code: 'termbase_too_large', note: 'the same file padded to 1,048,577 bytes' },
];

export function buildGenerated(spec) {
  const count = spec.kind === 'entries' ? spec.count : MAX_ENTRIES;
  const entries = Array.from({ length: count }, (_, i) => entry(`tb-${String(i + 1).padStart(4, '0')}`, {
    source: `term ${i + 1}`, target: `译名${i + 1}`, direction: i % 2 ? 'zh' : 'en', note: rep('n', 100),
  }));
  const text = pretty(file(entries));
  if (spec.kind === 'entries') return text;
  const size = Buffer.byteLength(text, 'utf8');
  if (size > spec.bytes) throw new Error(`base text already ${size} bytes`);
  return text + ' '.repeat(spec.bytes - size);
}

export function buildCases() {
  return {
    format: FORMAT,
    spec: 'SPEC.md',
    schema: 'schema.json',
    codes: CODES,
    limits: LIMITS,
    valid: validFixtures().map(({ file, note, canonical }) => ({ file, note, canonical })),
    invalid: invalidFixtures().map(({ file, code, schema, note }) => ({ file, code, schema, note })),
    generated: GENERATED,
  };
}

export function buildFiles() {
  const files = new Map();
  for (const f of [...validFixtures(), ...invalidFixtures()]) files.set(`fixtures/${f.file}`, Buffer.from(f.content));
  files.set('cases.json', Buffer.from(pretty(buildCases())));
  return files;
}

function main() {
  const write = process.argv.includes('--write');
  const files = buildFiles();
  const stale = [];
  mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of files) {
    const path = join(root, name);
    let current = null;
    try { current = readFileSync(path); } catch { /* absent */ }
    if (current === null || !current.equals(bytes)) {
      stale.push(name);
      if (write) writeFileSync(path, bytes);
    }
  }
  for (const name of readdirSync(dir)) {
    if (!files.has(`fixtures/${name}`)) {
      stale.push(`fixtures/${name} (unlisted)`);
      if (write) unlinkSync(join(dir, name));
    }
  }
  if (stale.length && !write) {
    console.error(`Stale termbase fixtures: ${stale.join(', ')}`);
    process.exit(1);
  }
  console.log(write ? `Wrote ${stale.length} changed file(s).` : 'Termbase fixtures are current.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
