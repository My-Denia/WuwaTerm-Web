import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  parseArgs,
  parseAuditReport,
  UntrustworthyReport,
} from '../scripts/check-dependency-advisories.mjs';

const script = fileURLToPath(new URL('../scripts/check-dependency-advisories.mjs', import.meta.url));
const directory = mkdtempSync(join(tmpdir(), 'wuwaterm-dependency-audit-'));

after(() => rmSync(directory, { recursive: true, force: true }));

// The shapes below were taken from npm 11.6.2 reports, trimmed to the fields
// the gate reads. npm writes metadata totals that count vulnerability entries,
// not advisories: lodash 4.17.20 carries four advisories and counts once.
function auditReport(vulnerabilities = {}, declaredCounts) {
  const tally = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  for (const entry of Object.values(vulnerabilities)) {
    tally[entry.severity] = (tally[entry.severity] ?? 0) + 1;
  }
  return {
    auditReportVersion: 2,
    vulnerabilities,
    metadata: {
      vulnerabilities: declaredCounts ?? { ...tally, total: Object.keys(vulnerabilities).length },
      dependencies: { prod: 20, dev: 666, optional: 198, peer: 22, peerOptional: 0, total: 696 },
    },
  };
}

function advisoryEntry(overrides) {
  return {
    name: 'lodash',
    severity: 'high',
    isDirect: true,
    range: '<=4.17.23',
    via: [{ title: 'Command Injection in lodash', url: 'https://github.com/advisories/GHSA-35jh-r3h4-6jhm' }],
    effects: [],
    fixAvailable: true,
    ...overrides,
  };
}

function writeReport(json) {
  const path = join(directory, `${randomUUID()}.json`);
  writeFileSync(path, typeof json === 'string' ? json : JSON.stringify(json));
  return path;
}

function run(json, extraArguments = []) {
  const path = writeReport(json);
  return spawnSync(process.execPath, [script, path, ...extraArguments], { encoding: 'utf8' });
}

function runArguments(arguments_) {
  return spawnSync(process.execPath, [script, ...arguments_], { encoding: 'utf8' });
}

test('a clean production tree passes', () => {
  const result = run(auditReport(), ['--audit-exit', '0', '--label', 'production dependency tree']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Audited: production dependency tree/);
  assert.match(result.stdout, /no advisories reported for this tree/);
  assert.match(result.stdout, /PASSED: no critical or high advisories/);
});

test('a high advisory blocks the gate and names the package', () => {
  const result = run(auditReport({ lodash: advisoryEntry({}) }), ['--audit-exit', '1']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /high lodash \(direct\)/);
  assert.match(result.stdout, /GHSA-35jh-r3h4-6jhm/);
  assert.match(result.stdout, /::error title=lodash \(high\)::/);
  assert.match(result.stderr, /FAILED: 1 blocking advisory/);
});

test('a critical advisory blocks the gate even when it is transitive', () => {
  const report = auditReport({
    minimist: advisoryEntry({
      name: 'minimist',
      severity: 'critical',
      isDirect: false,
      via: ['express'],
      effects: ['express'],
    }),
  });
  const result = run(report, ['--audit-exit', '1']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /critical minimist \(transitive\)/);
  assert.match(result.stdout, /through express/);
});

