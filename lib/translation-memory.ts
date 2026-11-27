// Explicit in-memory Translation Memory, portable format `wuwaterm-tm-v1` (ADR 0023 / MY-491).
//
// Pure and in memory only: strict reader, canonical writer, confirmation helper, and 4-tier matcher.
// Never touches browser storage (localStorage / sessionStorage / IndexedDB), network, or `.wuwaterm` manuscripts.
import { sha256Hex } from './sha256.js';

export const TM_FORMAT = 'wuwaterm-tm-v1' as const;
export const TM_SCHEMA_VERSION = 1 as const;
export const TM_DIRECTION_VALUES = ['en', 'zh'] as const;
export const TM_ORIGIN_HUMAN = 'human_confirmed' as const;
export const TM_ORIGIN_IMPORTED = 'imported_confirmed' as const;
export const TM_ORIGIN_VALUES = [TM_ORIGIN_HUMAN, TM_ORIGIN_IMPORTED] as const;

export const TM_MATCH_CONTEXT_EXACT = 'context_exact' as const;
export const TM_MATCH_EXACT = 'exact' as const;
export const TM_MATCH_NUMERIC_VARIANT = 'numeric_variant' as const;
export const TM_MATCH_NORMALIZED_EXACT = 'normalized_exact' as const;
export const TM_MATCH_KINDS = [
  TM_MATCH_CONTEXT_EXACT,
  TM_MATCH_EXACT,
  TM_MATCH_NUMERIC_VARIANT,
  TM_MATCH_NORMALIZED_EXACT,
] as const;

export const TM_FRESHNESS_VERIFIED = 'verified_fresh' as const;
export const TM_FRESHNESS_STALE = 'known_stale' as const;
export const TM_FRESHNESS_UNKNOWN = 'provenance_unknown' as const;
export const TM_FRESHNESS_VALUES = [
  TM_FRESHNESS_VERIFIED,
  TM_FRESHNESS_STALE,
  TM_FRESHNESS_UNKNOWN,
] as const;

export const TM_STALE_TERMS_REVISION = 'terms_revision_changed' as const;
export const TM_STALE_GAME_VERSION = 'game_version_changed' as const;
export const TM_STALE_NUMERIC = 'numeric_changed' as const;
export const TM_STALE_PROVENANCE_UNKNOWN = 'provenance_unknown' as const;
export const TM_STALE_REASONS = [
  TM_STALE_TERMS_REVISION,
  TM_STALE_GAME_VERSION,
  TM_STALE_NUMERIC,
  TM_STALE_PROVENANCE_UNKNOWN,
] as const;

export const MAX_TM_ENTRIES = 10_000;
export const MAX_TM_BYTES = 8 * 1_048_576;
export const MAX_LOOKUP_LIMIT = 50;
export const MAX_USE_COUNT = 2_147_483_647;

export const TM_LIMITS = {
  source: { min: 1, max: 2_000 },
  target: { min: 1, max: 2_000 },
  note: { min: 0, max: 160 },
  revision: { min: 1, max: 128 },
} as const;

export const TM_ERROR_CODES = [
  'tm_not_json',
  'tm_too_large',
  'tm_too_many_entries',
  'tm_duplicate_key',
  'tm_forbidden_key',
  'tm_nul',
  'tm_surrogate',
  'tm_non_finite',
  'tm_invalid_content',
  'tm_unconfirmed_origin',
  'tm_duplicate_entry',
] as const;

export type TmErrorCode = (typeof TM_ERROR_CODES)[number];
export type TmDirection = (typeof TM_DIRECTION_VALUES)[number];
export type TmOrigin = (typeof TM_ORIGIN_VALUES)[number];
export type TmMatchKind = (typeof TM_MATCH_KINDS)[number];
export type TmFreshness = (typeof TM_FRESHNESS_VALUES)[number];
export type TmStaleReason = (typeof TM_STALE_REASONS)[number];

