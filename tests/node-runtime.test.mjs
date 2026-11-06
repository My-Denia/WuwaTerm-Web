import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createNodeEnvironment, initializeNodeEnvironment, NODE_ENVIRONMENT } from '../lib/runtime/node.js';
import { admitRequest, poolStatus } from '../lib/shared-pool.js';
import { configuredUpstream, proxyMetaRequest, runtimeEnvironment } from '../lib/wuwaterm-proxy.js';

const fixtureRoot = mkdtempSync(join(process.env.WUWATERM_TEST_TMPDIR || tmpdir(), 'wuwaterm-node-'));
test.after(() => {
  if (process.env.WUWATERM_TEST_KEEP_FIXTURES !== '1') rmSync(fixtureRoot, { recursive: true, force: true });
});

function config(name, overrides = {}) {
  return {
    WUWATERM_RUNTIME_MODE: 'selfhost',
    WUWATERM_LOCAL_DB_PATH: join(fixtureRoot, `${name}.sqlite`),
    WUWATERM_TRANSLATION_ENABLED: 'true',
    WUWATERM_API_BASE_URL: 'http://127.0.0.1:9000/',
    WUWATERM_SITE_DEVICE_TOKEN: 'SYNTHETIC_NODE_TEST_TOKEN',
    ...overrides,
  };
}

test('local admission persists across restart and handles a lowered character limit', async () => {
  const source = config('persistence', { WUWATERM_LOCAL_LIMIT_CHARACTERS_PER_DAY: '3' });
  let environment = createNodeEnvironment(source);
  const first = await admitRequest(environment, 'translations', 4);
  assert.equal(first.ok, false);
  assert.equal((await first.response.json()).reason, 'translation_pool_exhausted');
  assert.equal((await admitRequest(environment, 'terms')).ok, true);
  const initial = await (await poolStatus(environment)).json();
  assert.equal(initial.shared, false);
  assert.equal(initial.terms.used, 1);
  assert.equal(initial.characters.limit, 3);
  environment.DB.close();
  const recorded = new DatabaseSync(source.WUWATERM_LOCAL_DB_PATH);
  recorded.exec('UPDATE shared_pool SET terms_used=2');
  recorded.close();
  environment = createNodeEnvironment({ ...source, WUWATERM_LOCAL_LIMIT_TERMS_PER_DAY: '1' });
  const restored = await (await poolStatus(environment)).json();
  assert.equal(restored.terms.used, 2);
  assert.equal(restored.terms.remaining, 0);
  const denied = await admitRequest(environment, 'terms');
  assert.equal((await denied.response.json()).reason, 'terms_pool_exhausted');
  environment.DB.close();
});

