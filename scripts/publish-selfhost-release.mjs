import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';

const repo = 'My-Denia/WuwaTerm-Web';
const apiRoot = `https://api.github.com/repos/${repo}`;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const check = (condition, message) => { if (!condition) throw new Error(message); };
const positive = value => /^[1-9][0-9]*$/u.test(value || '');

export function checkRun(run, { id, attempt, source, workflow, event }) {
  check(String(run.id) === id && (!attempt || String(run.run_attempt) === attempt)
    && run.path === `.github/workflows/${workflow}` && run.head_sha === source
    && run.head_branch === 'main' && run.event === event
    && run.status === 'completed' && run.conclusion === 'success'
    && run.repository?.full_name === repo && run.head_repository?.full_name === repo,
  `Unexpected or unsuccessful ${workflow} run`);
}

export function checkArtifact(artifact, { id, run, attempt, source, repositoryId }) {
  check(String(artifact.id) === id && !artifact.expired
    && artifact.name === `selfhost-linux-x64-${run}-${attempt}`
    && String(artifact.workflow_run?.id) === run
    && artifact.workflow_run?.head_sha === source && artifact.workflow_run?.head_branch === 'main'
    && artifact.workflow_run?.repository_id === repositoryId
    && artifact.workflow_run?.head_repository_id === repositoryId
    && /^sha256:[0-9a-f]{64}$/u.test(artifact.digest || ''),
  'Artifact does not belong to the selected successful run and attempt');
}

export function checkCandidate({ manifestBytes, sumsBytes, archiveBytes, buildInfoBytes }, expected) {
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const buildInfo = JSON.parse(buildInfoBytes.toString('utf8'));
  const { archive, ...info } = manifest;
  const suffix = expected.prefix ? `prefix-${digest(expected.prefix).slice(0, 12)}` : 'root';
  const archiveName = `wuwaterm-web-${expected.tag}-linux-x64-${suffix}.tar.gz`;
  check(isDeepStrictEqual(info, buildInfo), 'Manifest and BUILD-INFO differ');
  check(info.format === 'wuwaterm-web-selfhost-v1' && info.tag === expected.tag
    && info.tag_status === 'proposed' && info.version === expected.version
    && info.source_sha === expected.source && info.source_base_sha === null
    && info.source_tree === expected.tree && info.platform === 'linux-x64'
    && /^v24\./u.test(info.build_node || '') && info.base_path === expected.prefix
    && info.ci?.workflow === 'Web CI' && positive(info.ci.run_id)
    && info.ci.url === `https://github.com/${repo}/actions/runs/${info.ci.run_id}`,
  'Candidate metadata does not match the requested source, tag or prefix');
  check(archive?.name === archiveName && archive.sha256 === digest(archiveBytes),
    'Candidate archive name or digest does not match its manifest');
  const sums = `${archive.sha256}  ${archiveName}\n${digest(manifestBytes)}  manifest.json\n`;
  check(sumsBytes.toString('utf8') === sums, 'Candidate SHA256SUMS does not match the archive and manifest');
  const variant = expected.prefix ? 'prefix' : 'root';
  const manifestName = `manifest-${variant}.json`;
  const releaseSums = `${archive.sha256}  ${archiveName}\n${digest(manifestBytes)}  ${manifestName}\n`;
  return {
    ciRun: info.ci.run_id,
    assets: [
      { name: archiveName, bytes: archiveBytes },
      { name: manifestName, bytes: manifestBytes },
      { name: `SHA256SUMS-${variant}`, bytes: Buffer.from(releaseSums) },
    ],
  };
}

// Existing draft assets may be a matching subset; a published release must be complete.
// The caller downloads each existing asset before passing its bytes here.
export function missingAssets(expected, existing, draft) {
  const byName = new Map(expected.map(asset => [asset.name, asset]));
  check(byName.size === expected.length, 'Expected asset names are not unique');
  const seen = new Set();
  for (const asset of existing) {
    const wanted = byName.get(asset.name);
    check(wanted && !seen.has(asset.name) && asset.state === 'uploaded'
      && digest(asset.bytes) === digest(wanted.bytes), `Conflicting release asset: ${asset.name}`);
    seen.add(asset.name);
  }
  const missing = expected.filter(asset => !seen.has(asset.name));
  check(draft || missing.length === 0, 'Published release has missing assets');
  return missing;
}

