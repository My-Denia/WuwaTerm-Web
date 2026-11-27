'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { applyDomChangesToRaw, diffDomChange, domUtf16ToScalar, normalizeLineBreaks, rawSpanFromDomRange, scalarToDomUtf16 } from '../../lib/editor-coords';
import { highlightSegments } from '../../lib/review-report.js';
import type { ScalarOffset, Span } from '../../lib/workbench-model';
import { MarkdownPreview } from './markdown-preview';
import type { Cm6Editor as Cm6EditorComponent, Cm6EditorHandle, Cm6HandoffState } from './cm6-editor';

/**
 * The thin seam between the workspace and one text editor. The workspace speaks in document terms (scalar spans of the raw
 * text, edits with their IME composition state); the surface owns the DOM details (CRLF folding, selection offsets,
 * composition events, scroll ratio sync, inline highlights, and read-only Markdown preview).
 *
 * In `quick` mode (`enhanced = false`), this stays a zero-overhead native `<textarea>` with no CodeMirror bundle loaded.
 * In `manuscript` mode (`enhanced = true`), CodeMirror 6 is lazily imported on the client only and inherits live focus,
 * selection direction, and scroll position seamlessly across every switch.
 */
export type EditorSurfaceHandle = {
  focus(): void;
  /** Select `span` (scalars of the document text) and bring it into view; false when the span is not in the text. */
  reveal(span: Span): boolean;
  /** The selected range as a scalar span of the document text, or null when nothing is selected. */
  selection(): Span | null;
  /** Current vertical scroll ratio in [0, 1], or null when the active surface cannot scroll. */
  scrollRatio(): number | null;
  /** Programmatically scroll the active surface to a [0, 1] ratio without firing `onScrollRatio`. */
  setScrollRatio(ratio: number): void;
};

export type EditorEdit = { composing: boolean };

export type EditorHighlightKind =
  | 'term-verified'
  | 'term-conflict'
  | 'term-review'
  | 'structure'
  | 'semantic'
  | 'semantic-active'
  | 'termbase';

export type EditorHighlight = {
  start: ScalarOffset;
  end: ScalarOffset;
  kind: EditorHighlightKind;
  title?: string;
  /** Optional expected text at `[start, end]` verified against current document text before painting. */
  expectedText?: string;
};

type Props = {
  id: string;
  value: string;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  describedBy?: string;
  /** Accessible label element id, used to wire `aria-labelledby` onto CodeMirror 6's `role="textbox"`. */
  labelledBy?: string;
  /** Enable lazy-loaded CodeMirror 6 surface (manuscript mode); false stays native `<textarea>` (quick mode). */
  enhanced?: boolean;
  /** Inline highlight spans (raw Unicode scalar offsets) rendered in manuscript CM6 mode. */
  highlights?: readonly EditorHighlight[];
  preview?: boolean;
  previewEmptyText?: string;
  previewAriaLabel?: string;
  /** Called with the [0, 1] vertical scroll ratio on user scroll (paused during IME composition and programmatic sync/reveal). */
  onScrollRatio?: (ratio: number) => void;
  /** Called with the current caret/selection start as a Unicode scalar offset in the raw text. */
  onCursorChange?: (offset: ScalarOffset) => void;
  /**
   * Every change of the text. `composing` is true while an IME composition is open; its end is reported once more without
   * it, even when the committed text equals the last update, so the controller can close the composition step.
   */
  onEdit(value: string, edit: EditorEdit): void;
  onUndo?: () => void;
  onRedo?: () => void;
};

// Module-level cache so once CM6 loads on the client, switching back and forth is synchronous.
let cachedCm6: typeof Cm6EditorComponent | null = null;
let loadingCm6: Promise<typeof Cm6EditorComponent | null> | null = null;

function loadCm6Client(): Promise<typeof Cm6EditorComponent | null> {
  if (cachedCm6) return Promise.resolve(cachedCm6);
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (!loadingCm6) {
    loadingCm6 = import('./cm6-editor')
      .then(mod => {
        cachedCm6 = mod.Cm6Editor;
        return cachedCm6;
      })
      .catch(() => {
        loadingCm6 = null;
        return null;
      });
  }
  return loadingCm6;
}

const MIRRORED = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'letterSpacing', 'wordSpacing', 'lineHeight', 'textIndent',
  'textTransform', 'tabSize', 'wordBreak', 'overflowWrap', 'whiteSpace'] as const;

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

function readScrollRatio(element: HTMLElement | null): number | null {
  if (!element) return null;
  const max = element.scrollHeight - element.clientHeight;
  if (max <= 0) return null;
  return Math.min(1, Math.max(0, element.scrollTop / max));
}