test('a moderate advisory is reported but does not block', () => {
  const result = run(auditReport({ braces: advisoryEntry({ name: 'braces', severity: 'moderate' }) }), [
    '--audit-exit',
    '1',
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /moderate braces/);
  assert.match(result.stdout, /PASSED: no critical or high advisories/);
});

test('--summary-only reports a high advisory without failing on it', () => {
  const result = run(auditReport({ lodash: advisoryEntry({}) }), ['--audit-exit', '1', '--summary-only']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SUMMARY: reported, not gated/);
  assert.match(result.stdout, /above the threshold/);
});

test('a failed audit is not a clean audit', () => {
  const failures = {
    'missing lockfile': { error: { code: 'ENOLOCK', summary: 'This command requires an existing lockfile.' } },
    'unreachable registry': { message: 'request to http://127.0.0.1:1/-/npm/v1/security/advisories/bulk failed' },
  };
  for (const [label, payload] of Object.entries(failures)) {
    const result = run(payload, ['--audit-exit', '1']);
    assert.equal(result.status, 2, `${label} exited ${result.status}`);
    assert.match(result.stderr, /could not be trusted/);
  }
});

test('a report that cannot be read is a failure', () => {
  for (const payload of ['not json at all', '[]', '{}']) {
    const result = run(payload, ['--audit-exit', '0']);
    assert.equal(result.status, 2, `${payload} exited ${result.status}`);
  }
  const missing = runArguments([join(directory, 'absent.json'), '--audit-exit', '0']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /could not be read/);
});

test('an empty tree is not a clean tree', () => {
  const report = auditReport();
  report.metadata.dependencies.prod = 0;
  const result = run(report, ['--audit-exit', '0']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /covers no production dependencies/);
});

test('a report whose totals disagree with its entries is not trusted', () => {
  const report = auditReport({}, { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 });
  const result = run(report, ['--audit-exit', '1']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /contradicts itself/);
  assert.match(result.stderr, /metadata says 1 high, entries carry 0/);
});

test('an advisory whose severity cannot be classified is not trusted', () => {
  const report = auditReport({ lodash: advisoryEntry({ severity: 'severe' }) });
  const result = run(report, ['--audit-exit', '1']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /cannot classify/);
});

test('an exit status that is not a verdict is not trusted', () => {
  const crashed = run(auditReport(), ['--audit-exit', '7']);
  assert.equal(crashed.status, 2);
  assert.match(crashed.stderr, /neither "no advisories" \(0\) nor "advisories found" \(1\)/);

  const contradictory = run(auditReport(), ['--audit-exit', '1']);
  assert.equal(contradictory.status, 2);
  assert.match(contradictory.stderr, /the status and the report disagree/);
});

test('findings are printed most severe first', () => {
  const report = auditReport({
    braces: advisoryEntry({ name: 'braces', severity: 'moderate' }),
    minimist: advisoryEntry({ name: 'minimist', severity: 'critical' }),
    lodash: advisoryEntry({}),
  });
  const result = run(report, ['--audit-exit', '1']);
  assert.equal(result.status, 1);
  const positions = ['critical minimist', 'high lodash', 'moderate braces'].map((needle) =>
    result.stdout.indexOf(needle),
  );
  assert.ok(positions.every((position) => position >= 0), result.stdout);
  assert.deepEqual([...positions].sort((left, right) => left - right), positions);
});

test('the report reader returns what npm reported about the lockfile', () => {
  const { findings, coverage } = parseAuditReport(
    JSON.stringify(auditReport({ lodash: advisoryEntry({}) })),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'high');
  assert.equal(coverage.production, 20);
  assert.equal(coverage.total, 696);
});

test('options are parsed strictly', () => {
  assert.throws(() => parseArgs(['report.json', '--audit-exit', '']), UntrustworthyReport);
  assert.throws(() => parseArgs(['report.json', '--audit-exit', 'one']), UntrustworthyReport);
  assert.throws(() => parseArgs(['report.json', '--nonsense']), UntrustworthyReport);
  assert.throws(() => parseArgs(['one.json', 'two.json']), UntrustworthyReport);
  assert.deepEqual(parseArgs(['report.json', '--audit-exit', '1', '--summary-only']), {
    report: 'report.json',
    auditExit: 1,
    label: 'dependency tree',
    summaryOnly: true,
    help: false,
  });
});

test('the help text is not a verdict', () => {
  const result = runArguments(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /usage: node scripts\/check-dependency-advisories\.mjs/);
});
