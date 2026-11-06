import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

// Run after build:selfhost, from an isolated export of the intended source tree.
// CI binds the commit, tree and successful Web CI run before providing them.
const env = process.env;
const source = process.cwd();
const standalone = join(source, '.next-selfhost', 'standalone');
const output = resolve(env.WUWATERM_RELEASE_OUTPUT || 'outputs/selfhost-release');
const bundle = join(output, 'bundle');
const hashPattern = /^[0-9a-f]{40}$/u;
const sourceSha = env.WUWATERM_RELEASE_SOURCE_SHA || null;
const baseSha = env.WUWATERM_RELEASE_SOURCE_BASE_SHA || null;
const sourceTree = env.WUWATERM_RELEASE_SOURCE_TREE || '';
const tag = env.WUWATERM_RELEASE_TAG || '';
const prefix = env.NEXT_PUBLIC_WUWATERM_BASE_PATH || '';
const ciRun = env.WUWATERM_RELEASE_CI_RUN_ID || '';
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const check = (condition, message) => { if (!condition) throw new Error(message); };
check(process.platform === 'linux' && process.arch === 'x64' && Number(process.versions.node.split('.')[0]) === 24, 'Build the release with Node 24 on Linux x64');
check(hashPattern.test(sourceTree) && (sourceSha ? hashPattern.test(sourceSha) && !baseSha : hashPattern.test(baseSha || '')), 'Provide the source tree and either its commit or its uncommitted base');
check(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version) && tag === `v${version}`, 'Release tag must match package version');
check(!prefix || /^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/u.test(prefix), 'Invalid base path');
check(!ciRun || (sourceSha && /^[1-9][0-9]*$/u.test(ciRun)), 'A CI receipt needs a committed source and a numeric run ID');
check(!existsSync(join(source, '.openai')) && !readdirSync(source).some(name => /^\.(?:env|dev\.vars)/iu.test(name)), 'Use an isolated source export without hosting or environment files');
check(existsSync(join(standalone, 'server.js')) && existsSync(join(standalone, '.next-selfhost', 'static')), 'Build the self-host standalone server and assets first');
check(!existsSync(bundle), 'Release output already exists; select a fresh output directory');
const server = readFileSync(join(standalone, 'server.js'), 'utf8');
const config = server.match(/^const nextConfig = (.+)$/mu);
check(config && JSON.parse(config[1]).basePath === prefix, 'Release prefix differs from the standalone build');

function walk(directory, visit, skipLinks = false) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() && skipLinks) continue;
    check(!stat.isSymbolicLink(), `Release input contains a symbolic link: ${relative(source, path)}`);
    if (stat.isDirectory()) walk(path, visit, skipLinks);
    else if (stat.isFile()) visit(path);
    else throw new Error(`Unsupported release input: ${relative(source, path)}`);
  }
}
function rejectPrivateFile(path) {
  const parts = relative(standalone, path).split(sep);
  check(!parts.some(part => part === '.git' || part === '.openai' || part === 'goal-runs' || /^\.(?:env|dev\.vars)/iu.test(part) || part === '.npmrc' || /\.(?:sqlite\d*|db|log|pem|key)$/iu.test(part)), 'Standalone output contains a private or runtime data file');
}
walk(standalone, rejectPrivateFile);
mkdirSync(output, { recursive: true });
cpSync(standalone, bundle, { recursive: true });
cpSync('scripts/start-selfhost-release.mjs', join(bundle, 'start.mjs'));
cpSync('LICENSE', join(bundle, 'LICENSE'));
mkdirSync(join(bundle, 'docs'), { recursive: true });
cpSync('docs/self-hosting.md', join(bundle, 'docs', 'self-hosting.md'));

// Next can embed its build directory in generated server metadata. Replace that
// build-only path before distribution; the server resolves its runtime root
// from server.js. Never rewrite a binary if it happens to contain the path.
walk(bundle, path => {
  const bytes = readFileSync(path);
  if (!bytes.includes(Buffer.from(source))) return;
  check(!bytes.includes(0), 'A binary contains the build path');
  const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  writeFileSync(path, content.replaceAll(source, '/build/wuwaterm-web'));
});