function captureTextareaSnapshot(element: HTMLTextAreaElement, rawText: string): Cm6HandoffState {
  const backward = element.selectionDirection === 'backward';
  const anchorDom = backward ? element.selectionEnd : element.selectionStart;
  const headDom = backward ? element.selectionStart : element.selectionEnd;
  const sAnchor = domUtf16ToScalar(rawText, anchorDom);
  const sHead = domUtf16ToScalar(rawText, headDom);
  return {
    focused: document.activeElement === element,
    selection: sAnchor !== null && sHead !== null ? { anchor: sAnchor, head: sHead } : null,
    scrollRatio: readScrollRatio(element),
  };
}

type TextareaPaneProps = {
  id: string;
  value: string;
  placeholder?: string;
  rows: number;
  disabled?: boolean;
  hidden: boolean;
  describedBy?: string;
  boxRef: React.RefObject<HTMLTextAreaElement | null>;
  consumeInitialHandoff: () => Cm6HandoffState | null;
  onStateSnapshot: (snap: Cm6HandoffState) => void;
  suppressScrollBriefly: () => void;
  onScrollEl: (el: HTMLElement) => void;
  onCursorEl: (el: HTMLTextAreaElement, text: string) => void;
  onEdit: (value: string, edit: EditorEdit) => void;
  composingRef: React.RefObject<boolean>;
  submittedRef: React.RefObject<string>;
  latestRef: React.RefObject<string>;
};

/**
 * Isolated `<textarea>` child so its `useLayoutEffect` cleanup runs right before
 * `<Cm6Comp>` mounts in the same React commit — capturing live focus, selection
 * direction, and scroll ratio on every quick -> manuscript transition (1st, 2nd, Nth).
 */
function TextareaPane({
  id,
  value,
  placeholder,
  rows,
  disabled,
  hidden,
  describedBy,
  boxRef,
  consumeInitialHandoff,
  onStateSnapshot,
  suppressScrollBriefly,
  onScrollEl,
  onCursorEl,
  onEdit,
  composingRef,
  submittedRef,
  latestRef,
}: TextareaPaneProps) {
  const consumeRef = useRef(consumeInitialHandoff);
  const snapshotRef = useRef(onStateSnapshot);
  const suppressRef = useRef(suppressScrollBriefly);
  const onEditRef = useRef(onEdit);

  useEffect(() => {
    consumeRef.current = consumeInitialHandoff;
    snapshotRef.current = onStateSnapshot;
    suppressRef.current = suppressScrollBriefly;
    onEditRef.current = onEdit;
  });

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const handoff = consumeRef.current();
    if (handoff) {
      if (handoff.selection) {
        const anchor = scalarToDomUtf16(latestRef.current, handoff.selection.anchor);
        const head = scalarToDomUtf16(latestRef.current, handoff.selection.head);
        if (anchor !== null && head !== null) {
          const backward = anchor > head;
          el.setSelectionRange(Math.min(anchor, head), Math.max(anchor, head), backward ? 'backward' : 'forward');
        }
      }
      if (handoff.focused) {
        el.focus({ preventScroll: true });
      }
      if (handoff.scrollRatio !== null) {
        const ratio = handoff.scrollRatio;
        requestAnimationFrame(() => {
          if (boxRef.current !== el) return;
          const max = el.scrollHeight - el.clientHeight;
          if (max > 0) {
            suppressRef.current();
            el.scrollTop = Math.round(Math.min(1, Math.max(0, ratio)) * max);
          }
        });
      }
    }
    return () => {
      // Compare in LF coordinates because HTML <textarea>.value always normalizes CRLF/CR to LF.
      // Only forward an edit if the user genuinely had an unflushed DOM change, preserving untouched CRLF.
      const expectedDom = normalizeLineBreaks(latestRef.current);
      if (el.value !== expectedDom) {
        const delta = diffDomChange(expectedDom, el.value);
        const nextRaw = delta ? (applyDomChangesToRaw(latestRef.current, [delta]) ?? el.value) : el.value;
        submittedRef.current = nextRaw;
        latestRef.current = nextRaw;
        onEditRef.current(nextRaw, { composing: false });
      }
      snapshotRef.current(captureTextareaSnapshot(el, latestRef.current));
    };
  }, [boxRef, latestRef, submittedRef]);

  return (
    <textarea
      ref={boxRef}
      id={id}
      value={value}
      rows={rows}
      placeholder={placeholder}
      disabled={disabled}
      hidden={hidden}
      aria-describedby={describedBy}
      onFocus={event => onStateSnapshot(captureTextareaSnapshot(event.currentTarget, submittedRef.current))}
      onBlur={event => {
        const snap = captureTextareaSnapshot(event.currentTarget, submittedRef.current);
        onStateSnapshot({ ...snap, focused: false });
      }}
      onScroll={event => {
        onStateSnapshot(captureTextareaSnapshot(event.currentTarget, submittedRef.current));
        onScrollEl(event.currentTarget);
      }}
      onClick={event => onCursorEl(event.currentTarget, submittedRef.current)}
      onKeyUp={event => onCursorEl(event.currentTarget, submittedRef.current)}
      onSelect={event => onCursorEl(event.currentTarget, submittedRef.current)}
      onCompositionStart={() => { composingRef.current = true; }}
      onCompositionEnd={event => {
        composingRef.current = false;
        submittedRef.current = event.currentTarget.value;
        onEdit(event.currentTarget.value, { composing: false });
        onCursorEl(event.currentTarget, event.currentTarget.value);
      }}
      onChange={event => {
        const open = composingRef.current || (event.nativeEvent as InputEvent).isComposing === true;
        submittedRef.current = event.target.value;
        onEdit(event.target.value, { composing: open });
        onCursorEl(event.target, event.target.value);
      }}
    />
  );
}

