'use client';

// Lazy-loaded CodeMirror 6 editor for manuscript mode.
// Keeps quick mode free of CM6 bundle weight, preserves raw Unicode scalar
// coordinates & CRLF bytes on untouched regions, keeps cross-line IME replacements
// as one undo step, renders verified inline highlight decorations, and uses native
// EditorSelection + EditorView.scrollIntoView (zero mirror DOM).
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
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
  applyDomChangesToRaw,
  createCompositionTracker,
  domUtf16ToScalar,
  normalizeLineBreaks,
  rawSpanFromDomRange,
  scalarToDomUtf16,
  type DomChange,
} from '../../lib/editor-coords';
import { highlightSegments } from '../../lib/review-report.js';
import type { ScalarOffset, Span } from '../../lib/workbench-model';
import type { EditorEdit, EditorHighlight, EditorSurfaceHandle } from './editor-surface';

export type Cm6HandoffState = {
  focused: boolean;
  selection: { anchor: ScalarOffset; head: ScalarOffset } | null;
  scrollRatio: number | null;
};

export type Cm6EditorProps = {
  id: string;
  value: string;
  placeholder?: string;
  disabled?: boolean;
  describedBy?: string;
  labelledBy?: string;
  hidden?: boolean;
  highlights?: readonly EditorHighlight[];
  /** Reads the latest handoff snapshot captured from the outgoing textarea immediately before CM6 mounts. */
  consumeInitialHandoff?: () => Cm6HandoffState | null;
  /** Called on focus/blur and right before CM6 unmounts so returning to textarea preserves live focus/selection/scroll. */
  onStateSnapshot?: (snapshot: Cm6HandoffState) => void;
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
    if (item.expectedText !== undefined) {
      const verified = highlightSegments(rawText, { start: item.start, end: item.end, text: item.expectedText });
      if (!verified) continue;
    }
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

function buildContentAttrs(props: Pick<Cm6EditorProps, 'id' | 'describedBy' | 'labelledBy'>): Record<string, string> {
  return {
    id: props.id,
    'aria-multiline': 'true',
    'data-editor-surface': 'cm6',
    ...(props.labelledBy ? { 'aria-labelledby': props.labelledBy } : {}),
    ...(props.describedBy ? { 'aria-describedby': props.describedBy } : {}),
  };
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
  snapshotState(): Cm6HandoffState | null;
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
  const consumeInitialHandoffRef = useRef(props.consumeInitialHandoff);
  consumeInitialHandoffRef.current = props.consumeInitialHandoff;
  const onStateSnapshotRef = useRef(props.onStateSnapshot);
  onStateSnapshotRef.current = props.onStateSnapshot;

  const composingActiveRef = useRef(false);
  const suppressScroll = useRef(false);
  const suppressRaf = useRef<number | null>(null);

  const captureViewSnapshot = (view: EditorView | null): Cm6HandoffState | null => {
    if (!view) return null;
    const { anchor, head } = view.state.selection.main;
    const sAnchor = domUtf16ToScalar(latestRaw.current, anchor);
    const sHead = domUtf16ToScalar(latestRaw.current, head);
    return {
      focused: view.hasFocus || document.activeElement === view.contentDOM,
      selection: sAnchor !== null && sHead !== null ? { anchor: sAnchor, head: sHead } : null,
      scrollRatio: readScrollRatio(view.scrollDOM),
    };
  };

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

  // Use useLayoutEffect so mount/unmount snapshot handoff executes synchronously
  // in the exact DOM commit phase with outgoing/incoming <textarea>.
  useLayoutEffect(() => {
    const parent = containerRef.current;
    if (!parent) return;

    const initialDoc = normalizeLineBreaks(latestRaw.current);
    const contentAttrs = buildContentAttrs(props);

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

    let editContext: EventTarget | null = null;
    const composition = createCompositionTracker({
      scheduleFallback(onFire) {
        let timerId: ReturnType<typeof setTimeout> | null = null;
        let rafId: number | null = requestAnimationFrame(() => {
          rafId = null;
          timerId = setTimeout(() => {
            timerId = null;
            onFire();
          }, 50);
        });
        return () => {
          if (rafId !== null) {
            cancelAnimationFrame(rafId);
            rafId = null;
          }
          if (timerId !== null) {
            clearTimeout(timerId);
            timerId = null;
          }
        };
      },
      flushPendingObserver() {
        const obs = (viewRef.current as (EditorView & {
          observer?: { flush?: () => boolean; delayedFlush?: number; delayedAndroidKey?: unknown };
        }) | null)?.observer;
        if (!obs) return false;
        // CM6's DOMObserver.flush() returns false without applying mutations whenever
        // `delayedFlush >= 0 || delayedAndroidKey` (Android next-frame flush). Keep
        // the composition transaction open for that upcoming flush instead of closing early.
        const hasDeferredFlush = () => (typeof obs.delayedFlush === 'number' && obs.delayedFlush >= 0) || Boolean(obs.delayedAndroidKey);
        if (hasDeferredFlush()) return true;
        const flushed = obs.flush?.();
        return flushed === false && hasDeferredFlush();
      },
      onFinalize(syncFromView) {
        composingActiveRef.current = false;
        const activeView = viewRef.current;
        if (!activeView) return;
        if (syncFromView) {
          const docStr = activeView.state.doc.toString();
          if (normalizeLineBreaks(latestRaw.current) !== docStr) {
            latestRaw.current = docStr;
          }
        }
        onEditRef.current(latestRaw.current, { composing: false });
        if (syncFromView) {
          const cb = onCursorChangeRef.current;
          if (cb) {
            const scalar = domUtf16ToScalar(latestRaw.current, activeView.state.selection.main.from);
            if (scalar !== null) cb(scalar);
          }
        }
      },
    });

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
          const isExternal = update.transactions.some(tr => tr.annotation(externalSync));
          const isComposeEvent = update.transactions.some(tr => tr.isUserEvent('input.type.compose'));

          if (update.docChanged && !isExternal) {
            // In Chromium EditContext mode, CM6 can close a missed compositionend
            // internally (`view.composing === false`) before a normal non-compose
            // `textupdate` (e.g. typing `!`). Close the prior IME step using the
            // PRE-CHANGE raw text (`latestRaw.current`, never `update.state.doc`)
            // so `!` is applied once as its own separate undo entry.
            if (editContext && composition.isComposing() && !composition.isPendingEnd() && !update.view.composing && !isComposeEvent) {
              composition.closeBeforeNewEdit();
            }
            const edits: DomChange[] = [];
            update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
              edits.push({ fromA, toA, inserted: inserted.toString() });
            });
            const nextRaw = applyDomChangesToRaw(latestRaw.current, edits) ?? update.state.doc.toString();
            latestRaw.current = nextRaw;

            const isComposing = composition.onLocalDocChange(update.view.composing, isComposeEvent);
            composingActiveRef.current = isComposing;
            onEditRef.current(nextRaw, { composing: isComposing });
          }

          if (!isExternal && (update.selectionSet || update.docChanged)) {
            const snap = captureViewSnapshot(update.view);
            if (snap) onStateSnapshotRef.current?.(snap);
            const cb = onCursorChangeRef.current;
            if (cb) {
              const scalar = domUtf16ToScalar(latestRaw.current, update.state.selection.main.from);
              if (scalar !== null) cb(scalar);
            }
          }
        }),
      ],
    });

    const view = new EditorView({ state, parent });
    viewRef.current = view;
    Object.defineProperty(view.contentDOM, '__cm6View', { value: view, configurable: true });

    // Capture-phase compositionstart & beforeinput fire BEFORE CM6's bubble-phase
    // DOMObserver deletes a cross-line selection, keeping the entire IME replacement
    // inside a single controller composition transaction (one undo step).
    const onBeforeInputCapture = (event: InputEvent) => {
      if (event.isComposing || event.inputType === 'insertCompositionText' || event.inputType === 'deleteCompositionText') {
        composition.begin();
        composingActiveRef.current = true;
      } else {
        composition.onNonComposeEvent();
        composingActiveRef.current = composition.isComposing();
      }
    };
    const onKeyDownCapture = (event: KeyboardEvent) => {
      if (!event.isComposing && event.key !== 'Process') {
        composition.onNonComposeEvent();
        composingActiveRef.current = composition.isComposing();
      }
    };
    const onCompositionStartCapture = () => {
      composition.begin();
      composingActiveRef.current = true;
    };
    // Bubble-phase listener registered AFTER `new EditorView`: CM6 sets
    // `view.inputState.composing = -1` synchronously in its own `compositionend`
    // handler and defers DOMObserver flushing to a microtask (desktop) or next
    // animation frame (Android Chrome `flushSoon()`). Keep the composition open
    // until that final `docChanged`, a subsequent non-composition event, or the
    // cross-frame fallback timer fires.
    const onCompositionEndBubble = () => {
      composition.onCompositionEnd();
    };
    // With Chromium EditContext, compositionstart/compositionend fire on
    // `view.contentDOM.editContext` (not `contentDOM`), and `textupdate` commits
    // synchronously before `compositionend`, so close immediately so subsequent
    // non-IME input (e.g. `!`) starts its own undo step.
    const onEditContextCompositionEnd = () => {
      composition.finalizeNow();
      composingActiveRef.current = composition.isComposing();
    };
    const onFocus = () => {
      const snap = captureViewSnapshot(view);
      if (snap) onStateSnapshotRef.current?.(snap);
    };
    const onBlur = () => {
      composition.onNonComposeEvent();
      composingActiveRef.current = composition.isComposing();
      const snap = captureViewSnapshot(view);
      if (snap) onStateSnapshotRef.current?.(snap);
    };
    const onScroll = () => {
      if (suppressScroll.current || composingActiveRef.current || view.composing) return;
      const ratio = readScrollRatio(view.scrollDOM);
      if (ratio !== null) {
        const snap = captureViewSnapshot(view);
        if (snap) onStateSnapshotRef.current?.(snap);
        onScrollRatioRef.current?.(ratio);
      }
    };

    view.contentDOM.addEventListener('beforeinput', onBeforeInputCapture, true);
    view.contentDOM.addEventListener('keydown', onKeyDownCapture, true);
    view.contentDOM.addEventListener('compositionstart', onCompositionStartCapture, true);
    view.contentDOM.addEventListener('compositionend', onCompositionEndBubble, false);
    view.contentDOM.addEventListener('focus', onFocus);
    view.contentDOM.addEventListener('blur', onBlur);
    view.scrollDOM.addEventListener('scroll', onScroll, { passive: true });
    editContext = (view.contentDOM as HTMLElement & { editContext?: EventTarget | null }).editContext ?? null;
    if (editContext) {
      editContext.addEventListener('compositionstart', onCompositionStartCapture);
      editContext.addEventListener('compositionend', onEditContextCompositionEnd);
    }

    const initialDecos = buildDecorations(latestRaw.current, view.state.doc.length, latestHighlights.current);
    if (initialDecos !== Decoration.none) {
      view.dispatch({ effects: setHighlightsEffect.of(initialDecos), annotations: externalSync.of(true) });
    }

    const handoff = consumeInitialHandoffRef.current?.() ?? null;
    if (handoff) {
      if (handoff.selection) {
        const anchor = scalarToDomUtf16(latestRaw.current, handoff.selection.anchor);
        const head = scalarToDomUtf16(latestRaw.current, handoff.selection.head);
        if (anchor !== null && head !== null) {
          const docLen = view.state.doc.length;
          view.dispatch({
            selection: EditorSelection.range(
              Math.max(0, Math.min(docLen, anchor)),
              Math.max(0, Math.min(docLen, head)),
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
          if (viewRef.current !== view) return;
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
      composition.dispose();
      composingActiveRef.current = false;
      const exitSnap = captureViewSnapshot(view);
      if (exitSnap) onStateSnapshotRef.current?.(exitSnap);
      view.contentDOM.removeEventListener('beforeinput', onBeforeInputCapture, true);
      view.contentDOM.removeEventListener('keydown', onKeyDownCapture, true);
      view.contentDOM.removeEventListener('compositionstart', onCompositionStartCapture, true);
      view.contentDOM.removeEventListener('compositionend', onCompositionEndBubble, false);
      view.contentDOM.removeEventListener('focus', onFocus);
      view.contentDOM.removeEventListener('blur', onBlur);
      view.scrollDOM.removeEventListener('scroll', onScroll);
      if (editContext) {
        editContext.removeEventListener('compositionstart', onCompositionStartCapture);
        editContext.removeEventListener('compositionend', onEditContextCompositionEnd);
        editContext = null;
      }
      delete (view.contentDOM as unknown as { __cm6View?: unknown }).__cm6View;
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

  // Sync external value changes (undo, redo, import, translation, TM apply) without clobbering CRLF bytes or emitting cursor jumps.
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

  // Sync verified inline highlights.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const decos = buildDecorations(props.value, view.state.doc.length, props.highlights);
    view.dispatch({ effects: setHighlightsEffect.of(decos), annotations: externalSync.of(true) });
  }, [props.value, props.highlights]);

  // Sync disabled / placeholder / aria-describedby / aria-labelledby compartments.
  const { disabled, placeholder, describedBy, labelledBy, id } = props;
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: [
        editableComp.current.reconfigure(EditorView.editable.of(!disabled)),
        readOnlyComp.current.reconfigure(EditorState.readOnly.of(!!disabled)),
        placeholderComp.current.reconfigure(cmPlaceholder(placeholder ?? '')),
        contentAttrsComp.current.reconfigure(
          EditorView.contentAttributes.of(buildContentAttrs({ id, describedBy, labelledBy })),
        ),
      ],
      annotations: externalSync.of(true),
    });
  }, [disabled, placeholder, describedBy, labelledBy, id]);

  useImperativeHandle(ref, () => ({
    focus() {
      viewRef.current?.contentDOM.focus();
    },
    snapshotState() {
      return captureViewSnapshot(viewRef.current);
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
      if (!view || composingActiveRef.current || view.composing) return;
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