export type TmEntry = {
  direction: TmDirection;
  source_text: string;
  target_text: string;
  prev_source_hash: string | null;
  next_source_hash: string | null;
  origin: TmOrigin;
  terms_db_revision: string | null;
  game_version: string | null;
  note: string;
  use_count: number;
  created_at: string;
  updated_at: string;
};

export type TmFile = {
  format: typeof TM_FORMAT;
  schema_version: typeof TM_SCHEMA_VERSION;
  exported_at: string;
  entries: TmEntry[];
};

export type TmMatch = {
  entry: TmEntry;
  matchKind: TmMatchKind;
  freshness: TmFreshness;
  staleReasons: TmStaleReason[];
  numericChanged: boolean;
  needsRecheck: boolean;
};

export type TmMatchOptions = {
  prevSource?: string | null;
  nextSource?: string | null;
  currentTermsDbRevision?: string | null;
  currentGameVersion?: string | null;
  limit?: number;
};

/** A refused file or entry. `detail` names the offending location; it never carries file content. */
export class TranslationMemoryError extends Error {
  code: TmErrorCode;
  detail: string;
  constructor(code: TmErrorCode, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'TranslationMemoryError';
    this.code = code;
    this.detail = detail;
  }
}

const MAX_DEPTH = 8;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const TOP_KEYS = ['format', 'schema_version', 'exported_at', 'entries'] as const;
const ENTRY_KEYS = [
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
] as const;

const TIMESTAMP = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,9}))?Z$/;
const HASH_HEX = /^[0-9a-f]{64}$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const scalarLength = (text: string): number => Array.from(text).length;

function daysIn(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** An RFC 3339 UTC instant: uppercase `T` and `Z`, optional 1..9-digit fraction, and a real calendar day. */
export function isTmTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = TIMESTAMP.exec(value);
  return !!m && Number(m[3]) <= daysIn(Number(m[1]), Number(m[2]));
}

