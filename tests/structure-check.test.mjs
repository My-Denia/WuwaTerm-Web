import assert from 'node:assert/strict';
import test from 'node:test';
import { parseStructureCheckRequest, proxyStructureCheckRequest } from '../lib/wuwaterm-proxy.js';
import {
  STRUCTURE_LIMITS, structureCheckBatches, structureFindingCovers, validStructureCheckRequest, validStructureCheckResponse,
} from '../lib/structure-check.js';
import { coveredByStructure, judgedReport, structurePlan, structureViews } from '../lib/structure-layer.ts';
import { createWorkbenchController } from '../lib/workbench-controller.ts';
import { createPool, fixtureEnvironment } from './helpers/pool-fixture.mjs';

// Layer 1 (Core ADR 0022, POST /v1/structure-checks): the BFF's strict request and response rules, the client's batching, the rule
// by which a structure finding takes precedence over a semantic issue, and that nothing of it reaches a saved manuscript.

const CAP = 'structure-check-v1';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const span = (text, needle) => {
  const at = text.indexOf(needle);
  const start = Array.from(text.slice(0, at)).length;
  return { start, end: start + Array.from(needle).length, text: needle };
};
const input = {
  check_version: CAP,
  segments: [
    { segment_id: 's0', source: '获得 3 个声骸。', target: 'Obtain Echoes.' },
    { segment_id: 's1', source: '前往{0}。', target: 'Go there.' },
  ],
};
const LAYOUT = { source_paragraphs: 1, target_paragraphs: 1, source_lines: 1, target_lines: 1 };
const layout = () => ({ ...LAYOUT });
const answer = () => ({
  request_id: 'req-structure', check_version: CAP, checks: ['empty_target', 'numbers', 'placeholders', 'paragraphs'],
  segments: [
    { index: 0, segment_id: 's0', findings: [{ rule_id: 'number_missing', source_span: span(input.segments[0].source, '3'), target_span: null }], omitted_findings: 0, layout: layout() },
    { index: 1, segment_id: 's1', findings: [{ rule_id: 'placeholder_missing', source_span: span(input.segments[1].source, '{0}'), target_span: null }], omitted_findings: 0, layout: layout() },
  ],
});

function upstream({ capabilities = [CAP], reply = () => json(answer()) } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = url.pathname.replace('/wuwaterm-api/', '');
    calls.push({ path, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    if (path === 'v1/capabilities') return json({ api_version: 'v1', capabilities, request_id: 'req-caps' });
    return reply();
  };
  return { fetchImpl, calls, count: path => calls.filter(call => call.path === path).length };
}
async function withPool(run) {
  const DB = createPool();
  try { return await run(DB, fixtureEnvironment(DB)); } finally { DB.close(); }
}
const reviewsUsed = DB => DB.row()?.review_used ?? 0;

test('the BFF forwards a valid request once, counts it as one review and returns the whitelisted answer', async () => {
  await withPool(async (DB, environment) => {
    const up = upstream();
    const response = await proxyStructureCheckRequest({ environment, input, fetchImpl: up.fetchImpl });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), answer());
    assert.equal(up.count('v1/structure-checks'), 1);
    assert.deepEqual(up.calls.find(call => call.path === 'v1/structure-checks').body, input);
    assert.equal(reviewsUsed(DB), 1);
  });
});

test('without structure-check-v1 the BFF answers structure_check_unavailable and sends and charges nothing', async () => {
  await withPool(async (DB, environment) => {
    const up = upstream({ capabilities: ['semantic-review-v1'] });
    const response = await proxyStructureCheckRequest({ environment, input, fetchImpl: up.fetchImpl });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).reason, 'structure_check_unavailable');
    assert.equal(up.count('v1/structure-checks'), 0);
    assert.equal(reviewsUsed(DB), 0);
  });
});

