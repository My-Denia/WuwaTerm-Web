import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { WORKFILE_FORMAT, WORKFILE_FORMAT_V2, WORKFILE_FORMAT_V3, makeChoice, parseWorkfile, reconcileChoice, reconcileChoices, semanticPartsOf, serializeWorkfile } from '../../lib/manuscript.js';
import * as L from '../../lib/long-review.ts';
import { runWebTrace } from '../helpers/operation-trace-runner.mjs';
import { FRESH_MATCHER_REVISION, dictionary, fixture, freshApiReport, hash } from '../fixtures/manuscript.mjs';
import { requireWindowsRoot } from './windows-source.mjs';

const windowsRoot = requireWindowsRoot();
const manuscriptPath = join(windowsRoot, 'src/wuwaterm_client/manuscript.py');

// Load only the pinned, stdlib-only manuscript and semantic modules: importing the client
// package's API or UI would require desktop credentials and Qt dependencies.
const pythonBridge = String.raw`
import importlib
import json
import os
import sys
import types

if sys.version_info < (3, 12):
    raise RuntimeError('The Windows consumer requires Python 3.12 or later')
# manuscript.py imports its stdlib-only sibling semantic.py relatively, so register the
# package directory without running the client's UI or API imports.
package = types.ModuleType('wuwaterm_client')
package.__path__ = [os.path.dirname(sys.argv[1])]
sys.modules['wuwaterm_client'] = package
module = importlib.import_module('wuwaterm_client.manuscript')
request = json.load(sys.stdin)


def build_v2(module):
    # Built from the Windows consumer's own helpers and plain dicts, not from a Web file.
    import hashlib
    revision = lambda text: hashlib.sha256(text.encode('utf-8')).hexdigest()
    term_basis = {'dictionary_revision': 'e3' * 32, 'matcher_revision': 'f4' * 32}
    basis = {'review_version': 'semantic-review-v1', 'term_basis': term_basis}
    source, old_target = '第五天到了。\n它很安静。', 'It is the fourth day.\nIt is quiet.'
    target = 'It is the fifth day.\nIt is quiet.'
    core_source, core_target = source[:5], old_target[:21]
    span = lambda text, start, end: {'start': start, 'end': end, 'text': text[start:end]}
    decision = lambda n, category, s_span, t_span, kind, applied: {
        'issue_id': ('%02x' % n) * 16, 'fingerprint': ('%02x' % (n + 16)) * 16, 'category': category,
        'segment_index': 0, 'source_revision': revision(source), 'target_revision': revision(old_target),
        'source_span': s_span, 'target_span': t_span, 'decision': kind, 'applied_text': applied, 'basis': basis}
    decisions = [
        decision(1, 'quantity_change', span(source, 0, 3), span(old_target, 7, 17), 'accepted', 'fifth'),
        decision(2, 'omission', span(source, 7, 11), None, 'ignored', None),
        decision(3, 'meaning_shift', None, span(old_target, 28, 33), 'adjusted', 'calm'),
    ]
    issue = {
        'id': '9' * 32, 'fingerprint': '12' * 16, 'category': 'quantity_change', 'origin': 'model', 'confidence': 'high',
        'source_span': span(core_source, 0, 3), 'target_span': span(core_target, 7, 17),
        'source_excerpt': core_source[0:3], 'target_excerpt': core_target[7:17], 'rationale': 'Windows-built.',
        'suggestion': {'target_span': span(core_target, 7, 17), 'replacement': 'he fifth ', 'term_effect': 'none'},
        'suggestion_withheld': None, 'alternatives': []}
    report = {
        'request_id': 'windows-built', 'review_version': 'semantic-review-v1', 'source_revision': revision(core_source),
        'target_revision': revision(core_target), 'term_basis': term_basis, 'status': 'complete', 'status_reason': None,
        'dropped_unanchored': 0, 'checked': ['omission', 'unsupported_addition', 'meaning_shift', 'negation_change',
        'quantity_change', 'reference_inconsistency', 'term_sense'], 'issues': [issue], 'truncated': False,
        'truncated_reason': None, 'omitted_issues': 0}
    payload = {
        'source': source, 'target': target, 'direction': 'en', 'alignments': None, 'choices': [], 'history': [],
        'semantic_decisions': decisions, 'semantic_texts': [{'revision': revision(old_target), 'text': old_target}],
        'semantic_history': [{'source': source, 'target': old_target, 'direction': 'en', 'segments': [{
            'segment_index': 0, 'source_start': 0, 'source_end': 5, 'target_start': 0, 'target_end': 21, 'report': report}]}]}
    return {'payload': payload, 'content': module.serialize_workfile(payload)}


def build_v3(module, scenario):
    # A long manuscript run through the Windows client's own segment runtime, not read from a Web file:
    # the probe on segment 0, a check of segment 1, a term choice in each, a re-check of segment 0 with
    # its resolution; then a second choice in segment 0 that a changed result unconfirms and that matches
    # again; a target-only edit of segment 0 and its re-check; and the user's position and finished marks.
    records = importlib.import_module('wuwaterm_client.segment_records')
    segmentation = importlib.import_module('wuwaterm_client.segmentation')
    payload = {'source': scenario['source'], 'target': scenario['target'], 'direction': 'en', 'alignments': None,
               'choices': [], 'history': [], 'semantic_decisions': [], 'semantic_texts': [], 'semantic_history': []}
    pairs = lambda value: segmentation.pair_segments(value['source'], value['target'])
    payload = records.with_parts(payload, records.normalize(payload, pairs(payload)))
    candidate, extra, size = scenario['candidate'], scenario['extra'], len(scenario['candidate']['zh'])
    state = {'payload': payload, 'basis': None}

    def second(core, text):
        return core.index(text, core.index(text) + 1)

    def report(index, variant):
        record = records.parts_of(state['payload']).segments[index]
        source_core = state['payload']['source'][record['source_start']:record['source_end']]
        target_core = state['payload']['target'][record['target_start']:record['target_end']]
        at, again = target_core.index(candidate['en']), second(target_core, candidate['en'])
        both = [candidate, extra] if variant == 'extra' else [candidate]
        found = lambda s, t, c: {'verdict': 'verified_constraint', 'source': [s, s + size], 'target': [t, t + len(candidate['en'])],
                                 'candidates': c, 'candidates_truncated': False}
        s2 = second(source_core, candidate['zh'])
        result = {'truncated': False, 'evaluated': 2, 'not_evaluated': 0,
                  'findings': [found(0, at, [candidate]), found(s2, again, both)]}
        value = records.expand_result({**record, 'basis': scenario['basis'], 'result': result},
                                      state['payload']['source'], state['payload']['target'])
        return {**value, 'request_id': 'windows-built'}

    def check(index, variants=()):
        # One segment check as the client runs it: the planned request, then again while the runtime asks for it.
        for n in range(3):
            request = records.plan_request(state['payload'], index, state['basis'])
            applied = records.apply_response(state['payload'], request, report(index, variants[n] if n < len(variants) else None), state['basis'])
            if applied.outcome != 'stored':
                raise RuntimeError('unexpected outcome ' + applied.outcome)
            state['payload'], state['basis'] = records.with_parts(state['payload'], applied.parts), applied.basis
            if not applied.again:
                return n + 1
        raise RuntimeError('the check did not settle')

    def choose(*args):
        state['payload'] = records.with_parts(state['payload'], records.choose(state['payload'], *args))

    check(0)
    check(1)
    choose(0, 0, size, 'official_pair', candidate['candidate_id'])
    choose(1, 0, size, 'not_a_term')
    check(0)
    s2 = second(state['payload']['source'], candidate['zh'])
    choose(0, s2, s2 + size, 'not_a_term')
    check(0, ['extra'])
    # A target-only edit of segment 0, as the editor reports it, then normalized to the new pairing.
    before, (old, new) = state['payload']['target'], scenario['target_edit']
    start = before.index(old)
    parts = records.apply_edit(records.parts_of(state['payload']), before, 'target', start, start + len(old), len(new))
    edited = records.with_parts({**state['payload'], 'target': before.replace(old, new, 1)}, parts)
    state['payload'] = records.with_parts(edited, records.normalize(edited, pairs(edited), state['basis']))
    requests = check(0)
    parts = records.parts_of(state['payload'])
    payload = records.with_parts(state['payload'], parts._replace(progress={'current': 1, 'completed': [0, 1]}))
    return {'content': module.serialize_workfile(payload), 'edit_requests': requests}


def v3_runtime(operation, payload):
    records = importlib.import_module('wuwaterm_client.segment_records')
    segmentation = importlib.import_module('wuwaterm_client.segmentation')
    if operation == 'alignment_inputs':
        return [records.alignment_input(payload['alignments'], payload['source'], payload['target'],
                                        (r['source_start'], r['source_end']), (r['target_start'], r['target_end']))
                for r in payload['segments']]
    pairs = segmentation.pair_segments(payload['source'], payload['target'], alignments=payload['alignments'])
    parts = records.normalize(payload, pairs)
    return {'segments': parts.segments, 'segment_choice_history': parts.history, 'progress': parts.progress}


def duplicate_case(module, case, basis):
    records = importlib.import_module('wuwaterm_client.segment_records')
    segmentation = importlib.import_module('wuwaterm_client.segmentation')
    payload = module.parse_workfile(json.dumps(case['workfile']))
    parts = records.parts_of(payload)
    for edit in case['edits']:
        if 'side' in edit:
            side = edit['side']
            before = payload[side]
            start, old_end, inserted = edit['start'], edit['old_end'], edit['insert']
            parts = records.apply_edit(parts, before, side, start, old_end, len(inserted))
            payload = records.with_parts({**payload, side: before[:start] + inserted + before[old_end:]}, parts)
        elif 'direction' in edit:
            payload = records.with_parts({**payload, 'direction': edit['direction']}, parts)
        else:
            payload = records.with_parts({**payload, 'alignments': edit['alignments']}, parts)
    pairs = segmentation.pair_segments(payload['source'], payload['target'], alignments=payload['alignments'])
    normalized = records.normalize(payload, pairs, basis)
    return module.serialize_workfile(records.with_parts(payload, normalized))


def run_operation_trace(module, trace, bases, candidates):
    records = importlib.import_module('wuwaterm_client.segment_records')
    segmentation = importlib.import_module('wuwaterm_client.segmentation')

    def build_initial(initial):
        return {
            'source': '\n\n'.join(p['source_prefix'] + p['source_fill_char'] * p['source_fill_count'] for p in initial['paragraphs']),
            'target': '\n\n'.join(p['target'] for p in initial['paragraphs']),
            'direction': initial['direction'],
            'alignments': initial['alignments'],
            'choices': [],
            'history': [],
            'semantic_decisions': [],
            'semantic_texts': [],
            'semantic_history': [],
        }

    def build_report(step, record, source_core, target_core):
        basis = bases[step['basis']]
        findings = []
        for f in step['findings']:
            s_start = source_core.index(f['find'])
            t_start = target_core.index(f['target_find']) if f.get('target_find') else None
            findings.append({
                'verdict': f['verdict'],
                'source': [s_start, s_start + len(f['find'])],
                'target': None if t_start is None else [t_start, t_start + len(f['target_find'])],
                'candidates': [candidates[cid] for cid in f['candidates']],
                'candidates_truncated': bool(f.get('candidates_truncated', False)),
            })
        evaluated = sum(1 for item in findings if item['verdict'] != 'not_evaluated')
        not_evaluated = len(findings) - evaluated
        value = records.expand_result(
            {**record, 'basis': basis, 'result': {'truncated': False, 'evaluated': evaluated, 'not_evaluated': not_evaluated, 'findings': findings}},
            payload['source'], payload['target'],
        )
        return {**value, 'request_id': 'trace-windows'}

    def apply_edit_only(side, before, after, payload_now):
        pref = 0
        limit = min(len(before), len(after))
        while pref < limit and before[pref] == after[pref]:
            pref += 1
        suff = 0
        while suff < limit - pref and before[len(before) - 1 - suff] == after[len(after) - 1 - suff]:
            suff += 1
        old_end = len(before) - suff
        new_len = len(after) - suff - pref
        parts = records.apply_edit(records.parts_of(payload_now), before, side, pref, old_end, new_len)
        return records.with_parts({**payload_now, side: after}, parts)

    def normalize_payload(payload_now, basis_now):
        pairs = segmentation.pair_segments(payload_now['source'], payload_now['target'], alignments=payload_now['alignments'])
        return records.with_parts(payload_now, records.normalize(payload_now, pairs, basis_now))

    payload = build_initial(trace['initial'])
    pairs = segmentation.pair_segments(payload['source'], payload['target'], alignments=payload['alignments'])
    payload = records.with_parts(payload, records.normalize(payload, pairs))
    basis = None
    captured = {}
    checkpoints = []

    for step in trace['steps']:
        op = step['op']
        if op == 'check':
            for _ in range(2):
                req = records.plan_request(payload, step['segment'], basis)
                rec = records.parts_of(payload).segments[step['segment']]
                s_core = payload['source'][rec['source_start']:rec['source_end']]
                t_core = payload['target'][rec['target_start']:rec['target_end']]
                rep = build_report(step, rec, s_core, t_core)
                applied = records.apply_response(payload, req, rep, basis)
                if applied.outcome != 'stored':
                    raise RuntimeError('unexpected outcome ' + applied.outcome)
                payload, basis = records.with_parts(payload, applied.parts), applied.basis
                if not applied.again:
                    break
            else:
                raise RuntimeError('check did not settle')
        elif op == 'capture_request':
            req = records.plan_request(payload, step['segment'], basis)
            rec = records.parts_of(payload).segments[step['segment']]
            s_core = payload['source'][rec['source_start']:rec['source_end']]
            t_core = payload['target'][rec['target_start']:rec['target_end']]
            captured[step['ref']] = (req, build_report(step, rec, s_core, t_core))
        elif op == 'deliver_captured':
            req, rep = captured[step['ref']]
            applied = records.apply_response(payload, req, rep, basis)
            if step.get('expect_rejected'):
                if applied.outcome != 'discarded':
                    raise RuntimeError('expected discarded, got ' + applied.outcome)
            else:
                payload, basis = records.with_parts(payload, applied.parts), applied.basis
        elif op == 'choose':
            rec = records.parts_of(payload).segments[step['segment']]
            s_core = payload['source'][rec['source_start']:rec['source_end']]
            start = s_core.index(step['find'])
            cand_id = candidates[step['candidate']]['candidate_id'] if step['choice'] == 'official_pair' else None
            payload = records.with_parts(payload, records.choose(payload, step['segment'], start, start + len(step['find']), step['choice'], cand_id))
        elif op == 'delete_paragraph':
            s_parts = payload['source'].split('\n\n')
            t_parts = payload['target'].split('\n\n')
            s_before, t_before = payload['source'], payload['target']
            del s_parts[step['paragraph']]
            del t_parts[step['paragraph']]
            payload = apply_edit_only('source', s_before, '\n\n'.join(s_parts), payload)
            payload = apply_edit_only('target', t_before, '\n\n'.join(t_parts), payload)
            payload = normalize_payload(payload, basis)
        elif op == 'replace_text':
            side = step['side']
            before = payload[side]
            after = before.replace(step['find'], step['replace'], 1)
            payload = normalize_payload(apply_edit_only(side, before, after, payload), basis)
        elif op == 'set_direction':
            edited = {**payload, 'direction': step['direction']}
            pairs = segmentation.pair_segments(edited['source'], edited['target'], alignments=edited['alignments'])
            payload = records.with_parts(edited, records.normalize(edited, pairs, basis))
        elif op == 'set_progress':
            parts = records.parts_of(payload)
            if 'current' in step:
                parts = records.set_current(parts, step['current'])
            if 'finished' in step:
                for i in range(len(parts.segments)):
                    parts = records.set_finished(parts, i, i in step['finished'])
            payload = records.with_parts(payload, parts)
        elif op == 'save_and_reopen':
            raw = module.serialize_workfile(payload)
            payload = module.parse_workfile(raw)
            basis = None
        elif op == 'restore_history':
            payload = records.with_parts(payload, records.restore(payload, step['position'], step['segment']))
        elif op == 'assert':
            parts = records.parts_of(payload)
            pairs = segmentation.pair_segments(payload['source'], payload['target'], alignments=payload['alignments'])
            states = [records.record_view(r, payload, basis).state for r in parts.segments]
            choices = [[[c['choice'], c['source_span']['start'], c['confirmed']] for c in r['choices']] for r in parts.segments]
            plan = records.term_plan(payload, pairs, basis)
            restorable_map = [None] * len(parts.history)
            for pos, seg_idx in records.restorable(payload):
                if restorable_map[pos] is None:
                    restorable_map[pos] = seg_idx
            checkpoints.append({
                'states': states,
                'choices': choices,
                'history_count': len(parts.history),
                'progress': parts.progress,
                'probe': plan.probe,
                'restorable': restorable_map,
                'bytes': module.serialize_workfile(payload),
            })
    return checkpoints


try:
    if request['operation'] == 'parse':
        result = module.parse_workfile(request['content'])
    elif request['operation'] == 'serialize':
        result = module.serialize_workfile(request['payload'])
    elif request['operation'] == 'build_v2':
        result = build_v2(module)
    elif request['operation'] == 'build_v3':
        result = build_v3(module, request['scenario'])
    elif request['operation'] in ('alignment_inputs', 'normalize'):
        result = v3_runtime(request['operation'], request['payload'])
    elif request['operation'] == 'duplicate_case':
        result = duplicate_case(module, request['case'], request['basis'])
    elif request['operation'] == 'operation_trace':
        result = run_operation_trace(module, request['trace'], request['bases'], request['candidates'])
    elif request['operation'] == 'groups':
        result = module.choice_conflict_groups(request['payload'])
    else:
        raise ValueError('Unknown contract operation')
    response = {'result': result, 'format': module.WORKFILE_FORMAT}
except module.WorkfileError as error:
    response = {'error': error.code, 'format': module.WORKFILE_FORMAT}
json.dump(response, sys.stdout, ensure_ascii=False)
`;

