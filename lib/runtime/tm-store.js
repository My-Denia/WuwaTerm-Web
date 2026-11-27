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
const VALID_DIRECTIONS = new Set(['en', 'zh']);
const VALID_ORIGINS = new Set(['human_confirmed', 'imported_confirmed']);

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

const NUMERIC_MASK_ESCAPE = '\uE000';

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

function assertValidEntriesForStorage(entries) {
  if (!Array.isArray(entries)) throw new Error('tm_invalid_content');
  if (entries.length > MAX_TM_ENTRIES) throw new Error('tm_too_many_entries');
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('tm_invalid_content');
    if (!VALID_DIRECTIONS.has(entry.direction)) throw new Error('tm_invalid_content');
    if (!VALID_ORIGINS.has(entry.origin)) throw new Error('tm_unconfirmed_origin');
    if (typeof entry.source_text !== 'string' || !normalizeSource(entry.source_text)) throw new Error('tm_invalid_content');
    if (typeof entry.target_text !== 'string' || !normalizeSource(entry.target_text)) throw new Error('tm_invalid_content');
  }
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
  if (Buffer.byteLength(serialized, 'utf8') > MAX_TM_BYTES) {
    throw new Error('tm_too_large');
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
    deleteEntry(identity) {
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
          entries: readEntriesInternal(),
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
