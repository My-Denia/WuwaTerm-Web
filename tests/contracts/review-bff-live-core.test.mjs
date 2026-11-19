import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { REASON_VALUES } from '../../lib/manuscript.js';
import { createNodeEnvironment } from '../../lib/runtime/node.js';
import { parseReviewRequest, proxyReviewRequest } from '../../lib/wuwaterm-proxy.js';
import { requireBackendRoot } from './backend-source.mjs';

// The two review-v2 features the workbench asks for, end to end against the pinned Core: a real
// `POST /v1/reviews` served by the Core's own application object, reached over a loopback socket
// by the real BFF, with dense-128 and reason-v1 negotiated in `X-WuwaTerm-Review-Features`.
//
// The recorded fixtures in tests/fixtures prove the BFF's own contract. This file proves the live
// pair: the header the browser sends, the header the BFF forwards, the body Core's 64 KiB reader
// accepts, and the page and reasons the BFF's strict validator then accepts from that Core.

const FEATURES = 'dense-128,reason-v1';
// lib/wuwaterm-proxy.js: /api/reviews alone allows 65,536 bytes, and every other site endpoint keeps 32,768.
const MAX_REVIEW_REQUEST_BYTES = 65_536;
const OTHER_ENDPOINT_LIMIT = 32_768;
// Synthetic characters outside the fixture dictionary, used only to reach a size.
const FILLER = '甲乙丙丁戊己庚辛壬癸。';
const SIDE_LIMIT = 2_000;

const backendRoot = requireBackendRoot();
const helper = fileURLToPath(new URL('../helpers/core-review-server.py', import.meta.url));

let child;
let environment;
let workdir;
let reviewsUrl;

/** The Core's own interpreter: an explicit override, the checkout's venv, then PATH. */
function corePython() {
  const candidates = [
    process.env.WUWATERM_CORE_PYTHON,
    process.env.WUWATERM_CONTRACT_PYTHON,
    join(backendRoot, '.venv', 'bin', 'python'),
    'python3',
  ].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-c', 'import wuwaterm_api'], { stdio: 'ignore' });
    if (probe.status === 0) return candidate;
  }
  assert.fail(
    `No Python can import wuwaterm_api from ${backendRoot}; set WUWATERM_CORE_PYTHON to an interpreter with the pinned Core installed`,
  );
}

/** Start the pinned Core's API and resolve with the handshake line it prints once it listens. */
function startCoreServer() {
  const running = spawn(corePython(), ['-B', helper, backendRoot], { stdio: ['ignore', 'pipe', 'pipe'] });
  let first = '';
  let errors = '';
  running.stderr.setEncoding('utf8');
  running.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-8_000); });
  const handshake = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`The Core review server did not start in 120s\n${errors}`));
    }, 120_000);
    running.stdout.setEncoding('utf8');
    running.stdout.on('data', (chunk) => {
      if (first.includes('\n')) return;
      first += chunk;
      const end = first.indexOf('\n');
      if (end === -1) return;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(first.slice(0, end)));
      } catch (error) {
        reject(new Error(`The Core review server printed no handshake: ${error.message}\n${first}`));
      }
    });
    running.on('error', (error) => { clearTimeout(timer); reject(error); });
    running.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`The Core review server exited with ${code}\n${errors}`));
    });
  });
  return { running, handshake };
}

before(async () => {
  const started = startCoreServer();
  child = started.running;
  const { base_url: baseUrl, token } = await started.handshake;
  assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:[1-9][0-9]*\/$/u);
  reviewsUrl = new URL('v1/reviews', baseUrl).toString();
  workdir = mkdtempSync(join(tmpdir(), 'wuwaterm-web-live-review-'));
  // The real self-host environment builder: it validates the loopback upstream exactly as the
  // service does at startup and opens the real admission database.
  environment = createNodeEnvironment({
    WUWATERM_RUNTIME_MODE: 'selfhost',
    WUWATERM_TRANSLATION_ENABLED: 'true',
    WUWATERM_API_BASE_URL: baseUrl,
    WUWATERM_SITE_DEVICE_TOKEN: token,
    WUWATERM_LOCAL_DB_PATH: join(workdir, 'pool.sqlite3'),
  });
});