/** The current UTC instant to the second, matching Windows `tm_now`. */
export function tmNow(now: Date = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function compareInstants(a: string, b: string): number {
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

// ---- normalization, hashing, and numeric masking ----

/** SHA-256 of the exact UTF-8 source text, as lowercase 64-char hex. */
export function sourceHash(text: string): string {
  return sha256Hex(text);
}

/** Whitespace and line endings collapsed to single ASCII spaces without leading/trailing whitespace. */
export function normalizeSource(text: string): string {
  return text.trim().replace(/\s+/gu, ' ');
}

/** Every run of ASCII digits replaced by NUL marker, matching Windows `numeric_mask`. */
export function numericMask(text: string): string {
  return text.replace(/[0-9]+/g, '\u0000');
}

/** Context neighbour hash: whitespace-only/empty/null neighbour is no context (`null`). */
export function contextHash(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  return text.trim() ? sourceHash(text) : null;
}

function entryIdentity(entry: Pick<TmEntry, 'direction' | 'source_text' | 'prev_source_hash' | 'next_source_hash' | 'target_text'>): string {
  return `${entry.direction}\u0000${sourceHash(entry.source_text)}\u0000${entry.prev_source_hash ?? ''}\u0000${entry.next_source_hash ?? ''}\u0000${entry.target_text}`;
}

// ---- strict JSON reader ----

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const WHITESPACE = new Set([' ', '\t', '\n', '\r']);
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

function notJson(text: string, at: number, what: string): TranslationMemoryError {
  return new TranslationMemoryError('tm_not_json', `${what} at character ${at} of ${text.length}`);
}

function readJson(text: string): Json {
  let i = 0;

  const skip = () => { while (i < text.length && WHITESPACE.has(text[i]!)) i += 1; };

  function readString(): string {
    i += 1;
    let out = '';
    for (;;) {
      if (i >= text.length) throw notJson(text, i, 'unterminated string');
      const ch = text[i]!;
      if (ch === '"') { i += 1; return out; }
      if (ch === '\u0000') throw new TranslationMemoryError('tm_nul', `character ${i}`);
      if (ch < ' ') throw notJson(text, i, 'control character in string');
      if (ch !== '\\') { out += ch; i += 1; continue; }
      const esc = text[i + 1];
      if (esc === undefined) throw notJson(text, i, 'unterminated escape');
      if (esc !== 'u') {
        if (!Object.hasOwn(ESCAPES, esc)) throw notJson(text, i, 'unknown escape');
        out += ESCAPES[esc]!;
        i += 2;
        continue;
      }
      const hex = text.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw notJson(text, i, 'bad unicode escape');
      const unit = parseInt(hex, 16);
      i += 6;
      if (unit === 0) throw new TranslationMemoryError('tm_nul', `escape at character ${i - 6}`);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = /^\\u([dD][c-fC-F][0-9a-fA-F]{2})/.exec(text.slice(i, i + 6));
        if (!next) throw new TranslationMemoryError('tm_surrogate', `escape at character ${i - 6}`);
        out += String.fromCharCode(unit, parseInt(next[1]!, 16));
        i += 6;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) {
        throw new TranslationMemoryError('tm_surrogate', `escape at character ${i - 6}`);
      } else {
        out += String.fromCharCode(unit);
      }
    }
  }

  function readValue(depth: number): Json {
    if (depth > MAX_DEPTH) throw new TranslationMemoryError('tm_invalid_content', `nesting deeper than ${MAX_DEPTH}`);
    skip();
    const ch = text[i];
    if (ch === undefined) throw notJson(text, i, 'unexpected end');
    if (ch === '{') {
      i += 1;
      const object: Record<string, Json> = Object.create(null);
      skip();
      if (text[i] === '}') { i += 1; return object; }
      for (;;) {
        skip();
        if (text[i] !== '"') throw notJson(text, i, 'expected a key');
        const key = readString();
        if (FORBIDDEN_KEYS.has(key)) throw new TranslationMemoryError('tm_forbidden_key', key.slice(0, 40));
        if (Object.hasOwn(object, key)) throw new TranslationMemoryError('tm_duplicate_key', key.slice(0, 40));
        skip();
        if (text[i] !== ':') throw notJson(text, i, 'expected a colon');
        i += 1;
        object[key] = readValue(depth + 1);
        skip();
        if (text[i] === ',') { i += 1; continue; }
        if (text[i] === '}') { i += 1; return object; }
        throw notJson(text, i, 'expected a comma or a closing brace');
      }
    }
    if (ch === '[') {
      i += 1;
      const list: Json[] = [];
      skip();
      if (text[i] === ']') { i += 1; return list; }
      for (;;) {
        list.push(readValue(depth + 1));
        skip();
        if (text[i] === ',') { i += 1; continue; }
        if (text[i] === ']') { i += 1; return list; }
        throw notJson(text, i, 'expected a comma or a closing bracket');
      }
    }
    if (ch === '"') return readString();
    for (const [word, value] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(word, i)) { i += word.length; return value; }
    }
    for (const word of ['NaN', 'Infinity', '-Infinity']) {
      if (text.startsWith(word, i)) throw new TranslationMemoryError('tm_non_finite', word);
    }
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(text);
    if (!m) throw notJson(text, i, 'unexpected character');
    i += m[0].length;
    const value = Number(m[0]);
    if (!Number.isFinite(value)) throw new TranslationMemoryError('tm_non_finite', 'number out of range');
    return value;
  }

  const value = readValue(0);
  skip();
  if (i < text.length) throw notJson(text, i, 'content after the value');
  return value;
}

// ---- validation ----

function invalid(path: string, why: string): never {
  throw new TranslationMemoryError('tm_invalid_content', `${path}: ${why}`);
}

function exactKeys(value: object, keys: readonly string[], path: string) {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) invalid(`${path}.${key}`, 'unknown key');
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) invalid(`${path}.${key}`, 'missing key');
  }
}

