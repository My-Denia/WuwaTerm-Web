// The one document workspace: its mode rules, quick translation through the shared document, redo in the snapshot, IME
// composition against the base semantic state, and the runtime store that reads pool, capabilities and meta once per page.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkbenchController } from '../lib/workbench-controller.ts';
import { RuntimeStore } from '../lib/runtime-store.ts';
import { addSegmentResult, emptySemantic, freshSemantic, placedOccurrence } from '../lib/semantic-state.js';
import { revisionOf } from '../lib/review-report.js';

const quiet = { setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {} };
const clock = (now = 1_700_000_000_000) => ({ now: () => now, ...quiet });
const reply = body => ({ response: new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }), value: body });
function controller(options = {}) {
  return createWorkbenchController({ clock: clock(), onPoolRefresh: () => {}, fetchCapabilities: async () => [], ...options });
}
function load(doc, draft) {
  doc.replaceWithWorkfile({ draft, choices: [], reports: [], semantic: freshSemantic(draft), importedBody: null });
}

test('a new workspace opens in quick mode with automatic direction', () => {
  const doc = controller();
  const s = doc.getSnapshot();
  assert.equal(s.workspaceMode, 'quick');
  assert.equal(s.autoDirection, true);
  assert.equal(s.redoCount, 0);
  doc.dispose();
});

test('typing past the one-request limit switches to manuscript in place, keeps the text and history, and never switches back', () => {
  const doc = controller();
  doc.editText('source', '短句。');
  const long = '甲'.repeat(2001);
  doc.editText('source', long);
  let s = doc.getSnapshot();
  assert.equal(s.workspaceMode, 'manuscript');
  assert.equal(s.notice, 'switchedToManuscript');
  assert.equal(s.draft.source, long);
  assert.equal(s.history.length, 2);
  // Quick cannot hold a long document.
  assert.equal(doc.setWorkspaceMode('quick'), false);
  assert.equal(doc.getSnapshot().workspaceMode, 'manuscript');
  // Shortening it does not switch back on its own; the user may.
  doc.undo();
  s = doc.getSnapshot();
  assert.equal(s.draft.source, '短句。');
  assert.equal(s.workspaceMode, 'manuscript');
  assert.equal(doc.setWorkspaceMode('quick'), true);
  assert.equal(doc.getSnapshot().workspaceMode, 'quick');
  doc.dispose();
});

test('a long translation side also switches, and an imported manuscript opens in manuscript mode', () => {
  const doc = controller();
  doc.editText('target', 'a'.repeat(2001));
  assert.equal(doc.getSnapshot().workspaceMode, 'manuscript');
  doc.setWorkspaceMode('quick');
  assert.equal(doc.getSnapshot().workspaceMode, 'manuscript');
  const other = controller();
  load(other, { source: '今汐。', target: 'Jinhsi.', direction: 'en', alignments: null });
  assert.equal(other.getSnapshot().workspaceMode, 'manuscript');
  assert.equal(other.getSnapshot().notice, 'imported');
  doc.dispose();
  other.dispose();
});

test('quick translation with automatic direction sends no target language and adopts the detected one in the same undo step', async () => {
  const sent = [];
  const doc = controller({
    post: async (path, body) => {
      sent.push({ path, body });
      return reply({ kind: 'exact', text: '今汐', direction: 'zh', dictionary_miss: false, request_id: 'req-1' });
    },
  });
  doc.editText('source', 'Jinhsi');
  await doc.translateInReview();
  assert.deepEqual(sent, [{ path: '/api/translations', body: { text: 'Jinhsi' } }]);
  let s = doc.getSnapshot();
  assert.equal(s.draft.target, '今汐');
  assert.equal(s.draft.direction, 'zh');
  assert.deepEqual(s.lastTranslation, { source: 'Jinhsi', text: '今汐', kind: 'exact', direction: 'zh', dictionaryMiss: false, requestId: 'req-1' });
  assert.equal(s.workspaceMode, 'quick');
  // One undo removes the translation and the detected direction together.
  doc.undo();
  s = doc.getSnapshot();
  assert.equal(s.draft.target, '');
  assert.equal(s.draft.direction, 'en');
  assert.equal(s.redoCount, 1);
  doc.redo();
  s = doc.getSnapshot();
  assert.equal(s.draft.target, '今汐');
  assert.equal(s.draft.direction, 'zh');
  assert.equal(s.redoCount, 0);
  doc.dispose();
});