test('a response that does not match the request is upstream_schema_mismatch; an extra key, a wrong span or a wrong id', async () => {
  const cases = [
    body => { body.extra = 1; },
    body => { body.segments[0].findings[0].source_span.text = '4'; },
    body => { body.segments[1].segment_id = 's9'; },
    body => { body.segments[0].findings[0].rule_id = 'number_changed'; },
    body => { body.segments.pop(); },
    body => { body.segments[0].layout.extra = 0; },
    body => { body.checks.push('numbers'); },
  ];
  for (const mutate of cases) {
    await withPool(async (_, environment) => {
      const up = upstream({ reply: () => { const body = answer(); mutate(body); return json(body); } });
      const response = await proxyStructureCheckRequest({ environment, input, fetchImpl: up.fetchImpl });
      assert.equal(response.status, 502, String(mutate));
      assert.equal((await response.json()).reason, 'upstream_schema_mismatch');
    });
  }
});

test('a structure response over 64 KiB is read (Core measured 124 KB for 1,024 findings); one over 256 KiB is refused', async () => {
  const big = { check_version: CAP, segments: Array.from({ length: 64 }, (_, i) => ({ segment_id: `s${i}`, source: '1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17', target: 'x' })) };
  const reply = () => {
    const segments = big.segments.map((segment, index) => ({
      index, segment_id: segment.segment_id, omitted_findings: 1, layout: layout(),
      findings: Array.from({ length: 16 }, (_, k) => ({ rule_id: 'number_missing', source_span: span(segment.source, String(k + 1)), target_span: null })),
    }));
    return json({ request_id: 'req-big', check_version: CAP, checks: ['numbers'], segments });
  };
  await withPool(async (_, environment) => {
    const up = upstream({ reply });
    const response = await proxyStructureCheckRequest({ environment, input: big, fetchImpl: up.fetchImpl });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(text.length > 65_536, `the answer is ${text.length} bytes`);
  });
  await withPool(async (_, environment) => {
    const up = upstream({ reply: () => new Response('x'.repeat(STRUCTURE_LIMITS.responseBytes + 1), { headers: { 'content-type': 'application/json' } }) });
    const response = await proxyStructureCheckRequest({ environment, input: big, fetchImpl: up.fetchImpl });
    assert.equal((await response.json()).reason, 'upstream_response_too_large');
  });
});

test('Core errors are projected as for reviews; input_too_long keeps its 422', async () => {
  await withPool(async (_, environment) => {
    const up = upstream({ reply: () => json({ error: { code: 'input_too_long', message: 'too long' }, request_id: 'req-long' }, 422) });
    const response = await proxyStructureCheckRequest({ environment, input, fetchImpl: up.fetchImpl });
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { status: 'unavailable', reason: 'input_too_long', request_id: 'req-long' });
  });
});

test('the request rules: version, 1 to 64 segments, unique ids, 2,000 per side, 20,000 in all, no isolated surrogate, no extra key', async () => {
  assert.equal(validStructureCheckRequest(input), true);
  assert.equal(validStructureCheckRequest({ ...input, check_version: 'structure-check-v2' }), false);
  assert.equal(validStructureCheckRequest({ ...input, segments: [] }), false);
  assert.equal(validStructureCheckRequest({ ...input, segments: Array.from({ length: 65 }, () => ({ source: 'a', target: 'b' })) }), false);
  assert.equal(validStructureCheckRequest({ ...input, segments: [input.segments[0], { ...input.segments[1], segment_id: 's0' }] }), false);
  assert.equal(validStructureCheckRequest({ ...input, segments: [{ source: '甲'.repeat(2001), target: 'x' }] }), false);
  assert.equal(validStructureCheckRequest({ ...input, segments: Array.from({ length: 11 }, () => ({ source: '甲'.repeat(1000), target: '乙'.repeat(1000) })) }), false);
  assert.equal(validStructureCheckRequest({ ...input, segments: [{ source: '\uD800', target: 'x' }] }), false);
  assert.equal(validStructureCheckRequest({ ...input, segments: [{ source: 'a', target: 'b', note: 1 }] }), false);
  assert.equal(validStructureCheckRequest({ ...input, segments: [{ source: 'a', target: '', segment_id: null }] }), true, 'an empty target is what empty_target reports');
  const parsed = await parseStructureCheckRequest(new Request('https://site.test/api/structure-checks', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  }));
  assert.equal(parsed.ok, true);
  const tooLarge = await parseStructureCheckRequest(new Request('https://site.test/api/structure-checks', {
    method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(STRUCTURE_LIMITS.requestBytes + 1) }, body: '{}',
  }));
  assert.equal(tooLarge.ok, false);
  assert.equal((await tooLarge.response.json()).reason, 'site_request_too_large');
  assert.equal(validStructureCheckResponse(answer(), input), true);
});

