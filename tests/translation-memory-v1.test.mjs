// The wuwaterm-tm-v1 contract: strict reader refusals, Windows-to-Web JSON round-trip compatibility,
// 4-tier matching (context_exact > exact > numeric_variant > normalized_exact), multi-candidate coexistence,
// and staleness detection (terms_revision_changed, game_version_changed, numeric_changed).
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_TM_BYTES,
  MAX_TM_ENTRIES,
  TM_ERROR_CODES,
  TM_FORMAT,
  TM_ORIGIN_HUMAN,
  TM_ORIGIN_IMPORTED,
  TM_SCHEMA_VERSION,
  TranslationMemoryError,
  confirmTranslationMemoryEntry,
  contextHash,
  isTmTimestamp,
  matchTranslationMemory,
  mergeTranslationMemoryEntries,
  numericMask,
  parseTranslationMemoryBytes,
  parseTranslationMemoryText,
  serializeTranslationMemory,
  sourceHash,
  tmNow,
} from '../lib/translation-memory.ts';

const STAMP = '2026-11-27T00:00:00Z';
const LATER = '2026-11-27T01:00:00Z';

const makeEntry = (over = {}) => ({
  direction: 'en',
  source_text: '攻击力提高 20%，持续 10 秒',
  target_text: 'ATK +20% for 10s',
  prev_source_hash: null,
  next_source_hash: null,
  origin: TM_ORIGIN_HUMAN,
  terms_db_revision: null,
  game_version: null,
  note: '',
  use_count: 1,
  created_at: STAMP,
  updated_at: STAMP,
  ...over,
});

const makeFile = (entries = [makeEntry()], over = {}) => ({
  format: TM_FORMAT,
  schema_version: TM_SCHEMA_VERSION,
  exported_at: STAMP,
  entries,
  ...over,
});

const codeOf = fn => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof TranslationMemoryError, String(error));
    return error.code;
  }
  return null;
};

