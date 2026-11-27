'use client';

// Lazy-loaded CodeMirror 6 editor for manuscript mode.
// Keeps quick mode free of CM6 bundle weight, preserves raw Unicode scalar
// coordinates & CRLF semantics, renders inline highlight decorations, and
// uses native EditorSelection + EditorView.scrollIntoView (zero mirror DOM).
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import {
  Annotation,
  Compartment,
  EditorSelection,
  EditorState,
  StateEffect,
  StateField,
  type Range,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  drawSelection,
  highlightActiveLine,
  keymap,
  placeholder as cmPlaceholder,
  type DecorationSet,
} from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import {
  domUtf16ToScalar,
  normalizeLineBreaks,
  rawSpanFromDomRange,
  scalarToDomUtf16,
} from '../../lib/editor-coords';
import { highlightSegments } from '../../lib/review-report.js';
import type { ScalarOffset, Span } from '../../lib/workbench-model';
import type { EditorEdit, EditorHighlight, EditorSurfaceHandle } from './editor-surface';

export type Cm6HandoffState = {
  focused: boolean;
  selection: { from: ScalarOffset; to: ScalarOffset } | null;
  scrollRatio: number | null;
};

export type Cm6EditorProps = {
  id: string;
  value: string;
  placeholder?: string;
  disabled?: boolean;
  describedBy?: string;
  hidden?: boolean;
  highlights?: readonly EditorHighlight[];
  initialHandoff?: Cm6HandoffState | null;
  onHandoffConsumed?: () => void;
  onScrollRatio?: (ratio: number) => void;
  onCursorChange?: (offset: ScalarOffset) => void;
  onEdit(value: string, edit: EditorEdit): void;
  onUndo?: () => void;
  onRedo?: () => void;
};

const externalSync = Annotation.define<boolean>();
const setHighlightsEffect = StateEffect.define<DecorationSet>();

const highlightField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decorations, tr) {
    let next = tr.docChanged ? decorations.map(tr.changes) : decorations;
    for (const effect of tr.effects) {
      if (effect.is(setHighlightsEffect)) next = effect.value;
    }
    return next;
  },
  provide: field => EditorView.decorations.from(field),
});

function buildDecorations(rawText: string, docLength: number, highlights?: readonly EditorHighlight[]): DecorationSet {
  if (!highlights || highlights.length === 0 || docLength === 0) return Decoration.none;
  const ranges: Range<Decoration>[] = [];
  for (const item of highlights) {
    if (item.start >= item.end) continue;
    const from = scalarToDomUtf16(rawText, item.start);
    const to = scalarToDomUtf16(rawText, item.end);
    if (from === null || to === null) continue;
    const clampedFrom = Math.max(0, Math.min(docLength, from));
    const clampedTo = Math.max(0, Math.min(docLength, to));
    if (clampedFrom >= clampedTo) continue;
    ranges.push(
      Decoration.mark({
        class: `cm-wt-hl cm-wt-hl-${item.kind}`,
        attributes: item.title ? { title: item.title, 'data-hl-kind': item.kind } : { 'data-hl-kind': item.kind },
      }).range(clampedFrom, clampedTo),
    );
  }
  if (ranges.length === 0) return Decoration.none;
  return Decoration.set(ranges, true);
}

function readScrollRatio(element: HTMLElement | null): number | null {
  if (!element) return null;
  const max = element.scrollHeight - element.clientHeight;
  if (max <= 0) return null;
  return Math.min(1, Math.max(0, element.scrollTop / max));
}