function input(env) {
  const source = env.SOURCE_SHA || '';
  const control = env.GITHUB_SHA || '';
  const tag = env.RELEASE_TAG || '';
  const prefix = env.PREFIX_PATH || '';
  const candidates = ['ROOT', 'PREFIX'].map(name => ({
    run: env[`${name}_RUN_ID`] || '', attempt: env[`${name}_ATTEMPT`] || '',
    artifact: env[`${name}_ARTIFACT_ID`] || '', prefix: name === 'ROOT' ? '' : prefix,
  }));
  check(env.GITHUB_REPOSITORY === repo && env.GITHUB_REF === 'refs/heads/main'
    && env.GITHUB_EVENT_NAME === 'workflow_dispatch', 'Run this workflow from the trusted main branch');
  check(/^[0-9a-f]{40}$/u.test(source) && /^[0-9a-f]{40}$/u.test(control), 'Source and workflow SHA must be full commit IDs');
  check(/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(tag), 'Invalid release tag');
  check(/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/u.test(prefix), 'A non-root prefix is required');
  check(candidates.every(candidate => positive(candidate.run) && positive(candidate.attempt) && positive(candidate.artifact))
    && candidates[0].run !== candidates[1].run && candidates[0].artifact !== candidates[1].artifact,
  'Supply distinct root and prefix run, attempt and artifact IDs');
  check(env.GH_TOKEN, 'GH_TOKEN is required');
  return { source, control, tag, prefix, candidates };
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function request(url, { method = 'GET', body, accept = 'application/vnd.github+json', binary = false, optional = false } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      Accept: accept, Authorization: `Bearer ${process.env.GH_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}),
      ...(Buffer.isBuffer(body) ? { 'Content-Type': 'application/octet-stream' } : {}),
    },
    body: body && !Buffer.isBuffer(body) ? JSON.stringify(body) : body,
  });
  if (optional && response.status === 404) return null;
  check(response.ok, `GitHub request failed: ${method} ${new URL(url).pathname} (${response.status})`);
  if (binary) return Buffer.from(await response.arrayBuffer());
  return response.json();
}

async function pages(path) {
  const result = [];
  for (let page = 1; ; page += 1) {
    const entries = await request(`${apiRoot}${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    check(Array.isArray(entries), 'Expected a paginated GitHub array');
    result.push(...entries);
    if (entries.length < 100) return result;
  }
}

async function checkedTag(tag, source) {
  let object = (await request(`${apiRoot}/git/ref/tags/${encodeURIComponent(tag)}`, { optional: true }))?.object;
  if (!object) return false;
  for (let depth = 0; object.type === 'tag' && depth < 10; depth += 1) {
    object = (await request(`${apiRoot}/git/tags/${object.sha}`)).object;
  }
  check(object.type === 'commit' && object.sha === source, 'Existing tag does not point to the requested source');
  return true;
}

async function checkMain(control) {
  const main = await request(`${apiRoot}/git/ref/heads/main`);
  check(main.object?.type === 'commit' && main.object.sha === control, 'Main advanced since this workflow started; run it again');
}

function extract(zipPath, name) {
  return execFileSync('unzip', ['-p', zipPath, name], { maxBuffer: 512 * 1024 * 1024 });
}

async function candidateFiles(candidate, expected, temp) {
  const run = await request(`${apiRoot}/actions/runs/${candidate.run}/attempts/${candidate.attempt}`);
  checkRun(run, { id: candidate.run, attempt: candidate.attempt, source: expected.source,
    workflow: 'selfhost-release-build.yml', event: 'workflow_dispatch' });
  const artifact = await request(`${apiRoot}/actions/artifacts/${candidate.artifact}`);
  checkArtifact(artifact, { id: candidate.artifact, run: candidate.run, attempt: candidate.attempt,
    source: expected.source, repositoryId: run.repository.id });
  const zip = await request(`${apiRoot}/actions/artifacts/${candidate.artifact}/zip`, { binary: true });
  check(`sha256:${digest(zip)}` === artifact.digest, 'Downloaded Actions artifact digest differs');
  const zipPath = join(temp, `${candidate.artifact}.zip`);
  writeFileSync(zipPath, zip);
  const names = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' }).trimEnd().split('\n');
  const suffix = candidate.prefix ? `prefix-${digest(candidate.prefix).slice(0, 12)}` : 'root';
  const archiveName = `wuwaterm-web-${expected.tag}-linux-x64-${suffix}.tar.gz`;
  check(names.length === 3 && new Set(names).size === 3
    && [archiveName, 'manifest.json', 'SHA256SUMS'].every(name => names.includes(name)),
  'Actions artifact does not contain exactly the expected three files');
  const archiveBytes = extract(zipPath, archiveName);
  const archivePath = join(temp, archiveName);
  writeFileSync(archivePath, archiveBytes);
  const entries = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).split('\n');
  check(entries.filter(name => name === 'bundle/BUILD-INFO.json').length === 1, 'Archive must contain one BUILD-INFO.json');
  const buildInfoBytes = execFileSync('tar', ['-xzOf', archivePath, 'bundle/BUILD-INFO.json'], { maxBuffer: 1024 * 1024 });
  const result = checkCandidate({ manifestBytes: extract(zipPath, 'manifest.json'),
    sumsBytes: extract(zipPath, 'SHA256SUMS'), archiveBytes, buildInfoBytes }, { ...expected, prefix: candidate.prefix });
  const ci = await request(`${apiRoot}/actions/runs/${result.ciRun}`);
  checkRun(ci, { id: result.ciRun, source: expected.source, workflow: 'ci.yml', event: 'push' });
  return result.assets;
}