test('batches hold at most 64 segments, 20,000 scalars and the byte cap; a segment that cannot be sent is skipped', () => {
  const many = Array.from({ length: 130 }, (_, i) => ({ id: `s${i}`, source: 'Hello', target: '你好' }));
  assert.deepEqual(structureCheckBatches(many).batches.map(b => b.segments.length), [64, 64, 2]);
  // A supplementary-plane character is one scalar and four UTF-8 bytes: 20 such segments fit the scalar cap, 15 the byte cap.
  const heavy = Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, source: '\u{20000}'.repeat(1000), target: '' }));
  const byScalars = structureCheckBatches(heavy, 1_000_000).batches;
  assert.ok(byScalars.every(b => b.segments.reduce((n, s) => n + Array.from(s.source).length + Array.from(s.target).length, 0) <= 20_000));
  const byBytes = structureCheckBatches(heavy).batches;
  assert.ok(byBytes.every(b => new TextEncoder().encode(JSON.stringify(b)).length <= STRUCTURE_LIMITS.batchBytes));
  assert.ok(byBytes.length > byScalars.length, 'Chinese text at the scalar limit is split by bytes first');
  const { batches, skipped } = structureCheckBatches([{ id: 'long', source: '甲'.repeat(2001), target: 'x' }, { id: 'ok', source: 'a', target: 'b' }]);
  assert.deepEqual(skipped, ['long']);
  assert.deepEqual(batches.map(b => b.segments.map(s => s.segment_id)), [['ok']]);
  for (const batch of [...structureCheckBatches(many).batches, ...byBytes]) assert.equal(validStructureCheckRequest(batch), true);
});

test('a structure finding takes precedence only over a semantic issue of a category it restates, overlapping on its side', () => {
  const at = (start, end) => ({ start, end });
  const number = { rule_id: 'number_missing', source_span: at(3, 4), target_span: null };
  assert.equal(structureFindingCovers({ category: 'quantity_change', source_span: at(2, 6), target_span: at(0, 5) }, number), true);
  assert.equal(structureFindingCovers({ category: 'omission', source_span: at(3, 4), target_span: null }, number), true);
  assert.equal(structureFindingCovers({ category: 'quantity_change', source_span: at(8, 9), target_span: null }, number), false, 'no overlap');
  assert.equal(structureFindingCovers({ category: 'meaning_shift', source_span: at(3, 4), target_span: null }, number), false, 'another category');
  const extra = { rule_id: 'number_unexpected', source_span: null, target_span: at(10, 12) };
  assert.equal(structureFindingCovers({ category: 'unsupported_addition', source_span: null, target_span: at(11, 13) }, extra), true);
  assert.equal(structureFindingCovers({ category: 'unsupported_addition', source_span: at(10, 12), target_span: null }, extra), false, 'the rule is on the target side');
  assert.equal(structureFindingCovers({ category: 'omission', source_span: at(0, 2), target_span: null }, { rule_id: 'empty_target', source_span: null, target_span: null }), true);
  for (const rule of ['paragraph_count_mismatch', 'line_count_mismatch', 'tag_unbalanced']) {
    assert.equal(structureFindingCovers({ category: 'omission', source_span: at(0, 2), target_span: at(0, 2) }, { rule_id: rule, source_span: at(0, 2), target_span: at(0, 2) }), false, rule);
  }
});

