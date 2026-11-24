import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as L from '../../lib/long-review.ts';
import { parseWorkfile, serializeWorkfile } from '../../lib/manuscript.js';

export const OPERATION_TRACES = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../contracts/workbench-state/operation-traces.json', import.meta.url)), 'utf8'),
);

function buildInitialDraft(initial) {
  const source = initial.paragraphs.map(p => `${p.source_prefix}${p.source_fill_char.repeat(p.source_fill_count)}`).join('\n\n');
  const target = initial.paragraphs.map(p => p.target).join('\n\n');
  return { source, target, direction: initial.direction, alignments: initial.alignments };
}

function scalarIndexOf(text, needle) {
  const unitIdx = text.indexOf(needle);
  return unitIdx < 0 ? -1 : Array.from(text.slice(0, unitIdx)).length;
}

function buildReport(spec, record, sourceCore, targetCore) {
  const basis = OPERATION_TRACES.bases[spec.basis];
  const findings = spec.findings.map(f => {
    const sStart = scalarIndexOf(sourceCore, f.find);
    assert.ok(sStart >= 0, `source term ${f.find} not found in segment core`);
    const tStart = f.target_find ? scalarIndexOf(targetCore, f.target_find) : -1;
    assert.ok(!f.target_find || tStart >= 0, `target term ${f.target_find} not found in segment core`);
    return {
      verdict: f.verdict,
      source: [sStart, sStart + Array.from(f.find).length],
      target: f.target_find ? [tStart, tStart + Array.from(f.target_find).length] : null,
      candidates: f.candidates.map(id => OPERATION_TRACES.candidates[id]),
      candidates_truncated: Boolean(f.candidates_truncated),
    };
  });
  const evaluated = findings.filter(f => f.verdict !== 'not_evaluated').length;
  const notEvaluated = findings.length - evaluated;
  return {
    ...L.expandResult({
      source_hash: record.source_hash,
      target_hash: record.target_hash,
      basis,
      result: { truncated: false, evaluated, not_evaluated: notEvaluated, findings },
    }, sourceCore, targetCore),
    request_id: 'trace-web',
  };
}

function deleteParagraphWithSplice(text, index) {
  const parts = text.split('\n\n');
  assert.ok(index >= 0 && index < parts.length);
  const lengths = parts.map(p => Array.from(p).length);
  const totalScalars = Array.from(text).length;
  let start = 0;
  for (let i = 0; i < index; i += 1) start += lengths[i] + 2;
  let oldEnd;
  if (parts.length === 1) {
    start = 0;
    oldEnd = totalScalars;
  } else if (index < parts.length - 1) {
    oldEnd = start + lengths[index] + 2;
  } else {
    start -= 2;
    oldEnd = totalScalars;
  }
  parts.splice(index, 1);
  return {
    text: parts.join('\n\n'),
    splice: { start, oldEnd, newEnd: start },
  };
}

function replaceText(text, find, replace) {
  assert.ok(text.includes(find), `missing substring ${find}`);
  return text.replace(find, replace);
}