function releaseDescription(config, tree) {
  return `Linux x64 self-host candidates promoted without rebuilding.\n\nSource: ${config.source}\nTree: ${tree}\nRoot candidate: https://github.com/${repo}/actions/runs/${config.candidates[0].run}/attempts/${config.candidates[0].attempt} (artifact ${config.candidates[0].artifact})\nPrefix candidate: https://github.com/${repo}/actions/runs/${config.candidates[1].run}/attempts/${config.candidates[1].attempt} (artifact ${config.candidates[1].artifact}, base path ${config.prefix})\n\nThe original manifests and BUILD-INFO call the tag proposed; this release separately verifies that the existing tag resolves to the source above.\n`;
}

async function existingRelease(tag, name, body, assets) {
  const releases = (await pages('/releases')).filter(release => release.tag_name === tag);
  check(releases.length <= 1, 'More than one release uses this tag');
  if (!releases.length) return null;
  const release = releases[0];
  check(release.name === name && release.body === body && release.prerelease === tag.includes('-'),
    'Existing release metadata conflicts with these candidates');
  const remoteAssets = await pages(`/releases/${release.id}/assets`);
  const downloaded = [];
  for (const asset of remoteAssets) {
    check(assets.some(expected => expected.name === asset.name), `Unexpected release asset: ${asset.name}`);
    downloaded.push({ ...asset, bytes: await request(`${apiRoot}/releases/assets/${asset.id}`, { accept: 'application/octet-stream', binary: true }) });
  }
  return { release, missing: missingAssets(assets, downloaded, release.draft) };
}

async function main() {
  const config = input(process.env);
  const validationOnly = process.argv.includes('--check');
  check(process.argv.length === 2 || (process.argv.length === 3 && validationOnly), 'Use no arguments or --check');
  check(git('rev-parse', 'HEAD') === config.control, 'Checked-out workflow source differs from the dispatched main commit');
  git('merge-base', '--is-ancestor', config.source, config.control);
  const tree = git('rev-parse', `${config.source}^{tree}`);
  const version = JSON.parse(git('show', `${config.source}:package.json`)).version;
  check(config.tag === `v${version}`, 'Tag does not match the source package version');
  await checkMain(config.control);
  const temp = mkdtempSync(join(process.env.RELEASE_WORK_DIR || process.env.RUNNER_TEMP, 'selfhost-promotion-'));
  const expected = { source: config.source, tag: config.tag, tree, version };
  const assets = [];
  for (const candidate of config.candidates) assets.push(...await candidateFiles(candidate, expected, temp));
  const name = `WuwaTerm Web ${config.tag} (self-host Linux x64)`;
  const body = releaseDescription(config, tree);
  const tagExists = await checkedTag(config.tag, config.source);
  let existing = await existingRelease(config.tag, name, body, assets);
  check(!existing || existing.release.draft || tagExists, 'Published release has no matching tag');
  await checkMain(config.control);
  console.log(`Validated source ${config.source}, tree ${tree}, both candidate archives and existing release state.`);
  if (validationOnly) {
    console.log(tagExists ? 'Existing tag matches the source.' : 'Tag is absent; create it at this source before publishing.');
    return;
  }
  check(tagExists, 'Create the tag at the validated source before publishing');
  check(await checkedTag(config.tag, config.source), 'Tag disappeared before release creation');
  if (!existing) {
    const release = await request(`${apiRoot}/releases`, { method: 'POST', body: {
      tag_name: config.tag, name, body, draft: true, prerelease: config.tag.includes('-'),
    } });
    existing = { release, missing: assets };
  }
  if (!existing.release.draft) {
    console.log('Published release already has the exact expected assets.');
    return;
  }
  for (const asset of existing.missing) {
    await request(`https://uploads.github.com/repos/${repo}/releases/${existing.release.id}/assets?name=${encodeURIComponent(asset.name)}`,
      { method: 'POST', body: asset.bytes });
  }
  existing = await existingRelease(config.tag, name, body, assets);
  check(existing && existing.release.draft && existing.missing.length === 0, 'Draft assets changed or are incomplete');
  check(await checkedTag(config.tag, config.source), 'Tag disappeared before publication');
  await checkMain(config.control);
  await request(`${apiRoot}/releases/${existing.release.id}`, { method: 'PATCH', body: { draft: false } });
  const published = await existingRelease(config.tag, name, body, assets);
  check(published && !published.release.draft && await checkedTag(config.tag, config.source), 'Published release did not verify');
  console.log(`Published ${config.tag} with six verified assets.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
