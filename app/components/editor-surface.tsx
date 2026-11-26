'use client';

import { forwardRef, useImperativeHandle, useRef } from 'react';
import { highlightSegments, scalarToUtf16 } from '../../lib/review-report.js';
import type { Span, Utf16Offset } from '../../lib/workbench-model';

/**
 * The thin seam between the workspace and one text editor. The workspace speaks in document terms (scalar spans of the raw
 * text, edits with their IME composition state); the surface owns the DOM details (CRLF folding in a textarea, selection
 * offsets, composition events). Another editor can replace the textarea behind this handle without touching the workspace.
 */
export type EditorSurfaceHandle = {
  focus(): void;
  /** Select `span` (scalars of the document text) and bring it into view; false when the span is not in the text. */
  reveal(span: Span): boolean;
  /** The selected range as a scalar span of the document text, or null when nothing is selected. */
  selection(): Span | null;
};

export type EditorEdit = { composing: boolean };

type Props = {
  id: string;
  value: string;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  describedBy?: string;
  /**
   * Every change of the text. `composing` is true while an IME composition is open; its end is reported once more without
   * it, even when the committed text equals the last update, so the controller can close the composition step.
   */
  onEdit(value: string, edit: EditorEdit): void;
};

// A textarea shows CRLF and CR as one LF; document offsets count the raw text.
const domOffset = (text: string, offset: Utf16Offset) => text.slice(0, offset).replace(/\r\n?/g, '\n').length;

// Copied onto the mirror so its text wraps exactly as the textarea's content box does.
const MIRRORED = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'letterSpacing', 'wordSpacing', 'lineHeight', 'textIndent',
  'textTransform', 'tabSize', 'wordBreak', 'overflowWrap', 'whiteSpace'] as const;

/**
 * Scroll the textarea's own content so the selected DOM range is in view, a third of the way down. Setting the selection does not
 * scroll a textarea that was focused with preventScroll, so a located word deep in a long text stayed outside the box. The offset
 * is measured on a hidden copy of the text that wraps at the same width as the textarea's content box.
 */
function scrollSelectionIntoBox(element: HTMLTextAreaElement, start: number, end: number) {
  const style = getComputedStyle(element);
  const mirror = document.createElement('div');
  for (const key of MIRRORED) mirror.style[key] = style[key];
  const paddingX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  Object.assign(mirror.style, {
    position: 'absolute', top: '0', left: '-9999px', visibility: 'hidden', overflow: 'hidden', boxSizing: 'content-box',
    width: `${Math.max(0, element.clientWidth - paddingX)}px`, height: 'auto', padding: `${style.paddingTop} 0 0 0`, border: '0',
  });
  if (style.whiteSpace === 'normal') mirror.style.whiteSpace = 'pre-wrap';
  mirror.textContent = element.value.slice(0, start);
  const marker = document.createElement('span');
  marker.textContent = element.value.slice(start, end) || '\u200b';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const top = marker.offsetTop;
  const bottom = top + marker.offsetHeight;
  mirror.remove();
  if (top >= element.scrollTop && bottom <= element.scrollTop + element.clientHeight) return;
  element.scrollTop = Math.max(0, Math.round(top - element.clientHeight / 3));
}

function rawOffset(text: string, offset: number): number | null {
  let raw = 0;
  for (let dom = 0; dom < offset; dom += 1) {
    if (raw >= text.length) return null;
    raw += text[raw] === '\r' && text[raw + 1] === '\n' ? 2 : 1;
  }
  return raw;
}

export const EditorSurfaceAdapter = forwardRef<EditorSurfaceHandle, Props>(function EditorSurfaceAdapter(props, ref) {
  const box = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const latest = useRef(props.value);
  latest.current = props.value;

  useImperativeHandle(ref, () => ({
    focus() { box.current?.focus(); },
    reveal(span) {
      const element = box.current;
      const text = latest.current;
      if (!element) return false;
      const located = highlightSegments(text, span);
      const start = scalarToUtf16(text, span.start);
      const end = scalarToUtf16(text, span.end);
      if (!located || start === null || end === null) return false;
      const domStart = domOffset(text, start);
      const domEnd = domOffset(text, end);
      element.focus({ preventScroll: true });
      element.setSelectionRange(domStart, domEnd);
      scrollSelectionIntoBox(element, domStart, domEnd);
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      return true;
    },
    selection() {
      const element = box.current;
      const text = latest.current;
      if (!element || element.selectionStart === element.selectionEnd) return null;
      const start = rawOffset(text, element.selectionStart);
      const end = rawOffset(text, element.selectionEnd);
      if (start === null || end === null) return null;
      return { start: Array.from(text.slice(0, start)).length, end: Array.from(text.slice(0, end)).length, text: text.slice(start, end) };
    },
  }), []);

  return <textarea
    ref={box}
    id={props.id}
    value={props.value}
    rows={props.rows ?? 5}
    placeholder={props.placeholder}
    disabled={props.disabled}
    aria-describedby={props.describedBy}
    onCompositionStart={() => { composing.current = true; }}
    onCompositionEnd={event => {
      composing.current = false;
      props.onEdit(event.currentTarget.value, { composing: false });
    }}
    onChange={event => {
      const open = composing.current || (event.nativeEvent as InputEvent).isComposing === true;
      props.onEdit(event.target.value, { composing: open });
    }}
  />;
});
