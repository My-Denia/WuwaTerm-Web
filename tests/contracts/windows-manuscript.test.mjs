import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { WORKFILE_FORMAT, WORKFILE_FORMAT_V2, makeChoice, parseWorkfile, reconcileChoice, reconcileChoices, semanticPartsOf, serializeWorkfile } from '../../lib/manuscript.js';
import { fixture, freshApiReport } from '../fixtures/manuscript.mjs';
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
try:
    if request['operation'] == 'parse':
        result = module.parse_workfile(request['content'])
    elif request['operation'] == 'serialize':
        result = module.serialize_workfile(request['payload'])
    elif request['operation'] == 'build_v2':
        result = build_v2(module)
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
    { input: JSON.stringify(request), encoding: 'utf8', timeout: 30000 });
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
