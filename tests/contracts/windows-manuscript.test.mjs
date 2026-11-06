import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import { WORKFILE_FORMAT, makeChoice, parseWorkfile, reconcileChoice, reconcileChoices, serializeWorkfile } from '../../lib/manuscript.js';
import { fixture, freshApiReport } from '../fixtures/manuscript.mjs';
import { requireWindowsRoot } from './windows-source.mjs';

const windowsRoot = requireWindowsRoot();
const manuscriptPath = join(windowsRoot, 'src/wuwaterm_client/manuscript.py');

// Load only the pinned, stdlib-only manuscript module: importing the client
// package's API or UI would require desktop credentials and Qt dependencies.
const pythonBridge = String.raw`
import importlib.util
import json
import sys

if sys.version_info < (3, 12):
    raise RuntimeError('The Windows consumer requires Python 3.12 or later')
spec = importlib.util.spec_from_file_location('windows_manuscript', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
request = json.load(sys.stdin)
try:
    if request['operation'] == 'parse':
        result = module.parse_workfile(request['content'])
    elif request['operation'] == 'serialize':
        result = module.serialize_workfile(request['payload'])
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