function windows(request) {
  const result = spawnSync(process.env.WUWATERM_CONTRACT_PYTHON || 'python3',
    ['-I', '-B', '-c', pythonBridge, manuscriptPath],
    // A v3 file may be 44 MiB, so the pipes and the clock allow for one.
    { input: JSON.stringify(request), encoding: 'utf8', timeout: 120000, maxBuffer: 256 * 1024 * 1024 });
  assert.equal(result.status, 0, `Windows manuscript process failed: ${result.error || result.stderr}`);
  const response = JSON.parse(result.stdout);
  assert.equal(response.format, WORKFILE_FORMAT, 'Windows and Web manuscript versions differ');
  return response;
}

function sample() {
  const snapshot = fixture('🌊今汐。\n声骸。', '🌊Jinhsi.\nEcho.');
  snapshot.report = freshApiReport(snapshot.report);
  snapshot.alignments = [{
    source: { start: 0, end: Array.from(snapshot.source).length, text: snapshot.source },
    target: { start: 0, end: Array.from(snapshot.target).length, text: snapshot.target },
  }];
  const [first, second] = snapshot.report.findings;
  const choices = [
    makeChoice({ ...snapshot, finding: first, candidate: null }),
    makeChoice({ ...snapshot, finding: second, candidate: second.candidates[0] }),
  ];
  const history = {
    source: snapshot.source, target: snapshot.target, direction: snapshot.direction,
    alignments: snapshot.alignments, report: snapshot.report,
    resolutions: [
      { mention_id: first.id, choice: 'not_a_term' },
      { mention_id: second.id, choice: 'official_pair', candidate_id: second.candidates[0].candidate_id },
    ],
  };
  const oldHistory = structuredClone(history);
  oldHistory.report.rule_version = 'review-v1';
  delete oldHistory.report.dictionary.revision;
  delete oldHistory.report.matcher_revision;
  for (const finding of oldHistory.report.findings) {
    for (const candidate of finding.candidates) delete candidate.candidate_id;
  }
  return {
    snapshot,
    payload: { source: snapshot.source, target: snapshot.target, direction: snapshot.direction,
      alignments: snapshot.alignments, choices, history: [oldHistory, history], trusted: true, active: true },
  };
}

