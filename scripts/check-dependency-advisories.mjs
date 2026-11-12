#!/usr/bin/env node
/**
 * Decide whether an `npm audit --json` report blocks a dependency change.
 *
 * The installed npm's exit status is not a verdict: `npm audit` exits 1 when it
 * finds advisories and it also exits 1 when the audit itself failed. Measured
 * with npm 11.6.2, a missing lockfile answers exit 1 with
 * `{"error":{"code":"ENOLOCK"}}` on stdout, and an unreachable registry answers
 * exit 1 with `{"message":"... failed, reason: connect ECONNREFUSED ..."}`
 * instead of a report. A gate that reads only the status cannot tell those
 * apart from a real finding, so this script validates the report first and
 * treats anything it cannot read as a failure.
 *
 * Two modes share that validation:
 *
 *   node scripts/check-dependency-advisories.mjs report.json \
 *     --audit-exit 1 --label "production dependency tree"
 *       Fail when a critical or high advisory is in the report.
 *
 *   node scripts/check-dependency-advisories.mjs report.json \
 *     --audit-exit 1 --label "full dependency tree" --summary-only
 *       Print the same findings without failing on their severity. The
 *       dev-inclusive tree carries build and test tooling whose moderate
 *       advisories are not what this gate is for; they stay visible in the log
 *       and in the uploaded report instead of turning every week red.
 *
 * Exit status: 0 clean (or summary-only), 1 blocking advisories, 2 the report
 * cannot be trusted. 1 and 2 are both failures; 2 says the answer is unknown.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SEVERITY_ORDER = ['critical', 'high', 'moderate', 'low', 'info'];
const BLOCKING = new Set(['critical', 'high']);

const USAGE = `usage: node scripts/check-dependency-advisories.mjs <report.json> [options]

  --audit-exit <status>  the status npm audit exited with (0 or 1; anything
                         else means the audit did not complete)
  --label <text>         what was audited, printed in the header
  --summary-only         report the findings without failing on their severity;
                         a report that cannot be trusted still fails
  --help                 print this message`;

/** A report this gate refuses to draw a conclusion from. */
export class UntrustworthyReport extends Error {}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseArgs(argv) {
  const args = { report: null, auditExit: 0, label: 'dependency tree', summaryOnly: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--summary-only') {
      args.summaryOnly = true;
    } else if (argument === '--help' || argument === '-h') {
      args.help = true;
    } else if (argument === '--audit-exit' || argument === '--label') {
      const value = argv[index + 1];
      if (value === undefined || value.trim() === '') {
        throw new UntrustworthyReport(`${argument} needs a value`);
      }
      index += 1;
      if (argument === '--label') {
        args.label = value;
      } else {
        if (!/^-?\d+$/.test(value)) {
          throw new UntrustworthyReport(`--audit-exit "${value}" is not an integer`);
        }
        args.auditExit = Number(value);
      }
    } else if (argument.startsWith('-')) {
      throw new UntrustworthyReport(`unknown option ${argument}`);
    } else if (args.report === null) {
      args.report = argument;
    } else {
      throw new UntrustworthyReport(`unexpected second report path ${argument}`);
    }
  }
  return args;
}

/**
 * Turn a report into findings, or refuse it.
 *
 * `npm audit` writes a well-formed report for both outcomes, so the shapes
 * below are also the only way to tell "nothing found" from "nothing looked at".
 */
export function parseAuditReport(raw) {
  let report;
  try {
    report = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    throw new UntrustworthyReport(`the audit report is not JSON: ${error.message}`);
  }
  if (!isPlainObject(report)) {
    throw new UntrustworthyReport('the audit report is not a JSON object');
  }
  if (report.error !== undefined || typeof report.message === 'string') {
    throw new UntrustworthyReport(
      `npm audit answered with a failure instead of a report: ${describeFailure(report)}`,
    );
  }
  if (typeof report.auditReportVersion !== 'number') {
    throw new UntrustworthyReport(
      'the report has no numeric auditReportVersion, so it is not an npm audit report',
    );
  }
  const counts = declaredCounts(report.metadata);
  const coverage = lockCoverage(report.metadata);
  if (!isPlainObject(report.vulnerabilities)) {
    throw new UntrustworthyReport(
      'the report has no vulnerabilities object, so "no findings" cannot be read from it',
    );
  }
  const findings = Object.entries(report.vulnerabilities).map(([key, entry]) => readFinding(key, entry));
  verifyConsistency(counts, findings);
  return { counts, coverage, findings };
}

function describeFailure(report) {
  const parts = [];
  if (isPlainObject(report.error)) {
    for (const field of ['code', 'summary', 'detail']) {
      const value = report.error[field];
      if (typeof value === 'string' && value.trim() !== '') parts.push(value.trim());
    }
  }
  if (typeof report.message === 'string' && report.message.trim() !== '') {
    parts.push(report.message.trim());
  }
  return parts.length > 0 ? parts.join(': ') : 'no detail was given';
}