test('results are kept by segment content: an edited segment drops its result, the others keep theirs, in whole-text offsets', async () => {
  // Two paragraphs too long to merge into one segment (segmentation-v1 merges small neighbours).
  const pad = (text, filler) => `${text}${filler.repeat(1000)}`;
  const draft = { source: `${pad('获得 3 个声骸。', '文')}\n\n${pad('前往{0}。', '记')}`, target: `${pad('Obtain Echoes.', 'a')}\n\n${pad('Go there.', 'b')}`, direction: 'en', alignments: null };
  const plan = structurePlan(draft);
  assert.deepEqual(plan.items.map(i => i.id), ['s0', 's1']);
  const results = Object.fromEntries(plan.items.map((item, i) => [item.key, { findings: answer().segments[i].findings, omitted: 0, layout: layout() }]));
  const structure = { phase: 'done', results, skipped: 0, checks: [], error: null };
  const views = structureViews(draft, structure);
  assert.deepEqual(views[1].result.findings[0].source_span, { start: span(draft.source, '{0}').start, end: span(draft.source, '{0}').end, text: '{0}' });
  const edited = { ...draft, target: `${pad('Obtain three Echoes.', 'a')}\n\n${pad('Go there.', 'b')}` };
  const after = structureViews(edited, structure);
  assert.equal(after[0].result, null);
  assert.notEqual(after[1].result, null);
  assert.equal(coveredByStructure({ category: 'omission', source_span: views[1].result.findings[0].source_span, target_span: null }, views[1]), true);
  assert.equal(coveredByStructure({ category: 'omission', source_span: views[1].result.findings[0].source_span, target_span: null }, after[0]), false);
});

test('ADR 0022: structure findings never enter a saved manuscript or an export; the bytes are the same with and without them', async () => {
  const calls = [];
  const doc = createWorkbenchController({
    initialCapabilities: [CAP],
    onPoolRefresh: () => {},
    post: async (path, body) => {
      calls.push(path);
      assert.equal(path, '/api/structure-checks');
      return { response: json({}), value: {
        request_id: 'req-structure', check_version: CAP, checks: ['numbers'],
        segments: body.segments.map((segment, index) => ({ index, segment_id: segment.segment_id, findings: [{ rule_id: 'number_missing', source_span: span(segment.source, '3'), target_span: null }], omitted_findings: 0, layout: layout() })),
      } };
    },
  });
  doc.editText('source', '获得 3 个声骸。');
  doc.editText('target', 'Obtain Echoes.');
  const before = doc.save();
  const resultBefore = doc.exportResult();
  await doc.runStructureChecks();
  const snapshot = doc.getSnapshot();
  assert.equal(snapshot.structure.phase, 'done', JSON.stringify(snapshot.structure.error));
  assert.equal(Object.keys(snapshot.structure.results).length, 1);
  assert.deepEqual(calls, ['/api/structure-checks']);
  const after = doc.save();
  assert.equal(after.content, before.content);
  assert.equal(doc.exportResult().content, resultBefore.content);
  assert.equal(after.content.includes('number_missing'), false);
  // Undo history carries the document, not the session's structure results.
  assert.equal(snapshot.history.every(entry => !Object.hasOwn(entry, 'structure')), true);
  doc.dispose();
});

test('a summary never counts an ambiguous one-character name: judged findings only, not_evaluated lowered by their count', () => {
  const finding = (id, verdict, reason) => ({ id, verdict, rule_id: 'review.term_pair', ...(reason ? { reason } : {}) });
  const report = { coverage: { evaluated: 2, not_evaluated: 2, rules: [] }, findings: [finding('a', 'verified_constraint'), finding('b', 'not_evaluated', 'ordinary_word'), finding('c', 'not_evaluated', 'ambiguous_mention')] };
  const out = judgedReport(report);
  assert.deepEqual(out.report.findings.map(f => f.id), ['a', 'b']);
  assert.equal(out.report.coverage.not_evaluated, 1);
  assert.deepEqual(out.ambiguous.map(f => f.id), ['c']);
  assert.equal(judgedReport({ ...report, findings: report.findings.slice(0, 2) }).report.coverage.not_evaluated, 2);
});