test('Web and the pinned Windows consumer exchange Unicode manuscripts and historical reports', () => {
  const { snapshot, payload } = sample();
  const webFile = serializeWorkfile(payload);
  const fromWeb = windows({ operation: 'parse', content: webFile });
  const fromWindows = windows({ operation: 'serialize', payload });
  assert.ok(fromWeb.result);
  assert.ok(fromWindows.result);
  const windowsParsed = parseWorkfile(fromWindows.result);
  assert.deepEqual(windowsParsed, fromWeb.result);
  assert.deepEqual(windowsParsed, parseWorkfile(webFile));
  assert.equal(windowsParsed.source, '🌊今汐。\n声骸。');
  assert.deepEqual(windowsParsed.choices, payload.choices);
  assert.deepEqual(windowsParsed.history, payload.history);
  assert.deepEqual(windowsParsed.history.map(item => item.report.rule_version), ['review-v1', 'review-v2']);
  assert.equal(Object.hasOwn(windowsParsed, 'trusted'), false);
  assert.equal(Object.hasOwn(windowsParsed, 'active'), false);
  assert.ok(windowsParsed.history.every(item => !Object.hasOwn(item, 'trusted') && !Object.hasOwn(item, 'active')));
  const choice = windowsParsed.choices[0];
  assert.equal(reconcileChoice(choice, snapshot, windowsParsed.history[1], true).code, 'awaiting_fresh_basis');
  assert.equal(reconcileChoice(choice, snapshot, snapshot, true).code, 'imported_not_a_term');
});