test('independent Node processes admit only one request against the same durable limit', async () => {
  const source = config('concurrent', { WUWATERM_LOCAL_LIMIT_TERMS_PER_DAY: '1' });
  const environment = createNodeEnvironment(source);
  const helper = new URL('./helpers/node-pool-contender.mjs', import.meta.url);
  const children = Array.from({ length: 5 }, () => spawn(process.execPath, [helper.pathname], {
    env: { ...source, NODE_NO_WARNINGS: '1' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  }));
  const results = children.map(child => new Promise((resolve, reject) => {
    let ready = false;
    child.on('error', reject);
    child.on('exit', code => { if (code !== 0) reject(new Error('contender failed')); });
    child.on('message', message => {
      if (message === 'ready') { ready = true; return; }
      if (ready) resolve(message);
    });
  }));
  await Promise.all(children.map(child => new Promise((resolve, reject) => {
    child.on('message', message => { if (message === 'ready') resolve(); });
    child.on('exit', () => reject(new Error('contender exited before start')));
  })));
  for (const child of children) child.send('go');
  const statuses = await Promise.all(results);
  assert.equal(statuses.filter(status => status === 200).length, 1);
  assert.ok(statuses.every(status => [200, 429, 503].includes(status)));
  const snapshot = await (await poolStatus(environment)).json();
  assert.equal(snapshot.terms.used, 1);
  environment.DB.close();
});

test('a locked SQLite database refuses admission without dispatching', async () => {
  const source = config('locked');
  const environment = createNodeEnvironment(source);
  const lock = new DatabaseSync(source.WUWATERM_LOCAL_DB_PATH);
  lock.exec('BEGIN IMMEDIATE');
  const result = await admitRequest(environment, 'terms');
  assert.equal(result.ok, false);
  assert.equal(result.response.status, 503);
  lock.exec('ROLLBACK');
  lock.close();
  assert.equal((await (await poolStatus(environment)).json()).terms.used, 0);
  environment.DB.close();
});

test('startup refuses foreign databases and invalid settings without changing foreign bytes', () => {
  const source = config('foreign');
  writeFileSync(source.WUWATERM_LOCAL_DB_PATH, 'synthetic unrelated data', { mode: 0o600 });
  chmodSync(source.WUWATERM_LOCAL_DB_PATH, 0o600);
  const before = readFileSync(source.WUWATERM_LOCAL_DB_PATH);
  assert.throws(() => createNodeEnvironment(source), /Invalid self-host/);
  assert.deepEqual(readFileSync(source.WUWATERM_LOCAL_DB_PATH), before);
  const sqliteSource = config('foreign-sqlite');
  const foreign = new DatabaseSync(sqliteSource.WUWATERM_LOCAL_DB_PATH);
  foreign.exec("CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES ('preserve')");
  foreign.close();
  chmodSync(sqliteSource.WUWATERM_LOCAL_DB_PATH, 0o600);
  const sqliteBefore = readFileSync(sqliteSource.WUWATERM_LOCAL_DB_PATH);
  assert.throws(() => createNodeEnvironment(sqliteSource), /Invalid self-host/);
  assert.deepEqual(readFileSync(sqliteSource.WUWATERM_LOCAL_DB_PATH), sqliteBefore);
  for (const overrides of [
    { WUWATERM_RUNTIME_MODE: 'public' },
    { WUWATERM_TRANSLATION_ENABLED: 'yes' },
    { WUWATERM_LOCAL_LIMIT_TERMS_PER_DAY: '0' },
    { WUWATERM_LOCAL_LIMIT_TERMS_PER_DAY: '1e3' },
    { WUWATERM_LOCAL_LIMIT_TERM_PER_DAY: '1' },
    { WUWATERM_LOCAL_DB_PATH: 'relative.sqlite' },
  ]) assert.throws(() => createNodeEnvironment(config('invalid', overrides)), /Invalid self-host/);
});

test('self-host endpoint policy accepts only canonical loopback or explicitly pinned TLS', () => {
  const source = config('url');
  assert.ok(configuredUpstream(source));
  assert.ok(configuredUpstream({ ...source, WUWATERM_API_BASE_URL: 'http://[::1]:9000/api/' }));
  assert.ok(configuredUpstream({ ...source, WUWATERM_API_BASE_URL: 'https://core.example.test/api/', WUWATERM_API_ALLOWED_HOST: 'core.example.test' }));
  for (const value of [
    'http://localhost:9000/', 'http://127.1:9000/', 'http://192.0.2.1:9000/',
    'http://user@127.0.0.1:9000/', 'http://127.0.0.1:9000/?x=1',
    'http://127.0.0.1:9000/#fragment', 'http://127.0.0.1:9000/%2e%2e/',
    'https://core.example.test/api/',
  ]) assert.equal(configuredUpstream({ ...source, WUWATERM_API_BASE_URL: value }), null);
});

test('root API mount permits ordinary slash-containing metadata while keeping bearer server-side', async () => {
  const environment = createNodeEnvironment(config('projection'));
  let seen;
  const response = await proxyMetaRequest({ environment, fetchImpl: async (url, init) => {
    seen = { url, init };
    return Response.json({ api_version: 'v1', service_version: 'test', term_count: 1,
      request_id: 'test/request', llm_configured: false, schema_version: '2',
      source_profile: null, source_commit: null });
  } });
  assert.equal(response.status, 200);
  assert.equal((await response.text()).includes(environment.WUWATERM_SITE_DEVICE_TOKEN), false);
  assert.equal(seen.url.pathname, '/v1/meta');
  assert.equal(seen.init.redirect, 'manual');
  assert.equal(seen.init.credentials, 'omit');
  environment.DB.close();
});

test('Node environment must be initialized before self-host admission', async () => {
  const old = process.env.WUWATERM_RUNTIME_MODE;
  process.env.WUWATERM_RUNTIME_MODE = 'selfhost';
  assert.deepEqual(await runtimeEnvironment(), {});
  const environment = initializeNodeEnvironment(config('initialized'));
  assert.equal((await runtimeEnvironment()).DB, environment.DB);
  environment.DB.close();
  delete globalThis[NODE_ENVIRONMENT];
  if (old === undefined) delete process.env.WUWATERM_RUNTIME_MODE;
  else process.env.WUWATERM_RUNTIME_MODE = old;
});