function declaredCounts(metadata) {
  if (!isPlainObject(metadata) || !isPlainObject(metadata.vulnerabilities)) {
    throw new UntrustworthyReport(
      'the report has no metadata.vulnerabilities block, so its totals cannot be read',
    );
  }
  const counts = {};
  for (const severity of SEVERITY_ORDER) {
    counts[severity] = readCount(metadata.vulnerabilities, severity, 'metadata.vulnerabilities');
  }
  counts.total = readCount(metadata.vulnerabilities, 'total', 'metadata.vulnerabilities');
  return counts;
}

function lockCoverage(metadata) {
  const dependencies = isPlainObject(metadata) ? metadata.dependencies : undefined;
  if (!isPlainObject(dependencies)) {
    throw new UntrustworthyReport(
      'the report has no metadata.dependencies block, so an audit of nothing would look clean',
    );
  }
  const coverage = {
    production: readCount(dependencies, 'prod', 'metadata.dependencies'),
    dev: readCount(dependencies, 'dev', 'metadata.dependencies'),
    optional: readCount(dependencies, 'optional', 'metadata.dependencies'),
    peer: readCount(dependencies, 'peer', 'metadata.dependencies'),
    total: readCount(dependencies, 'total', 'metadata.dependencies'),
  };
  if (coverage.production < 1) {
    throw new UntrustworthyReport(
      'the report covers no production dependencies, so it is not the answer for a project ' +
        'that declares some: npm read an empty graph, another directory or a stale lockfile',
    );
  }
  return coverage;
}

function readCount(source, field, where) {
  const value = source[field] ?? 0;
  if (!Number.isInteger(value) || value < 0) {
    throw new UntrustworthyReport(`${where}.${field} is not a non-negative integer`);
  }
  return value;
}

function readFinding(key, entry) {
  if (!isPlainObject(entry)) {
    throw new UntrustworthyReport(`the report's ${key} entry is not an object`);
  }
  const name = typeof entry.name === 'string' && entry.name !== '' ? entry.name : key;
  const severity = typeof entry.severity === 'string' ? entry.severity.trim().toLowerCase() : '';
  if (!SEVERITY_ORDER.includes(severity)) {
    throw new UntrustworthyReport(
      `the report gives ${name} the severity "${severity || '(missing)'}", which this gate cannot ` +
        'classify, so it cannot decide whether that advisory is blocking',
    );
  }
  return {
    name,
    severity,
    direct: entry.isDirect === true,
    affected: typeof entry.range === 'string' ? entry.range : '',
    advisories: readAdvisories(entry.via),
    fix: describeFix(entry.fixAvailable),
    effects: Array.isArray(entry.effects) ? entry.effects.filter((item) => typeof item === 'string') : [],
  };
}

/**
 * `via` mixes advisory records with the names of packages that carry an
 * advisory transitively, so both are kept and told apart when printed.
 */
function readAdvisories(via) {
  if (!Array.isArray(via)) return [];
  const advisories = [];
  for (const item of via) {
    if (typeof item === 'string') {
      advisories.push({ title: `through ${item}`, url: '' });
      continue;
    }
    if (!isPlainObject(item)) continue;
    advisories.push({
      title: typeof item.title === 'string' ? item.title : 'advisory without a title',
      url: typeof item.url === 'string' ? item.url : '',
    });
  }
  return advisories;
}

function describeFix(fixAvailable) {
  if (fixAvailable === true) return 'fix available';
  if (fixAvailable === false) return 'no fix published';
  if (isPlainObject(fixAvailable) && typeof fixAvailable.name === 'string') {
    const version = typeof fixAvailable.version === 'string' ? ` ${fixAvailable.version}` : '';
    const major = fixAvailable.isSemVerMajor === true ? ', semver-major' : '';
    return `fix: ${fixAvailable.name}${version}${major}`;
  }
  return 'fix state not reported';
}

/**
 * npm's metadata totals and the vulnerability entries describe the same audit,
 * so a disagreement means part of the report was dropped. That is the shape a
 * report takes when somebody trusts a green summary over an empty body.
 */
function verifyConsistency(counts, findings) {
  const tally = Object.fromEntries(SEVERITY_ORDER.map((severity) => [severity, 0]));
  for (const finding of findings) tally[finding.severity] += 1;
  const disagreements = [];
  for (const severity of SEVERITY_ORDER) {
    if (counts[severity] !== tally[severity]) {
      disagreements.push(`metadata says ${counts[severity]} ${severity}, entries carry ${tally[severity]}`);
    }
  }
  if (counts.total !== findings.length) {
    disagreements.push(`metadata says ${counts.total} total, entries carry ${findings.length}`);
  }
  if (disagreements.length > 0) {
    throw new UntrustworthyReport(
      `the report contradicts itself (${disagreements.join('; ')}), so a result read from it ` +
        'would not be evidence either way',
    );
  }
}