test('both consumers reject unsupported formats, report versions and duplicate source choices', () => {
  const { payload } = sample();
  const base = parseWorkfile(serializeWorkfile(payload));
  const cases = [
    // A v2 label on a v1 body lacks the semantic keys, so both consumers reject it as an unsupported shape.
    { code: 'workfile_unsupported_format', mutate: value => { value.format = 'wuwaterm-manuscript-v2'; } },
    { code: 'workfile_invalid_content', mutate: value => { value.history[0].report.rule_version = 'review-v3'; } },
    { code: 'workfile_unsupported_format', mutate: value => { value.trusted = true; } },
    { code: 'workfile_duplicate_choices', mutate: value => {
      value.source = '另一个段落';
      value.alignments = null;
      value.choices = [value.choices[0], structuredClone(value.choices[0])];
    } },
  ];
  for (const { code, mutate } of cases) {
    const value = structuredClone(base);
    mutate(value);
    const content = JSON.stringify(value);
    assert.throws(() => parseWorkfile(content), { code });
    assert.equal(windows({ operation: 'parse', content }).error, code);
  }
});

test('choices that converge after a source edit cannot be saved until the conflict is resolved', () => {
  const { snapshot, payload } = sample();
  const first = payload.choices[0];
  const other = structuredClone(first);
  const prefix = 'another block\n';
  other.source = prefix + other.source;
  other.source_span.start += Array.from(prefix).length;
  other.source_span.end += Array.from(prefix).length;
  const ambiguous = { ...payload, source: `${payload.source}\n${payload.source}`, choices: [first, other] };
  const webFile = serializeWorkfile(ambiguous);
  const loaded = windows({ operation: 'parse', content: webFile }).result;
  assert.deepEqual(windows({ operation: 'groups', payload: loaded }).result, []);
  loaded.source = payload.source;
  assert.deepEqual(windows({ operation: 'groups', payload: loaded }).result, [[0, 1]]);
  assert.ok(reconcileChoices(loaded.choices, snapshot, snapshot, loaded.choices)
    .every(item => item.status === 'pending' && item.code === 'duplicate_position' && item.resolution === null));
  assert.throws(() => serializeWorkfile(loaded), { code: 'workfile_duplicate_choices' });
  assert.equal(windows({ operation: 'serialize', payload: loaded }).error, 'workfile_duplicate_choices');
  loaded.choices.pop();
  const recovered = windows({ operation: 'serialize', payload: loaded }).result;
  const reopened = parseWorkfile(recovered);
  assert.deepEqual(reopened.choices, [first]);
  assert.deepEqual(reopened.history, payload.history);
  assert.deepEqual(reopened.alignments, payload.alignments);
});