export const EditorSurfaceAdapter = forwardRef<EditorSurfaceHandle, Props>(function EditorSurfaceAdapter(props, ref) {
  const box = useRef<HTMLTextAreaElement>(null);
  const cm6Ref = useRef<Cm6EditorHandle>(null);
  const previewBox = useRef<HTMLDivElement>(null);
  const [Cm6Comp, setCm6Comp] = useState<typeof Cm6EditorComponent | null>(() => (props.enhanced ? cachedCm6 : null));
  const pendingHandoffRef = useRef<Cm6HandoffState | null>(null);
  const hasMountedOnce = useRef(false);

  const composing = useRef(false);
  const suppressScroll = useRef(false);
  const suppressRaf = useRef<number | null>(null);
  const previewRef = useRef(!!props.preview);
  const latest = useRef(props.value);
  const submitted = useRef(props.value);
  const onScrollRatioRef = useRef(props.onScrollRatio);
  const onCursorChangeRef = useRef(props.onCursorChange);
  const useCm6 = Boolean(props.enhanced && Cm6Comp);
  const useCm6Ref = useRef(useCm6);

  useEffect(() => {
    hasMountedOnce.current = true;
    previewRef.current = !!props.preview;
    latest.current = props.value;
    submitted.current = props.value;
    onScrollRatioRef.current = props.onScrollRatio;
    onCursorChangeRef.current = props.onCursorChange;
    useCm6Ref.current = useCm6;
  });

  // Lazily load CodeMirror 6 only when manuscript mode (`enhanced`) is active on the client.
  useEffect(() => {
    if (!props.enhanced) return;
    if (Cm6Comp) return;
    let active = true;
    void loadCm6Client().then(loaded => {
      if (!active || !loaded) return;
      setCm6Comp(() => loaded);
    });
    return () => { active = false; };
  }, [props.enhanced, Cm6Comp]);

  const handleStateSnapshot = useCallback((snap: Cm6HandoffState) => {
    pendingHandoffRef.current = snap;
  }, []);

  const consumeInitialHandoff = useCallback((): Cm6HandoffState | null => {
    if (!hasMountedOnce.current) return null;
    const snap = pendingHandoffRef.current;
    pendingHandoffRef.current = null;
    return snap;
  }, []);

  const reportCursor = useCallback((element: HTMLTextAreaElement, text: string) => {
    pendingHandoffRef.current = captureTextareaSnapshot(element, text);
    const callback = onCursorChangeRef.current;
    if (!callback) return;
    const scalar = domUtf16ToScalar(text, element.selectionStart);
    if (scalar !== null) callback(scalar);
  }, []);

  const suppressScrollBriefly = useCallback(() => {
    suppressScroll.current = true;
    if (suppressRaf.current !== null) cancelAnimationFrame(suppressRaf.current);
    suppressRaf.current = requestAnimationFrame(() => {
      suppressRaf.current = requestAnimationFrame(() => {
        suppressScroll.current = false;
        suppressRaf.current = null;
      });
    });
  }, []);

  useEffect(() => () => {
    if (suppressRaf.current !== null) cancelAnimationFrame(suppressRaf.current);
  }, []);

  const activeTextareaScroller = (): HTMLElement | null => (previewRef.current ? previewBox.current : box.current);

  useImperativeHandle(ref, () => ({
    focus() {
      if (previewRef.current) { previewBox.current?.focus(); return; }
      if (useCm6Ref.current && cm6Ref.current) { cm6Ref.current.focus(); return; }
      box.current?.focus();
    },
    reveal(span) {
      if (useCm6Ref.current && cm6Ref.current) {
        return cm6Ref.current.reveal(span);
      }
      const element = box.current;
      const text = latest.current;
      if (!element) return false;
      const located = highlightSegments(text, span);
      const domStart = scalarToDomUtf16(text, span.start);
      const domEnd = scalarToDomUtf16(text, span.end);
      if (!located || domStart === null || domEnd === null) return false;
      suppressScrollBriefly();
      element.focus({ preventScroll: true });
      element.setSelectionRange(domStart, domEnd);
      scrollSelectionIntoBox(element, domStart, domEnd);
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      return true;
    },
    selection() {
      if (useCm6Ref.current && cm6Ref.current) {
        return cm6Ref.current.selection();
      }
      const element = box.current;
      const text = latest.current;
      if (!element || element.selectionStart === element.selectionEnd) return null;
      return rawSpanFromDomRange(text, element.selectionStart, element.selectionEnd);
    },
    scrollRatio() {
      if (previewRef.current) return readScrollRatio(previewBox.current);
      if (useCm6Ref.current && cm6Ref.current) return cm6Ref.current.scrollRatio();
      return readScrollRatio(activeTextareaScroller());
    },
    setScrollRatio(ratio) {
      if (previewRef.current) {
        const element = previewBox.current;
        if (!element) return;
        const max = element.scrollHeight - element.clientHeight;
        if (max <= 0) return;
        const nextTop = Math.round(Math.min(1, Math.max(0, ratio)) * max);
        if (Math.abs(element.scrollTop - nextTop) < 1) return;
        suppressScrollBriefly();
        element.scrollTop = nextTop;
        return;
      }
      if (useCm6Ref.current && cm6Ref.current) {
        cm6Ref.current.setScrollRatio(ratio);
        return;
      }
      if (composing.current) return;
      const element = activeTextareaScroller();
      if (!element) return;
      const max = element.scrollHeight - element.clientHeight;
      if (max <= 0) return;
      const clamped = Math.min(1, Math.max(0, ratio));
      const nextTop = Math.round(clamped * max);
      if (Math.abs(element.scrollTop - nextTop) < 1) return;
      suppressScrollBriefly();
      element.scrollTop = nextTop;
    },
  }), [suppressScrollBriefly]);

  const handleScroll = useCallback((element: HTMLElement) => {
    if (suppressScroll.current || composing.current) return;
    const ratio = readScrollRatio(element);
    if (ratio !== null) {
      onScrollRatioRef.current?.(ratio);
    }
  }, []);

  return <>
    {useCm6 && Cm6Comp ? (
      <Cm6Comp
        ref={cm6Ref}
        id={props.id}
        value={props.value}
        placeholder={props.placeholder}
        disabled={props.disabled}
        describedBy={props.describedBy}
        labelledBy={props.labelledBy}
        hidden={!!props.preview}
        highlights={props.highlights}
        consumeInitialHandoff={consumeInitialHandoff}
        onStateSnapshot={handleStateSnapshot}
        onScrollRatio={ratio => {
          onScrollRatioRef.current?.(ratio);
        }}
        onCursorChange={offset => {
          onCursorChangeRef.current?.(offset);
        }}
        onEdit={props.onEdit}
        onUndo={props.onUndo}
        onRedo={props.onRedo}
      />
    ) : (
      <TextareaPane
        id={props.id}
        value={props.value}
        rows={props.rows ?? 5}
        placeholder={props.placeholder}
        disabled={props.disabled}
        hidden={!!props.preview}
        describedBy={props.describedBy}
        boxRef={box}
        consumeInitialHandoff={consumeInitialHandoff}
        onStateSnapshot={handleStateSnapshot}
        suppressScrollBriefly={suppressScrollBriefly}
        onScrollEl={handleScroll}
        onCursorEl={reportCursor}
        onEdit={props.onEdit}
        composingRef={composing}
        submittedRef={submitted}
        latestRef={latest}
      />
    )}
    {props.preview && (
      <MarkdownPreview
        ref={previewBox}
        value={props.value}
        emptyText={props.previewEmptyText ?? ''}
        ariaLabel={props.previewAriaLabel ?? props.id}
        onScroll={event => handleScroll(event.currentTarget)}
      />
    )}
  </>;
});
