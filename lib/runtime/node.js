// This module is imported only by the Node startup hook, never by the public
// Cloudflare runtime. The database contains aggregate admission counters only.
import { closeSync, constants, lstatSync, openSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { POOL_LIMITS } from '../shared-pool.js';
import { configuredUpstream } from '../wuwaterm-proxy.js';

export const NODE_ENVIRONMENT = Symbol.for('wuwaterm.node.environment');
const APPLICATION_ID = 0x5755544d;
const SCHEMA_VERSION = 1;
const BUSY_TIMEOUT_MS = 250;
const COLUMNS = [
  'id', 'second_key', 'minute_key', 'day_key', 'upstream_used',
  'translation_minute_used', 'terms_used', 'translation_used',
  'character_used', 'meta_used', 'review_used',
];
const SCHEMA = `CREATE TABLE shared_pool (
  id INTEGER PRIMARY KEY NOT NULL CHECK(id=1),
  second_key INTEGER NOT NULL CHECK(second_key>=0),
  minute_key INTEGER NOT NULL CHECK(minute_key>=0),
  day_key INTEGER NOT NULL CHECK(day_key>=0),
  upstream_used INTEGER NOT NULL CHECK(upstream_used>=0),
  translation_minute_used INTEGER NOT NULL CHECK(translation_minute_used>=0),
  terms_used INTEGER NOT NULL CHECK(terms_used>=0),
  translation_used INTEGER NOT NULL CHECK(translation_used>=0),
  character_used INTEGER NOT NULL CHECK(character_used>=0),
  meta_used INTEGER NOT NULL CHECK(meta_used>=0),
  review_used INTEGER NOT NULL CHECK(review_used>=0)
)`;

const LIMIT_NAMES = Object.freeze({
  upstreamPerMinute: 'WUWATERM_LOCAL_LIMIT_UPSTREAM_PER_MINUTE',
  translationsPerMinute: 'WUWATERM_LOCAL_LIMIT_TRANSLATIONS_PER_MINUTE',
  termsPerDay: 'WUWATERM_LOCAL_LIMIT_TERMS_PER_DAY',
  translationsPerDay: 'WUWATERM_LOCAL_LIMIT_TRANSLATIONS_PER_DAY',
  charactersPerDay: 'WUWATERM_LOCAL_LIMIT_CHARACTERS_PER_DAY',
  metaPerDay: 'WUWATERM_LOCAL_LIMIT_META_PER_DAY',
  reviewsPerDay: 'WUWATERM_LOCAL_LIMIT_REVIEWS_PER_DAY',
});

function invalidConfiguration() {
  // Do not include environment values, file paths or database errors in logs.
  return new Error('Invalid self-host runtime configuration or database');
}

function localLimits(source) {
  const limits = {};
  const knownNames = new Set(Object.values(LIMIT_NAMES));
  if (Object.keys(source).some(name => name.startsWith('WUWATERM_LOCAL_LIMIT_') && !knownNames.has(name))) throw invalidConfiguration();
  for (const [key, name] of Object.entries(LIMIT_NAMES)) {
    const value = source[name];
    if (value === undefined) {
      limits[key] = POOL_LIMITS[key];
      continue;
    }
    if (typeof value !== 'string' || !/^[1-9][0-9]*$/u.test(value)) throw invalidConfiguration();
    const parsed = Number(value);
    const max = key === 'charactersPerDay' ? 1_000_000_000 : 1_000_000;
    if (!Number.isSafeInteger(parsed) || parsed > max) throw invalidConfiguration();
    limits[key] = parsed;
  }
  return Object.freeze(limits);
}

function openPool(filename) {
  if (typeof filename !== 'string' || !isAbsolute(filename) || filename.includes('\0')) throw invalidConfiguration();
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
      // Tag and initialize together. An interrupted initialization leaves an
      // unrecognized file and fails closed on the next startup.
      sqlite.exec('BEGIN IMMEDIATE');
      sqlite.exec(SCHEMA);
      sqlite.exec(`PRAGMA application_id=${APPLICATION_ID}`);
      sqlite.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
      sqlite.exec('COMMIT');
    } else {
      const app = sqlite.prepare('PRAGMA application_id').get();
      const version = sqlite.prepare('PRAGMA user_version').get();
      if (app.application_id !== APPLICATION_ID || version.user_version !== SCHEMA_VERSION) throw invalidConfiguration();
    }
    const columns = sqlite.prepare('PRAGMA table_info(shared_pool)').all().map(column => column.name);
    if (columns.length !== COLUMNS.length || columns.some((name, i) => name !== COLUMNS[i])) throw invalidConfiguration();
    if (sqlite.prepare('PRAGMA quick_check(1)').get().quick_check !== 'ok') throw invalidConfiguration();
    sqlite.exec('PRAGMA journal_mode=WAL');
    sqlite.exec('PRAGMA synchronous=FULL');
  } catch {
    try { sqlite?.close(); } catch { /* startup fails closed */ }
    throw invalidConfiguration();
  }
  return {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let values = [];
      const adapter = {
        bind(...args) { values = args; return adapter; },
        async first() {
          // D1 binds by ordinal; node:sqlite binds numbered placeholders by name.
          const bindings = Object.fromEntries(values.map((value, i) => [String(i + 1), value]));
          return (values.length ? statement.get(bindings) : statement.get()) ?? null;
        },
      };
      return adapter;
    },
    close() { sqlite.close(); },
  };
}

export function createNodeEnvironment(source = process.env) {
  if (source.WUWATERM_RUNTIME_MODE !== 'selfhost'
    || !['true', 'false'].includes(source.WUWATERM_TRANSLATION_ENABLED)) throw invalidConfiguration();
  const result = {
    WUWATERM_RUNTIME_MODE: 'selfhost',
    WUWATERM_TRANSLATION_ENABLED: source.WUWATERM_TRANSLATION_ENABLED,
    WUWATERM_API_BASE_URL: source.WUWATERM_API_BASE_URL,
    WUWATERM_API_ALLOWED_HOST: source.WUWATERM_API_ALLOWED_HOST,
    WUWATERM_SITE_DEVICE_TOKEN: source.WUWATERM_SITE_DEVICE_TOKEN,
    WUWATERM_LOCAL_LIMITS: localLimits(source),
  };
  if (!configuredUpstream(result)) throw invalidConfiguration();
  return { ...result, DB: openPool(source.WUWATERM_LOCAL_DB_PATH) };
}

export function initializeNodeEnvironment(source = process.env) {
  if (source.WUWATERM_RUNTIME_MODE !== 'selfhost') throw invalidConfiguration();
  if (globalThis[NODE_ENVIRONMENT]) return globalThis[NODE_ENVIRONMENT];
  const environment = createNodeEnvironment(source);
  globalThis[NODE_ENVIRONMENT] = environment;
  return environment;
}