after(() => {
  try { environment?.DB.close(); } catch { /* the server below is what matters */ }
  if (workdir) rmSync(workdir, { recursive: true, force: true });
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const deadline = setTimeout(() => child.kill('SIGKILL'), 10_000);
  child.once('exit', () => clearTimeout(deadline));
});

// The service admits one request per second; a browser spreads them out, this file paces them.
let lastAdmission = 0;
async function pace() {
  const wait = 1_100 - (Date.now() - lastAdmission);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastAdmission = Date.now();
}

/** One browser request through the real parser and BFF, with the upstream call observed. */
async function reviewThroughBff(input, features = null) {
  const headers = { 'content-type': 'application/json' };
  if (features !== null) headers['X-WuwaTerm-Review-Features'] = features;
  const request = new Request('https://web.example.test/api/reviews', {
    method: 'POST',
    headers,
    body: JSON.stringify(input),
  });
  const parsed = await parseReviewRequest(request);
  assert.equal(parsed.ok, true, 'the Web parser refused a request this contract sends');
  await pace();
  let forwarded = null;
  const response = await proxyReviewRequest({
    environment,
    input: parsed.input,
    features: parsed.features,
    fetchImpl: async (url, init) => {
      forwarded = { url: String(url), headers: init.headers, body: init.body };
      return await fetch(url, init);
    },
  });
  const body = JSON.parse(await response.text());
  return { response, body, forwarded };
}

const forwardedFeatures = (forwarded) => Object.entries(forwarded.headers)
  .filter(([name]) => name.toLowerCase() === 'x-wuwaterm-review-features')
  .map(([, value]) => value);

/**
 * Lines of a standalone term next to lines of a repeated one.
 *
 * A live review verifies the standalone mention against its own `Jinhsi.` line and cannot
 * resolve the repeated pair, so one page holds both kinds. That is what makes "a reason only on
 * an unresolved finding" checkable end to end instead of asserted against a recorded body.
 */
function mixedManuscript(pairs) {
  const source = [];
  const target = [];
  for (let index = 0; index < pairs; index += 1) {
    source.push('今汐。', '今汐与今汐。');
    target.push('Jinhsi.', 'Jinhsi.');
  }
  return { source: source.join('\n'), target: target.join('\n') };
}

/** The same pattern plus filler, padded to the 2,000-code-point side limit. */
function paddedManuscript({ verified, ambiguous }) {
  const source = [];
  const target = [];
  for (let index = 0; index < verified; index += 1) { source.push('今汐。'); target.push('Jinhsi.'); }
  for (let index = 0; index < ambiguous; index += 1) { source.push('今汐与今汐。'); target.push('Jinhsi.'); }
  const text = (lines) => {
    let value = lines.join('\n');
    const room = SIDE_LIMIT - FILLER.length - Array.from(value).length;
    if (room > 0) value += `\n${FILLER.repeat(Math.floor(room / FILLER.length))}`;
    return value;
  };
  return { source: text(source), target: text(target) };
}

const wholeTextAlignment = ({ source, target }) => [{
  source: { start: 0, end: Array.from(source).length, text: source },
  target: { start: 0, end: Array.from(target).length, text: target },
}];

