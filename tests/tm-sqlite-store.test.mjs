// Unit tests for Part 4: Self-hosted SQLite TM persistence (`tm.sqlite3`) and `/api/tm` route boundary.
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createNodeEnvironment, NODE_ENVIRONMENT } from '../lib/runtime/node.js';
import { openTmStore, TM_APPLICATION_ID, TM_SQLITE_SCHEMA_VERSION } from '../lib/runtime/tm-store.js';
import { GET as getTm, POST as postTm } from '../app/api/tm/route.ts';

const fixtureRoot = mkdtempSync(join(process.env.WUWATERM_TEST_TMPDIR || tmpdir(), 'wuwaterm-tm-sqlite-'));
test.after(() => {
  if (process.env.WUWATERM_TEST_KEEP_FIXTURES !== '1') rmSync(fixtureRoot, { recursive: true, force: true });
});

function selfhostConfig(subDir) {
  const dir = mkdtempSync(join(fixtureRoot, `${subDir}-`));
  return {
    dir,
    env: {
      WUWATERM_RUNTIME_MODE: 'selfhost',
      WUWATERM_LOCAL_DB_PATH: join(dir, 'pool.sqlite3'),
      WUWATERM_TRANSLATION_ENABLED: 'true',
      WUWATERM_API_BASE_URL: 'http://127.0.0.1:9000/',
      WUWATERM_SITE_DEVICE_TOKEN: 'SYNTHETIC_TM_NODE_TOKEN',
    },
  };
}

test('createNodeEnvironment opens hardened tm.sqlite3 beside pool.sqlite3 with mode 0600, PRAGMAs, indexes, and origin CHECK', () => {
  const { dir, env } = selfhostConfig('hardening');
  const runtime = createNodeEnvironment(env);
  try {
    const tmPath = join(dir, 'tm.sqlite3');
    const stat = lstatSync(tmPath);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.mode & 0o777, 0o600);

    const inspect = new DatabaseSync(tmPath);
    try {
      assert.equal(inspect.prepare('PRAGMA application_id').get().application_id, TM_APPLICATION_ID);
      assert.equal(inspect.prepare('PRAGMA user_version').get().user_version, TM_SQLITE_SCHEMA_VERSION);
      assert.equal(String(inspect.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase(), 'wal');
      const schemaRows = Object.fromEntries(inspect.prepare('SELECT key, value FROM tm_schema').all().map(r => [r.key, r.value]));
      assert.deepEqual(schemaRows, { format: 'wuwaterm-tm-v1', schema_version: '1' });

      const indexes = inspect.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tm_entries'").all().map(r => r.name);
      assert.ok(indexes.includes('tm_entries_candidate'));
      assert.ok(indexes.includes('tm_entries_norm'));
      assert.ok(indexes.includes('tm_entries_masked'));

      // SQLite CHECK constraint must reject any unconfirmed origin directly at the DB layer!
      assert.throws(() => {
        inspect.prepare(
          `INSERT INTO tm_entries (
             direction, source_text, source_hash, source_norm, source_masked, target_text,
             prev_source_hash, next_source_hash, origin, terms_db_revision, game_version,
             note, use_count, created_at, updated_at
           ) VALUES ('en', '今汐', ?, '今汐', '今汐', 'Jinhsi', NULL, NULL, 'machine_translated', NULL, NULL, '', 1, '2026-11-27T00:00:00Z', '2026-11-27T00:00:00Z')`,
        ).run('a'.repeat(64));
      });
    } finally {
      inspect.close();
    }
  } finally {
    runtime.TM_DB.close();
    runtime.DB.close();
  }
});

test('openTmStore refuses foreign bytes and loose file permissions without altering foreign bytes', () => {
  const dir = mkdtempSync(join(fixtureRoot, 'foreign-'));
  const foreignPath = join(dir, 'tm.sqlite3');
  writeFileSync(foreignPath, 'unrelated foreign file', { mode: 0o600 });
  chmodSync(foreignPath, 0o600);
  const before = readFileSync(foreignPath);
  assert.throws(() => openTmStore(foreignPath), /Invalid self-host/);
  assert.deepEqual(readFileSync(foreignPath), before);

  const looseDir = mkdtempSync(join(fixtureRoot, 'loose-'));
  const loosePath = join(looseDir, 'tm.sqlite3');
  const created = openTmStore(loosePath);
  created.close();
  chmodSync(loosePath, 0o644);
  assert.throws(() => openTmStore(loosePath), /Invalid self-host/);
});