// ---- Manuscript v2: both directions -------------------------------------------------

const v2Dir = fileURLToPath(new URL('../../contracts/manuscript-v2/', import.meta.url));
const v2Cases = JSON.parse(readFileSync(join(v2Dir, 'cases.json'), 'utf8'));
const read = file => readFileSync(join(v2Dir, file), 'utf8');
const SEMANTIC_KEYS = ['semantic_decisions', 'semantic_texts', 'semantic_history'];

// Exchange one v2 file: Windows reads it, rewrites it, Web reads that rewrite.
// Returns whether the rewrite is byte-identical to the input.
function exchange(content, label) {
  const web = parseWorkfile(content);
  assert.equal(web.format, WORKFILE_FORMAT_V2, label);
  const fromWindows = windows({ operation: 'parse', content });
  assert.ok(fromWindows.result, `${label}: Windows rejected a Web v2 file (${fromWindows.error})`);
  assert.deepEqual(fromWindows.result, web, `${label}: Windows parse differs from Web parse`);
  const rewritten = windows({ operation: 'serialize', payload: fromWindows.result });
  assert.ok(rewritten.result, `${label}: Windows could not write it back (${rewritten.error})`);
  const reread = parseWorkfile(rewritten.result);
  assert.deepEqual(reread, web, `${label}: Windows rewrite changes the content`);
  for (const key of SEMANTIC_KEYS) assert.deepEqual(reread[key], web[key], `${label}: ${key}`);
  assert.deepEqual(semanticPartsOf(reread), semanticPartsOf(web));
  const webAgain = serializeWorkfile(web);
  return { rewritten: rewritten.result, bytesEqual: rewritten.result === content, webBytesEqual: webAgain === content };
}

test('every valid v2 fixture is read by Windows and survives a Windows rewrite', () => {
  assert.ok(v2Cases.valid.length >= 1);
  for (const { file } of v2Cases.valid) {
    const content = read(file);
    const result = exchange(content, file);
    assert.equal(result.webBytesEqual, true, `${file}: Web does not rewrite its own fixture byte for byte`);
    assert.equal(result.bytesEqual, true, `${file}: Windows rewrite differs from the fixture bytes`);
  }
});

test('a Web-written v2 manuscript with every decision kind is read by Windows and rewritten by it', () => {
  const { payload } = sample();
  const base = parseWorkfile(read(v2Cases.valid[0].file));
  const live = { ...payload, ...semanticPartsOf(base) };
  assert.deepEqual(live.semantic_decisions.map(item => item.decision), ['accepted', 'ignored', 'adjusted']);
  const content = serializeWorkfile(live);
  assert.equal(JSON.parse(content).format, WORKFILE_FORMAT_V2);
  const result = exchange(content, 'live Web v2');
  assert.equal(result.webBytesEqual, true);
  assert.equal(result.bytesEqual, true, 'Windows rewrite differs from the Web-written bytes');
  assert.deepEqual(parseWorkfile(result.rewritten).choices, payload.choices);
});

