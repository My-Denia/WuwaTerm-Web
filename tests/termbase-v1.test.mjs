// The wuwaterm-termbase-v1 contract: every committed fixture against the strict reader and the JSON Schema, the size and
// count limits at their exact edges, canonical round trips, and the literal reference matcher.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { buildFiles, buildGenerated } from '../scripts/build-termbase-v1-fixtures.mjs';
import { validateJsonSchema } from '../scripts/validate-json-schema.mjs';
import {
  MATCH_SPANS_PER_ENTRY, MATCH_TEXT_LIMIT, MAX_TERMBASE_BYTES, MAX_TERMBASE_ENTRIES, TERMBASE_ERROR_CODES, TermbaseError,
  findMatchingTermbaseEntry, inferDirection, isTermbaseTimestamp, matchTermbase, nextEntryId, parseTermbaseBytes,
  parseTermbaseText, promoteTermbaseEntry, serializeTermbase, termbaseNow, validateTermbase,
} from '../lib/termbase.ts';
import {
  TERMBASE_DIRECTION_VALUES, TERMBASE_FORMAT, TERMBASE_KIND_VALUES, TERMBASE_LIMITS,
} from '../lib/generated/termbase-contract.ts';

const ROOT = join(process.cwd(), 'contracts', 'termbase-v1');
const schema = JSON.parse(readFileSync(join(ROOT, 'schema.json'), 'utf8'));
const cases = JSON.parse(readFileSync(join(ROOT, 'cases.json'), 'utf8'));
const read = name => readFileSync(join(ROOT, 'fixtures', name));
const codeOf = fn => { try { fn(); } catch (error) { assert.ok(error instanceof TermbaseError, String(error)); return error.code; } return null; };

test('the committed fixtures and the generated types match their sources', () => {
  execFileSync(process.execPath, ['scripts/build-termbase-v1-fixtures.mjs'], { cwd: process.cwd(), stdio: 'pipe' });
  execFileSync(process.execPath, ['scripts/generate-contract-types.mjs', '--check'], { cwd: process.cwd(), stdio: 'pipe' });
  assert.equal(buildFiles().size, cases.valid.length + cases.invalid.length + 1);
});

test('the contract constants, error codes and limits agree across schema, cases and reader', () => {
  assert.equal(TERMBASE_FORMAT, 'wuwaterm-termbase-v1');
  assert.deepEqual([...TERMBASE_DIRECTION_VALUES], ['en', 'zh']);
  assert.deepEqual([...TERMBASE_KIND_VALUES], ['community_term', 'preferred_term', 'do_not_translate']);
  assert.deepEqual([...TERMBASE_ERROR_CODES], cases.codes);
  assert.equal(cases.limits.file_bytes, MAX_TERMBASE_BYTES);
  assert.equal(MAX_TERMBASE_BYTES, 1_048_576);
  assert.equal(cases.limits.entries, MAX_TERMBASE_ENTRIES);
  assert.deepEqual(
    [cases.limits.id_scalars, cases.limits.source_scalars, cases.limits.target_scalars, cases.limits.note_scalars],
    [TERMBASE_LIMITS.id.max, TERMBASE_LIMITS.source.max, TERMBASE_LIMITS.target.max, TERMBASE_LIMITS.note.max],
  );
  assert.deepEqual([TERMBASE_LIMITS.id.min, TERMBASE_LIMITS.source.min, TERMBASE_LIMITS.target.min, TERMBASE_LIMITS.note.min], [1, 1, 1, 0]);
});

test('every valid fixture is read, satisfies the schema, and writes back to the canonical bytes where it is canonical', () => {
  assert.ok(cases.valid.length >= 5);
  for (const item of cases.valid) {
    const bytes = read(item.file);
    const parsed = parseTermbaseBytes(bytes);
    const check = validateJsonSchema(schema, JSON.parse(bytes.toString('utf8')));
    assert.equal(check.valid, true, `${item.file}: ${JSON.stringify(check.errors.slice(0, 3))}`);
    const written = serializeTermbase(parsed);
    if (item.canonical) assert.equal(written, bytes.toString('utf8'), item.file);
    assert.deepEqual(parseTermbaseText(written), parsed, `${item.file} round trip`);
    assert.equal(serializeTermbase(parseTermbaseText(written)), written, `${item.file} second round trip`);
  }
});