const editorTheme = EditorView.theme({
  '&': {
    backgroundColor: 'var(--field-bg)',
    color: 'var(--text)',
    border: '1px solid var(--field-line)',
    borderRadius: '10px',
    fontSize: '14px',
    fontFamily: 'inherit',
    transition: 'border-color .15s ease, box-shadow .15s ease',
  },
  '&.cm-focused': {
    outline: 'none',
    borderColor: 'var(--accent)',
    boxShadow: '0 0 0 2px color-mix(in srgb, var(--accent) 26%, transparent)',
  },
  '.cm-scroller': {
    fontFamily: 'inherit',
    lineHeight: '1.75',
    overflowY: 'auto',
    overflowX: 'hidden',
    minHeight: 'clamp(220px, 38vh, 460px)',
    maxHeight: 'clamp(340px, 56vh, 640px)',
  },
  '.cm-content': {
    padding: '13px 14px',
    caretColor: 'var(--accent)',
    minHeight: '100%',
  },
  '.cm-line': {
    padding: '0',
  },
  '.cm-placeholder': {
    color: 'var(--placeholder)',
  },
  '.cm-activeLine': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 5%, transparent)',
  },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 28%, transparent)',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--accent)',
    borderLeftWidth: '2px',
  },
});

export type Cm6EditorHandle = EditorSurfaceHandle & {
  caretOrSelection(): { from: ScalarOffset; to: ScalarOffset } | null;
  isFocused(): boolean;
};