function boundedString(value: unknown, path: string, min: number, max: number): string {
  if (typeof value !== 'string') return invalid(path, 'expected a string');
  if (value.includes('\u0000')) throw new TranslationMemoryError('tm_nul', path);
  if (LONE_SURROGATE.test(value)) throw new TranslationMemoryError('tm_surrogate', path);
  const n = scalarLength(value);
  if (n < min || n > max) invalid(path, `expected ${min}..${max} characters, got ${n}`);
  return value;
}

function optionalBoundedString(value: unknown, path: string, min: number, max: number): string | null {
  return value === null ? null : boundedString(value, path, min, max);
}

function hashOrNull(value: unknown, path: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !HASH_HEX.test(value)) {
    invalid(path, 'expected a lowercase SHA-256 digest or null');
  }
  return value;
}

function validateOrigin(value: unknown, path: string): TmOrigin {
  if (typeof value !== 'string' || !(TM_ORIGIN_VALUES as readonly string[]).includes(value)) {
    throw new TranslationMemoryError('tm_unconfirmed_origin', path);
  }
  return value as TmOrigin;
}

function validateEntry(value: unknown, index: number): TmEntry {
  const path = `entries[${index}]`;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid(path, 'expected an object');
  exactKeys(value, ENTRY_KEYS, path);
  const e = value as Record<string, unknown>;
  const direction = e.direction;
  if (typeof direction !== 'string' || !(TM_DIRECTION_VALUES as readonly string[]).includes(direction)) {
    invalid(`${path}.direction`, 'expected "en" or "zh"');
  }
  const sourceText = boundedString(e.source_text, `${path}.source_text`, TM_LIMITS.source.min, TM_LIMITS.source.max);
  const targetText = boundedString(e.target_text, `${path}.target_text`, TM_LIMITS.target.min, TM_LIMITS.target.max);
  if (!normalizeSource(sourceText) || !normalizeSource(targetText)) {
    invalid(path, 'expected non-blank source and target text');
  }
  const prevSourceHash = hashOrNull(e.prev_source_hash, `${path}.prev_source_hash`);
  const nextSourceHash = hashOrNull(e.next_source_hash, `${path}.next_source_hash`);
  const origin = validateOrigin(e.origin, `${path}.origin`);
  const termsDbRevision = optionalBoundedString(e.terms_db_revision, `${path}.terms_db_revision`, TM_LIMITS.revision.min, TM_LIMITS.revision.max);
  const gameVersion = optionalBoundedString(e.game_version, `${path}.game_version`, TM_LIMITS.revision.min, TM_LIMITS.revision.max);
  const note = boundedString(e.note, `${path}.note`, TM_LIMITS.note.min, TM_LIMITS.note.max);
  const useCount = e.use_count;
  if (typeof useCount !== 'number' || !Number.isInteger(useCount) || useCount < 0 || useCount > MAX_USE_COUNT) {
    invalid(`${path}.use_count`, `expected an integer in 0..${MAX_USE_COUNT}`);
  }
  if (!isTmTimestamp(e.created_at)) invalid(`${path}.created_at`, 'expected an RFC 3339 UTC timestamp');
  if (!isTmTimestamp(e.updated_at)) invalid(`${path}.updated_at`, 'expected an RFC 3339 UTC timestamp');

  return {
    direction: direction as TmDirection,
    source_text: sourceText,
    target_text: targetText,
    prev_source_hash: prevSourceHash,
    next_source_hash: nextSourceHash,
    origin,
    terms_db_revision: termsDbRevision,
    game_version: gameVersion,
    note,
    use_count: useCount,
    created_at: e.created_at as string,
    updated_at: e.updated_at as string,
  };
}