test('every invalid fixture is refused with its own code, and the schema agrees where it can judge the file', () => {
  assert.ok(cases.invalid.length >= 40);
  const seen = new Set();
  for (const item of cases.invalid) {
    const bytes = read(item.file);
    assert.equal(codeOf(() => parseTermbaseBytes(bytes)), item.code, `${item.file} (${item.note})`);
    seen.add(item.code);
    let parsed;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); } catch { parsed = undefined; }
    if (item.schema === 'not-json') {
      assert.equal(parsed, undefined, item.file);
    } else {
      assert.notEqual(parsed, undefined, `${item.file} should be JSON`);
      assert.equal(validateJsonSchema(schema, parsed).valid, item.schema === 'accepts', `${item.file} schema ${item.schema}`);
    }
  }
  // Every refusal code but the two size codes, which the generated fixtures cover, has at least one fixture.
  for (const code of TERMBASE_ERROR_CODES) {
    if (code === 'termbase_too_large' || code === 'termbase_too_many_entries') continue;
    assert.ok(seen.has(code), `no fixture for ${code}`);
  }
});

test('2,000 entries read; 2,001 are refused', () => {
  const spec = name => cases.generated.find(g => g.file === name);
  const ok = buildGenerated(spec('valid-2000-entries.json'));
  assert.equal(parseTermbaseText(ok).entries.length, 2000);
  assert.equal(serializeTermbase(parseTermbaseText(ok)), ok);
  assert.equal(codeOf(() => parseTermbaseText(buildGenerated(spec('invalid-2001-entries.json')))), 'termbase_too_many_entries');
  const many = parseTermbaseText(ok);
  many.entries.push({ ...many.entries[0], id: 'extra' });
  assert.equal(codeOf(() => serializeTermbase(many)), 'termbase_too_many_entries');
});

test('exactly 1,048,576 bytes read; one byte more is refused before decoding', () => {
  const spec = name => cases.generated.find(g => g.file === name);
  const edge = Buffer.from(buildGenerated(spec('valid-exactly-1-mib.json')));
  assert.equal(edge.byteLength, 1_048_576);
  assert.equal(parseTermbaseBytes(edge).entries.length, 2000);
  const over = Buffer.from(buildGenerated(spec('invalid-1-mib-plus-1.json')));
  assert.equal(over.byteLength, 1_048_577);
  assert.equal(codeOf(() => parseTermbaseBytes(over)), 'termbase_too_large');
  // The limit is on bytes, not characters: an oversize file is refused even when its text would parse.
  assert.equal(codeOf(() => parseTermbaseBytes(new Uint8Array(1_048_577).fill(0x20))), 'termbase_too_large');
});

test('the writer refuses a termbase that would exceed 1 MiB, and one that breaks the contract', () => {
  const entry = i => ({ id: `tb-${i}`, source: '\u{20BB7}'.repeat(120), target: '\u{20BB7}'.repeat(160), direction: 'en', kind: 'community_term', note: '\u{20BB7}'.repeat(160), updated_at: '2026-11-25T00:00:00Z' });
  const big = { format: TERMBASE_FORMAT, schema_version: 1, updated_at: '2026-11-25T00:00:00Z', entries: Array.from({ length: 1000 }, (_, i) => entry(i)) };
  assert.equal(codeOf(() => serializeTermbase(big)), 'termbase_too_large');
  assert.equal(codeOf(() => serializeTermbase({ ...big, entries: [{ ...entry(1), kind: 'official' }] })), 'termbase_invalid_content');
  assert.equal(codeOf(() => serializeTermbase({ ...big, entries: [{ ...entry(1), note: 'a\u0000b' }] })), 'termbase_nul');
  assert.equal(codeOf(() => serializeTermbase({ ...big, entries: [{ ...entry(1), note: '\ud800' }] })), 'termbase_surrogate');
});