test('strict reader refuses malformed JSON, prototype pollution, duplicate keys, NUL, surrogates, non-finite numbers, and unconfirmed origins', () => {
  const utf8 = value => Buffer.from(JSON.stringify(value), 'utf8');

  assert.equal(codeOf(() => parseTranslationMemoryBytes(Buffer.from(''))), 'tm_not_json');
  assert.equal(codeOf(() => parseTranslationMemoryBytes(Buffer.from('{'))), 'tm_not_json');
  assert.equal(codeOf(() => parseTranslationMemoryBytes(Buffer.from([0xff, 0xfe, 0x00]))), 'tm_not_json');
  // UTF-8 BOM is rejected.
  assert.equal(codeOf(() => parseTranslationMemoryBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8(makeFile([]))]))), 'tm_not_json');
  assert.equal(codeOf(() => parseTranslationMemoryText(`${JSON.stringify(makeFile([]))} trailing`)), 'tm_not_json');
  assert.equal(codeOf(() => parseTranslationMemoryBytes(Buffer.concat([utf8(makeFile([])), Buffer.from([0x00])]))), 'tm_nul');

  assert.equal(codeOf(() => parseTranslationMemoryText(`{"format":"wuwaterm-tm-v1","format":"wuwaterm-tm-v1","schema_version":1,"exported_at":"${STAMP}","entries":[]}`)), 'tm_duplicate_key');
  assert.equal(codeOf(() => parseTranslationMemoryText('{"__proto__":{"polluted":1}}')), 'tm_forbidden_key');
  assert.equal(({}).polluted, undefined);
  assert.equal(codeOf(() => parseTranslationMemoryText('{"constructor":1}')), 'tm_forbidden_key');
  assert.equal(codeOf(() => parseTranslationMemoryText('{"prototype":1}')), 'tm_forbidden_key');

  assert.equal(codeOf(() => parseTranslationMemoryText('{"format":NaN}')), 'tm_non_finite');
  assert.equal(codeOf(() => parseTranslationMemoryText('{"format":Infinity}')), 'tm_non_finite');
  assert.equal(codeOf(() => parseTranslationMemoryText('{"format":-Infinity}')), 'tm_non_finite');
  assert.equal(codeOf(() => parseTranslationMemoryText('{"entries":1e400}')), 'tm_non_finite');

  assert.equal(codeOf(() => parseTranslationMemoryText(JSON.stringify(makeFile([makeEntry({ source_text: 'a\u0000b' })])))), 'tm_nul');
  assert.equal(codeOf(() => parseTranslationMemoryText(JSON.stringify(makeFile([])).replace('[]', '[{"source_text":"a\\ud800b"}]'))), 'tm_surrogate');
  assert.equal(codeOf(() => parseTranslationMemoryText('\ud800')), 'tm_surrogate');

  for (const origin of ['machine_translated', 'draft', 'model', '', 'HUMAN_CONFIRMED', null, 123]) {
    assert.equal(codeOf(() => parseTranslationMemoryBytes(utf8(makeFile([makeEntry({ origin })])))), 'tm_unconfirmed_origin', String(origin));
  }

  // Unknown/missing keys and field bounds.
  assert.equal(codeOf(() => parseTranslationMemoryBytes(utf8(makeFile([makeEntry({ extra: 1 })])))), 'tm_invalid_content');
  const missing = makeEntry();
  delete missing.note;
  assert.equal(codeOf(() => parseTranslationMemoryBytes(utf8(makeFile([missing])))), 'tm_invalid_content');
  assert.equal(codeOf(() => parseTranslationMemoryBytes(utf8(makeFile([], { format: 'wuwaterm-tm-v2' })))), 'tm_invalid_content');
  assert.equal(codeOf(() => parseTranslationMemoryBytes(utf8(makeFile([], { schema_version: 2 })))), 'tm_invalid_content');
  assert.equal(codeOf(() => parseTranslationMemoryBytes(utf8(makeFile([], { schema_version: true })))), 'tm_invalid_content');
  assert.equal(codeOf(() => parseTranslationMemoryBytes(utf8(makeFile([], { exported_at: '2026-11-27 00:00:00' })))), 'tm_invalid_content');
  assert.equal(codeOf(() => parseTranslationMemoryBytes(utf8(makeFile([makeEntry({ direction: 'fr' })])))), 'tm_invalid_content');
  assert.equal(codeOf(() => parseTranslationMemoryBytes(utf8(makeFile([makeEntry({ source_text: '' })])))), 'tm_invalid_content');
  assert.equal(codeOf(() => parseTranslationMemoryBytes(utf8(makeFile([makeEntry({ target_text: '   ' })])))), 'tm_invalid_content');
  assert.equal(codeOf(() => parseTranslationMemoryBytes(utf8(makeFile([makeEntry({ note: 'n'.repeat(161) })])))), 'tm_invalid_content');
  assert.equal(codeOf(() => parseTranslationMemoryBytes(utf8(makeFile([makeEntry({ prev_source_hash: 'A'.repeat(64) })])))), 'tm_invalid_content');
  assert.equal(codeOf(() => parseTranslationMemoryBytes(utf8(makeFile([makeEntry({ use_count: -1 })])))), 'tm_invalid_content');
  assert.equal(codeOf(() => parseTranslationMemoryBytes(utf8(makeFile([makeEntry({ use_count: true })])))), 'tm_invalid_content');
  assert.equal(codeOf(() => parseTranslationMemoryBytes(utf8(makeFile([makeEntry(), makeEntry()])))), 'tm_invalid_content');

  // Error detail never leaks secret content.
  const secret = 'SECRET-NOTE-LEAK-CHECK';
  try {
    parseTranslationMemoryBytes(utf8(makeFile([makeEntry({ direction: 'xx', note: secret })])));
    assert.fail('expected refusal');
  } catch (error) {
    assert.equal(error.code, 'tm_invalid_content');
    assert.equal(error.message.includes(secret), false);
  }
  assert.ok(TM_ERROR_CODES.includes('tm_unconfirmed_origin'));
});

test('8 MiB byte limit and 10,000 entry limit are enforced', () => {
  const overBytes = new Uint8Array(MAX_TM_BYTES + 1).fill(0x20);
  assert.equal(codeOf(() => parseTranslationMemoryBytes(overBytes)), 'tm_too_large');

  const entries = Array.from({ length: MAX_TM_ENTRIES + 1 }, (_, i) => makeEntry({ source_text: `source ${i}`, target_text: `target ${i}` }));
  const overEntriesBytes = Buffer.from(JSON.stringify(makeFile(entries)), 'utf8');
  assert.ok(overEntriesBytes.byteLength < MAX_TM_BYTES);
  assert.equal(codeOf(() => parseTranslationMemoryBytes(overEntriesBytes)), 'tm_too_many_entries');
  assert.equal(codeOf(() => serializeTranslationMemory(makeFile(entries))), 'tm_too_many_entries');
});