test('a v2 manuscript built by the Windows client is read and rewritten by Web, and read back by Windows', () => {
  const built = windows({ operation: 'build_v2' }).result;
  assert.equal(JSON.parse(built.content).format, WORKFILE_FORMAT_V2);
  const web = parseWorkfile(built.content);
  assert.deepEqual(web.semantic_decisions, built.payload.semantic_decisions);
  assert.deepEqual(web.semantic_texts, built.payload.semantic_texts);
  assert.deepEqual(web.semantic_history, built.payload.semantic_history);
  const webFile = serializeWorkfile(web);
  assert.equal(webFile, built.content, 'Web rewrite differs from the Windows-written bytes');
  const back = windows({ operation: 'parse', content: webFile });
  assert.ok(back.result, back.error);
  assert.deepEqual(back.result, web);
});

test('both consumers reject every invalid v2 fixture', () => {
  const differing = [];
  for (const { file, error } of v2Cases.invalid) {
    const content = read(file);
    let webCode = null;
    try { parseWorkfile(content); } catch (cause) { webCode = cause.code; }
    assert.equal(webCode, error, `${file}: Web error code`);
    const windowsCode = windows({ operation: 'parse', content }).error;
    assert.ok(windowsCode, `${file}: Windows accepted an invalid fixture`);
    if (windowsCode !== error) differing.push(`${file}: Web ${error}, Windows ${windowsCode}`);
  }
  // Both reject; the error code must match where the two ports define the same limit.
  assert.deepEqual(differing, [], 'Web and Windows report different codes for the same invalid file');
});

// ---- Manuscript v3: both directions -------------------------------------------------

const v3Dir = fileURLToPath(new URL('../../contracts/manuscript-v3/', import.meta.url));
const v3Cases = JSON.parse(readFileSync(join(v3Dir, 'cases.json'), 'utf8'));
const readV3 = file => readFileSync(join(v3Dir, file), 'utf8');
const contentOf = c => (c.pad_to_bytes ? readV3(c.file) + ' '.repeat(c.pad_to_bytes - Buffer.byteLength(readV3(c.file), 'utf8')) : readV3(c.file));
const draftOf = x => ({ source: x.source, target: x.target, direction: x.direction, alignments: x.alignments });

test('every valid v3 fixture is read alike by Web and Windows, and both write back its canonical bytes', () => {
  for (const c of v3Cases.valid) {
    const content = contentOf(c);
    const web = parseWorkfile(content);
    const fromWindows = windows({ operation: 'parse', content });
    assert.ok(fromWindows.result, `${c.file}: Windows rejected it (${fromWindows.error})`);
    assert.deepEqual(fromWindows.result, web, `${c.file}: Windows parse differs from Web parse`);
    const canonical = readV3(c.canonical);
    assert.equal(serializeWorkfile(web), canonical, `${c.file}: Web bytes`);
    assert.equal(windows({ operation: 'serialize', payload: fromWindows.result }).result, canonical, `${c.file}: Windows bytes`);
  }
});

// invalid-v3-format-v4.json is the v3 contract's "unknown format version" case and a valid v4 payload, so the v3 reader gives its
// code while the v4-capable Web parser and the pinned Windows consumer both accept it.
const READ_AS_V4 = new Set(['invalid-v3-format-v4.json']);

test('both consumers reject every invalid v3 fixture with its code, including 129 decisions in the v2 part', () => {
  assert.ok(v3Cases.invalid.some(c => c.file === 'invalid-v3-129-decisions.json' && c.error === 'workfile_too_many_entries'));
  const differing = [];
  for (const c of v3Cases.invalid) {
    const content = contentOf(c);
    if (READ_AS_V4.has(c.file)) {
      assert.equal(parseWorkfile(content).format, 'wuwaterm-manuscript-v4', `${c.file}: Web reads it as v4`);
      const fromWindows = windows({ operation: 'parse', content });
      assert.ok(fromWindows.result, `${c.file}: Windows rejected a valid v4 payload (${fromWindows.error})`);
      continue;
    }
    let web = null;
    try { parseWorkfile(content); } catch (cause) { web = cause.code; }
    const fromWindows = windows({ operation: 'parse', content }).error ?? null;
    if (web !== c.error || fromWindows !== c.error) differing.push(`${c.file}: expected ${c.error}, Web ${web}, Windows ${fromWindows}`);
  }
  assert.deepEqual(differing, []);
});

test('Windows computes the stored alignment input digest of the explicit-alignments fixture, as Web does', () => {
  const x = parseWorkfile(readV3('valid-v3-explicit-alignments.json'));
  assert.ok(Array.isArray(x.alignments) && x.alignments.length > 0);
  const web = x.segments.map(r => L.alignmentInput(x.alignments, x.source, x.target, r));
  assert.ok(web.every(value => /^[0-9a-f]{64}$/u.test(value)));
  assert.deepEqual(windows({ operation: 'alignment_inputs', payload: x }).result, web);
  const live = x.segments.filter(r => r.status !== 'pending');
  assert.ok(live.length > 0);
  for (const r of live) assert.equal(r.alignment_input, web[r.index], `record ${r.index}`);
});

// Three synthetic paragraphs per side, each starting with the term: a long manuscript of three ready segments.
const SCENARIO = (() => {
  const zh = i => `今汐在第${i}段。今汐又来了。${Array.from({ length: 80 }, (_, k) => `第${i}段第${k + 1}句是合成句子。`).join('')}`;
  const en = i => `Jinhsi is in paragraph ${i}. Jinhsi came back. ${Array.from({ length: 34 }, (_, k) => `Paragraph ${i} line ${k + 1} is synthetic.`).join(' ')}`;
  return {
    source: [1, 2, 3].map(zh).join('\n\n'), target: [1, 2, 3].map(en).join('\n\n'),
    candidate: { candidate_id: hash('candidate-jinhsi'), zh: '今汐', en: 'Jinhsi', category: 'character' },
    // A second candidate that one response offers at the second occurrence, which unconfirms the not_a_term chosen there.
    extra: { candidate_id: hash('candidate-jinhsi-extra'), zh: '今汐', en: 'Jinhsi Prime', category: 'character' },
    basis: { rule_version: 'review-v2', dictionary: { ...dictionary }, matcher_revision: FRESH_MATCHER_REVISION },
    target_edit: ['Paragraph 1 line 1 is synthetic.', 'Paragraph 1 line 1 is still synthetic.'],
  };
})();

