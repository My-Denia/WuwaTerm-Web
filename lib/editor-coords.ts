// Bidirectional coordinate conversions between raw document Unicode scalar
// offsets (preserving CRLF / CR) and LF-normalized UTF-16 DOM/CodeMirror offsets.
// Zero React or DOM dependencies so unit tests and workers can share it.
import { scalarToUtf16 } from './review-report.js';
import { scalarOffset, type ScalarOffset, type Span, type Utf16Offset } from './workbench-model.ts';

/** Normalize CRLF and lone CR to LF for DOM/CodeMirror display without mutating raw document bytes. */
export function normalizeLineBreaks(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** Map a UTF-16 offset in raw text (with CRLF/CR) to an LF-normalized UTF-16 offset. */
export function domOffset(rawText: string, offset: Utf16Offset | number): number {
  return rawText.slice(0, offset).replace(/\r\n?/g, '\n').length;
}

/** Map an LF-normalized UTF-16 offset back to a UTF-16 offset in raw text. */
export function rawOffset(rawText: string, domPos: number): number | null {
  if (domPos < 0) return null;
  let raw = 0;
  for (let dom = 0; dom < domPos; dom += 1) {
    if (raw >= rawText.length) return null;
    raw += rawText[raw] === '\r' && rawText[raw + 1] === '\n' ? 2 : 1;
  }
  return raw;
}

/** Map a raw Unicode scalar offset to an LF-normalized UTF-16 offset (textarea / CM6). */
export function scalarToDomUtf16(rawText: string, scalar: number): number | null {
  const utf16 = scalarToUtf16(rawText, scalar);
  if (utf16 === null) return null;
  return domOffset(rawText, utf16);
}

/** Map an LF-normalized UTF-16 offset to a raw Unicode scalar offset. */
export function domUtf16ToScalar(rawText: string, domPos: number): ScalarOffset | null {
  const raw = rawOffset(rawText, domPos);
  if (raw === null) return null;
  return scalarOffset(Array.from(rawText.slice(0, raw)).length);
}

export type DomChange = {
  fromA: number;
  toA: number;
  inserted: string;
};

/**
 * Append `right` to `left` without allowing a standalone trailing `\r` in `left`
 * to fuse with a leading `\n` in `right` into a single `\r\n` (which would swallow
 * one newline when normalized back to LF).
 */
function appendWithoutCrLfFusion(left: string, right: string): string {
  if (left.endsWith('\r') && right.startsWith('\n')) {
    return left.slice(0, -1) + '\n' + right;
  }
  return left + right;
}

/**
 * Compute a single minimal LF-coordinate change between two normalized DOM strings,
 * or null when they are identical.
 */
export function diffDomChange(oldDom: string, newDom: string): DomChange | null {
  if (oldDom === newDom) return null;
  let start = 0;
  const minLen = Math.min(oldDom.length, newDom.length);
  while (start < minLen && oldDom.charCodeAt(start) === newDom.charCodeAt(start)) start += 1;
  let oldEnd = oldDom.length;
  let newEnd = newDom.length;
  while (oldEnd > start && newEnd > start && oldDom.charCodeAt(oldEnd - 1) === newDom.charCodeAt(newEnd - 1)) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  return { fromA: start, toA: oldEnd, inserted: newDom.slice(start, newEnd) };
}

/**
 * Apply ascending, disjoint LF-normalized DOM/CodeMirror change ranges back onto
 * the raw document text so untouched regions keep their exact `\r\n` / `\r` bytes
 * while guaranteeing the invariant `normalizeLineBreaks(result) === expectedDom`.
 * Returns null if any offset falls outside the raw text.
 */
export function applyDomChangesToRaw(rawText: string, changes: readonly DomChange[]): string | null {
  if (changes.length === 0) return rawText;
  let out = '';
  let rawCursor = 0;
  for (const change of changes) {
    const rawFrom = rawOffset(rawText, change.fromA);
    const rawTo = rawOffset(rawText, change.toA);
    if (rawFrom === null || rawTo === null || rawFrom < rawCursor || rawTo < rawFrom) {
      return null;
    }
    out = appendWithoutCrLfFusion(out, rawText.slice(rawCursor, rawFrom));
    out = appendWithoutCrLfFusion(out, change.inserted);
    rawCursor = rawTo;
  }
  out = appendWithoutCrLfFusion(out, rawText.slice(rawCursor));
  return out;
}

/** Build a raw-text Span (preserving CRLF bytes) from an LF-normalized UTF-16 range. */
export function rawSpanFromDomRange(rawText: string, domFrom: number, domTo: number): Span | null {
  if (domFrom === domTo) return null;
  const lo = Math.min(domFrom, domTo);
  const hi = Math.max(domFrom, domTo);
  const start = rawOffset(rawText, lo);
  const end = rawOffset(rawText, hi);
  if (start === null || end === null) return null;
  return {
    start: scalarOffset(Array.from(rawText.slice(0, start)).length),
    end: scalarOffset(Array.from(rawText.slice(0, end)).length),
    text: rawText.slice(start, end),
  };
}