test('Windows-to-Web JSON round-trip compatibility preserves exact key order, hashes, and provenance', () => {
  // Exact portable payload produced by WuwaTerm-Windows `export_tm_json()`.
  const prevHash = sourceHash('前置段落');
  const nextHash = sourceHash('另一段');
  const windowsJson = JSON.stringify({
    format: 'wuwaterm-tm-v1',
    schema_version: 1,
    exported_at: STAMP,
    entries: [
      {
        direction: 'en',
        source_text: '攻击力提高 20%，持续 10 秒',
        target_text: 'ATK +20% for 10s',
        prev_source_hash: prevHash,
        next_source_hash: nextHash,
        origin: 'human_confirmed',
        terms_db_revision: 'r14',
        game_version: '3.0',
        note: '人工确认',
        use_count: 3,
        created_at: STAMP,
        updated_at: LATER,
      },
      {
        direction: 'zh',
        source_text: 'Echo',
        target_text: '声骸',
        prev_source_hash: null,
        next_source_hash: null,
        origin: 'imported_confirmed',
        terms_db_revision: null,
        game_version: null,
        note: '',
        use_count: 1,
        created_at: STAMP,
        updated_at: STAMP,
      },
    ],
  }, null, 2) + '\n';

  const parsed = parseTranslationMemoryText(windowsJson);
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.equal(Object.getPrototypeOf(parsed.entries[0]), Object.prototype);
  const reserialized = serializeTranslationMemory(parsed);
  assert.equal(reserialized, windowsJson);

  const raw = JSON.parse(reserialized);
  assert.deepEqual(Object.keys(raw), ['format', 'schema_version', 'exported_at', 'entries']);
  assert.deepEqual(Object.keys(raw.entries[0]), [
    'direction',
    'source_text',
    'target_text',
    'prev_source_hash',
    'next_source_hash',
    'origin',
    'terms_db_revision',
    'game_version',
    'note',
    'use_count',
    'created_at',
    'updated_at',
  ]);
  // Verify SHA-256 matches Python hashlib.sha256 UTF-8 hex for CJK.
  assert.equal(contextHash('   \n '), null);
  assert.equal(sourceHash('攻击力提高 20%，持续 10 秒').length, 64);
});

test('4-tier matching ranks context_exact > exact > numeric_variant > normalized_exact and allows multi-candidate coexistence', () => {
  const entries = [
    makeEntry({
      source_text: '攻击力提高 20%\r\n持续 10 秒',
      target_text: 'ATK +20% for 10s (normalized)',
      use_count: 50,
    }),
    makeEntry({
      source_text: '攻击力提高 20%，持续 10 秒',
      target_text: 'ATK +20% for 10s',
      terms_db_revision: 'r14',
      game_version: '3.0',
      use_count: 1,
    }),
    makeEntry({
      source_text: '攻击力提高 20% 持续 10 秒',
      target_text: 'ATK +20% for 10s (plain)',
      use_count: 2,
    }),
    makeEntry({
      source_text: '攻击力提高 20% 持续 10 秒',
      target_text: 'ATK +20% for 10s (ctx)',
      prev_source_hash: sourceHash('准备'),
      next_source_hash: sourceHash('奖励'),
      use_count: 1,
    }),
    makeEntry({
      direction: 'zh',
      source_text: '攻击力提高 20% 持续 10 秒',
      target_text: 'Wrong direction',
    }),
  ];

  // Exact + context_exact + normalized_exact coexistence & rank order:
  const exactHits = matchTranslationMemory(entries, '攻击力提高 20% 持续 10 秒', 'en', {
    prevSource: '准备',
    nextSource: '奖励',
  });
  assert.deepEqual(
    exactHits.map(m => [m.matchKind, m.entry.target_text]),
    [
      ['context_exact', 'ATK +20% for 10s (ctx)'],
      ['exact', 'ATK +20% for 10s (plain)'],
      ['normalized_exact', 'ATK +20% for 10s (normalized)'],
    ],
  );
  assert.equal(exactHits[2].numericChanged, false);

  // Numeric variant rank beats normalized_exact when both exist, and detects 20%/10s -> 25%/12s:
  const mixedEntries = [
    makeEntry({ source_text: '攻击力提高\r\n25%，持续 12 秒', target_text: 'Normalized target', use_count: 99 }),
    makeEntry({ source_text: '攻击力提高 20%，持续 10 秒', target_text: 'ATK +20% for 10s', terms_db_revision: 'r14', game_version: '3.0' }),
  ];
  const numericAndNormalized = matchTranslationMemory(mixedEntries, '攻击力提高 25%，持续 12 秒', 'en');
  assert.deepEqual(
    numericAndNormalized.map(m => [m.matchKind, m.numericChanged, m.needsRecheck, m.staleReasons]),
    [
      ['numeric_variant', true, true, ['numeric_changed']],
      ['normalized_exact', false, false, []],
    ],
  );
  assert.equal(numericMask('攻击力提高 25%，持续 12 秒'), numericMask('攻击力提高 20%，持续 10 秒'));
  // Full-width digits are NOT matched as ASCII numeric variants.
  assert.deepEqual(matchTranslationMemory(mixedEntries, '攻击力提高 ２５％，持续 １２ 秒', 'en'), []);
});

