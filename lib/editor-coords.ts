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
