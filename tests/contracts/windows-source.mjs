import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The checkout must be both at the pinned commit and contain those exact
// source bytes. A locally modified consumer cannot silently satisfy CI.
export function requireWindowsRoot() {
  const root = process.env.WUWATERM_WINDOWS_ROOT;
  assert.ok(root, 'Set WUWATERM_WINDOWS_ROOT to the pinned Windows checkout');
  const pin = readFileSync(fileURLToPath(new URL('../../contracts/windows-ref.txt', import.meta.url)), 'utf8').trim();
  assert.match(pin, /^[0-9a-f]{40}$/u, 'Invalid Windows source revision');
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  const top = git('rev-parse', '--show-toplevel').toString('utf8').trim();
  assert.equal(realpathSync(root), realpathSync(top), 'WUWATERM_WINDOWS_ROOT must be the checkout root');
  const actual = git('rev-parse', '--verify', 'HEAD^{commit}').toString('utf8').trim();
  assert.equal(actual, pin, 'Windows checkout does not match contracts/windows-ref.txt');
  for (const path of ['src/wuwaterm_client/strings.py', 'src/wuwaterm_client/manuscript.py', 'src/wuwaterm_client/semantic.py']) {
    assert.deepEqual(readFileSync(join(root, path)), git('show', `${pin}:${path}`), `Windows source differs from pinned commit: ${path}`);
  }
  return root;
}
