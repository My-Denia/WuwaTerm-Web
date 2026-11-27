// Shared Playwright helpers for interacting with EditorSurfaceAdapter across
// both quick mode (native <textarea>) and manuscript mode (CodeMirror 6).
import { expect } from '@playwright/test';

/** Wait for an editor surface (textarea or CM6 contenteditable) to be ready, then return its normalized text. */
export async function readEditorValue(page, selector) {
  return page.locator(selector).evaluate(el => {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value;
    const view = el.__cm6View ?? el.cmView?.view;
    if (view) return view.state.doc.toString();
    return el.textContent ?? '';
  });
}

/** Assert the editor's document text matches `expected` (string or RegExp; works on both <textarea> and CodeMirror 6). */
export async function expectEditorValue(page, selector, expected, options = {}) {
  if (expected instanceof RegExp) {
    await expect.poll(() => readEditorValue(page, selector), options).toMatch(expected);
  } else {
    await expect.poll(() => readEditorValue(page, selector), options).toBe(expected);
  }
}

/** Assert the editor's document text contains `substring`. */
export async function expectEditorContains(page, selector, substring, options = {}) {
  await expect.poll(() => readEditorValue(page, selector), options).toContain(substring);
}

/** Assert the editor's document text does NOT match `unexpected`. */
export async function expectEditorNotValue(page, selector, unexpected, options = {}) {
  await expect.poll(() => readEditorValue(page, selector), options).not.toBe(unexpected);
}

/** Replace the full text of an editor (works on both <textarea> and CodeMirror 6). */
export async function fillEditor(page, selector, text) {
  const loc = page.locator(selector);
  await loc.waitFor({ state: 'visible' });
  const workspace = page.locator('.document-workspace');
  if (await workspace.count() && await workspace.getAttribute('data-mode') === 'manuscript') {
    await expect(loc).toHaveAttribute('data-editor-surface', 'cm6', { timeout: 15_000 });
  }
  const isNative = await loc.evaluate(el => el.tagName === 'TEXTAREA' || el.tagName === 'INPUT');
  if (isNative) {
    await loc.fill(text);
    return;
  }
  await loc.evaluate((el, value) => {
    const view = el.__cm6View ?? el.cmView?.view;
    if (!view) throw new Error('CM6 EditorView not attached');
    const normalized = value.replace(/\r\n?/g, '\n');
    view.focus();
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: normalized },
      selection: { anchor: normalized.length, head: normalized.length },
    });
  }, text);
}

/** Read current selection `{ start, end, text }` in DOM LF-normalized UTF-16 coordinates. */
export async function readEditorSelection(page, selector) {
  return page.locator(selector).evaluate(el => {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      return {
        start: el.selectionStart,
        end: el.selectionEnd,
        text: el.value.slice(el.selectionStart, el.selectionEnd),
      };
    }
    const view = el.__cm6View ?? el.cmView?.view;
    if (!view) return { start: 0, end: 0, text: '' };
    const { from, to } = view.state.selection.main;
    return {
      start: from,
      end: to,
      text: view.state.doc.sliceString(from, to),
    };
  });
}

/** Programmatically set selection range in DOM LF-normalized UTF-16 coordinates. */
export async function setEditorSelection(page, selector, start, end = start) {
  await page.locator(selector).evaluate((el, range) => {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      el.focus();
      el.setSelectionRange(range.start, range.end);
      el.dispatchEvent(new Event('select', { bubbles: true }));
      return;
    }
    const view = el.__cm6View ?? el.cmView?.view;
    if (!view) throw new Error('CM6 EditorView not attached');
    view.focus();
    const len = view.state.doc.length;
    const from = Math.max(0, Math.min(len, range.start));
    const to = Math.max(0, Math.min(len, range.end));
    view.dispatch({ selection: { anchor: from, head: to } });
  }, { start, end });
}

/** Read scroll geometry `{ scrollTop, scrollHeight, clientHeight }` of the editor's scroll container. */
export async function readEditorScroll(page, selector) {
  return page.locator(selector).evaluate(el => {
    const view = el.__cm6View ?? el.cmView?.view;
    const scroller = view ? view.scrollDOM : el;
    return {
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
    };
  });
}

/** Set scrollTop on the editor's scroll container and optionally dispatch a `scroll` event. */
export async function setEditorScroll(page, selector, position, { ratio = false, dispatch = false } = {}) {
  await page.locator(selector).evaluate((el, opts) => {
    const view = el.__cm6View ?? el.cmView?.view;
    const scroller = view ? view.scrollDOM : el;
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scroller.scrollTop = opts.ratio ? Math.round(max * opts.position) : (opts.position === 'end' ? scroller.scrollHeight : opts.position);
    if (opts.dispatch) scroller.dispatchEvent(new Event('scroll'));
  }, { position, ratio, dispatch });
}

/** Check whether the editor's selected text is currently visible inside its scroll container. */
export async function editorSelectionInView(page, selector) {
  return page.locator(selector).evaluate(el => {
    const view = el.__cm6View ?? el.cmView?.view;
    if (view) {
      const { from, to } = view.state.selection.main;
      const selected = view.state.doc.sliceString(from, to);
      const coords = view.coordsAtPos(from);
      const rect = view.scrollDOM.getBoundingClientRect();
      const inView = !!coords && coords.top >= rect.top - 2 && coords.bottom <= rect.bottom + 2;
      return { selected, inView };
    }
    const style = getComputedStyle(el);
    const line = el.value.slice(0, el.selectionStart).split('\n').length - 1;
    const lineHeight = parseFloat(style.lineHeight);
    const top = parseFloat(style.paddingTop) + line * lineHeight;
    return {
      selected: el.value.slice(el.selectionStart, el.selectionEnd),
      inView: top >= el.scrollTop - 1 && top + lineHeight <= el.scrollTop + el.clientHeight + 1,
    };
  });
}

/** Open one of the right-hand Unified Inspector tabs in manuscript mode (`review` | `terms` | `memory`). */
export async function openInspectorTab(page, tab) {
  const btn = page.locator(`[data-inspector-tab="${tab}"]`);
  if (await btn.count()) {
    await btn.click();
    await expect(btn).toHaveAttribute('aria-selected', 'true');
  }
}