/** The same steps as build_v3 in the bridge, through the Web runtime (lib/long-review.ts). */
function webBuiltV3({ source, target, candidate, extra, basis: responseBasis, target_edit: [old, replacement] }) {
  let draft = { source, target, direction: 'en', alignments: null };
  let long = L.longFromWorkfile({ ...draft, segments: [], segment_choice_history: [], progress: { current: null, completed: [] } });
  let basis = null;
  const second = (core, text) => core.indexOf(text, core.indexOf(text) + 1);
  const report = (index, variant) => {
    const it = L.segmentInputs(draft).items[index];
    const found = (s, t, candidates) => ({ verdict: 'verified_constraint', source: [s, s + candidate.zh.length], target: [t, t + candidate.en.length],
      candidates, candidates_truncated: false });
    const result = { truncated: false, evaluated: 2, not_evaluated: 0, findings: [
      found(0, it.targetCore.indexOf(candidate.en), [candidate]),
      found(second(it.sourceCore, candidate.zh), second(it.targetCore, candidate.en), variant === 'extra' ? [candidate, extra] : [candidate]),
    ] };
    return { ...L.expandResult({ source_hash: it.sourceHash, target_hash: it.targetHash, basis: responseBasis, result }, it.sourceCore, it.targetCore), request_id: 'web-built' };
  };
  // One segment check as the workbench runs it: the planned request, then at most one more when applyResult asks for it.
  const check = (index, variants = []) => {
    for (let n = 0; n < 2; n += 1) {
      const ctx = { draft, basis };
      const request = L.segmentRequest(long, index, ctx, { withResolutions: n > 0 || L.recheckPlan(long, index, ctx) === 'with_resolutions' });
      const out = L.applyResult(long, ctx, request, report(index, variants[n]));
      assert.equal(out.error, null);
      ({ long, basis } = out);
      if (!out.secondRequest) return n + 1;
    }
    assert.fail('the check did not settle');
  };
  const choose = (index, start, picked) => {
    long = L.chooseTerm(long, { index, finding: { source: [start, start + candidate.zh.length] }, candidate: picked }, { draft, basis }).long;
  };
  check(0);
  check(1);
  choose(0, 0, candidate);
  choose(1, 0, null);
  check(0);
  choose(0, second(source, candidate.zh), null);
  check(0, ['extra']);
  // A target-only edit of segment 0, then its re-check under the same basis.
  const edited = { ...draft, target: draft.target.replace(old, replacement) };
  long = L.reconcileLong(long, draft, edited);
  draft = edited;
  const requests = check(0);
  long = L.setFinished(L.setFinished(L.setCurrent(long, 1), 0, true), 1, true);
  const content = serializeWorkfile({ ...draft, choices: [], history: [], semantic_decisions: [], semantic_texts: [], semantic_history: [], ...L.workfileParts(long, draft, { basis }) });
  return { content, requests };
}

test('a long manuscript with choices, a target-only edit and progress: Web and Windows write the same v3 bytes and keep each other\'s file', () => {
  const web = webBuiltV3(SCENARIO);
  const built = windows({ operation: 'build_v3', scenario: SCENARIO }).result;
  assert.equal(JSON.parse(web.content).format, WORKFILE_FORMAT_V3);
  assert.equal(built.content, web.content, 'the same runtime steps give different files');
  // SPEC step 6: after the target-only edit only the request count may differ (Web 1, a realigning client 2).
  assert.equal(web.requests, 1);
  assert.ok([1, 2].includes(built.edit_requests), `${built.edit_requests} requests`);
  const parsed = parseWorkfile(built.content);
  assert.deepEqual(parsed.segments.map(r => r.status), ['done', 'stale', 'pending']);
  // The not_a_term at the second occurrence matches again but was unconfirmed before the edit, so it stays unconfirmed.
  assert.deepEqual(parsed.segments.map(r => r.choices.map(c => [c.choice, c.source_span.start, c.confirmed])),
    [[['official_pair', 0, true], ['not_a_term', 7, false]], [['not_a_term', 0, true]], []]);
  assert.ok(parsed.target.includes(SCENARIO.target_edit[1]));
  assert.deepEqual(parsed.progress, { current: 1, completed: [0, 1] });
  // Web opens the Windows file through its runtime and writes it back byte for byte.
  const long = L.longFromWorkfile(parsed);
  assert.equal(serializeWorkfile({ ...parsed, ...L.workfileParts(long, draftOf(parsed), { basis: null }) }), built.content);
  // Windows reads the Web file as Web does, its normalize keeps every record, and it writes the file back byte for byte.
  const fromWindows = windows({ operation: 'parse', content: web.content });
  assert.deepEqual(fromWindows.result, parseWorkfile(web.content));
  assert.deepEqual(windows({ operation: 'normalize', payload: fromWindows.result }).result,
    { segments: parsed.segments, segment_choice_history: parsed.segment_choice_history, progress: parsed.progress });
  assert.equal(windows({ operation: 'serialize', payload: fromWindows.result }).result, web.content);
});

