// Live service provenance for the page translation memory (MY-491): which dictionary revision and game version the
// running service reports, TTL/cooldown behavior, and why stale/failed metadata or imported manuscripts never grant verified_fresh.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TM_FRESHNESS_STALE,
  TM_FRESHNESS_UNKNOWN,
  TM_FRESHNESS_VERIFIED,
  TM_STALE_GAME_VERSION,
  TM_STALE_PROVENANCE_UNKNOWN,
  confirmTranslationMemoryEntry,
  matchTranslationMemory,
} from '../lib/translation-memory.ts';
import {
  isDictionaryFresh,
  isMetaFresh,
  liveGameVersion,
  liveTermsDbRevision,
  tmAutoReuseBasis,
  tmConfirmBasis,
  tmDisplayMatchBasis,
  tmServiceBasis,
} from '../lib/tm-live-provenance.ts';
import {
  DICTIONARY_ERROR_RETRY_COOLDOWN_MS,
  DICTIONARY_FRESH_TTL_MS,
  META_ERROR_RETRY_COOLDOWN_MS,
  META_FRESH_TTL_MS,
  RuntimeStore,
} from '../lib/runtime-store.ts';
import { CAPABILITY_DICTIONARY_IDENTITY } from '../lib/semantic-review.js';

const REVISION = 'a'.repeat(64);
const STAMP = '2026-11-27T00:00:00Z';
const LIVE_DICTIONARY = { schema_version: '2', source_commit: 'commit-live', term_count: 1200, revision: REVISION };
const META = {
  schema_version: '2',
  source_commit: 'commit-live',
  game_version: '3.7.0',
  resource_version: 'res-1',
  changelist: null,
  term_count: 1200,
  request_id: 'meta-1',
};

const NOW = 1_700_000_000_000;
const success = (over = {}, fetchedAt = NOW) => ({ kind: 'success', data: { ...META, ...over }, fetchedAt });
const liveSnapshot = (over = {}) => ({ trusted: true, report: { dictionary: { ...LIVE_DICTIONARY, ...over } } });
const importedSnapshot = (over = {}) => ({ trusted: false, report: { dictionary: { ...LIVE_DICTIONARY, ...over } } });
const makeEntry = (over = {}) => ({
  direction: 'en',
  source_text: '共鸣效率提高 10%',
  target_text: 'Energy Regen +10%',
  prev_source_hash: null,
  next_source_hash: null,
  origin: 'human_confirmed',
  terms_db_revision: REVISION,
  game_version: '3.7.0',
  note: '',
  use_count: 1,
  created_at: STAMP,
  updated_at: STAMP,
  ...over,
});

