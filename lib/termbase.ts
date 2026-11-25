// The local user termbase, format `wuwaterm-termbase-v1` (contracts/termbase-v1/SPEC.md).
//
// Everything here is pure and in memory: a strict reader, a canonical writer and a literal reference matcher. Nothing in
// this module touches storage, the network or the manuscript; the termbase is a reference list the person keeps, never a
// dictionary and never an input to a translation or a review.
import {
  TERMBASE_DIRECTION_VALUES, TERMBASE_FORMAT, TERMBASE_KIND_VALUES, TERMBASE_LIMITS, TERMBASE_SCHEMA_VERSION,
} from './generated/termbase-contract.ts';
import type {
  ContractTermbaseEntryV1, ContractTermbaseV1, TermbaseDirection, TermbaseKind,
} from './generated/termbase-contract.ts';

export { TERMBASE_FORMAT, TERMBASE_DIRECTION_VALUES, TERMBASE_KIND_VALUES };
export type { TermbaseDirection, TermbaseKind };
export type TermbaseEntry = ContractTermbaseEntryV1;
export type Termbase = ContractTermbaseV1;

export const MAX_TERMBASE_BYTES = 1_048_576;
export const MAX_TERMBASE_ENTRIES = TERMBASE_LIMITS.entries;
/** Nesting deeper than a termbase can legitimately be (file, entries, entry) is refused before it can exhaust the stack. */
const MAX_DEPTH = 8;

export const TERMBASE_ERROR_CODES = [
  'termbase_not_json',
  'termbase_too_large',
  'termbase_too_many_entries',
  'termbase_duplicate_key',
  'termbase_forbidden_key',
  'termbase_nul',
  'termbase_surrogate',
  'termbase_non_finite',
  'termbase_invalid_content',
] as const;
export type TermbaseErrorCode = (typeof TERMBASE_ERROR_CODES)[number];

/** A refused file. `detail` names the offending location (for example `entries[3].source`); it never carries file content. */
export class TermbaseError extends Error {
  code: TermbaseErrorCode;
  detail: string;
  constructor(code: TermbaseErrorCode, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'TermbaseError';
    this.code = code;
    this.detail = detail;
  }
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const TOP_KEYS = ['format', 'schema_version', 'updated_at', 'entries'] as const;
const ENTRY_KEYS = ['id', 'source', 'target', 'direction', 'kind', 'note', 'updated_at'] as const;
const TIMESTAMP = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,9})?Z$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const scalarLength = (text: string): number => Array.from(text).length;

function daysIn(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** An RFC 3339 UTC instant: uppercase `T` and `Z`, an optional fraction, and a day that exists in its month. */
export function isTermbaseTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = TIMESTAMP.exec(value);
  return !!m && Number(m[3]) <= daysIn(Number(m[1]), Number(m[2]));
}

// ---- strict JSON reader ----

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const WHITESPACE = new Set([' ', '\t', '\n', '\r']);
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

function notJson(text: string, at: number, what: string): TermbaseError {
  return new TermbaseError('termbase_not_json', `${what} at character ${at} of ${text.length}`);
}

/**
 * RFC 8259 JSON with the refusals a termbase needs: a duplicate or prototype-pollution key, a NUL, an isolated surrogate
 * escape and a non-finite number each fail with their own code, and nothing else is tolerated (no comments, no trailing
 * commas, no leading zeros, no single quotes).
 */
function readJson(text: string): Json {
  let i = 0;

  const skip = () => { while (i < text.length && WHITESPACE.has(text[i]!)) i += 1; };

  function readString(): string {
    i += 1; // opening quote
    let out = '';
    for (;;) {
      if (i >= text.length) throw notJson(text, i, 'unterminated string');
      const ch = text[i]!;
      if (ch === '"') { i += 1; return out; }
      if (ch === '\u0000') throw new TermbaseError('termbase_nul', `character ${i}`);
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
      if (unit === 0) throw new TermbaseError('termbase_nul', `escape at character ${i - 6}`);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = /^\\u([dD][c-fC-F][0-9a-fA-F]{2})/.exec(text.slice(i, i + 6));
        if (!next) throw new TermbaseError('termbase_surrogate', `escape at character ${i - 6}`);
        out += String.fromCharCode(unit, parseInt(next[1]!, 16));
        i += 6;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) {
        throw new TermbaseError('termbase_surrogate', `escape at character ${i - 6}`);
      } else {
        out += String.fromCharCode(unit);
      }
    }
  }

  function readValue(depth: number): Json {
    if (depth > MAX_DEPTH) throw new TermbaseError('termbase_invalid_content', `nesting deeper than ${MAX_DEPTH}`);
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
        if (FORBIDDEN_KEYS.has(key)) throw new TermbaseError('termbase_forbidden_key', key);
        if (Object.hasOwn(object, key)) throw new TermbaseError('termbase_duplicate_key', key.slice(0, 40));
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
      if (text.startsWith(word, i)) throw new TermbaseError('termbase_non_finite', word);
    }
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(text);
    if (!m) throw notJson(text, i, 'unexpected character');
    i += m[0].length;
    const value = Number(m[0]);
    if (!Number.isFinite(value)) throw new TermbaseError('termbase_non_finite', 'number out of range');
    return value;
  }

  const value = readValue(0);
  skip();
  if (i < text.length) throw notJson(text, i, 'content after the value');
  return value;
}