const duplicateCasesPath = fileURLToPath(new URL('../../contracts/workbench-state/duplicate-attribution.json', import.meta.url));
const duplicateCases = JSON.parse(readFileSync(duplicateCasesPath, 'utf8'));

test('MY-350 duplicate attribution: Web and Windows produce identical v3 bytes and round-trip each other', () => {
  assert.equal(duplicateCases.schema, 'wuwaterm-duplicate-attribution-cases-v1');
  for (const c of duplicateCases.cases) {
    const parsed = parseWorkfile(JSON.stringify(c.workfile));
    let draft = { source: parsed.source, target: parsed.target, direction: parsed.direction, alignments: parsed.alignments };
    let long = L.longFromWorkfile(parsed);
    if (c.edits.length > 0) {
      const next = { ...draft };
      for (const ed of c.edits) {
        if ('side' in ed) {
          const chars = Array.from(next[ed.side]);
          next[ed.side] = chars.slice(0, ed.start).join('') + ed.insert + chars.slice(ed.old_end).join('');
        } else if ('direction' in ed) {
          next.direction = ed.direction;
        } else {
          next.alignments = ed.alignments;
        }
      }
      long = L.reconcileLong(long, draft, next);
      draft = next;
    }
    const webBytes = serializeWorkfile({ ...parsed, ...draft, ...L.workfileParts(long, draft, { basis: duplicateCases.basis }) });
    const winBytes = windows({ operation: 'duplicate_case', case: c, basis: duplicateCases.basis }).result;
    assert.equal(winBytes, webBytes, `${c.id}: Windows bytes differ from Web bytes`);
    // Bidirectional reopen parity: Web opens Windows's bytes and writes identically; Windows opens Web's bytes identically.
    const winParsedByWeb = parseWorkfile(winBytes);
    const webReopened = L.longFromWorkfile(winParsedByWeb);
    assert.equal(serializeWorkfile({ ...winParsedByWeb, ...L.workfileParts(webReopened, {
      source: winParsedByWeb.source, target: winParsedByWeb.target, direction: winParsedByWeb.direction, alignments: winParsedByWeb.alignments,
    }, { basis: duplicateCases.basis }) }), winBytes, `${c.id}: Web reopen of Windows bytes drifted`);
    const webParsedByWin = windows({ operation: 'parse', content: webBytes }).result;
    assert.deepEqual(webParsedByWin, winParsedByWeb, `${c.id}: Windows parse of Web bytes differs`);
    const winNorm = windows({ operation: 'normalize', payload: webParsedByWin }).result;
    assert.equal(windows({ operation: 'serialize', payload: { ...webParsedByWin, ...winNorm } }).result, webBytes, `${c.id}: Windows reopen of Web bytes drifted`);
  }
});

// ---- Manuscript v4: both consumers read, write and reject it alike -----------------------------------------------------------

const v4Dir = fileURLToPath(new URL('../../contracts/manuscript-v4/', import.meta.url));
const v4Cases = JSON.parse(readFileSync(join(v4Dir, 'cases.json'), 'utf8'));
const readV4 = file => readFileSync(join(v4Dir, file), 'utf8');
const contentOfV4 = c => (c.pad_to_bytes ? readV4(c.file) + ' '.repeat(c.pad_to_bytes - Buffer.byteLength(readV4(c.file), 'utf8')) : readV4(c.file));

test('every valid v4 fixture: Web and Windows read it alike and write its canonical bytes', () => {
  for (const c of v4Cases.valid) {
    const content = contentOfV4(c);
    const web = parseWorkfile(content);
    assert.equal(serializeWorkfile(web), readV4(c.canonical), `${c.file}: Web bytes`);
    const fromWindows = windows({ operation: 'parse', content });
    assert.ok(fromWindows.result, `${c.file}: Windows rejected it (${fromWindows.error})`);
    assert.deepEqual(fromWindows.result, web, `${c.file}: Windows parse differs from Web parse`);
    assert.equal(windows({ operation: 'serialize', payload: fromWindows.result }).result, readV4(c.canonical), `${c.file}: Windows bytes`);
  }
});

test('every invalid v4 fixture: Web and Windows give its code', () => {
  const differing = [];
  for (const c of v4Cases.invalid) {
    const content = contentOfV4(c);
    let web = null;
    try { parseWorkfile(content); } catch (cause) { web = cause.code; }
    const fromWindows = windows({ operation: 'parse', content }).error ?? null;
    if (web !== c.error || fromWindows !== c.error) differing.push(`${c.file}: expected ${c.error}, Web ${web}, Windows ${fromWindows}`);
  }
  assert.deepEqual(differing, []);
});

const operationTracesPath = fileURLToPath(new URL('../../contracts/workbench-state/operation-traces.json', import.meta.url));
const operationTraces = JSON.parse(readFileSync(operationTracesPath, 'utf8'));

test('shared operation traces produce identical checkpoints and canonical v3/v4 bytes across Web and Windows', () => {
  assert.equal(operationTraces.schema, 'wuwaterm-operation-traces-v1');
  for (const trace of operationTraces.traces) {
    const webCheckpoints = runWebTrace(trace);
    const winCheckpoints = windows({
      operation: 'operation_trace',
      trace,
      bases: operationTraces.bases,
      candidates: operationTraces.candidates,
    }).result;
    assert.equal(winCheckpoints.length, webCheckpoints.length, `${trace.id}: checkpoint count mismatch`);
    for (let i = 0; i < webCheckpoints.length; i += 1) {
      assert.deepEqual(winCheckpoints[i], webCheckpoints[i], `${trace.id} checkpoint #${i} diverged between Web and Windows`);
    }
  }
});