test('text input refuses an isolated surrogate and a BOM, and a prototype key never reaches a result', () => {
  assert.equal(codeOf(() => parseTermbaseText('\ud800')), 'termbase_surrogate');
  assert.equal(codeOf(() => parseTermbaseText('﻿{}')), 'termbase_not_json');
  assert.equal(codeOf(() => parseTermbaseText('{"__proto__":{"polluted":1}}')), 'termbase_forbidden_key');
  assert.equal(({}).polluted, undefined);
  const parsed = parseTermbaseText(read('valid-one-entry.json').toString('utf8'));
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.equal(Object.getPrototypeOf(parsed.entries[0]), Object.prototype);
});

test('a reader error names a location and never echoes file content', () => {
  const secret = 'SECRET-NOTE-TEXT';
  const text = read('valid-one-entry.json').toString('utf8').replace('Community team role shorthand in guides.', secret).replace('"direction": "en"', '"direction": "xx"');
  try { parseTermbaseText(text); assert.fail('expected a refusal'); } catch (error) {
    assert.equal(error.code, 'termbase_invalid_content');
    assert.match(error.detail, /^entries\[0\]\.direction/);
    assert.equal(error.message.includes(secret), false);
  }
});

test('timestamps: RFC 3339 UTC with real calendar days', () => {
  for (const ok of ['2026-11-25T00:00:00Z', '2024-02-29T23:59:59Z', '2026-11-25T08:30:15.123456789Z']) assert.equal(isTermbaseTimestamp(ok), true, ok);
  for (const no of ['2026-02-29T00:00:00Z', '2026-04-31T00:00:00Z', '2026-11-25T24:00:00Z', '2026-11-25T00:00:60Z', '2026-11-25T00:00:00+00:00', '2026-11-25 00:00:00Z', '2026-11-25T00:00:00.Z', '', 5, null]) assert.equal(isTermbaseTimestamp(no), false, String(no));
  assert.equal(isTermbaseTimestamp(termbaseNow()), true);
  assert.doesNotMatch(termbaseNow(), /\./);
});

test('validateTermbase returns a copy and nextEntryId skips taken ids', () => {
  const source = parseTermbaseText(read('valid-all-kinds.json').toString('utf8'));
  const copy = validateTermbase(source);
  assert.deepEqual(copy, source);
  assert.notEqual(copy.entries[0], source.entries[0]);
  assert.equal(nextEntryId([]), 'tb-001');
  assert.equal(nextEntryId([{ id: 'tb-002' }, { id: 'tb-001' }]), 'tb-003');
  assert.equal(nextEntryId([{ id: 'tb-002' }]), 'tb-003');
});

const entry = (id, source, direction, over = {}) => ({ id, source, target: `t-${id}`, direction, kind: 'community_term', note: '', updated_at: '2026-11-25T00:00:00Z', ...over });

test('matching is literal, per direction, ordered by first position, with scalar offsets', () => {
  const list = [
    entry('a', '主C', 'en'),
    entry('b', '今汐', 'en'),
    entry('c', '今汐', 'zh'),
    entry('d', '不存在', 'en'),
  ];
  const text = '今汐是主C，今汐强。';
  const { matches, truncated } = matchTermbase(list, text, 'en');
  assert.equal(truncated, false);
  assert.deepEqual(matches.map(m => m.entry.id), ['b', 'a']);
  assert.deepEqual(matches[0].spans, [{ start: 0, end: 2 }, { start: 6, end: 8 }]);
  assert.equal(matches[0].count, 2);
  assert.deepEqual(matches[1].spans, [{ start: 3, end: 5 }]);
  // The other direction sees only its own entries.
  assert.deepEqual(matchTermbase(list, '今汐', 'zh').matches.map(m => m.entry.id), ['c']);
  // No entries or no text: nothing.
  assert.deepEqual(matchTermbase([], text, 'en'), { matches: [], truncated: false });
  assert.deepEqual(matchTermbase(list, '', 'en'), { matches: [], truncated: false });
});

