// Self-hosted SQLite Translation Memory store (`state-web/data/tm.sqlite3`, ADR 0023 / MY-491).
//
// Imported ONLY by `lib/runtime/node.js`, never by the public Cloudflare runtime or browser bundle.
// Stores only confirmed (`human_confirmed` | `imported_confirmed`) user entries under the instance's
// local data directory, completely separate from official `terms.db` and `pool.sqlite3`.
import { closeSync, constants, lstatSync, openSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sha256Hex } from '../sha256.js';

export const TM_APPLICATION_ID = 0x5755544e;
export const TM_SQLITE_SCHEMA_VERSION = 1;
const BUSY_TIMEOUT_MS = 1_000;
const MAX_TM_ENTRIES = 10_000;
const MAX_TM_BYTES = 8 * 1_048_576;
const MAX_USE_COUNT = 2_147_483_647;
const TM_LIMITS = {
  source: { min: 1, max: 2_000 },
  target: { min: 1, max: 2_000 },
  note: { min: 0, max: 160 },
  revision: { min: 1, max: 128 },
};
const VALID_DIRECTIONS = new Set(['en', 'zh']);
const VALID_ORIGINS = new Set(['human_confirmed', 'imported_confirmed']);
const HASH_HEX = /^[0-9a-f]{64}$/u;
const TIMESTAMP = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,9}))?Z$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const EXPECTED_COLUMNS = [
  'id',
  'direction',
  'source_text',
  'source_hash',
  'source_norm',
  'source_masked',
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
];

const SCHEMA_SQL = `
CREATE TABLE tm_schema (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
) STRICT;

INSERT INTO tm_schema (key, value) VALUES
  ('format', 'wuwaterm-tm-v1'),
  ('schema_version', '1');

CREATE TABLE tm_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  direction TEXT NOT NULL CHECK(direction IN ('en', 'zh')),
  source_text TEXT NOT NULL CHECK(length(source_text) > 0),
  source_hash TEXT NOT NULL CHECK(length(source_hash) = 64),
  source_norm TEXT NOT NULL CHECK(length(source_norm) > 0),
  source_masked TEXT NOT NULL CHECK(length(source_masked) > 0),
  target_text TEXT NOT NULL CHECK(length(target_text) > 0),
  prev_source_hash TEXT CHECK(prev_source_hash IS NULL OR length(prev_source_hash) = 64),
  next_source_hash TEXT CHECK(next_source_hash IS NULL OR length(next_source_hash) = 64),
  origin TEXT NOT NULL CHECK(origin IN ('human_confirmed', 'imported_confirmed')),
  terms_db_revision TEXT,
  game_version TEXT,
  note TEXT NOT NULL DEFAULT '',
  use_count INTEGER NOT NULL CHECK(use_count >= 0 AND use_count <= 2147483647),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX tm_entries_candidate ON tm_entries (
  direction,
  source_hash,
  COALESCE(prev_source_hash, ''),
  COALESCE(next_source_hash, ''),
  target_text
);

CREATE INDEX tm_entries_norm ON tm_entries (direction, source_norm);
CREATE INDEX tm_entries_masked ON tm_entries (direction, source_masked);
`;

function invalidConfiguration() {
  // Never include file paths, environment values, or entry content in startup errors.
  return new Error('Invalid self-host runtime configuration or database');
}

function tmStorageError(code, detail = '') {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  error.detail = detail;
  return error;
}

const NUMERIC_MASK_ESCAPE = '\uE000';

function scalarLength(text) {
  return Array.from(text).length;
}