// ---- validation ----

function invalid(path: string, why: string): never {
  throw new TermbaseError('termbase_invalid_content', `${path}: ${why}`);
}

function exactKeys(value: object, keys: readonly string[], path: string) {
  for (const key of Object.keys(value)) if (!keys.includes(key)) invalid(`${path}.${key}`, 'unknown key');
  for (const key of keys) if (!Object.hasOwn(value, key)) invalid(`${path}.${key}`, 'missing key');
}

function boundedString(value: unknown, path: string, min: number, max: number): string {
  if (typeof value !== 'string') return invalid(path, 'expected a string');
  if (value.includes('\u0000')) throw new TermbaseError('termbase_nul', path);
  if (LONE_SURROGATE.test(value)) throw new TermbaseError('termbase_surrogate', path);
  const n = scalarLength(value);
  if (n < min || n > max) invalid(path, `expected ${min}..${max} characters, got ${n}`);
  return value;
}

function validateEntry(value: unknown, index: number): TermbaseEntry {
  const path = `entries[${index}]`;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid(path, 'expected an object');
  exactKeys(value, ENTRY_KEYS, path);
  const e = value as Record<string, unknown>;
  const limits = TERMBASE_LIMITS;
  const direction = e.direction;
  const kind = e.kind;
  if (!(TERMBASE_DIRECTION_VALUES as readonly unknown[]).includes(direction)) invalid(`${path}.direction`, 'expected "en" or "zh"');
  if (!(TERMBASE_KIND_VALUES as readonly unknown[]).includes(kind)) invalid(`${path}.kind`, 'unknown kind');
  if (!isTermbaseTimestamp(e.updated_at)) invalid(`${path}.updated_at`, 'expected an RFC 3339 UTC timestamp');
  return {
    id: boundedString(e.id, `${path}.id`, limits.id.min, limits.id.max),
    source: boundedString(e.source, `${path}.source`, limits.source.min, limits.source.max),
    target: boundedString(e.target, `${path}.target`, limits.target.min, limits.target.max),
    direction: direction as TermbaseDirection,
    kind: kind as TermbaseKind,
    note: boundedString(e.note, `${path}.note`, limits.note.min, limits.note.max),
    updated_at: e.updated_at as string,
  };
}

/** Checks a termbase value against the contract and returns a clean copy; anything else throws a TermbaseError. */
export function validateTermbase(value: unknown): Termbase {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid('$', 'expected an object');
  exactKeys(value, TOP_KEYS, '$');
  const v = value as Record<string, unknown>;
  if (v.format !== TERMBASE_FORMAT) invalid('$.format', `expected "${TERMBASE_FORMAT}"`);
  if (v.schema_version !== TERMBASE_SCHEMA_VERSION) invalid('$.schema_version', `expected ${TERMBASE_SCHEMA_VERSION}`);
  if (!isTermbaseTimestamp(v.updated_at)) invalid('$.updated_at', 'expected an RFC 3339 UTC timestamp');
  if (!Array.isArray(v.entries)) return invalid('$.entries', 'expected an array');
  if (v.entries.length > MAX_TERMBASE_ENTRIES) throw new TermbaseError('termbase_too_many_entries', `${v.entries.length} entries`);
  const seen = new Set<string>();
  const entries = v.entries.map((item, index) => {
    const entry = validateEntry(item, index);
    if (seen.has(entry.id)) invalid(`entries[${index}].id`, 'duplicate id');
    seen.add(entry.id);
    return entry;
  });
  return { format: TERMBASE_FORMAT, schema_version: TERMBASE_SCHEMA_VERSION, updated_at: v.updated_at, entries };
}

// ---- reading and writing ----

/** Reads a termbase from the file's exact bytes. The 1 MiB limit applies to these bytes, before anything is decoded. */
export function parseTermbaseBytes(bytes: Uint8Array): Termbase {
  if (bytes.byteLength > MAX_TERMBASE_BYTES) throw new TermbaseError('termbase_too_large', `${bytes.byteLength} bytes`);
  let text: string;
  try {
    // A byte order mark is kept as U+FEFF so the JSON reader refuses it: the format is plain UTF-8.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new TermbaseError('termbase_not_json', 'not valid UTF-8');
  }
  if (text.includes('\u0000')) throw new TermbaseError('termbase_nul', 'NUL byte');
  return validateTermbase(readJson(text));
}