test('an explicit quick direction and manuscript mode send the target language; translation-context-v1 adds context', async () => {
  const sent = [];
  const doc = controller({
    fetchCapabilities: async () => ['translation-context-v1'],
    post: async (path, body) => { sent.push(body); return reply({ kind: 'llm', text: 'Hello.', direction: 'en', dictionary_miss: true, request_id: 'req-2' }); },
  });
  await doc.loadCapabilities();
  doc.setQuickDirection('en');
  doc.editText('source', '你好。');
  await doc.translateInReview();
  doc.setQuickDirection('auto');
  doc.setWorkspaceMode('manuscript');
  doc.editText('source', '你好！');
  await doc.translateInReview();
  assert.deepEqual(sent, [
    { text: '你好。', to: 'en', context: {} },
    { text: '你好！', to: 'en', context: {} },
  ]);
  assert.equal(doc.getSnapshot().lastTranslation.dictionaryMiss, true);
  doc.dispose();
});

test('redo depth is part of the snapshot and a new edit clears it', () => {
  const doc = controller();
  doc.editText('source', 'A');
  doc.editText('target', 'B');
  doc.undo();
  doc.undo();
  assert.equal(doc.getSnapshot().redoCount, 2);
  doc.redo();
  assert.equal(doc.getSnapshot().redoCount, 1);
  doc.editText('source', 'AC');
  assert.equal(doc.getSnapshot().redoCount, 0);
  doc.dispose();
});

test('an editor reporting the same text again adds no undo step', () => {
  const doc = controller();
  doc.editText('source', 'Alpha');
  const depth = doc.getSnapshot().history.length;
  doc.editText('source', 'Alpha');
  doc.editText('source', 'Alpha', { composing: true });
  assert.equal(doc.getSnapshot().history.length, depth);
  doc.dispose();
});

test('a composition that ends where it began leaves semantic issues live, though an intermediate state crossed them', async () => {
  const source = 'Alpha beta.';
  const target = '甲乙丙。丁戊。';
  const span = (text, start, end) => ({ start, end, text: Array.from(text).slice(start, end).join('') });
  const result = {
    id: 'r1', segmentKey: 'k', index: 0, sentSource: source, sentTarget: target, imported: false,
    report: { term_basis: { dictionary_revision: 'a'.repeat(64), matcher_revision: 'a'.repeat(64) }, issues: [] },
    doc: { source, target, sourceRevision: await revisionOf(source), targetRevision: await revisionOf(target) },
    region: { source: { start: 0, end: Array.from(source).length }, target: { start: 0, end: Array.from(target).length } },
  };
  const issue = {
    id: '1'.repeat(32), fingerprint: '2'.repeat(32), category: 'meaning_shift', segment_index: 0,
    source_span: span(source, 0, 5), target_span: span(target, 4, 6), suggestion: null, suggestion_withheld: null, alternatives: [],
  };
  const placed = {
    id: 'r1:1', resultId: 'r1', issue, occurrence: placedOccurrence(result, issue), stale: false,
    live: { source_span: issue.source_span, target_span: issue.target_span, suggestion_span: null },
  };
  const semantic = addSegmentResult(emptySemantic(), result, [placed], [{ revision: result.doc.targetRevision, text: target }]);
  const doc = controller();
  doc.replaceWithWorkfile({ draft: { source, target, direction: 'en', alignments: null }, choices: [], reports: [], semantic, importedBody: null });
  const before = doc.getSnapshot().semantic;
  // An intermediate candidate replaces the period and 丁, which on its own would lose the issue's target span…
  doc.editText('target', '甲乙丙X戊。', { composing: true });
  assert.equal(doc.getSnapshot().semantic.placed[0].stale, true);
  // …and the composition is cancelled back to the original text.
  doc.editText('target', target, { composing: true });
  doc.editText('target', target);
  const after = doc.getSnapshot().semantic;
  assert.equal(after.placed[0].stale, false);
  assert.deepEqual(after.placed[0].live, before.placed[0].live);
  assert.deepEqual(after.results[0].region, before.results[0].region);
  doc.dispose();
});