test('the live game version is adopted only from a confirmed /api/meta read that reports a usable value', () => {
  assert.equal(liveGameVersion(success()), '3.7.0');
  assert.equal(liveGameVersion({ kind: 'idle' }), null);
  assert.equal(liveGameVersion({ kind: 'loading', lastKnown: null }), null);
  assert.equal(liveGameVersion({ kind: 'error', lastKnown: null, failedAt: NOW }), null);
  // A re-read in flight or failed keeps lastKnown game_version for stale-drift detection.
  assert.equal(liveGameVersion({ kind: 'loading', lastKnown: META }), '3.7.0');
  assert.equal(liveGameVersion({ kind: 'error', lastKnown: META, failedAt: NOW }), '3.7.0');

  assert.equal(liveGameVersion(success({ game_version: null })), null);
  assert.equal(liveGameVersion(success({ game_version: '' })), null);
  assert.equal(liveGameVersion(success({ game_version: '   ' })), null);
  assert.equal(liveGameVersion(success({ game_version: '\u3000' })), null);
  // The sentinel is "not reported" regardless of case or surrounding whitespace.
  assert.equal(liveGameVersion(success({ game_version: 'unavailable' })), null);
  assert.equal(liveGameVersion(success({ game_version: 'UNAVAILABLE' })), null);
  assert.equal(liveGameVersion(success({ game_version: ' unavailable ' })), null);
  // `source_commit` names the dictionary build, never the game.
  assert.equal(liveGameVersion(success({ game_version: null, source_commit: '3.7.0' })), null);
  // Surrounding whitespace is trimmed; the trimmed value is what an entry records and compares.
  assert.equal(liveGameVersion(success({ game_version: ' 3.7.0 ' })), '3.7.0');
  // The value has to fit the entry field it will be written into (1..128 scalar characters).
  assert.equal(liveGameVersion(success({ game_version: '3'.repeat(128) })), '3'.repeat(128));
  assert.equal(liveGameVersion(success({ game_version: '3'.repeat(129) })), null);
  assert.equal(liveGameVersion(success({ game_version: ` ${'3'.repeat(128)} ` })), '3'.repeat(128));
  // C0/C1 control characters and isolated surrogates cannot be stored in an entry, so they are not a basis.
  assert.equal(liveGameVersion(success({ game_version: '3.7\u0000' })), null);
  assert.equal(liveGameVersion(success({ game_version: '3.7\u001f' })), null);
  assert.equal(liveGameVersion(success({ game_version: '3.7\u007f' })), null);
  assert.equal(liveGameVersion(success({ game_version: '3.7\u0081' })), null);
  assert.equal(liveGameVersion(success({ game_version: '3.7\u009f' })), null);
  assert.equal(liveGameVersion(success({ game_version: '3.7\uD800' })), null);
  assert.equal(liveGameVersion(success({ game_version: '3.7\uDC00' })), null);
});

test('only a fresh /api/meta success matching a live review supplies currentTermsDbRevision; idle, loading, error, and expired reads return null', () => {
  const rev = (meta, snap, now = NOW) => liveTermsDbRevision(meta, snap, { now });

  assert.equal(rev({ kind: 'idle' }, null), null, 'no review yet');
  assert.equal(rev({ kind: 'idle' }, liveSnapshot()), null, 'idle meta is not a live confirmation');
  assert.equal(rev(success(), importedSnapshot()), null, 'an imported manuscript report is saved history, not the live service');
  assert.equal(rev({ kind: 'error', lastKnown: null, failedAt: NOW }, liveSnapshot()), null, 'failed meta must not confer verified revision');
  assert.equal(rev({ kind: 'error', lastKnown: META, failedAt: NOW }, liveSnapshot()), null, 'failed re-read with lastKnown must not confer verified_fresh');
  assert.equal(rev({ kind: 'loading', lastKnown: null }, liveSnapshot()), null, 'loading without confirmation returns null');
  assert.equal(rev({ kind: 'loading', lastKnown: META }, liveSnapshot()), null, 'loading re-read without fresh confirmation returns null');

  assert.equal(rev(success(), liveSnapshot()), REVISION);
  assert.equal(isMetaFresh(success({}, NOW), { now: NOW + META_FRESH_TTL_MS - 1 }), true);
  assert.equal(rev(success({}, NOW), liveSnapshot(), NOW + META_FRESH_TTL_MS - 1), REVISION);
  // Once TTL expires, currentTermsDbRevision drops to null even though data is cached.
  assert.equal(isMetaFresh(success({}, NOW), { now: NOW + META_FRESH_TTL_MS }), false);
  assert.equal(rev(success({}, NOW), liveSnapshot(), NOW + META_FRESH_TTL_MS), null);

  // Any disagreement in the dictionary identity means the service's dictionary changed under the saved review.
  assert.equal(rev(success({ schema_version: '3' }), liveSnapshot()), null);
  assert.equal(rev(success({ source_commit: 'commit-next' }), liveSnapshot()), null);
  assert.equal(rev(success({ term_count: 1201 }), liveSnapshot()), null);
  // A service that reports neither schema nor commit still matches a report that says the same.
  assert.equal(
    rev(success({ schema_version: null, source_commit: null }), liveSnapshot({ schema_version: null, source_commit: null })),
    REVISION,
  );
});