/** Reads a termbase from text already in memory. Isolated surrogates are refused, since they have no UTF-8 form. */
export function parseTermbaseText(text: string): Termbase {
  if (LONE_SURROGATE.test(text)) throw new TermbaseError('termbase_surrogate', 'isolated surrogate in text');
  return parseTermbaseBytes(new TextEncoder().encode(text));
}

/** The canonical file: key order as in the contract, two-space indent, LF, one trailing newline. */
export function serializeTermbase(termbase: Termbase): string {
  const clean = validateTermbase(termbase);
  const text = JSON.stringify({
    format: clean.format,
    schema_version: clean.schema_version,
    updated_at: clean.updated_at,
    entries: clean.entries.map(e => ({
      id: e.id, source: e.source, target: e.target, direction: e.direction, kind: e.kind, note: e.note, updated_at: e.updated_at,
    })),
  }, null, 2) + '\n';
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > MAX_TERMBASE_BYTES) throw new TermbaseError('termbase_too_large', `${bytes} bytes`);
  return text;
}

/** An RFC 3339 UTC instant to the second, the form every timestamp the page writes takes. */
export function termbaseNow(now: Date = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The next free `tb-NNN` id for a list of entries. */
export function nextEntryId(entries: readonly TermbaseEntry[]): string {
  const taken = new Set(entries.map(e => e.id));
  for (let n = entries.length + 1; ; n += 1) {
    const id = `tb-${String(n).padStart(3, '0')}`;
    if (!taken.has(id)) return id;
  }
}

// ---- reference matching ----

export type TermbaseSpan = { start: number; end: number };
export type TermbaseMatch = { entry: TermbaseEntry; count: number; spans: TermbaseSpan[] };
export type TermbaseMatches = { matches: TermbaseMatch[]; truncated: boolean };

/** Longest text the matcher reads, in UTF-16 code units; the rest of a very long manuscript is not scanned. */
export const MATCH_TEXT_LIMIT = 100_000;
/** Spans kept per entry; `count` still counts every occurrence. */
export const MATCH_SPANS_PER_ENTRY = 20;

const HAN = /\p{Script=Han}/u;
/** The direction a text reads as when the person has left it automatic: any Han character means Chinese into English. */
export function inferDirection(text: string): TermbaseDirection {
  return HAN.test(text) ? 'en' : 'zh';
}

// A word character for boundary purposes: a letter, digit or underscore that is not CJK, since CJK text has no spaces.
const WORD = String.raw`(?!\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul})[\p{L}\p{N}_]`;
const WORD_AT_START = new RegExp(`^${WORD}`, 'u');
const WORD_AT_END = new RegExp(`${WORD}$`, 'u');
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

function surfaceRegExp(surface: string): RegExp {
  const before = WORD_AT_START.test(surface) ? `(?<!${WORD})` : '';
  const after = WORD_AT_END.test(surface) ? `(?!${WORD})` : '';
  return new RegExp(`${before}${escapeRegExp(surface)}${after}`, 'giu');
}

/**
 * The entries of one direction whose source surface occurs literally in `text`, case-insensitively and, where the surface
 * begins or ends with a letter or digit, only as a whole word. Offsets are scalar offsets into the scanned text. This is a
 * reading aid and nothing else: a match changes no translation, review verdict or dictionary lookup.
 */
export function matchTermbase(entries: readonly TermbaseEntry[], text: string, direction: TermbaseDirection): TermbaseMatches {
  if (!entries.length || !text) return { matches: [], truncated: false };
  let scanned = text;
  let truncated = false;
  if (scanned.length > MATCH_TEXT_LIMIT) {
    truncated = true;
    scanned = scanned.slice(0, MATCH_TEXT_LIMIT);
    if (/[\uD800-\uDBFF]$/.test(scanned)) scanned = scanned.slice(0, -1);
  }
  const ascii = !/[^\u0000-\u007f]/.test(scanned);
  // UTF-16 index to scalar offset; only a text with astral characters needs the table.
  const scalarAt = ascii ? (index: number) => index : (() => {
    const offsets = new Map<number, number>();
    let scalar = 0;
    for (let unit = 0; unit < scanned.length; scalar += 1) {
      offsets.set(unit, scalar);
      unit += scanned.codePointAt(unit)! > 0xffff ? 2 : 1;
    }
    offsets.set(scanned.length, scalar);
    return (index: number) => offsets.get(index) ?? scalar;
  })();

  const matches: TermbaseMatch[] = [];
  for (const entry of entries) {
    if (entry.direction !== direction) continue;
    const spans: TermbaseSpan[] = [];
    let count = 0;
    for (const hit of scanned.matchAll(surfaceRegExp(entry.source))) {
      count += 1;
      if (spans.length < MATCH_SPANS_PER_ENTRY) {
        const start = hit.index!;
        spans.push({ start: scalarAt(start), end: scalarAt(start + hit[0].length) });
      }
    }
    if (count) matches.push({ entry, count, spans });
  }
  matches.sort((a, b) => a.spans[0]!.start - b.spans[0]!.start);
  return { matches, truncated };
}