// Include upstream notices and license text for traced npm packages, direct
// browser dependencies and Next's compiled dependencies. The npm package
// metadata and any license-bearing README are included alongside the texts.
const packages = new Set(Object.keys(JSON.parse(readFileSync('package.json', 'utf8')).dependencies).map(name => join('node_modules', name)));
walk(standalone, path => {
  const parts = relative(standalone, path).split(sep);
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (parts[index] !== 'node_modules') continue;
    const end = parts[index + 1]?.startsWith('@') ? index + 3 : index + 2;
    if (parts.length >= end) packages.add(join(...parts.slice(0, end)));
  }
});
const notices = join(bundle, 'third-party-notices');
mkdirSync(join(notices, 'license-texts'), { recursive: true });
for (const name of ['LGPL-3.0.txt', 'GPL-3.0.txt']) {
  cpSync(join('licenses', name), join(notices, 'license-texts', name));
}
let noticeCount = 0;
for (const packagePath of [...packages].sort()) {
  const root = join(source, packagePath);
  check(existsSync(root), `Traced dependency is absent from the source install: ${packagePath}`);
  walk(root, path => {
    const name = basename(path);
    const isNotice = /^(?:licen[cs]e|copying|notice|third.?party.*(?:notice|licen[cs]e))/iu.test(name);
    const isPackage = path === join(root, 'package.json') || path === join(root, 'versions.json');
    const isLicenseReadme = path === join(root, 'README.md') && /licen[cs](?:e|ing)/iu.test(readFileSync(path, 'utf8'));
    if (!isNotice && !isPackage && !isLicenseReadme) return;
    const destination = join(notices, packagePath, relative(root, path));
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(path, destination);
    noticeCount += 1;
  }, true);
}
check(noticeCount > 0, 'No dependency notices were collected');

// Check the complete payload, including notices, for the builder's home path.
const privateHome = source.match(/^\/(?:home|Users)\/[^/]+\//u)?.[0];
walk(bundle, path => {
  const bytes = readFileSync(path);
  check(!bytes.includes(Buffer.from(source)) && (!privateHome || !bytes.includes(Buffer.from(privateHome))), 'Release payload contains a private build path');
});

const info = {
  format: 'wuwaterm-web-selfhost-v1', tag, tag_status: 'proposed', version,
  source_sha: sourceSha, source_base_sha: baseSha, source_tree: sourceTree,
  source_export_excludes: ['.openai', '.env*', '**/.env*', '.dev.vars*', '**/.dev.vars*'],
  build_node: process.version, platform: 'linux-x64', base_path: prefix,
  ci: ciRun ? { workflow: 'Web CI', run_id: ciRun, url: `https://github.com/My-Denia/WuwaTerm-Web/actions/runs/${ciRun}` } : null,
};
writeFileSync(join(bundle, 'BUILD-INFO.json'), `${JSON.stringify(info, null, 2)}\n`);
const suffix = prefix ? `prefix-${createHash('sha256').update(prefix).digest('hex').slice(0, 12)}` : 'root';
const archiveName = `wuwaterm-web-${tag}-linux-x64-${suffix}.tar.gz`;
const archive = join(output, archiveName);
check(!existsSync(archive) && !existsSync(join(output, 'manifest.json')) && !existsSync(join(output, 'SHA256SUMS')), 'Release files already exist');
const tar = spawnSync('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-czf', archive, '-C', output, 'bundle'], { stdio: 'inherit' });
check(tar.status === 0, 'Could not create the release archive');
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const manifest = { ...info, archive: { name: archiveName, sha256: digest(archive) } };
writeFileSync(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(join(output, 'SHA256SUMS'), `${manifest.archive.sha256}  ${archiveName}\n${digest(join(output, 'manifest.json'))}  manifest.json\n`);
console.log(`Created ${archiveName}, manifest.json and SHA256SUMS`);