function fakeFetch(routes) {
  const calls = [];
  const fetch = async (path, init) => {
    calls.push(path);
    const route = routes[path];
    if (!route) throw new Error('unexpected ' + path);
    return route(init);
  };
  return { calls, fetch };
}
const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const POOL = {
  status: 'available', translation_enabled: true,
  terms: { used: 0, limit: 100, remaining: 100 }, translations: { used: 0, limit: 100, remaining: 100 },
  characters: { used: 0, limit: 10000, remaining: 10000 }, reviews: { used: 0, limit: 60, remaining: 60 },
  reset_at: '2099-01-01T00:00:00Z',
};
const META = { schema_version: '3.6', source_commit: 'abc123', game_version: '2.4', resource_version: null, changelist: null, term_count: 12, request_id: 'm-1' };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('the runtime store reads the pool once per page and capabilities once for every caller', async () => {
  const { calls, fetch } = fakeFetch({
    '/api/pool': async () => json(POOL),
    '/api/capabilities': async () => json({ capabilities: ['semantic-review-v1', 7], request_id: 'c' }),
  });
  const store = new RuntimeStore({ fetch });
  store.start();
  store.start();
  const [a, b] = await Promise.all([store.capabilities(), store.capabilities()]);
  await tick();
  assert.deepEqual(a, ['semantic-review-v1']);
  assert.equal(a, b);
  assert.deepEqual(calls.sort(), ['/api/capabilities', '/api/pool']);
  const s = store.getSnapshot();
  assert.equal(s.pool.kind, 'success');
  assert.deepEqual(s.capabilities, ['semantic-review-v1']);
  assert.equal(s.meta.kind, 'idle');
});

test('a newer pool read replaces one in flight; a page without the pool never reads it', async () => {
  let first;
  const gate = new Promise(resolve => { first = resolve; });
  let n = 0;
  const { calls, fetch } = fakeFetch({
    '/api/pool': async init => {
      n += 1;
      if (n === 1) { await gate; if (init.signal.aborted) throw new DOMException('aborted', 'AbortError'); }
      return json({ ...POOL, reviews: { used: n, limit: 60, remaining: 60 - n } });
    },
  });
  const store = new RuntimeStore({ fetch });
  store.start();
  store.refreshPool();
  await tick();
  first();
  await tick();
  assert.equal(calls.length, 2);
  assert.equal(store.getSnapshot().pool.data.reviews.remaining, 58);
  const off = new RuntimeStore({ fetch: async () => { throw new Error('no read expected'); }, pool: false });
  off.start();
  off.refreshPool();
  assert.equal(off.getSnapshot().pool.kind, 'off');
});

test('dictionary provenance is read only on request, joined while in flight, kept, and read again only when forced', async () => {
  let release;
  const metaHandler = async () => { await new Promise(resolve => { release = resolve; }); return json(META); };
  const { calls, fetch } = fakeFetch({ '/api/meta': metaHandler, '/api/meta?refresh=1': metaHandler });
  const store = new RuntimeStore({ fetch, pool: false });
  store.start();
  assert.deepEqual(calls, []);
  const one = store.loadMeta();
  const two = store.loadMeta();
  assert.equal(one, two);
  await tick();
  release();
  await one;
  assert.equal(store.getSnapshot().meta.kind, 'success');
  await store.loadMeta();
  assert.equal(calls.length, 1);
  const again = store.loadMeta(true);
  await tick();
  release();
  await again;
  assert.deepEqual(calls, ['/api/meta', '/api/meta?refresh=1']);
  const bad = new RuntimeStore({ fetch: async () => json({ ...META, extra: 1 }), pool: false });
  await bad.loadMeta();
  assert.equal(bad.getSnapshot().meta.kind, 'error');
});
