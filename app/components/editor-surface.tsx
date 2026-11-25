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
      element.focus({ preventScroll: true });
      element.setSelectionRange(domOffset(text, start), domOffset(text, end));
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