test('dense-128 and reason-v1 reach the live Core: every finding of the page arrives, and only unresolved findings carry a reason', async () => {
  const input = { ...mixedManuscript(12), direction: 'en', review_version: 'review-v2' };

  const dense = await reviewThroughBff(input, FEATURES);
  assert.equal(dense.response.status, 200, JSON.stringify(dense.body));
  assert.equal(dense.forwarded.url, reviewsUrl, 'the BFF did not call the live Core');
  assert.deepEqual(forwardedFeatures(dense.forwarded), [FEATURES]);
  assert.equal(dense.response.headers.get('x-wuwaterm-review-features'), FEATURES);
  assert.ok(Buffer.byteLength(dense.forwarded.body) <= OTHER_ENDPOINT_LIMIT, 'this case is about the features, not the size cap');
  // 12 standalone mentions and 24 repeated ones: one page only dense-128 can return whole.
  assert.equal(dense.body.findings.length, 36);
  assert.equal(dense.body.truncated, false);
  const verified = dense.body.findings.filter((finding) => finding.verdict === 'verified_constraint');
  const unresolved = dense.body.findings.filter((finding) => finding.verdict === 'not_evaluated');
  assert.equal(verified.length, 12);
  assert.equal(unresolved.length, 24);
  assert.ok(verified.every((finding) => !Object.hasOwn(finding, 'reason')), 'a verified finding must not carry a reason');
  assert.ok(unresolved.every((finding) => REASON_VALUES.includes(finding.reason)), JSON.stringify(unresolved.map((f) => f.reason)));

  // The same review without the header keeps the published shape: 32 findings, no reasons, no echo.
  const published = await reviewThroughBff(input);
  assert.equal(published.response.status, 200, JSON.stringify(published.body));
  assert.deepEqual(forwardedFeatures(published.forwarded), []);
  assert.equal(published.response.headers.get('x-wuwaterm-review-features'), null);
  assert.equal(published.body.findings.length, 32);
  assert.equal(published.body.truncated, true);
  assert.ok(published.body.findings.every((finding) => !Object.hasOwn(finding, 'reason')));
});

test('a review body above 32 KiB and within 64 KiB carries 128 dense resolutions to the live Core', async () => {
  const { source, target } = paddedManuscript({ verified: 100, ambiguous: 14 });
  const base = { source, target, direction: 'en', review_version: 'review-v2', alignments: wholeTextAlignment({ source, target }) };

  // First the basis: the live Core's own revisions, and the mention ids this source produces.
  const basis = await reviewThroughBff(base, FEATURES);
  assert.equal(basis.response.status, 200, JSON.stringify(basis.body));
  assert.equal(basis.body.findings.length, 128);
  assert.equal(basis.body.truncated, false);
  assert.ok(basis.body.findings.every((finding) => finding.verdict === 'not_evaluated'
    && REASON_VALUES.includes(finding.reason)), 'a whole-text alignment leaves these mentions unresolved');
  const resolved = basis.body.findings.filter((finding) => finding.candidates[0]?.candidate_id);
  assert.equal(resolved.length, 128, 'every finding of the dense page offers a candidate to resolve with');

  const denseRequest = {
    ...base,
    resolutions: resolved.map((finding) => ({
      mention_id: finding.id, choice: 'official_pair', candidate_id: finding.candidates[0].candidate_id,
    })),
    resolution_context: {
      source_revision: basis.body.source_revision,
      rule_version: 'review-v2',
      dictionary_revision: basis.body.dictionary.revision,
      matcher_revision: basis.body.matcher_revision,
    },
  };
  assert.ok(Buffer.byteLength(JSON.stringify(denseRequest)) > OTHER_ENDPOINT_LIMIT, 'this case must exceed the other endpoints\' cap');

  const dense = await reviewThroughBff(denseRequest, FEATURES);
  assert.equal(dense.response.status, 200, JSON.stringify(dense.body));
  assert.equal(dense.forwarded.url, reviewsUrl);
  assert.deepEqual(forwardedFeatures(dense.forwarded), [FEATURES]);
  const forwardedBytes = Buffer.byteLength(dense.forwarded.body);
  assert.ok(forwardedBytes > OTHER_ENDPOINT_LIMIT && forwardedBytes <= MAX_REVIEW_REQUEST_BYTES,
    `${forwardedBytes} bytes must be above the old cap and within the review cap`);
  assert.equal(dense.response.headers.get('x-wuwaterm-review-features'), FEATURES);
  // The Core resolved the 128 answers against the source it hashed, so the ids and the
  // dictionary/matcher revisions in the context were the live ones, not recorded ones.
  assert.equal(dense.body.findings.length, 128);
  assert.equal(dense.body.truncated, false);
  assert.ok(dense.body.findings.some((finding) => REASON_VALUES.includes(finding.reason)));
  assert.ok(dense.body.findings.every((finding) => (finding.verdict === 'not_evaluated')
    === Object.hasOwn(finding, 'reason')));
});