test('failed or expired meta keeps lastKnown game_version for known_stale drift while denying verified_fresh', () => {
  const entrySameGame = makeEntry({ source_text: '同版本句', terms_db_revision: REVISION, game_version: '3.7.0' });
  const entryOldGame = makeEntry({ source_text: '旧版本句', terms_db_revision: REVISION, game_version: '3.6.0' });

  for (const meta of [
    { kind: 'error', lastKnown: META, failedAt: NOW },
    success({}, NOW - META_FRESH_TTL_MS),
  ]) {
    const basis = tmServiceBasis(meta, liveSnapshot(), { now: NOW });
    assert.deepEqual(basis, { currentTermsDbRevision: null, currentGameVersion: '3.7.0' });

    const sameGameMatch = matchTranslationMemory([entrySameGame], '同版本句', 'en', basis)[0];
    assert.equal(sameGameMatch.freshness, TM_FRESHNESS_UNKNOWN);
    assert.deepEqual(sameGameMatch.staleReasons, [TM_STALE_PROVENANCE_UNKNOWN]);
    assert.equal(sameGameMatch.needsRecheck, true);

    const oldGameMatch = matchTranslationMemory([entryOldGame], '旧版本句', 'en', basis)[0];
    assert.equal(oldGameMatch.freshness, TM_FRESHNESS_STALE);
    assert.deepEqual(oldGameMatch.staleReasons, [TM_STALE_GAME_VERSION, TM_STALE_PROVENANCE_UNKNOWN]);
    assert.equal(oldGameMatch.needsRecheck, true);
  }
});

test('a dictionary change under the saved review reads as provenance_unknown, while the live game version still names the game change', () => {
  const meta = success();
  const saved = liveSnapshot({ source_commit: 'commit-old' });
  const basis = tmServiceBasis(meta, saved, { now: NOW });
  assert.deepEqual(basis, { currentTermsDbRevision: null, currentGameVersion: '3.7.0' });

  const changedGame = matchTranslationMemory(
    [makeEntry({ source_text: '旧版本句', terms_db_revision: REVISION, game_version: '3.6.0' })],
    '旧版本句',
    'en',
    basis,
  )[0];
  assert.equal(changedGame.freshness, TM_FRESHNESS_STALE);
  assert.deepEqual(changedGame.staleReasons, [TM_STALE_GAME_VERSION, TM_STALE_PROVENANCE_UNKNOWN]);
  assert.equal(changedGame.needsRecheck, true);

  const noRecordedGame = matchTranslationMemory(
    [makeEntry({ source_text: '无游戏版本句', terms_db_revision: REVISION, game_version: null })],
    '无游戏版本句',
    'en',
    basis,
  )[0];
  assert.equal(noRecordedGame.freshness, TM_FRESHNESS_UNKNOWN);
  assert.deepEqual(noRecordedGame.staleReasons, [TM_STALE_PROVENANCE_UNKNOWN]);
  assert.equal(noRecordedGame.needsRecheck, true);
});

