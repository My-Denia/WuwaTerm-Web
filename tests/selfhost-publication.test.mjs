import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { checkArtifact, checkCandidate, checkRun, missingAssets } from '../scripts/publish-selfhost-release.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const source = 'a'.repeat(40);
const tree = 'b'.repeat(40);
const repo = 'My-Denia/WuwaTerm-Web';
const candidateRun = {
  id: 101, run_attempt: 2, path: '.github/workflows/selfhost-release-build.yml',
  head_sha: source, head_branch: 'main', event: 'workflow_dispatch',
  status: 'completed', conclusion: 'success',
  repository: { id: 12, full_name: repo }, head_repository: { full_name: repo },
};
const runExpected = { id: '101', attempt: '2', source, workflow: 'selfhost-release-build.yml', event: 'workflow_dispatch' };
const artifact = {
  id: 201, name: 'selfhost-linux-x64-101-2', expired: false, digest: `sha256:${'c'.repeat(64)}`,
  workflow_run: { id: 101, head_sha: source, head_branch: 'main', repository_id: 12, head_repository_id: 12 },
};
const artifactExpected = { id: '201', run: '101', attempt: '2', source, repositoryId: 12 };

function candidate(prefix = '') {
  const tag = 'v0.1.0';
  const archiveBytes = Buffer.from('archive bytes');
  const suffix = prefix ? `prefix-${hash(prefix).slice(0, 12)}` : 'root';
  const archiveName = `wuwaterm-web-${tag}-linux-x64-${suffix}.tar.gz`;
  const info = { format: 'wuwaterm-web-selfhost-v1', tag, tag_status: 'proposed', version: '0.1.0',
    source_sha: source, source_base_sha: null, source_tree: tree, platform: 'linux-x64',
    build_node: 'v24.22.1', base_path: prefix,
    ci: { workflow: 'Web CI', run_id: '301', url: `https://github.com/${repo}/actions/runs/301` } };
  const buildInfoBytes = Buffer.from(JSON.stringify(info));
  const manifestBytes = Buffer.from(JSON.stringify({ ...info, archive: { name: archiveName, sha256: hash(archiveBytes) } }));
  const sumsBytes = Buffer.from(`${hash(archiveBytes)}  ${archiveName}\n${hash(manifestBytes)}  manifest.json\n`);
  return { files: { manifestBytes, sumsBytes, archiveBytes, buildInfoBytes },
    expected: { prefix, tag, version: '0.1.0', source, tree }, archiveName };
}

test('candidate run and artifact are bound to the successful source and exact attempt', () => {
  assert.doesNotThrow(() => checkRun(candidateRun, runExpected));
  assert.doesNotThrow(() => checkArtifact(artifact, artifactExpected));
  assert.throws(() => checkRun({ ...candidateRun, conclusion: 'failure' }, runExpected));
  assert.throws(() => checkRun({ ...candidateRun, head_sha: 'd'.repeat(40) }, runExpected));
  assert.throws(() => checkRun({ ...candidateRun, run_attempt: 1 }, runExpected));
  assert.throws(() => checkArtifact({ ...artifact, name: 'selfhost-linux-x64-101-1' }, artifactExpected));
  assert.throws(() => checkArtifact({ ...artifact, expired: true }, artifactExpected));
  assert.throws(() => checkArtifact({ ...artifact, workflow_run: { ...artifact.workflow_run, head_repository_id: 13 } }, artifactExpected));
});

test('root and prefix candidates retain the archive and manifest bytes with variant checksums', () => {
  for (const prefix of ['', '/private']) {
    const { files, expected, archiveName } = candidate(prefix);
    const result = checkCandidate(files, expected);
    const variant = prefix ? 'prefix' : 'root';
    assert.equal(result.ciRun, '301');
    assert.deepEqual(result.assets.map(asset => asset.name), [archiveName, `manifest-${variant}.json`, `SHA256SUMS-${variant}`]);
    assert.deepEqual(result.assets[0].bytes, files.archiveBytes);
    assert.deepEqual(result.assets[1].bytes, files.manifestBytes);
    assert.equal(result.assets[2].bytes.toString(), `${hash(files.archiveBytes)}  ${archiveName}\n${hash(files.manifestBytes)}  manifest-${variant}.json\n`);
  }
});

test('candidate checks reject a changed archive, checksum, embedded metadata or prefix', () => {
  const { files, expected } = candidate('/private');
  assert.throws(() => checkCandidate({ ...files, archiveBytes: Buffer.from('changed') }, expected), /digest/);
  assert.throws(() => checkCandidate({ ...files, sumsBytes: Buffer.from('wrong') }, expected), /SHA256SUMS/);
  assert.throws(() => checkCandidate({ ...files, buildInfoBytes: Buffer.from('{}') }, expected), /BUILD-INFO/);
  assert.throws(() => checkCandidate(files, { ...expected, prefix: '/other' }), /metadata/);
  assert.throws(() => checkCandidate(files, { ...expected, tree: 'e'.repeat(40) }), /metadata/);
});

test('draft resumption adds only absent assets and refuses conflicting or incomplete published assets', () => {
  const expected = [
    { name: 'a.tar.gz', bytes: Buffer.from('archive') },
    { name: 'manifest-root.json', bytes: Buffer.from('manifest') },
  ];
  const uploaded = { ...expected[0], state: 'uploaded' };
  assert.deepEqual(missingAssets(expected, [uploaded], true), [expected[1]]);
  assert.deepEqual(missingAssets(expected, expected.map(asset => ({ ...asset, state: 'uploaded' })), false), []);
  assert.throws(() => missingAssets(expected, [uploaded], false), /missing/);
  assert.throws(() => missingAssets(expected, [{ ...uploaded, bytes: Buffer.from('different') }], true), /Conflicting/);
  assert.throws(() => missingAssets(expected, [uploaded, uploaded], true), /Conflicting/);
  assert.throws(() => missingAssets(expected, [{ name: 'extra', bytes: Buffer.alloc(0), state: 'uploaded' }], true), /Conflicting/);
});
