import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const envNames = [
  'WUWATERM_API_BASE_URL',
  'WUWATERM_API_ALLOWED_HOST',
  'WUWATERM_SITE_DEVICE_TOKEN',
];
const canaries = [
  'SYNTHETIC_DEVICE_SENTINEL_74A1C9',
  'SYNTHETIC_PRODUCT_TOKEN_61E8',
  'not-a-real-service.invalid',
  'api.wuwaterm-test.net',
  '/wuwaterm-api/',
  '/private',
];
const scanExtensions = new Set(['.html', '.js', '.css', '.map', '.json']);
const requiredBuildArtifacts = [
  'dist/server/index.js',
  'dist/client/vinext-client-entry-manifest.json',
];
for (const artifact of requiredBuildArtifacts) {
  assert.equal(existsSync(join(root, artifact)), true, `missing ${artifact}; run the production build first`);
}

const emittedRoots = ['dist/client', 'dist/assets'].filter((path) => existsSync(join(root, path)));
let scannedFiles = 0;
for (const emittedRoot of emittedRoots) {
  const absolute = join(root, emittedRoot);
  for (const file of walk(absolute)) {
    if (!scanExtensions.has(extname(file))) continue;
    scannedFiles += 1;
    const text = readFileSync(file, 'utf8');
    for (const needle of [...envNames, ...canaries, 'Authorization', 'Bearer ']) {
      assert.equal(text.includes(needle), false, `${relative(root, file)} exposes ${needle}`);
    }
  }
}
assert.ok(scannedFiles > 0, 'production build emitted no scannable client artifacts');

const rootHtml = join(root, 'dist/index.html');
if (existsSync(rootHtml)) {
  const text = readFileSync(rootHtml, 'utf8');
  for (const needle of [...envNames, ...canaries]) assert.equal(text.includes(needle), false);
}

for (const emittedRoot of emittedRoots) {
  const absolute = join(root, emittedRoot);
  for (const file of walk(absolute)) {
    assert.notEqual(extname(file), '.map', `${relative(root, file)} is an unexpected client source map`);
  }
}

console.log(`verify:no-client-secret PASS (${scannedFiles} client artifacts scanned)`);

function* walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile() && !path.split(sep).includes('server')) yield path;
  }
}