test('RuntimeStore refreshes meta after TTL, retries error after cooldown, and keeps lastKnown non-fresh on error', async () => {
  let clock = NOW;
  let mode = 'fail';
  let calls = 0;
  const store = new RuntimeStore({
    pool: false,
    now: () => clock,
    fetch: async (path) => {
      assert.equal(path, '/api/meta');
      calls += 1;
      if (mode === 'fail') {
        return new Response('upstream-unavailable', { status: 502 });
      }
      return new Response(JSON.stringify(META), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  // Initial read fails and records failedAt.
  await store.loadMeta();
  assert.equal(calls, 1);
  assert.deepEqual(store.getSnapshot().meta, { kind: 'error', lastKnown: null, failedAt: NOW });

  // Inside error cooldown: non-forced loadMeta() does not hit /api/meta.
  clock += META_ERROR_RETRY_COOLDOWN_MS - 1;
  await store.loadMeta();
  assert.equal(calls, 1);

  // After cooldown elapses: non-forced loadMeta() automatically retries and succeeds.
  clock += 1;
  mode = 'ok';
  await store.loadMeta();
  assert.equal(calls, 2);
  const firstSuccessAt = clock;
  assert.deepEqual(store.getSnapshot().meta, { kind: 'success', data: META, fetchedAt: firstSuccessAt });

  // Within TTL: cached success is reused without fetching.
  clock += META_FRESH_TTL_MS - 1;
  await store.loadMeta();
  assert.equal(calls, 2);
  assert.deepEqual(tmServiceBasis(store.getSnapshot().meta, liveSnapshot(), { now: clock }), {
    currentTermsDbRevision: REVISION,
    currentGameVersion: '3.7.0',
  });

  // Once TTL expires: basis drops currentTermsDbRevision to null, and loadMeta(false) refreshes.
  clock += 1;
  assert.deepEqual(tmServiceBasis(store.getSnapshot().meta, liveSnapshot(), { now: clock }), {
    currentTermsDbRevision: null,
    currentGameVersion: '3.7.0',
  });
  await store.loadMeta();
  assert.equal(calls, 3);
  assert.deepEqual(store.getSnapshot().meta, { kind: 'success', data: META, fetchedAt: clock });

  // Forced re-read failing keeps lastKnown game_version but strips currentTermsDbRevision.
  mode = 'fail';
  const reread = store.loadMeta(true);
  assert.equal(store.getSnapshot().meta.kind, 'loading');
  assert.deepEqual(tmServiceBasis(store.getSnapshot().meta, liveSnapshot(), { now: clock }), {
    currentTermsDbRevision: null,
    currentGameVersion: '3.7.0',
  });
  await reread;
  assert.equal(calls, 4);
  assert.equal(store.getSnapshot().meta.kind, 'error');
  assert.deepEqual(tmServiceBasis(store.getSnapshot().meta, liveSnapshot(), { now: clock }), {
    currentTermsDbRevision: null,
    currentGameVersion: '3.7.0',
  });
});

test('confirming against a fresh live review and matching /api/meta writes the real basis and reads back verified_fresh', () => {
  const basis = tmServiceBasis(success(), liveSnapshot(), { now: NOW });
  assert.deepEqual(basis, { currentTermsDbRevision: REVISION, currentGameVersion: '3.7.0' });

  const outcome = confirmTranslationMemoryEntry([], {
    sourceText: '共鸣效率提高 10%',
    targetText: 'Energy Regen +10%',
    direction: 'en',
    termsDbRevision: basis.currentTermsDbRevision,
    gameVersion: basis.currentGameVersion,
  });
  assert.equal(outcome.status, 'added');
  assert.equal(outcome.entry.terms_db_revision, REVISION);
  assert.equal(outcome.entry.game_version, '3.7.0');

  const fresh = matchTranslationMemory([outcome.entry], '共鸣效率提高 10%', 'en', basis)[0];
  assert.equal(fresh.freshness, TM_FRESHNESS_VERIFIED);
  assert.deepEqual(fresh.staleReasons, []);
  assert.equal(fresh.needsRecheck, false);

  const nextGame = tmServiceBasis(success({ game_version: '3.8.0' }), liveSnapshot(), { now: NOW });
  const stale = matchTranslationMemory([outcome.entry], '共鸣效率提高 10%', 'en', nextGame)[0];
  assert.equal(stale.freshness, TM_FRESHNESS_STALE);
  assert.deepEqual(stale.staleReasons, [TM_STALE_GAME_VERSION]);
  assert.equal(stale.needsRecheck, true);
});

const DICT = {
  revision: REVISION,
  schema_version: '2',
  source_commit: 'commit-live',
  game_version: '3.7.0',
  term_count: 1200,
  request_id: 'dict-1',
};
const dictSuccess = (over = {}, fetchedAt = NOW) => ({ kind: 'success', data: { ...DICT, ...over }, fetchedAt });

test('four-tier operation provenance: direct /api/dictionary, legacy fallback, and P1-02 confirm never leaks lastKnown', () => {
  // Tier 1 & 2 (Browse / Manual reference apply): fresh /api/dictionary grants verified_fresh without any review.
  assert.equal(isDictionaryFresh(dictSuccess(), { now: NOW }), true);
  assert.deepEqual(tmDisplayMatchBasis(dictSuccess(), { kind: 'idle' }, null, { now: NOW }), {
    currentTermsDbRevision: REVISION,
    currentGameVersion: '3.7.0',
  });

  // Expired or errored /api/dictionary keeps lastKnown game_version ONLY for display known_stale drift, never verified_fresh.
  assert.deepEqual(tmDisplayMatchBasis(dictSuccess({}, NOW - DICTIONARY_FRESH_TTL_MS), { kind: 'idle' }, null, { now: NOW }), {
    currentTermsDbRevision: null,
    currentGameVersion: '3.7.0',
  });
  assert.deepEqual(tmDisplayMatchBasis({ kind: 'error', lastKnown: DICT, failedAt: NOW }, { kind: 'idle' }, null, { now: NOW }), {
    currentTermsDbRevision: null,
    currentGameVersion: '3.7.0',
  });

  // Tier 3 (Human confirm, P1-02): ONLY genuinely fresh live provenance; idle/loading/error/expired MUST return null for BOTH!
  assert.deepEqual(tmConfirmBasis(dictSuccess(), { kind: 'idle' }, null, { now: NOW }), {
    currentTermsDbRevision: REVISION,
    currentGameVersion: '3.7.0',
  });
  assert.deepEqual(tmConfirmBasis({ kind: 'unsupported' }, success(), liveSnapshot(), { now: NOW }), {
    currentTermsDbRevision: REVISION,
    currentGameVersion: '3.7.0',
  });
  assert.deepEqual(tmConfirmBasis({ kind: 'unsupported' }, success(), null, { now: NOW }), {
    currentTermsDbRevision: null,
    currentGameVersion: '3.7.0',
  });

  for (const [label, dictView, metaView] of [
    ['dict idle', { kind: 'idle' }, success()],
    ['dict loading with lastKnown', { kind: 'loading', lastKnown: DICT }, success()],
    ['dict error with lastKnown', { kind: 'error', lastKnown: DICT, failedAt: NOW }, success()],
    ['dict TTL expired', dictSuccess({}, NOW - DICTIONARY_FRESH_TTL_MS), success()],
    ['legacy meta idle', { kind: 'unsupported' }, { kind: 'idle' }],
    ['legacy meta loading with lastKnown', { kind: 'unsupported' }, { kind: 'loading', lastKnown: META }],
    ['legacy meta error with lastKnown', { kind: 'unsupported' }, { kind: 'error', lastKnown: META, failedAt: NOW }],
    ['legacy meta TTL expired', { kind: 'unsupported' }, success({}, NOW - META_FRESH_TTL_MS)],
  ]) {
    assert.deepEqual(
      tmConfirmBasis(dictView, metaView, liveSnapshot(), { now: NOW }),
      { currentTermsDbRevision: null, currentGameVersion: null },
      `P1-02 confirm must not leak lastKnown for ${label}`,
    );
  }

  // Tier 4 (Auto batch reuse): requires fresh live revision; fails closed when unavailable/expired/unverified.
  assert.deepEqual(tmAutoReuseBasis(dictSuccess(), { kind: 'idle' }, null, { now: NOW }), {
    currentTermsDbRevision: REVISION,
    currentGameVersion: '3.7.0',
  });
  assert.deepEqual(tmAutoReuseBasis({ kind: 'unsupported' }, success(), liveSnapshot(), { now: NOW }), {
    currentTermsDbRevision: REVISION,
    currentGameVersion: '3.7.0',
  });
  assert.deepEqual(tmAutoReuseBasis({ kind: 'unsupported' }, success(), null, { now: NOW }), {
    currentTermsDbRevision: null,
    currentGameVersion: null,
  });
  assert.deepEqual(tmAutoReuseBasis({ kind: 'error', lastKnown: DICT, failedAt: NOW }, success(), liveSnapshot(), { now: NOW }), {
    currentTermsDbRevision: null,
    currentGameVersion: null,
  });
  assert.deepEqual(tmAutoReuseBasis(dictSuccess({}, NOW - DICTIONARY_FRESH_TTL_MS), success(), liveSnapshot(), { now: NOW }), {
    currentTermsDbRevision: null,
    currentGameVersion: null,
  });
});

test('RuntimeStore.loadDictionary checks capabilities first, caches for 10m TTL, and enforces fixed 30s error retry cooldown', async () => {
  let clock = NOW;
  let dictCalls = 0;
  let dictMode = 'fail';

  // Legacy server without dictionary-identity-v1 sets unsupported without calling /api/dictionary.
  const legacyStore = new RuntimeStore({
    pool: false,
    now: () => clock,
    fetch: async (path) => {
      if (path === '/api/capabilities') {
        return new Response(JSON.stringify({ capabilities: ['translation-context-v1'], request_id: 'cap-1' }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${path}`);
    },
  });
  await legacyStore.loadDictionary();
  assert.deepEqual(legacyStore.getSnapshot().dictionary, { kind: 'unsupported' });

  // Modern server advertising dictionary-identity-v1.
  const store = new RuntimeStore({
    pool: false,
    now: () => clock,
    fetch: async (path) => {
      if (path === '/api/capabilities') {
        return new Response(JSON.stringify({ capabilities: ['dictionary-identity-v1'], request_id: 'cap-2' }), { status: 200 });
      }
      assert.equal(path, '/api/dictionary');
      dictCalls += 1;
      if (dictMode === 'fail') return new Response('unavailable', { status: 503 });
      return new Response(JSON.stringify(DICT), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  await store.loadDictionary();
  assert.equal(dictCalls, 1);
  assert.deepEqual(store.getSnapshot().dictionary, { kind: 'error', lastKnown: null, failedAt: NOW });

  // Inside fixed 30s cooldown: non-forced call skips fetch.
  clock += DICTIONARY_ERROR_RETRY_COOLDOWN_MS - 1;
  await store.loadDictionary();
  assert.equal(dictCalls, 1);

  // After 30s cooldown: retries automatically and succeeds.
  clock += 1;
  dictMode = 'ok';
  await store.loadDictionary();
  assert.equal(dictCalls, 2);
  assert.deepEqual(store.getSnapshot().dictionary, { kind: 'success', data: DICT, fetchedAt: clock });

  // Within 10m TTL: cached without hitting /api/dictionary.
  clock += DICTIONARY_FRESH_TTL_MS - 1;
  await store.loadDictionary();
  assert.equal(dictCalls, 2);

  // Past 10m TTL: refreshes automatically.
  clock += 1;
  await store.loadDictionary();
  assert.equal(dictCalls, 3);
  assert.deepEqual(store.getSnapshot().dictionary, { kind: 'success', data: DICT, fetchedAt: clock });

  // Forced refresh failing preserves lastKnown while denying confirm & auto-reuse.
  dictMode = 'fail';
  await store.loadDictionary(true);
  assert.equal(dictCalls, 4);
  assert.deepEqual(store.getSnapshot().dictionary, { kind: 'error', lastKnown: DICT, failedAt: clock });
  assert.deepEqual(tmConfirmBasis(store.getSnapshot().dictionary, { kind: 'idle' }, null, { now: clock }), {
    currentTermsDbRevision: null,
    currentGameVersion: null,
  });
});

test('Finding #3: transient /api/capabilities 503 enters retryable error instead of permanent unsupported', async () => {
  let clock = NOW;
  let capStatus = 503;
  let capCalls = 0;
  let dictCalls = 0;
  const store = new RuntimeStore({
    pool: false,
    now: () => clock,
    fetch: async path => {
      if (path === '/api/capabilities') {
        capCalls += 1;
        if (capStatus !== 200) return new Response(null, { status: capStatus });
        return new Response(JSON.stringify({ capabilities: [CAPABILITY_DICTIONARY_IDENTITY], request_id: 'cap-ok' }), { status: 200 });
      }
      if (path === '/api/dictionary') {
        dictCalls += 1;
        return new Response(JSON.stringify(DICT), { status: 200 });
      }
      throw new Error(`Unexpected path: ${path}`);
    },
  });

  // First call fails with 503 -> error (NOT unsupported!), /api/dictionary untouched.
  await store.loadDictionary();
  assert.equal(capCalls, 1);
  assert.equal(dictCalls, 0);
  assert.deepEqual(store.getSnapshot().dictionary, { kind: 'error', lastKnown: null, failedAt: NOW });

  // Inside 30s cooldown: non-forced call respects cooldown.
  clock += DICTIONARY_ERROR_RETRY_COOLDOWN_MS - 1;
  await store.loadDictionary();
  assert.equal(capCalls, 1);

  // Service recovers; after 30s cooldown, non-forced loadDictionary retries capabilities and succeeds!
  capStatus = 200;
  clock += 1;
  await store.loadDictionary();
  assert.equal(capCalls, 2);
  assert.equal(dictCalls, 1);
  assert.deepEqual(store.getSnapshot().dictionary, { kind: 'success', data: DICT, fetchedAt: clock });

  // Also test immediate recovery via force = true right after a 503 without waiting for cooldown.
  let capStatus2 = 503;
  let capCalls2 = 0;
  let dictCalls2 = 0;
  const store2 = new RuntimeStore({
    pool: false,
    now: () => clock,
    fetch: async path => {
      if (path === '/api/capabilities') {
        capCalls2 += 1;
        if (capStatus2 !== 200) return new Response(null, { status: capStatus2 });
        return new Response(JSON.stringify({ capabilities: [CAPABILITY_DICTIONARY_IDENTITY], request_id: 'cap-ok-2' }), { status: 200 });
      }
      if (path === '/api/dictionary') {
        dictCalls2 += 1;
        return new Response(JSON.stringify(DICT), { status: 200 });
      }
      throw new Error(`Unexpected path: ${path}`);
    },
  });
  await store2.loadDictionary();
  assert.equal(store2.getSnapshot().dictionary.kind, 'error');
  capStatus2 = 200;
  await store2.loadDictionary(true);
  assert.equal(capCalls2, 2);
  assert.equal(dictCalls2, 1);
  assert.deepEqual(store2.getSnapshot().dictionary, { kind: 'success', data: DICT, fetchedAt: clock });
});

test('Finding #4: re-confirming an existing entry with explicit null overwrites stale revision and gameVersion', () => {
  const first = confirmTranslationMemoryEntry([], {
    sourceText: '共鸣效率提高 10%',
    targetText: 'Energy Regen +10%',
    direction: 'en',
    termsDbRevision: REVISION,
    gameVersion: '3.6.0',
  }, new Date('2026-11-27T00:00:00Z'));
  assert.equal(first.status, 'added');
  assert.equal(first.entry.terms_db_revision, REVISION);
  assert.equal(first.entry.game_version, '3.6.0');

  // Scenario A: dictionary check failed -> explicit { termsDbRevision: null, gameVersion: null } MUST clear stale provenance!
  const cleared = confirmTranslationMemoryEntry(first.entries, {
    sourceText: '共鸣效率提高 10%',
    targetText: 'Energy Regen +10%',
    direction: 'en',
    termsDbRevision: null,
    gameVersion: null,
  }, new Date('2026-11-27T01:00:00Z'));
  assert.equal(cleared.status, 'updated');
  assert.equal(cleared.entry.use_count, 2);
  assert.equal(cleared.entry.terms_db_revision, null);
  assert.equal(cleared.entry.game_version, null);

  // Scenario B: live dictionary returned a new revision with gameVersion: null -> MUST NOT pair new revision with old 3.6.0!
  const newRev = 'e'.repeat(64);
  const newRevOnly = confirmTranslationMemoryEntry(first.entries, {
    sourceText: '共鸣效率提高 10%',
    targetText: 'Energy Regen +10%',
    direction: 'en',
    termsDbRevision: newRev,
    gameVersion: null,
  }, new Date('2026-11-27T02:00:00Z'));
  assert.equal(newRevOnly.status, 'updated');
  assert.equal(newRevOnly.entry.terms_db_revision, newRev);
  assert.equal(newRevOnly.entry.game_version, null);
});