/** Validates a `wuwaterm-tm-v1` object and returns a clean copy; refuses anything invalid with `TranslationMemoryError`. */
export function validateTranslationMemory(value: unknown): TmFile {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid('$', 'expected an object');
  exactKeys(value, TOP_KEYS, '$');
  const v = value as Record<string, unknown>;
  if (v.format !== TM_FORMAT) invalid('$.format', `expected "${TM_FORMAT}"`);
  if (typeof v.schema_version !== 'number' || v.schema_version !== TM_SCHEMA_VERSION) {
    invalid('$.schema_version', `expected ${TM_SCHEMA_VERSION}`);
  }
  if (!isTmTimestamp(v.exported_at)) invalid('$.exported_at', 'expected an RFC 3339 UTC timestamp');
  if (!Array.isArray(v.entries)) return invalid('$.entries', 'expected an array');
  if (v.entries.length > MAX_TM_ENTRIES) {
    throw new TranslationMemoryError('tm_too_many_entries', `${v.entries.length} entries`);
  }
  const seen = new Set<string>();
  const entries = v.entries.map((item, index) => {
    const entry = validateEntry(item, index);
    const id = entryIdentity(entry);
    if (seen.has(id)) invalid(`entries[${index}]`, 'duplicate candidate');
    seen.add(id);
    return entry;
  });
  return {
    format: TM_FORMAT,
    schema_version: TM_SCHEMA_VERSION,
    exported_at: v.exported_at,
    entries,
  };
}

// ---- reading and writing ----

/** Parses a `wuwaterm-tm-v1` file from exact UTF-8 bytes; enforces the 8 MiB limit before decoding. */
export function parseTranslationMemoryBytes(bytes: Uint8Array): TmFile {
  if (bytes.byteLength > MAX_TM_BYTES) {
    throw new TranslationMemoryError('tm_too_large', `${bytes.byteLength} bytes`);
  }
  let text: string;
  try {
    // Keep any UTF-8 BOM as U+FEFF so the JSON parser refuses it: the format is plain UTF-8 without BOM.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new TranslationMemoryError('tm_not_json', 'not valid UTF-8');
  }
  if (text.includes('\u0000')) throw new TranslationMemoryError('tm_nul', 'NUL byte');
  return validateTranslationMemory(readJson(text));
}

/** Parses a `wuwaterm-tm-v1` file from text already in memory; refuses lone surrogates. */
export function parseTranslationMemoryText(text: string): TmFile {
  if (LONE_SURROGATE.test(text)) throw new TranslationMemoryError('tm_surrogate', 'isolated surrogate in text');
  return parseTranslationMemoryBytes(new TextEncoder().encode(text));
}

/** Canonical `wuwaterm-tm-v1` JSON: exact key order, 2-space indent, LF, trailing newline, <= 8 MiB UTF-8. */
export function serializeTranslationMemory(tm: TmFile): string {
  const clean = validateTranslationMemory(tm);
  const text = JSON.stringify({
    format: clean.format,
    schema_version: clean.schema_version,
    exported_at: clean.exported_at,
    entries: clean.entries.map(entry => ({
      direction: entry.direction,
      source_text: entry.source_text,
      target_text: entry.target_text,
      prev_source_hash: entry.prev_source_hash,
      next_source_hash: entry.next_source_hash,
      origin: entry.origin,
      terms_db_revision: entry.terms_db_revision,
      game_version: entry.game_version,
      note: entry.note,
      use_count: entry.use_count,
      created_at: entry.created_at,
      updated_at: entry.updated_at,
    })),
  }, null, 2) + '\n';
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > MAX_TM_BYTES) throw new TranslationMemoryError('tm_too_large', `${bytes} bytes`);
  return text;
}

// ---- in-memory mutations ----

export type TmConfirmCandidate = {
  sourceText: string;
  targetText: string;
  direction: TmDirection;
  prevSource?: string | null;
  nextSource?: string | null;
  origin?: TmOrigin | string;
  termsDbRevision?: string | null;
  gameVersion?: string | null;
  note?: string;
};