function plural(count, singular, pluralForm) {
  return count === 1 ? singular : pluralForm;
}

function sortFindings(findings) {
  return [...findings].sort((left, right) => {
    const bySeverity = SEVERITY_ORDER.indexOf(left.severity) - SEVERITY_ORDER.indexOf(right.severity);
    return bySeverity !== 0 ? bySeverity : left.name.localeCompare(right.name);
  });
}

function describeFinding(finding) {
  const scope = finding.direct ? 'direct' : 'transitive';
  return `${finding.severity} ${finding.name} (${scope})`;
}

function printHeader(label, coverage) {
  console.log(`Audited: ${label}`);
  console.log(
    `Lockfile metadata: ${coverage.total} packages ` +
      `(production ${coverage.production}, dev ${coverage.dev}, optional ${coverage.optional}, ` +
      `peer ${coverage.peer}); the counts describe the lockfile, not the audited subset`,
  );
}

function printFindings(findings) {
  if (findings.length === 0) {
    console.log('  no advisories reported for this tree');
    return;
  }
  for (const finding of sortFindings(findings)) {
    const details = [finding.affected ? `affected ${finding.affected}` : '', finding.fix].filter(Boolean);
    console.log(`  ${describeFinding(finding)}`);
    console.log(`    ${details.join('; ')}`);
    if (finding.effects.length > 0) {
      console.log(`    also reported through: ${finding.effects.join(', ')}`);
    }
    for (const advisory of finding.advisories) {
      console.log(`    - ${advisory.title}${advisory.url ? ` ${advisory.url}` : ''}`);
    }
  }
  const totals = SEVERITY_ORDER.map((severity) => ({
    severity,
    count: findings.filter((finding) => finding.severity === severity).length,
  }))
    .filter(({ count }) => count > 0)
    .map(({ severity, count }) => `${count} ${severity}`);
  console.log(`  totals: ${findings.length} ${plural(findings.length, 'advisory', 'advisories')} (${totals.join(', ')})`);
}

function untrusted(error, reportPath) {
  console.error(`dependency audit: ${error.message}`);
  const subject =
    reportPath === undefined
      ? 'the audit could not run'
      : `the audit report ${reportPath} could not be trusted`;
  console.error(`::error title=Dependency audit::${subject}; see the log`);
  return 2;
}

export function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    return untrusted(error);
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.report === null) {
    console.log(USAGE);
    return untrusted(new UntrustworthyReport('no audit report path was given'));
  }

  let report;
  try {
    if (args.auditExit !== 0 && args.auditExit !== 1) {
      throw new UntrustworthyReport(
        `npm audit exited ${args.auditExit}, which is neither "no advisories" (0) nor "advisories ` +
          'found" (1): the audit did not complete, so its report is not an answer',
      );
    }
    report = parseAuditReport(readFileSync(args.report));
    if (args.auditExit === 1 && report.counts.total === 0) {
      throw new UntrustworthyReport(
        'npm audit exited 1 but the report lists no advisories; the status and the report ' +
          'disagree, so neither is trusted',
      );
    }
  } catch (error) {
    return untrusted(
      error instanceof UntrustworthyReport ? error : new UntrustworthyReport(
        `the audit report ${args.report} could not be read: ${error.message}`,
      ),
      args.report,
    );
  }

  printHeader(args.label, report.coverage);
  printFindings(report.findings);
  const blocking = report.findings.filter((finding) => BLOCKING.has(finding.severity));

  if (args.summaryOnly) {
    if (blocking.length > 0) {
      console.log(
        `  note: ${blocking.length} ${plural(blocking.length, 'advisory is', 'advisories are')} at or ` +
          'above the threshold in this tree. This run reports them; the production tree is the gate.',
      );
    }
    console.log('SUMMARY: reported, not gated');
    return 0;
  }

  if (blocking.length > 0) {
    for (const finding of blocking) {
      console.log(
        `::error title=${finding.name} (${finding.severity})::${describeFinding(finding)}; ` +
          `${[finding.affected ? `affected ${finding.affected}` : '', finding.fix].filter(Boolean).join('; ')}`,
      );
    }
    console.error(
      `FAILED: ${blocking.length} blocking ${plural(blocking.length, 'advisory', 'advisories')} in the ` +
        'production dependency tree. Raise the dependency floor, or record why the advisory does not ' +
        'apply; do not widen this gate to go green.',
    );
    return 1;
  }

  console.log('PASSED: no critical or high advisories in the production dependency tree');
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