test('matching: Latin surfaces are case-insensitive whole words, CJK and symbol edges are plain substrings', () => {
  const list = [entry('dps', 'DPS', 'en'), entry('sub', 'sub carry', 'zh'), entry('cpp', 'C++', 'zh'), entry('dot', 'a.b', 'zh')];
  assert.deepEqual(matchTermbase(list, '这个dps很强', 'en').matches.map(m => m.entry.id), ['dps']);
  assert.deepEqual(matchTermbase(list, 'MyDPS and DPSX', 'en').matches, []);
  assert.deepEqual(matchTermbase(list, 'A Sub Carry, ok', 'zh').matches.map(m => m.entry.id), ['sub']);
  assert.deepEqual(matchTermbase(list, 'subcarry', 'zh').matches, []);
  assert.deepEqual(matchTermbase(list, 'I like C++ a lot, and C++.', 'zh').matches[0].count, 2);
  // Regex metacharacters in a surface are literal.
  assert.deepEqual(matchTermbase(list, 'xa.b and aXb', 'zh').matches, []);
  assert.deepEqual(matchTermbase(list, 'a.b and aXb', 'zh').matches.map(m => m.entry.id), ['dot']);
});

test('matching counts astral characters as one scalar and caps the work on a very long text', () => {
  const astral = matchTermbase([entry('x', '\u{20BB7}字', 'en')], '\u{20BB7}\u{20BB7}字', 'en');
  assert.deepEqual(astral.matches[0].spans, [{ start: 1, end: 3 }]);
  const many = matchTermbase([entry('x', 'a', 'zh', { source: 'ab' })], 'ab '.repeat(500), 'zh');
  assert.equal(many.matches[0].count, 500);
  assert.equal(many.matches[0].spans.length, MATCH_SPANS_PER_ENTRY);
  const long = matchTermbase([entry('x', '尾', 'en')], '甲'.repeat(MATCH_TEXT_LIMIT) + '尾', 'en');
  assert.equal(long.truncated, true);
  assert.deepEqual(long.matches, []);
  const cut = matchTermbase([entry('x', 'ab', 'zh')], 'x'.repeat(MATCH_TEXT_LIMIT - 1) + '\u{20BB7}ab', 'zh');
  assert.equal(cut.truncated, true);
});

test('matching never changes its inputs and has no dependence on the official dictionary', () => {
  const list = Object.freeze([Object.freeze(entry('a', '今汐', 'en'))]);
  const before = JSON.stringify(list);
  matchTermbase(list, '今汐', 'en');
  assert.equal(JSON.stringify(list), before);
});

test('inferDirection reads any Han character as Chinese into English', () => {
  assert.equal(inferDirection('今汐 is here'), 'en');
  assert.equal(inferDirection('plain English'), 'zh');
  assert.equal(inferDirection(''), 'zh');
});

test('promoteTermbaseEntry adds preferred_term entries, detects duplicates, and flags incomplete candidates', () => {
  const first = promoteTermbaseEntry([], { source: ' 声骸 ', target: ' Echo ', direction: 'en' });
  assert.equal(first.status, 'added');
  assert.equal(first.entry.id, 'tb-001');
  assert.equal(first.entry.source, '声骸');
  assert.equal(first.entry.target, 'Echo');
  assert.equal(first.entry.kind, 'preferred_term');
  assert.equal(first.entry.direction, 'en');
  assert.equal(first.entries.length, 1);

  assert.ok(findMatchingTermbaseEntry(first.entries, { source: '声骸', target: 'Echo', direction: 'en' }));
  assert.equal(findMatchingTermbaseEntry(first.entries, { source: '声骸', target: 'Echo', direction: 'zh' }), null);

  const dup = promoteTermbaseEntry(first.entries, { source: '声骸', target: 'Echo', direction: 'en' });
  assert.equal(dup.status, 'duplicate');
  assert.equal(dup.entry.id, 'tb-001');

  const incomplete = promoteTermbaseEntry(first.entries, { source: '今汐', target: '   ', direction: 'en' });
  assert.deepEqual(incomplete, { status: 'incomplete', source: '今汐', target: '', direction: 'en', kind: 'preferred_term' });

  const invalid = promoteTermbaseEntry(first.entries, { source: 'a\u0000b', target: 'c', direction: 'en' });
  assert.equal(invalid.status, 'invalid');
  assert.equal(invalid.error, 'field_invalid');
});