export function runWebTrace(trace) {
  let draft = buildInitialDraft(trace.initial);
  let long = L.longFromWorkfile({ ...draft, segments: [], segment_choice_history: [], progress: { current: null, completed: [] } });
  let basis = null;
  const captured = new Map();
  const checkpoints = [];

  for (const step of trace.steps) {
    if (step.op === 'check') {
      let settled = false;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const ctx = { draft, basis };
        const withResolutions = attempt > 0 || L.recheckPlan(long, step.segment, ctx) === 'with_resolutions';
        const request = L.segmentRequest(long, step.segment, ctx, { withResolutions });
        assert.ok(request, `expected ready segmentRequest at ${step.segment}`);
        const item = L.segmentInputs(draft).items[step.segment];
        const report = buildReport(step, long.records[step.segment], item.sourceCore, item.targetCore);
        const out = L.applyResult(long, ctx, request, report);
        assert.equal(out.error, null);
        ({ long, basis } = out);
        if (!out.secondRequest) { settled = true; break; }
      }
      assert.equal(settled, true, 'check step did not settle within 2 requests');
    } else if (step.op === 'capture_request') {
      const ctx = { draft, basis };
      const withResolutions = L.recheckPlan(long, step.segment, ctx) === 'with_resolutions';
      const request = L.segmentRequest(long, step.segment, ctx, { withResolutions });
      assert.ok(request);
      const item = L.segmentInputs(draft).items[step.segment];
      const report = buildReport(step, long.records[step.segment], item.sourceCore, item.targetCore);
      captured.set(step.ref, { request, report });
    } else if (step.op === 'deliver_captured') {
      const item = captured.get(step.ref);
      assert.ok(item, `missing captured ref ${step.ref}`);
      const ctx = { draft, basis };
      const out = L.applyResult(long, ctx, item.request, item.report);
      if (step.expect_rejected) {
        assert.equal(out.error, 'segment_changed');
        assert.equal(out.long, long);
      } else {
        assert.equal(out.error, null);
        ({ long, basis } = out);
      }
    } else if (step.op === 'choose') {
      const item = L.segmentInputs(draft).items[step.segment];
      const sStart = scalarIndexOf(item.sourceCore, step.find);
      assert.ok(sStart >= 0);
      const cand = step.choice === 'official_pair' ? OPERATION_TRACES.candidates[step.candidate] : null;
      const out = L.chooseTerm(long, {
        index: step.segment,
        finding: { source: [sStart, sStart + Array.from(step.find).length] },
        candidate: cand,
      }, { draft, basis });
      assert.equal(out.error, null);
      long = out.long;
    } else if (step.op === 'delete_paragraph') {
      const srcDel = deleteParagraphWithSplice(draft.source, step.paragraph);
      const tgtDel = deleteParagraphWithSplice(draft.target, step.paragraph);
      const next = {
        ...draft,
        source: srcDel.text,
        target: tgtDel.text,
      };
      long = L.reconcileLong(long, draft, next, { source: srcDel.splice, target: tgtDel.splice });
      draft = next;
    } else if (step.op === 'replace_text') {
      const next = { ...draft, [step.side]: replaceText(draft[step.side], step.find, step.replace) };
      long = L.reconcileLong(long, draft, next);
      draft = next;
    } else if (step.op === 'set_direction') {
      const next = { ...draft, direction: step.direction };
      long = L.reconcileLong(long, draft, next);
      draft = next;
    } else if (step.op === 'set_progress') {
      if ('current' in step) long = L.setCurrent(long, step.current);
      if ('finished' in step) {
        for (let i = 0; i < long.records.length; i += 1) {
          long = L.setFinished(long, i, step.finished.includes(i));
        }
      }
    } else if (step.op === 'save_and_reopen') {
      const bytes = serializeWorkfile({
        ...draft, choices: [], history: [], semantic_decisions: [], semantic_texts: [], semantic_history: [],
        ...L.workfileParts(long, draft, { basis }),
      });
      const parsed = parseWorkfile(bytes);
      draft = { source: parsed.source, target: parsed.target, direction: parsed.direction, alignments: parsed.alignments };
      long = L.longFromWorkfile(parsed);
      basis = null;
    } else if (step.op === 'restore_history') {
      const out = L.restoreHistoryEntry(long, step.position, step.segment, { draft, basis });
      assert.equal(out.error, null);
      long = out.long;
    } else if (step.op === 'assert') {
      const ctx = { draft, basis };
      const views = long.records.map((_, i) => L.recordView(long, i, ctx));
      const states = views.map(v => v.state);
      const choices = long.records.map(r => r.choices.map(c => [c.choice, c.source_span.start, c.confirmed]));
      const plan = L.termPlan(long, ctx);
      const restorable = L.restorableHistory(long, ctx);
      const recheckPlan = step.recheck_plan
        ? Object.fromEntries(Object.keys(step.recheck_plan).map(k => [k, L.recheckPlan(long, Number(k), ctx)]))
        : undefined;
      if (step.states) assert.deepEqual(states, step.states);
      if (step.choices) assert.deepEqual(choices, step.choices);
      if (step.history_count !== undefined) assert.equal(long.history.length, step.history_count);
      if (step.progress) assert.deepEqual(long.progress, step.progress);
      if ('probe' in step) assert.equal(plan.probe, step.probe);
      if (step.restorable) assert.deepEqual(restorable, step.restorable);
      if (step.recheck_plan) assert.deepEqual(recheckPlan, step.recheck_plan);
      checkpoints.push({
        states,
        choices,
        history_count: long.history.length,
        progress: long.progress,
        probe: plan.probe,
        restorable,
        bytes: serializeWorkfile({
          ...draft, choices: [], history: [], semantic_decisions: [], semantic_texts: [], semantic_history: [],
          ...L.workfileParts(long, draft, { basis }),
        }),
      });
    } else {
      assert.fail(`Unknown op ${step.op}`);
    }
  }
  return checkpoints;
}