export type TmConfirmResult =
  | { status: 'added' | 'updated'; entry: TmEntry; entries: TmEntry[] }
  | { status: 'invalid'; error: 'field_required' | 'field_too_long' | 'field_invalid' | 'unconfirmed_origin' | 'list_full' | 'list_too_large'; field?: 'source' | 'target' | 'note'; max?: number };

/**
 * Records one explicitly confirmed translation into the in-memory TM list.
 * Strictly refuses any origin outside `"human_confirmed" | "imported_confirmed"` (default `"human_confirmed"`).
 */
export function confirmTranslationMemoryEntry(
  entries: readonly TmEntry[],
  candidate: TmConfirmCandidate,
  now: Date = new Date(),
): TmConfirmResult {
  const originRaw = candidate.origin ?? TM_ORIGIN_HUMAN;
  if (typeof originRaw !== 'string' || !(TM_ORIGIN_VALUES as readonly string[]).includes(originRaw)) {
    return { status: 'invalid', error: 'unconfirmed_origin' };
  }
  const origin = originRaw as TmOrigin;

  const checkText = (field: 'source' | 'target' | 'note', value: string, min: number, max: number): TmConfirmResult | null => {
    if (value.includes('\u0000') || LONE_SURROGATE.test(value)) {
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

  const sourceText = candidate.sourceText;
  const targetText = candidate.targetText;
  const note = (candidate.note ?? '').trim();
  const problem = checkText('source', sourceText, TM_LIMITS.source.min, TM_LIMITS.source.max)
    ?? checkText('target', targetText, TM_LIMITS.target.min, TM_LIMITS.target.max)
    ?? checkText('note', note, TM_LIMITS.note.min, TM_LIMITS.note.max);
  if (problem) return problem;

  const prevHash = contextHash(candidate.prevSource);
  const nextHash = contextHash(candidate.nextSource);
  const termsDbRevision = candidate.termsDbRevision ?? null;
  const gameVersion = candidate.gameVersion ?? null;
  const stamp = tmNow(now);

  const probe: TmEntry = {
    direction: candidate.direction,
    source_text: sourceText,
    target_text: targetText,
    prev_source_hash: prevHash,
    next_source_hash: nextHash,
    origin,
    terms_db_revision: termsDbRevision,
    game_version: gameVersion,
    note,
    use_count: 1,
    created_at: stamp,
    updated_at: stamp,
  };
  const key = entryIdentity(probe);
  const existingIndex = entries.findIndex(item => entryIdentity(item) === key);

  let nextEntries: TmEntry[];
  let resultEntry: TmEntry;
  let status: 'added' | 'updated';

  if (existingIndex >= 0) {
    const existing = entries[existingIndex]!;
    resultEntry = {
      ...existing,
      origin: existing.origin === TM_ORIGIN_HUMAN || origin === TM_ORIGIN_HUMAN ? TM_ORIGIN_HUMAN : TM_ORIGIN_IMPORTED,
      terms_db_revision: termsDbRevision !== null ? termsDbRevision : existing.terms_db_revision,
      game_version: gameVersion !== null ? gameVersion : existing.game_version,
      note: note || existing.note,
      use_count: Math.min(MAX_USE_COUNT, existing.use_count + 1),
      updated_at: stamp,
    };
    nextEntries = entries.map((item, idx) => (idx === existingIndex ? resultEntry : item));
    status = 'updated';
  } else {
    if (entries.length >= MAX_TM_ENTRIES) {
      return { status: 'invalid', error: 'list_full' };
    }
    resultEntry = probe;
    nextEntries = [...entries, resultEntry];
    status = 'added';
  }

  try {
    const validated = validateTranslationMemory({
      format: TM_FORMAT,
      schema_version: TM_SCHEMA_VERSION,
      exported_at: stamp,
      entries: nextEntries,
    });
    serializeTranslationMemory(validated);
    return {
      status,
      entry: validated.entries[existingIndex >= 0 ? existingIndex : validated.entries.length - 1]!,
      entries: validated.entries,
    };
  } catch (error) {
    if (error instanceof TranslationMemoryError && error.code === 'tm_too_large') {
      return { status: 'invalid', error: 'list_too_large' };
    }
    return { status: 'invalid', error: 'field_invalid', field: 'source' };
  }
}

/** Merges validated incoming entries into existing ones without duplicating candidates or downgrading human origin. */
export function mergeTranslationMemoryEntries(existing: readonly TmEntry[], incoming: readonly TmEntry[]): TmEntry[] {
  const byKey = new Map<string, number>();
  const merged: TmEntry[] = existing.map((item, index) => {
    byKey.set(entryIdentity(item), index);
    return { ...item };
  });

  for (const item of incoming) {
    const key = entryIdentity(item);
    const index = byKey.get(key);
    if (index !== undefined) {
      const cur = merged[index]!;
      merged[index] = {
        ...cur,
        origin: cur.origin === TM_ORIGIN_HUMAN || item.origin === TM_ORIGIN_HUMAN ? TM_ORIGIN_HUMAN : TM_ORIGIN_IMPORTED,
        terms_db_revision: cur.terms_db_revision !== null ? cur.terms_db_revision : item.terms_db_revision,
        game_version: cur.game_version !== null ? cur.game_version : item.game_version,
        note: cur.note || item.note,
        use_count: Math.max(cur.use_count, item.use_count),
        created_at: compareInstants(cur.created_at, item.created_at) <= 0 ? cur.created_at : item.created_at,
        updated_at: compareInstants(cur.updated_at, item.updated_at) >= 0 ? cur.updated_at : item.updated_at,
      };
      continue;
    }
    if (merged.length >= MAX_TM_ENTRIES) {
      throw new TranslationMemoryError('tm_too_many_entries', `${merged.length + 1} entries`);
    }
    byKey.set(key, merged.length);
    merged.push({ ...item });
  }
  serializeTranslationMemory({
    format: TM_FORMAT,
    schema_version: TM_SCHEMA_VERSION,
    exported_at: tmNow(),
    entries: merged,
  });
  return merged;
}

// ---- 4-tier matching engine ----

const RANK: Record<TmMatchKind, number> = {
  [TM_MATCH_CONTEXT_EXACT]: 0,
  [TM_MATCH_EXACT]: 1,
  [TM_MATCH_NUMERIC_VARIANT]: 2,
  [TM_MATCH_NORMALIZED_EXACT]: 3,
};

function exactKind(
  entry: TmEntry,
  prevHash: string | null,
  nextHash: string | null,
  allowContextExact: boolean,
): TmMatchKind {
  return allowContextExact &&
    (prevHash !== null || nextHash !== null) &&
    entry.prev_source_hash === prevHash &&
    entry.next_source_hash === nextHash
    ? TM_MATCH_CONTEXT_EXACT
    : TM_MATCH_EXACT;
}

function buildMatch(
  entry: TmEntry,
  matchKind: TmMatchKind,
  currentTermsDbRevision: string | null,
  currentGameVersion: string | null,
): TmMatch {
  const staleReasons: TmStaleReason[] = [];
  const termsChanged =
    currentTermsDbRevision !== null &&
    entry.terms_db_revision !== null &&
    entry.terms_db_revision !== currentTermsDbRevision;
  const gameChanged =
    currentGameVersion !== null &&
    entry.game_version !== null &&
    entry.game_version !== currentGameVersion;
  if (termsChanged) {
    staleReasons.push(TM_STALE_TERMS_REVISION);
  }
  if (gameChanged) {
    staleReasons.push(TM_STALE_GAME_VERSION);
  }
  const numericChanged = matchKind === TM_MATCH_NUMERIC_VARIANT;
  if (numericChanged) {
    staleReasons.push(TM_STALE_NUMERIC);
  }
  const provenanceUnknown =
    currentTermsDbRevision === null ||
    entry.terms_db_revision === null ||
    (currentGameVersion === null) !== (entry.game_version === null);
  if (provenanceUnknown) {
    staleReasons.push(TM_STALE_PROVENANCE_UNKNOWN);
  }
  const freshness: TmFreshness =
    termsChanged || gameChanged || numericChanged
      ? TM_FRESHNESS_STALE
      : provenanceUnknown
        ? TM_FRESHNESS_UNKNOWN
        : TM_FRESHNESS_VERIFIED;
  const needsRecheck = freshness !== TM_FRESHNESS_VERIFIED || numericChanged;
  return {
    entry,
    matchKind,
    freshness,
    staleReasons,
    numericChanged,
    needsRecheck,
  };
}

/** Re-evaluates a single cached TM hit's staleness/provenance against current service basis. */
export function recheckTmMatchFreshness(
  match: TmMatch,
  options: { currentTermsDbRevision?: string | null; currentGameVersion?: string | null } = {},
): TmMatch {
  return buildMatch(
    match.entry,
    match.matchKind,
    options.currentTermsDbRevision ?? null,
    options.currentGameVersion ?? null,
  );
}

/**
 * Matches confirmed TM entries against `source` in `direction`, ranked by:
 * `context_exact` > `exact` > `numeric_variant` > `normalized_exact`,
 * then `use_count` desc, then parsed `updated_at` instant desc.
 */
export function matchTranslationMemory(
  entries: readonly TmEntry[],
  source: string,
  direction: TmDirection,
  options: TmMatchOptions = {},
): TmMatch[] {
  if (!entries.length || !source) return [];
  const norm = normalizeSource(source);
  if (!norm || source.includes('\u0000') || LONE_SURROGATE.test(source) || scalarLength(source) > TM_LIMITS.source.max) {
    return [];
  }
  const rawLimit = options.limit ?? 5;
  const limit = Math.max(1, Math.min(MAX_LOOKUP_LIMIT, Math.trunc(rawLimit)));
  const neighbourTooLong = (value: string | null | undefined): boolean =>
    typeof value === 'string' && value.trim().length > 0 && scalarLength(value) > TM_LIMITS.source.max;
  const allowContextExact = !neighbourTooLong(options.prevSource) && !neighbourTooLong(options.nextSource);
  const prevHash = allowContextExact ? contextHash(options.prevSource) : null;
  const nextHash = allowContextExact ? contextHash(options.nextSource) : null;
  const currentTerms = options.currentTermsDbRevision ?? null;
  const currentGame = options.currentGameVersion ?? null;
  const masked = numericMask(source);

  const candidates: { match: TmMatch; order: number }[] = [];
  for (let idx = 0; idx < entries.length; idx += 1) {
    const entry = entries[idx]!;
    if (entry.direction !== direction) continue;
    let kind: TmMatchKind | null = null;
    if (entry.source_text === source) {
      kind = exactKind(entry, prevHash, nextHash, allowContextExact);
    } else if (normalizeSource(entry.source_text) === norm) {
      kind = TM_MATCH_NORMALIZED_EXACT;
    } else if (numericMask(entry.source_text) === masked) {
      kind = TM_MATCH_NUMERIC_VARIANT;
    }
    if (kind === null) continue;
    candidates.push({
      match: buildMatch(entry, kind, currentTerms, currentGame),
      order: idx,
    });
  }

  candidates.sort((a, b) => {
    const rankDiff = RANK[a.match.matchKind] - RANK[b.match.matchKind];
    if (rankDiff !== 0) return rankDiff;
    const useDiff = b.match.entry.use_count - a.match.entry.use_count;
    if (useDiff !== 0) return useDiff;
    const timeDiff = compareInstants(b.match.entry.updated_at, a.match.entry.updated_at);
    if (timeDiff !== 0) return timeDiff;
    return a.order - b.order;
  });

  return candidates.slice(0, limit).map(item => item.match);
}