test('staleness flags terms_revision_changed, game_version_changed, and numeric_changed only when current values are known', () => {
  const entries = [
    makeEntry({ source_text: '挑战成功', target_text: 'Challenge complete', terms_db_revision: 'r14', game_version: '3.0' }),
    makeEntry({ source_text: '没有记录', target_text: 'No record', terms_db_revision: null, game_version: null }),
  ];

  const fresh = matchTranslationMemory(entries, '挑战成功', 'en', {
    currentTermsDbRevision: 'r14',
    currentGameVersion: '3.0',
  });
  assert.equal(fresh.length, 1);
  assert.deepEqual(fresh[0].staleReasons, []);
  assert.equal(fresh[0].needsRecheck, false);

  const termsChanged = matchTranslationMemory(entries, '挑战成功', 'en', {
    currentTermsDbRevision: 'r15',
    currentGameVersion: '3.0',
  });
  assert.deepEqual(termsChanged[0].staleReasons, ['terms_revision_changed']);
  assert.equal(termsChanged[0].needsRecheck, true);

  const bothChanged = matchTranslationMemory(entries, '挑战成功', 'en', {
    currentTermsDbRevision: 'r15',
    currentGameVersion: '3.1',
  });
  assert.deepEqual(bothChanged[0].staleReasons, ['terms_revision_changed', 'game_version_changed']);

  // Unknown current revisions do not falsely mark entries stale.
  const unknownCurrent = matchTranslationMemory(entries, '挑战成功', 'en');
  assert.deepEqual(unknownCurrent[0].staleReasons, []);

  // Missing revision on stored entry IS stale when current revision is known.
  const missingRecord = matchTranslationMemory(entries, '没有记录', 'en', {
    currentTermsDbRevision: 'r14',
  });
  assert.deepEqual(missingRecord[0].staleReasons, ['terms_revision_changed']);

  // Ordering compares parsed instants (.5Z > Z), not lexicographical strings.
  const ordered = matchTranslationMemory([
    makeEntry({ source_text: '同一句', target_text: 'earlier', updated_at: '2026-11-27T00:00:00Z' }),
    makeEntry({ source_text: '同一句', target_text: 'later', updated_at: '2026-11-27T00:00:00.5Z' }),
  ], '同一句', 'en');
  assert.deepEqual(ordered.map(m => m.entry.target_text), ['later', 'earlier']);
});

test('confirmTranslationMemoryEntry and mergeTranslationMemoryEntries enforce human/imported origins and merge cleanly', () => {
  const rejected = confirmTranslationMemoryEntry([], {
    sourceText: '主C',
    targetText: 'main DPS',
    direction: 'en',
    origin: 'machine_translated',
  });
  assert.deepEqual(rejected, { status: 'invalid', error: 'unconfirmed_origin' });

  const first = confirmTranslationMemoryEntry([], {
    sourceText: '主C',
    targetText: 'main DPS',
    direction: 'en',
    termsDbRevision: 'r14',
  }, new Date('2026-11-27T00:00:00Z'));
  assert.equal(first.status, 'added');
  assert.equal(first.entry.origin, 'human_confirmed');
  assert.equal(first.entry.use_count, 1);

  const second = confirmTranslationMemoryEntry(first.entries, {
    sourceText: '主C',
    targetText: 'main DPS',
    direction: 'en',
  }, new Date('2026-11-27T01:00:00Z'));
  assert.equal(second.status, 'updated');
  assert.equal(second.entry.use_count, 2);
  assert.equal(second.entry.created_at, '2026-11-27T00:00:00Z');
  assert.equal(second.entry.updated_at, '2026-11-27T01:00:00Z');
  assert.equal(second.entry.terms_db_revision, 'r14');

  const merged = mergeTranslationMemoryEntries(
    [makeEntry({ source_text: '主C', target_text: 'main DPS', origin: TM_ORIGIN_IMPORTED, use_count: 1 })],
    [makeEntry({ source_text: '主C', target_text: 'main DPS', origin: TM_ORIGIN_HUMAN, use_count: 4, note: '人工' })],
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].origin, 'human_confirmed');
  assert.equal(merged[0].use_count, 4);
  assert.equal(merged[0].note, '人工');
  assert.equal(isTmTimestamp(tmNow()), true);
});
