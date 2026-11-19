import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Both names are in use: CI and README set WUWATERM_BACKEND_ROOT, and a local run may
// spell it WUWATERM_CORE_ROOT. One resolver keeps the contract suite from reading two
// different checkouts depending on which name happened to be exported.
export function requireBackendCheckout() {
  const root = process.env.WUWATERM_BACKEND_ROOT || process.env.WUWATERM_CORE_ROOT;
  assert.ok(root, 'Set WUWATERM_BACKEND_ROOT (or WUWATERM_CORE_ROOT) to the pinned backend checkout');
  return root;
}

// The checkout must be a Core repository root without uncommitted src/ bytes, because the live
// review contract runs that checkout's own application code. Its HEAD is deliberately not
// compared with contracts/backend-ref.txt: this repository's CI checks that pin out, while
// Core CI (`.github/workflows/ci.yml`, job "API to Web contract") passes its own candidate
// commit as WUWATERM_BACKEND_ROOT so the pair is tested forward, before Core merges.
export function requireBackendRoot() {
  const root = requireBackendCheckout();
  const pin = readFileSync(fileURLToPath(new URL('../../contracts/backend-ref.txt', import.meta.url)), 'utf8').trim();
  assert.match(pin, /^[0-9a-f]{40}$/u, 'Invalid backend source revision');
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  const top = git('rev-parse', '--show-toplevel').toString('utf8').trim();
  assert.equal(realpathSync(root), realpathSync(top), 'The backend root must be the checkout root');
  const commit = git('rev-parse', '--verify', 'HEAD^{commit}').toString('utf8').trim();
  const modified = git('status', '--porcelain', '--untracked-files=no', '--', 'src').toString('utf8').trim();
  assert.equal(modified, '', `Backend src/ differs from ${commit}; the live server would not be the checked-out source`);
  return root;
}