function daysIn(year, month) {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isTmTimestamp(value) {
  if (typeof value !== 'string') return false;
  const m = TIMESTAMP.exec(value);
  return !!m && Number(m[3]) <= daysIn(Number(m[1]), Number(m[2]));
}

function tmNow(now = new Date()) {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function compareInstants(a, b) {
  const ma = TIMESTAMP.exec(a);
  const mb = TIMESTAMP.exec(b);
  if (!ma || !mb) return 0;
  const msA = Date.UTC(Number(ma[1]), Number(ma[2]) - 1, Number(ma[3]), Number(ma[4]), Number(ma[5]), Number(ma[6]));
  const msB = Date.UTC(Number(mb[1]), Number(mb[2]) - 1, Number(mb[3]), Number(mb[4]), Number(mb[5]), Number(mb[6]));
  if (msA !== msB) return msA < msB ? -1 : 1;
  const fracA = Number((ma[7] ?? '').padEnd(9, '0'));
  const fracB = Number((mb[7] ?? '').padEnd(9, '0'));
  return fracA === fracB ? 0 : fracA < fracB ? -1 : 1;
}

function contextHash(text) {
  if (text === null || text === undefined) return null;
  return typeof text === 'string' && text.trim() ? sha256Hex(text) : null;
}

function normalizeSource(text) {
  return text.trim().replace(/\s+/gu, ' ');
}

function numericMask(text) {
  // Never emit NUL (\x00): SQLite length(TEXT) stops at the first NUL byte,
  // which would fail CHECK(length(source_masked) > 0) for leading-digit sources like "10% 暴击率".
  return text
    .replaceAll(NUMERIC_MASK_ESCAPE, `${NUMERIC_MASK_ESCAPE}\uE001`)
    .replace(/[0-9]+/gu, `${NUMERIC_MASK_ESCAPE}0`);
}

function rowToEntry(row) {
  return {
    direction: row.direction,
    source_text: row.source_text,
    target_text: row.target_text,
    prev_source_hash: row.prev_source_hash ?? null,
    next_source_hash: row.next_source_hash ?? null,
    origin: row.origin,
    terms_db_revision: row.terms_db_revision ?? null,
    game_version: row.game_version ?? null,
    note: row.note ?? '',
    use_count: row.use_count,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function entryRawBytes(entry) {
  return Buffer.byteLength(entry.source_text, 'utf8')
    + Buffer.byteLength(entry.target_text, 'utf8')
    + Buffer.byteLength(entry.note ?? '', 'utf8')
    + Buffer.byteLength(entry.terms_db_revision ?? '', 'utf8')
    + Buffer.byteLength(entry.game_version ?? '', 'utf8');
}

function withinMaxBytesFast(cnt, rawBytes) {
  return 256 + cnt * 600 + rawBytes * 6 <= MAX_TM_BYTES;
}

function serializedSizeBytes(entries) {
  const serialized = JSON.stringify({
    format: 'wuwaterm-tm-v1',
    schema_version: 1,
    exported_at: '2026-01-01T00:00:00Z',
    entries: entries.map(entry => ({
      direction: entry.direction,
      source_text: entry.source_text,
      target_text: entry.target_text,
      prev_source_hash: entry.prev_source_hash ?? null,
      next_source_hash: entry.next_source_hash ?? null,
      origin: entry.origin,
      terms_db_revision: entry.terms_db_revision ?? null,
      game_version: entry.game_version ?? null,
      note: entry.note ?? '',
      use_count: entry.use_count,
      created_at: entry.created_at,
      updated_at: entry.updated_at,
    })),
  }, null, 2) + '\n';
  return Buffer.byteLength(serialized, 'utf8');
}

function assertValidSingleEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw tmStorageError('tm_invalid_content');
  if (!VALID_DIRECTIONS.has(entry.direction)) throw tmStorageError('tm_invalid_content');
  if (!VALID_ORIGINS.has(entry.origin)) throw tmStorageError('tm_unconfirmed_origin');
  if (typeof entry.source_text !== 'string' || !normalizeSource(entry.source_text)) throw tmStorageError('tm_invalid_content');
  if (typeof entry.target_text !== 'string' || !normalizeSource(entry.target_text)) throw tmStorageError('tm_invalid_content');
  if (entry.source_text.includes('\u0000') || entry.target_text.includes('\u0000')) throw tmStorageError('tm_nul');
  if (LONE_SURROGATE.test(entry.source_text) || LONE_SURROGATE.test(entry.target_text)) throw tmStorageError('tm_surrogate');
  if (scalarLength(entry.source_text) > TM_LIMITS.source.max || scalarLength(entry.target_text) > TM_LIMITS.target.max) {
    throw tmStorageError('tm_invalid_content');
  }
  if (entry.prev_source_hash !== null && (typeof entry.prev_source_hash !== 'string' || !HASH_HEX.test(entry.prev_source_hash))) {
    throw tmStorageError('tm_invalid_content');
  }
  if (entry.next_source_hash !== null && (typeof entry.next_source_hash !== 'string' || !HASH_HEX.test(entry.next_source_hash))) {
    throw tmStorageError('tm_invalid_content');
  }
  if (entry.terms_db_revision !== null && (typeof entry.terms_db_revision !== 'string' || entry.terms_db_revision.includes('\u0000') || LONE_SURROGATE.test(entry.terms_db_revision) || scalarLength(entry.terms_db_revision) < TM_LIMITS.revision.min || scalarLength(entry.terms_db_revision) > TM_LIMITS.revision.max)) {
    throw tmStorageError('tm_invalid_content');
  }
  if (entry.game_version !== null && (typeof entry.game_version !== 'string' || entry.game_version.includes('\u0000') || LONE_SURROGATE.test(entry.game_version) || scalarLength(entry.game_version) < TM_LIMITS.revision.min || scalarLength(entry.game_version) > TM_LIMITS.revision.max)) {
    throw tmStorageError('tm_invalid_content');
  }
  const note = entry.note ?? '';
  if (typeof note !== 'string' || note.includes('\u0000') || LONE_SURROGATE.test(note) || scalarLength(note) > TM_LIMITS.note.max) {
    throw tmStorageError('tm_invalid_content');
  }
  if (typeof entry.use_count !== 'number' || !Number.isInteger(entry.use_count) || entry.use_count < 0 || entry.use_count > MAX_USE_COUNT) {
    throw tmStorageError('tm_invalid_content');
  }
  if (!isTmTimestamp(entry.created_at) || !isTmTimestamp(entry.updated_at)) {
    throw tmStorageError('tm_invalid_content');
  }
}

function validateConfirmCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { ok: false, invalid: { status: 'invalid', error: 'field_invalid', field: 'source' } };
  }
  const originRaw = candidate.origin ?? 'human_confirmed';
  if (typeof originRaw !== 'string' || !VALID_ORIGINS.has(originRaw)) {
    return { ok: false, invalid: { status: 'invalid', error: 'unconfirmed_origin' } };
  }
  if (!VALID_DIRECTIONS.has(candidate.direction)) {
    return { ok: false, invalid: { status: 'invalid', error: 'field_invalid', field: 'source' } };
  }
  const checkText = (field, value, min, max) => {
    if (typeof value !== 'string' || value.includes('\u0000') || LONE_SURROGATE.test(value)) {
      return { status: 'invalid', error: 'field_invalid', field };
    }
    if (field !== 'note' && !normalizeSource(value)) {
      return { status: 'invalid', error: 'field_required', field };
    }
    const len = scalarLength(value);
    if (len < min) return { status: 'invalid', error: 'field_required', field };
    if (len > max) return { status: 'invalid', error: 'field_too_long', field, max };
    return null;
  };
  if (candidate.note !== undefined && typeof candidate.note !== 'string') {
    return { ok: false, invalid: { status: 'invalid', error: 'field_invalid', field: 'note' } };
  }
  const sourceText = candidate.sourceText;
  const targetText = candidate.targetText;
  const note = (candidate.note ?? '').trim();
  const problem = checkText('source', sourceText, TM_LIMITS.source.min, TM_LIMITS.source.max)
    ?? checkText('target', targetText, TM_LIMITS.target.min, TM_LIMITS.target.max)
    ?? checkText('note', note, TM_LIMITS.note.min, TM_LIMITS.note.max);
  if (problem) return { ok: false, invalid: problem };

  const checkOptionalRevision = (value) => {
    if (value === undefined || value === null) return true;
    if (typeof value !== 'string' || value.includes('\u0000') || LONE_SURROGATE.test(value)) return false;
    const len = scalarLength(value);
    return len >= TM_LIMITS.revision.min && len <= TM_LIMITS.revision.max;
  };
  if (!checkOptionalRevision(candidate.termsDbRevision) || !checkOptionalRevision(candidate.gameVersion)) {
    return { ok: false, invalid: { status: 'invalid', error: 'field_invalid', field: 'source' } };
  }

  return {
    ok: true,
    value: {
      direction: candidate.direction,
      sourceText,
      targetText,
      prevHash: contextHash(candidate.prevSource),
      nextHash: contextHash(candidate.nextSource),
      origin: originRaw,
      termsDbRevision: candidate.termsDbRevision,
      gameVersion: candidate.gameVersion,
      note,
    },
  };
}

function assertValidEntriesForStorage(entries) {
  if (!Array.isArray(entries)) throw tmStorageError('tm_invalid_content');
  if (entries.length > MAX_TM_ENTRIES) throw tmStorageError('tm_too_many_entries', `${entries.length} entries`);
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw tmStorageError('tm_invalid_content');
    if (!VALID_DIRECTIONS.has(entry.direction)) throw tmStorageError('tm_invalid_content');
    if (!VALID_ORIGINS.has(entry.origin)) throw tmStorageError('tm_unconfirmed_origin');
    if (typeof entry.source_text !== 'string' || !normalizeSource(entry.source_text)) throw tmStorageError('tm_invalid_content');
    if (typeof entry.target_text !== 'string' || !normalizeSource(entry.target_text)) throw tmStorageError('tm_invalid_content');
  }
  const bytes = serializedSizeBytes(entries);
  if (bytes > MAX_TM_BYTES) {
    throw tmStorageError('tm_too_large', `${bytes} bytes`);
  }
}