test('/api/tm route returns 404 memory_only in public mode and persists confirmed entries across reload in selfhost mode', async () => {
  const prevMode = process.env.WUWATERM_RUNTIME_MODE;
  const prevEnv = globalThis[NODE_ENVIRONMENT];
  try {
    // Public mode: 404 memory_only, zero DB access.
    delete process.env.WUWATERM_RUNTIME_MODE;
    delete globalThis[NODE_ENVIRONMENT];
    const pubGet = await getTm();
    assert.equal(pubGet.status, 404);
    assert.deepEqual(await pubGet.json(), { status: 'unavailable', mode: 'memory_only' });
    const pubPost = await postTm(new Request('https://site.test/api/tm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'clear' }),
    }));
    assert.equal(pubPost.status, 404);

    // Selfhost mode: full CRUD + validation + persistence across restart.
    const { env } = selfhostConfig('route');
    let runtime = createNodeEnvironment(env);
    process.env.WUWATERM_RUNTIME_MODE = 'selfhost';
    globalThis[NODE_ENVIRONMENT] = runtime;

    const initial = await (await getTm()).json();
    assert.deepEqual(initial, { mode: 'selfhost_sqlite', entries: [], storageVersion: '0' });

    // Confirm valid entry
    const rev = 'd'.repeat(64);
    const confirmRes = await postTm(new Request('http://127.0.0.1/api/tm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'confirm',
        candidate: {
          sourceText: '今汐释放共鸣解放。',
          targetText: 'Jinhsi casts Resonance Liberation.',
          direction: 'en',
          prevSource: '战斗开始。',
          nextSource: '战斗结束。',
          origin: 'human_confirmed',
          termsDbRevision: rev,
          gameVersion: '3.7.0',
        },
      }),
    }));
    assert.equal(confirmRes.status, 200);
    const confirmed = await confirmRes.json();
    assert.equal(confirmed.status, 'added');
    assert.equal(confirmed.entries.length, 1);
    assert.equal(confirmed.entry.origin, 'human_confirmed');
    assert.equal(confirmed.entry.terms_db_revision, rev);
    assert.equal(confirmed.entry.game_version, '3.7.0');

    // Reject unconfirmed origin
    const badOrigin = await postTm(new Request('http://127.0.0.1/api/tm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'confirm',
        candidate: {
          sourceText: '非法来源',
          targetText: 'Invalid origin',
          direction: 'en',
          origin: 'machine_translated',
        },
      }),
    }));
    assert.equal(badOrigin.status, 400);
    assert.equal((await badOrigin.json()).error, 'unconfirmed_origin');

    // Simulate process restart: close handles and reopen createNodeEnvironment against same data dir!
    runtime.TM_DB.close();
    runtime.DB.close();
    runtime = createNodeEnvironment(env);
    globalThis[NODE_ENVIRONMENT] = runtime;

    const reloaded = await (await getTm()).json();
    assert.equal(reloaded.entries.length, 1);
    assert.equal(reloaded.entries[0].source_text, '今汐释放共鸣解放。');
    assert.equal(reloaded.entries[0].target_text, 'Jinhsi casts Resonance Liberation.');

    // Merge imported entry without downgrading existing human_confirmed entry
    const mergeRes = await postTm(new Request('http://127.0.0.1/api/tm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'merge',
        file: {
          format: 'wuwaterm-tm-v1',
          schema_version: 1,
          exported_at: '2026-11-27T00:00:00Z',
          entries: [
            { ...reloaded.entries[0], origin: 'imported_confirmed', use_count: 5 },
            {
              direction: 'en',
              source_text: '声骸技能冷却 10 秒。',
              target_text: 'Echo Skill cooldown is 10s.',
              prev_source_hash: null,
              next_source_hash: null,
              origin: 'imported_confirmed',
              terms_db_revision: rev,
              game_version: '3.7.0',
              note: '',
              use_count: 1,
              created_at: '2026-11-27T00:00:00Z',
              updated_at: '2026-11-27T00:00:00Z',
            },
          ],
        },
      }),
    }));
    assert.equal(mergeRes.status, 200);
    const merged = await mergeRes.json();
    assert.equal(merged.entries.length, 2);
    assert.equal(merged.entries[0].origin, 'human_confirmed', 'merge must never downgrade human_confirmed');
    assert.equal(merged.entries[0].use_count, 5);

    // Delete one entry
    const delRes = await postTm(new Request('http://127.0.0.1/api/tm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'delete',
        entry: merged.entries[1],
      }),
    }));
    assert.equal(delRes.status, 200);
    const afterDel = await delRes.json();
    assert.equal(afterDel.deleted, true);
    assert.equal(afterDel.entries.length, 1);

    // Clear all entries
    const clearRes = await postTm(new Request('http://127.0.0.1/api/tm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'clear' }),
    }));
    assert.equal(clearRes.status, 200);
    assert.deepEqual((await clearRes.json()).entries, []);

    // Finding #2: Leading-digit sources (e.g. "10% 暴击率", "100") must persist cleanly without NUL in source_masked!
    const digitRes = await postTm(new Request('http://127.0.0.1/api/tm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'confirm',
        candidate: {
          sourceText: '10% 暴击率',
          targetText: '10% CRIT Rate',
          direction: 'en',
          prevSource: null,
          nextSource: null,
          origin: 'human_confirmed',
          termsDbRevision: rev,
          gameVersion: '3.7.0',
        },
      }),
    }));
    assert.equal(digitRes.status, 200);
    const digitBody = await digitRes.json();
    assert.equal(digitBody.status, 'added');
    assert.equal(digitBody.entries.length, 1);
    assert.equal(digitBody.entries[0].source_text, '10% 暴击率');
    assert.equal(typeof digitBody.storageVersion, 'string');

    // Also verify numeric-only source "100" imports cleanly and SQLite source_masked has no NUL byte.
    const digitMergeRes = await postTm(new Request('http://127.0.0.1/api/tm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'merge',
        file: {
          format: 'wuwaterm-tm-v1',
          schema_version: 1,
          exported_at: '2026-11-27T00:00:00Z',
          entries: [{
            direction: 'en',
            source_text: '100',
            target_text: '100',
            prev_source_hash: null,
            next_source_hash: null,
            origin: 'imported_confirmed',
            terms_db_revision: rev,
            game_version: '3.7.0',
            note: '',
            use_count: 1,
            created_at: '2026-11-27T00:00:00Z',
            updated_at: '2026-11-27T00:00:00Z',
          }],
        },
      }),
    }));
    assert.equal(digitMergeRes.status, 200);
    const digitMerged = await digitMergeRes.json();
    assert.equal(digitMerged.entries.length, 2);

    // Inspect SQLite directly to verify length(source_masked) > 0 and no NUL bytes.
    const checkDb = new DatabaseSync(runtime.TM_DB.path, { readOnly: true });
    const maskedRows = checkDb.prepare('SELECT source_text, source_masked, length(source_masked) AS mlen FROM tm_entries ORDER BY id').all();
    checkDb.close();
    assert.equal(maskedRows.length, 2);
    for (const row of maskedRows) {
      assert.ok(row.mlen > 0, `source_masked length must be > 0 for ${row.source_text}`);
      assert.equal(row.source_masked.includes('\u0000'), false, `source_masked must not contain NUL for ${row.source_text}`);
    }

    // Finding #8: Unforced replace from a stale empty tab returns 409 Conflict with latest entries + storageVersion and preserves existing rows!
    const getBeforeConflict = await (await getTm()).json();
    assert.equal(getBeforeConflict.entries.length, 2);
    assert.equal(typeof getBeforeConflict.storageVersion, 'string');

    const conflictReplace = await postTm(new Request('http://127.0.0.1/api/tm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'replace',
        forceReplace: false,
        expectedVersion: '0',
        file: {
          format: 'wuwaterm-tm-v1',
          schema_version: 1,
          exported_at: '2026-11-27T00:00:00Z',
          entries: [{
            direction: 'en',
            source_text: '单条覆盖',
            target_text: 'Single overwrite',
            prev_source_hash: null,
            next_source_hash: null,
            origin: 'imported_confirmed',
            terms_db_revision: null,
            game_version: null,
            note: '',
            use_count: 1,
            created_at: '2026-11-27T00:00:00Z',
            updated_at: '2026-11-27T00:00:00Z',
          }],
        },
      }),
    }));
    assert.equal(conflictReplace.status, 409);
    const conflictBody = await conflictReplace.json();
    assert.equal(conflictBody.status, 'conflict');
    assert.equal(conflictBody.code, 'tm_storage_conflict');
    assert.equal(conflictBody.entries.length, 2);
    assert.equal(conflictBody.storageVersion, getBeforeConflict.storageVersion);

    // Explicit forceReplace: true overwrites intentionally and bumps storageVersion.
    const forcedReplace = await postTm(new Request('http://127.0.0.1/api/tm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'replace',
        forceReplace: true,
        file: {
          format: 'wuwaterm-tm-v1',
          schema_version: 1,
          exported_at: '2026-11-27T00:00:00Z',
          entries: [{
            direction: 'en',
            source_text: '单条覆盖',
            target_text: 'Single overwrite',
            prev_source_hash: null,
            next_source_hash: null,
            origin: 'imported_confirmed',
            terms_db_revision: null,
            game_version: null,
            note: '',
            use_count: 1,
            created_at: '2026-11-27T00:00:00Z',
            updated_at: '2026-11-27T00:00:00Z',
          }],
        },
      }),
    }));
    assert.equal(forcedReplace.status, 200);
    const forcedBody = await forcedReplace.json();
    assert.equal(forcedBody.entries.length, 1);
    assert.equal(forcedBody.entries[0].source_text, '单条覆盖');
    assert.notEqual(forcedBody.storageVersion, getBeforeConflict.storageVersion);

    runtime.TM_DB.close();
    runtime.DB.close();
  } finally {
    if (prevEnv === undefined) delete globalThis[NODE_ENVIRONMENT];
    else globalThis[NODE_ENVIRONMENT] = prevEnv;
    if (prevMode === undefined) delete process.env.WUWATERM_RUNTIME_MODE;
    else process.env.WUWATERM_RUNTIME_MODE = prevMode;
  }
});