export const Cm6Editor = forwardRef<Cm6EditorHandle, Cm6EditorProps>(function Cm6Editor(props, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const editableComp = useRef(new Compartment());
  const readOnlyComp = useRef(new Compartment());
  const placeholderComp = useRef(new Compartment());
  const contentAttrsComp = useRef(new Compartment());

  const latestRaw = useRef(props.value);
  latestRaw.current = props.value;
  const latestHighlights = useRef(props.highlights);
  latestHighlights.current = props.highlights;
  const onEditRef = useRef(props.onEdit);
  onEditRef.current = props.onEdit;
  const onScrollRatioRef = useRef(props.onScrollRatio);
  onScrollRatioRef.current = props.onScrollRatio;
  const onCursorChangeRef = useRef(props.onCursorChange);
  onCursorChangeRef.current = props.onCursorChange;
  const onUndoRef = useRef(props.onUndo);
  onUndoRef.current = props.onUndo;
  const onRedoRef = useRef(props.onRedo);
  onRedoRef.current = props.onRedo;
  const initialHandoffRef = useRef(props.initialHandoff);
  const onHandoffConsumedRef = useRef(props.onHandoffConsumed);
  onHandoffConsumedRef.current = props.onHandoffConsumed;

  const composingRef = useRef(false);
  const suppressScroll = useRef(false);
  const suppressRaf = useRef<number | null>(null);

  const suppressScrollBriefly = () => {
    suppressScroll.current = true;
    if (suppressRaf.current !== null) cancelAnimationFrame(suppressRaf.current);
    suppressRaf.current = requestAnimationFrame(() => {
      suppressRaf.current = requestAnimationFrame(() => {
        suppressScroll.current = false;
        suppressRaf.current = null;
      });
    });
  };

  useEffect(() => {
    const parent = containerRef.current;
    if (!parent) return;

    const initialDoc = normalizeLineBreaks(latestRaw.current);
    const contentAttrs: Record<string, string> = {
      id: props.id,
      'aria-multiline': 'true',
      'data-editor-surface': 'cm6',
      ...(props.describedBy ? { 'aria-describedby': props.describedBy } : {}),
    };

    const workbenchKeymap = keymap.of([
      {
        key: 'Mod-z',
        run: () => {
          if (!onUndoRef.current) return false;
          onUndoRef.current();
          return true;
        },
      },
      {
        key: 'Mod-Shift-z',
        run: () => {
          if (!onRedoRef.current) return false;
          onRedoRef.current();
          return true;
        },
      },
      {
        key: 'Mod-y',
        run: () => {
          if (!onRedoRef.current) return false;
          onRedoRef.current();
          return true;
        },
      },
      ...defaultKeymap,
    ]);

    const state = EditorState.create({
      doc: initialDoc,
      extensions: [
        EditorView.lineWrapping,
        drawSelection(),
        highlightActiveLine(),
        editorTheme,
        highlightField,
        workbenchKeymap,
        editableComp.current.of(EditorView.editable.of(!props.disabled)),
        readOnlyComp.current.of(EditorState.readOnly.of(!!props.disabled)),
        placeholderComp.current.of(cmPlaceholder(props.placeholder ?? '')),
        contentAttrsComp.current.of(EditorView.contentAttributes.of(contentAttrs)),
        EditorView.updateListener.of(update => {
          if (update.docChanged) {
            const isExternal = update.transactions.some(tr => tr.annotation(externalSync));
            if (!isExternal) {
              const nextVal = update.state.doc.toString();
              const isComposing = composingRef.current || update.view.composing;
              latestRaw.current = nextVal;
              onEditRef.current(nextVal, { composing: isComposing });
            }
          }
          if (update.selectionSet || update.docChanged) {
            const cb = onCursorChangeRef.current;
            if (cb) {
              const scalar = domUtf16ToScalar(latestRaw.current, update.state.selection.main.from);
              if (scalar !== null) cb(scalar);
            }
          }
        }),
        EditorView.domEventHandlers({
          compositionstart: () => {
            composingRef.current = true;
          },
          compositionend: (_event, view) => {
            composingRef.current = false;
            const committed = view.state.doc.toString();
            latestRaw.current = committed;
            onEditRef.current(committed, { composing: false });
            const cb = onCursorChangeRef.current;
            if (cb) {
              const scalar = domUtf16ToScalar(latestRaw.current, view.state.selection.main.from);
              if (scalar !== null) cb(scalar);
            }
          },
        }),
      ],
    });

    const view = new EditorView({ state, parent });
    viewRef.current = view;
    Object.defineProperty(view.contentDOM, '__cm6View', { value: view, configurable: true });

    const initialDecos = buildDecorations(latestRaw.current, view.state.doc.length, latestHighlights.current);
    if (initialDecos !== Decoration.none) {
      view.dispatch({ effects: setHighlightsEffect.of(initialDecos) });
    }

    const onScroll = () => {
      if (suppressScroll.current || composingRef.current || view.composing) return;
      const ratio = readScrollRatio(view.scrollDOM);
      if (ratio !== null) onScrollRatioRef.current?.(ratio);
    };
    view.scrollDOM.addEventListener('scroll', onScroll, { passive: true });

    const handoff = initialHandoffRef.current;
    if (handoff) {
      initialHandoffRef.current = null;
      onHandoffConsumedRef.current?.();
      if (handoff.selection) {
        const from = scalarToDomUtf16(latestRaw.current, handoff.selection.from);
        const to = scalarToDomUtf16(latestRaw.current, handoff.selection.to);
        if (from !== null && to !== null) {
          const docLen = view.state.doc.length;
          view.dispatch({
            selection: EditorSelection.range(
              Math.max(0, Math.min(docLen, from)),
              Math.max(0, Math.min(docLen, to)),
            ),
            annotations: externalSync.of(true),
          });
        }
      }
      if (handoff.focused) {
        view.contentDOM.focus({ preventScroll: true });
      }
      if (handoff.scrollRatio !== null) {
        const targetRatio = handoff.scrollRatio;
        requestAnimationFrame(() => {
          const scroller = view.scrollDOM;
          const max = scroller.scrollHeight - scroller.clientHeight;
          if (max > 0) {
            suppressScrollBriefly();
            scroller.scrollTop = Math.round(Math.min(1, Math.max(0, targetRatio)) * max);
          }
        });
      }
    }

    return () => {
      delete (view.contentDOM as unknown as { __cm6View?: unknown }).__cm6View;
      view.scrollDOM.removeEventListener('scroll', onScroll);
      if (suppressRaf.current !== null) {
        cancelAnimationFrame(suppressRaf.current);
        suppressRaf.current = null;
      }
      view.destroy();
      viewRef.current = null;
    };
  // Mount once per CM6 lifecycle; reactive props update via compartments/effects below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.id]);

  // Sync external value changes (undo, redo, import, translation) without clobbering CRLF bytes or caret.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const normalized = normalizeLineBreaks(props.value);
    const current = view.state.doc.toString();
    if (normalized === current) return;
    const prevSel = view.state.selection.main;
    const nextAnchor = Math.min(prevSel.anchor, normalized.length);
    const nextHead = Math.min(prevSel.head, normalized.length);
    view.dispatch({
      changes: { from: 0, to: current.length, insert: normalized },
      selection: EditorSelection.range(nextAnchor, nextHead),
      annotations: externalSync.of(true),
    });
  }, [props.value]);

  // Sync inline highlights.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const decos = buildDecorations(props.value, view.state.doc.length, props.highlights);
    view.dispatch({ effects: setHighlightsEffect.of(decos) });
  }, [props.value, props.highlights]);

  // Sync disabled / placeholder / aria-describedby compartments.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: [
        editableComp.current.reconfigure(EditorView.editable.of(!props.disabled)),
        readOnlyComp.current.reconfigure(EditorState.readOnly.of(!!props.disabled)),
        placeholderComp.current.reconfigure(cmPlaceholder(props.placeholder ?? '')),
        contentAttrsComp.current.reconfigure(
          EditorView.contentAttributes.of({
            id: props.id,
            'aria-multiline': 'true',
            'data-editor-surface': 'cm6',
            ...(props.describedBy ? { 'aria-describedby': props.describedBy } : {}),
          }),
        ),
      ],
    });
  }, [props.disabled, props.placeholder, props.describedBy, props.id]);

  useImperativeHandle(ref, () => ({
    focus() {
      viewRef.current?.contentDOM.focus();
    },
    isFocused() {
      const view = viewRef.current;
      return !!view && (view.hasFocus || document.activeElement === view.contentDOM);
    },
    caretOrSelection() {
      const view = viewRef.current;
      if (!view) return null;
      const { from, to } = view.state.selection.main;
      const sFrom = domUtf16ToScalar(latestRaw.current, from);
      const sTo = domUtf16ToScalar(latestRaw.current, to);
      if (sFrom === null || sTo === null) return null;
      return { from: sFrom, to: sTo };
    },
    reveal(span: Span) {
      const view = viewRef.current;
      const raw = latestRaw.current;
      if (!view) return false;
      const located = highlightSegments(raw, span);
      const cmStart = scalarToDomUtf16(raw, span.start);
      const cmEnd = scalarToDomUtf16(raw, span.end);
      if (!located || cmStart === null || cmEnd === null) return false;
      const docLen = view.state.doc.length;
      const from = Math.max(0, Math.min(docLen, cmStart));
      const to = Math.max(0, Math.min(docLen, cmEnd));
      suppressScrollBriefly();
      view.contentDOM.focus({ preventScroll: true });
      view.dispatch({
        selection: EditorSelection.range(from, to),
        effects: EditorView.scrollIntoView(EditorSelection.range(from, to), { y: 'center' }),
      });
      view.dom.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      return true;
    },
    selection() {
      const view = viewRef.current;
      if (!view) return null;
      const { from, to } = view.state.selection.main;
      return rawSpanFromDomRange(latestRaw.current, from, to);
    },
    scrollRatio() {
      return readScrollRatio(viewRef.current?.scrollDOM ?? null);
    },
    setScrollRatio(ratio: number) {
      const view = viewRef.current;
      if (!view || composingRef.current || view.composing) return;
      const scroller = view.scrollDOM;
      const max = scroller.scrollHeight - scroller.clientHeight;
      if (max <= 0) return;
      const clamped = Math.min(1, Math.max(0, ratio));
      const nextTop = Math.round(clamped * max);
      if (Math.abs(scroller.scrollTop - nextTop) < 1) return;
      suppressScrollBriefly();
      scroller.scrollTop = nextTop;
    },
  }), []);

  return (
    <div
      ref={containerRef}
      className="cm6-editor-host"
      data-editor-engine="cm6"
      data-editor-id={props.id}
      hidden={!!props.hidden}
    />
  );
});