export function tmDatabasePathForPool(poolDbPath) {
  if (typeof poolDbPath !== 'string' || !isAbsolute(poolDbPath) || poolDbPath.includes('\0')) {
    throw invalidConfiguration();
  }
  return join(dirname(poolDbPath), 'tm.sqlite3');
}

export function openTmStore(filename) {
  if (typeof filename !== 'string' || !isAbsolute(filename) || filename.includes('\0')) {
    throw invalidConfiguration();
  }
  let created = false;
  try {
    const fd = openSync(filename, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    closeSync(fd);
    created = true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw invalidConfiguration();
  }
  let sqlite;
  try {
    const info = lstatSync(filename);
    if (!info.isFile() || (info.mode & 0o077) !== 0) throw invalidConfiguration();
    sqlite = new DatabaseSync(filename, { timeout: BUSY_TIMEOUT_MS });
    if (created) {
      sqlite.exec('BEGIN IMMEDIATE');
      sqlite.exec(SCHEMA_SQL);
      sqlite.exec(`PRAGMA application_id=${TM_APPLICATION_ID}`);
      sqlite.exec(`PRAGMA user_version=${TM_SQLITE_SCHEMA_VERSION}`);
      sqlite.exec('COMMIT');
    } else {
      const app = sqlite.prepare('PRAGMA application_id').get();
      const version = sqlite.prepare('PRAGMA user_version').get();
      if (app?.application_id !== TM_APPLICATION_ID || version?.user_version !== TM_SQLITE_SCHEMA_VERSION) {
        throw invalidConfiguration();
      }
      const schemaRows = sqlite.prepare('SELECT key, value FROM tm_schema').all();
      const schemaMap = new Map(schemaRows.map(row => [row.key, row.value]));
      if (schemaMap.get('format') !== 'wuwaterm-tm-v1' || schemaMap.get('schema_version') !== '1') {
        throw invalidConfiguration();
      }
    }
    const columns = sqlite.prepare('PRAGMA table_info(tm_entries)').all().map(column => column.name);
    if (columns.length !== EXPECTED_COLUMNS.length || columns.some((name, i) => name !== EXPECTED_COLUMNS[i])) {
      throw invalidConfiguration();
    }
    if (sqlite.prepare('PRAGMA quick_check(1)').get()?.quick_check !== 'ok') {
      throw invalidConfiguration();
    }
    const modeRow = sqlite.prepare('PRAGMA journal_mode').get();
    if (String(modeRow?.journal_mode ?? '').toLowerCase() !== 'wal') {
      sqlite.exec('PRAGMA journal_mode=WAL');
    }
    sqlite.exec('PRAGMA synchronous=FULL');
  } catch {
    try { sqlite?.close(); } catch { /* startup fails closed */ }
    throw invalidConfiguration();
  }

  const selectAllStmt = sqlite.prepare(
    `SELECT direction, source_text, target_text, prev_source_hash, next_source_hash,
            origin, terms_db_revision, game_version, note, use_count, created_at, updated_at
     FROM tm_entries
     ORDER BY id ASC`,
  );
  const selectByCandidateStmt = sqlite.prepare(
    `SELECT id, direction, source_text, target_text, prev_source_hash, next_source_hash,
            origin, terms_db_revision, game_version, note, use_count, created_at, updated_at
     FROM tm_entries
     WHERE direction = ?
       AND source_hash = ?
       AND COALESCE(prev_source_hash, '') = ?
       AND COALESCE(next_source_hash, '') = ?
       AND target_text = ?`,
  );
  const countAndBytesStmt = sqlite.prepare(
    `SELECT COUNT(*) AS cnt,
            COALESCE(SUM(
              LENGTH(CAST(source_text AS BLOB))
              + LENGTH(CAST(target_text AS BLOB))
              + LENGTH(CAST(note AS BLOB))
              + LENGTH(CAST(COALESCE(terms_db_revision, '') AS BLOB))
              + LENGTH(CAST(COALESCE(game_version, '') AS BLOB))
            ), 0) AS raw_bytes
     FROM tm_entries`,
  );
  const selectVersionStmt = sqlite.prepare("SELECT value FROM tm_schema WHERE key = 'storage_version'");
  const upsertVersionStmt = sqlite.prepare(
    `INSERT INTO tm_schema (key, value) VALUES ('storage_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  const deleteAllStmt = sqlite.prepare('DELETE FROM tm_entries');
  const insertStmt = sqlite.prepare(
    `INSERT INTO tm_entries (
       direction, source_text, source_hash, source_norm, source_masked, target_text,
       prev_source_hash, next_source_hash, origin, terms_db_revision, game_version,
       note, use_count, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateConfirmByIdStmt = sqlite.prepare(
    `UPDATE tm_entries
     SET origin = ?,
         terms_db_revision = ?,
         game_version = ?,
         note = ?,
         use_count = ?,
         updated_at = ?
     WHERE id = ?`,
  );
  const updateMergedByIdStmt = sqlite.prepare(
    `UPDATE tm_entries
     SET origin = ?,
         terms_db_revision = ?,
         game_version = ?,
         note = ?,
         use_count = ?,
         created_at = ?,
         updated_at = ?
     WHERE id = ?`,
  );
  const deleteOneStmt = sqlite.prepare(
    `DELETE FROM tm_entries
     WHERE direction = ?
       AND source_hash = ?
       AND COALESCE(prev_source_hash, '') = ?
       AND COALESCE(next_source_hash, '') = ?
       AND target_text = ?`,
  );

  function readVersionInternal() {
    const row = selectVersionStmt.get();
    const raw = row?.value;
    return typeof raw === 'string' && /^[0-9]+$/u.test(raw) ? raw : '0';
  }

  function bumpVersionInternal() {
    const next = String(Number(readVersionInternal()) + 1);
    upsertVersionStmt.run(next);
    return next;
  }

  function readEntriesInternal() {
    return selectAllStmt.all().map(rowToEntry);
  }

  function writeEntriesInternal(entries) {
    assertValidEntriesForStorage(entries);
    deleteAllStmt.run();
    for (const entry of entries) {
      insertStmt.run(
        entry.direction,
        entry.source_text,
        sha256Hex(entry.source_text),
        normalizeSource(entry.source_text),
        numericMask(entry.source_text),
        entry.target_text,
        entry.prev_source_hash ?? null,
        entry.next_source_hash ?? null,
        entry.origin,
        entry.terms_db_revision ?? null,
        entry.game_version ?? null,
        entry.note ?? '',
        entry.use_count,
        entry.created_at,
        entry.updated_at,
      );
    }
    return bumpVersionInternal();
  }

  function withImmediateTransaction(fn) {
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      sqlite.exec('COMMIT');
      return value;
    } catch (error) {
      try { sqlite.exec('ROLLBACK'); } catch { /* ignore rollback error */ }
      throw error;
    }
  }

  return {
    path: filename,
    getVersion() {
      return readVersionInternal();
    },
    listEntries() {
      return readEntriesInternal();
    },
    getSnapshot() {
      return withImmediateTransaction(() => ({
        entries: readEntriesInternal(),
        storageVersion: readVersionInternal(),
      }));
    },
    replaceEntries(entries) {
      return withImmediateTransaction(() => {
        writeEntriesInternal(entries);
        return readEntriesInternal();
      });
    },
    runAtomic(transform) {
      return withImmediateTransaction(() => {
        const current = readEntriesInternal();
        const currentVersion = readVersionInternal();
        const outcome = transform(current, currentVersion);
        if (outcome && outcome.write && Array.isArray(outcome.entries)) {
          const storageVersion = writeEntriesInternal(outcome.entries);
          return { ...outcome.result, entries: readEntriesInternal(), storageVersion };
        }
        return { ...(outcome?.result ?? { entries: current }), storageVersion: currentVersion };
      });
    },
    confirmEntry(candidate, options = {}) {
      const checked = validateConfirmCandidate(candidate);
      if (!checked.ok) return checked.invalid;
      const v = checked.value;
      const includeEntries = options.includeEntries ?? true;
      const stamp = tmNow(options.now ?? new Date());
      const srcHash = sha256Hex(v.sourceText);
      const srcNorm = normalizeSource(v.sourceText);
      const srcMasked = numericMask(v.sourceText);

      return withImmediateTransaction(() => {
        const existing = selectByCandidateStmt.get(
          v.direction,
          srcHash,
          v.prevHash ?? '',
          v.nextHash ?? '',
          v.targetText,
        );
        if (existing) {
          const nextOrigin = existing.origin === 'human_confirmed' || v.origin === 'human_confirmed'
            ? 'human_confirmed'
            : 'imported_confirmed';
          const nextRevision = v.termsDbRevision !== undefined
            ? (v.termsDbRevision ?? null)
            : existing.terms_db_revision;
          const revisionChanged = nextRevision !== existing.terms_db_revision;
          const nextGameVersion = v.gameVersion !== undefined
            ? (v.gameVersion ?? null)
            : (revisionChanged ? null : existing.game_version);
          const nextNote = v.note || existing.note;
          const nextUseCount = Math.min(MAX_USE_COUNT, existing.use_count + 1);
          const updatedEntry = {
            direction: v.direction,
            source_text: v.sourceText,
            target_text: v.targetText,
            prev_source_hash: v.prevHash,
            next_source_hash: v.nextHash,
            origin: nextOrigin,
            terms_db_revision: nextRevision,
            game_version: nextGameVersion,
            note: nextNote,
            use_count: nextUseCount,
            created_at: existing.created_at,
            updated_at: stamp,
          };
          if (
            nextNote !== existing.note
            || nextRevision !== existing.terms_db_revision
            || nextGameVersion !== existing.game_version
          ) {
            const { cnt, raw_bytes } = countAndBytesStmt.get();
            const delta = entryRawBytes(updatedEntry) - entryRawBytes(existing);
            if (!withinMaxBytesFast(cnt, raw_bytes + delta)) {
              const all = readEntriesInternal();
              const prospective = all.map(item => (
                item.direction === updatedEntry.direction
                && item.source_text === updatedEntry.source_text
                && item.target_text === updatedEntry.target_text
                && item.prev_source_hash === updatedEntry.prev_source_hash
                && item.next_source_hash === updatedEntry.next_source_hash
                  ? updatedEntry
                  : item
              ));
              if (serializedSizeBytes(prospective) > MAX_TM_BYTES) {
                return { status: 'invalid', error: 'list_too_large' };
              }
            }
          }
          updateConfirmByIdStmt.run(
            nextOrigin,
            nextRevision,
            nextGameVersion,
            nextNote,
            nextUseCount,
            stamp,
            existing.id,
          );
          const storageVersion = bumpVersionInternal();
          return {
            status: 'updated',
            entry: updatedEntry,
            ...(includeEntries ? { entries: readEntriesInternal() } : {}),
            storageVersion,
          };
        }

        const { cnt, raw_bytes } = countAndBytesStmt.get();
        if (cnt >= MAX_TM_ENTRIES) {
          return { status: 'invalid', error: 'list_full' };
        }
        const newEntry = {
          direction: v.direction,
          source_text: v.sourceText,
          target_text: v.targetText,
          prev_source_hash: v.prevHash,
          next_source_hash: v.nextHash,
          origin: v.origin,
          terms_db_revision: v.termsDbRevision ?? null,
          game_version: v.gameVersion ?? null,
          note: v.note,
          use_count: 1,
          created_at: stamp,
          updated_at: stamp,
        };
        if (!withinMaxBytesFast(cnt + 1, raw_bytes + entryRawBytes(newEntry))) {
          if (serializedSizeBytes([...readEntriesInternal(), newEntry]) > MAX_TM_BYTES) {
            return { status: 'invalid', error: 'list_too_large' };
          }
        }
        insertStmt.run(
          v.direction,
          v.sourceText,
          srcHash,
          srcNorm,
          srcMasked,
          v.targetText,
          v.prevHash,
          v.nextHash,
          v.origin,
          newEntry.terms_db_revision,
          newEntry.game_version,
          v.note,
          1,
          stamp,
          stamp,
        );
        const storageVersion = bumpVersionInternal();
        return {
          status: 'added',
          entry: newEntry,
          ...(includeEntries ? { entries: readEntriesInternal() } : {}),
          storageVersion,
        };
      });
    },
    mergeEntries(incoming, options = {}) {
      if (!Array.isArray(incoming)) throw tmStorageError('tm_invalid_content');
      for (const item of incoming) {
        assertValidSingleEntry(item);
      }
      const includeEntries = options.includeEntries ?? true;
      return withImmediateTransaction(() => {
        const stats = countAndBytesStmt.get();
        let cnt = stats.cnt;
        let rawBytes = stats.raw_bytes;
        let changed = false;

        for (const item of incoming) {
          const srcHash = sha256Hex(item.source_text);
          const existing = selectByCandidateStmt.get(
            item.direction,
            srcHash,
            item.prev_source_hash ?? '',
            item.next_source_hash ?? '',
            item.target_text,
          );
          if (existing) {
            const nextOrigin = existing.origin === 'human_confirmed' || item.origin === 'human_confirmed'
              ? 'human_confirmed'
              : 'imported_confirmed';
            const nextRevision = existing.terms_db_revision !== null ? existing.terms_db_revision : (item.terms_db_revision ?? null);
            const nextGameVersion = existing.game_version !== null ? existing.game_version : (item.game_version ?? null);
            const nextNote = existing.note || (item.note ?? '');
            const nextUseCount = Math.max(existing.use_count, item.use_count);
            const nextCreatedAt = compareInstants(existing.created_at, item.created_at) <= 0 ? existing.created_at : item.created_at;
            const nextUpdatedAt = compareInstants(existing.updated_at, item.updated_at) >= 0 ? existing.updated_at : item.updated_at;
            const oldBytes = entryRawBytes(existing);
            const nextEntry = {
              ...existing,
              origin: nextOrigin,
              terms_db_revision: nextRevision,
              game_version: nextGameVersion,
              note: nextNote,
              use_count: nextUseCount,
              created_at: nextCreatedAt,
              updated_at: nextUpdatedAt,
            };
            rawBytes += entryRawBytes(nextEntry) - oldBytes;
            updateMergedByIdStmt.run(
              nextOrigin,
              nextRevision,
              nextGameVersion,
              nextNote,
              nextUseCount,
              nextCreatedAt,
              nextUpdatedAt,
              existing.id,
            );
            changed = true;
          } else {
            if (cnt >= MAX_TM_ENTRIES) {
              throw tmStorageError('tm_too_many_entries', `${cnt + 1} entries`);
            }
            insertStmt.run(
              item.direction,
              item.source_text,
              srcHash,
              normalizeSource(item.source_text),
              numericMask(item.source_text),
              item.target_text,
              item.prev_source_hash ?? null,
              item.next_source_hash ?? null,
              item.origin,
              item.terms_db_revision ?? null,
              item.game_version ?? null,
              item.note ?? '',
              item.use_count,
              item.created_at,
              item.updated_at,
            );
            cnt += 1;
            rawBytes += entryRawBytes(item);
            changed = true;
          }
        }

        if (changed && !withinMaxBytesFast(cnt, rawBytes)) {
          assertValidEntriesForStorage(readEntriesInternal());
        }
        const storageVersion = changed ? bumpVersionInternal() : readVersionInternal();
        return {
          ...(includeEntries ? { entries: readEntriesInternal() } : {}),
          storageVersion,
        };
      });
    },
    deleteEntry(identity, options = {}) {
      if (!identity || typeof identity !== 'object') throw new Error('tm_invalid_content');
      if (!VALID_DIRECTIONS.has(identity.direction)
        || typeof identity.source_text !== 'string'
        || typeof identity.target_text !== 'string') {
        throw new Error('tm_invalid_content');
      }
      const prevHash = identity.prev_source_hash ?? '';
      const nextHash = identity.next_source_hash ?? '';
      if (typeof prevHash !== 'string' || typeof nextHash !== 'string') {
        throw new Error('tm_invalid_content');
      }
      const includeEntries = options.includeEntries ?? true;
      return withImmediateTransaction(() => {
        const result = deleteOneStmt.run(
          identity.direction,
          sha256Hex(identity.source_text),
          prevHash,
          nextHash,
          identity.target_text,
        );
        const deleted = Number(result?.changes ?? 0) > 0;
        const storageVersion = deleted ? bumpVersionInternal() : readVersionInternal();
        return {
          deleted,
          ...(includeEntries ? { entries: readEntriesInternal() } : {}),
          storageVersion,
        };
      });
    },
    clearEntries() {
      return withImmediateTransaction(() => {
        const result = deleteAllStmt.run();
        const storageVersion = Number(result?.changes ?? 0) > 0 ? bumpVersionInternal() : readVersionInternal();
        return { entries: [], storageVersion };
      });
    },
    close() {
      sqlite.close();
    },
  };
}
