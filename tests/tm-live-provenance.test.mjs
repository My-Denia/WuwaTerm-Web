// Live service provenance for the page translation memory (MY-491): which dictionary revision and game version the
// running service reports, and why an imported manuscript's saved review can never stand in for either.
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
import { liveGameVersion, liveTermsDbRevision, tmServiceBasis } from '../lib/tm-live-provenance.ts';
import { RuntimeStore } from '../lib/runtime-store.ts';

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

const success = (over = {}) => ({ kind: 'success', data: { ...META, ...over } });
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
  assert.equal(liveGameVersion({ kind: 'error', lastKnown: null }), null);
  // A re-read in flight or failed keeps what the last confirmed read reported.
  assert.equal(liveGameVersion({ kind: 'loading', lastKnown: META }), '3.7.0');
  assert.equal(liveGameVersion({ kind: 'error', lastKnown: META }), '3.7.0');

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

test('only a live review supplies the current dictionary revision, and a disagreeing /api/meta withdraws it', () => {
  const rev = liveTermsDbRevision;
  assert.equal(rev({ kind: 'idle' }, null), null, 'no review yet');
  assert.equal(rev(success(), importedSnapshot()), null, 'an imported manuscript report is saved history, not the live service');
  assert.equal(rev({ kind: 'idle' }, liveSnapshot()), REVISION, 'a live review is its own evidence until /api/meta says otherwise');
  assert.equal(rev({ kind: 'error', lastKnown: null }, liveSnapshot()), REVISION, 'a page that confirmed no read does not disprove the live review');
  assert.equal(rev({ kind: 'loading', lastKnown: META }, liveSnapshot()), REVISION, 'a re-read in flight keeps the confirmed match');
  assert.equal(
    rev({ kind: 'error', lastKnown: META }, liveSnapshot({ source_commit: 'commit-old' })),
    null,
    'a confirmed read that withdrew the revision keeps it withdrawn when a re-read fails',
  );
  assert.equal(rev(success(), liveSnapshot()), REVISION);

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

test('a dictionary change under the saved review reads as provenance_unknown, while the live game version still names the game change', () => {
  const meta = success();
  const saved = liveSnapshot({ source_commit: 'commit-old' });
  assert.deepEqual(tmServiceBasis(meta, saved), { currentTermsDbRevision: null, currentGameVersion: '3.7.0' });

  const basis = tmServiceBasis(meta, saved);
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

test('a re-read in flight or failed keeps the confirmed service identity, so a withdrawn revision never comes back', async () => {
  let status = 'ok';
  const fetcher = async (path) => {
    assert.equal(path, '/api/meta');
    return status === 'ok'
      ? new Response(JSON.stringify(META), { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response('upstream-unavailable', { status: 502 });
  };
  const store = new RuntimeStore({ fetch: fetcher, pool: false });
  const saved = liveSnapshot({ source_commit: 'commit-old' });
  await store.loadMeta();
  assert.equal(store.getSnapshot().meta.kind, 'success');
  assert.deepEqual(tmServiceBasis(store.getSnapshot().meta, saved), {
    currentTermsDbRevision: null,
    currentGameVersion: '3.7.0',
  });

  status = 'fail';
  const reread = store.loadMeta(true);
  assert.equal(store.getSnapshot().meta.kind, 'loading');
  assert.deepEqual(tmServiceBasis(store.getSnapshot().meta, saved), {
    currentTermsDbRevision: null,
    currentGameVersion: '3.7.0',
  });
  await reread;
  assert.equal(store.getSnapshot().meta.kind, 'error');
  assert.deepEqual(tmServiceBasis(store.getSnapshot().meta, saved), {
    currentTermsDbRevision: null,
    currentGameVersion: '3.7.0',
  });

  // A successful re-read that still reports another dictionary keeps it withdrawn as well.
  status = 'ok';
  await store.loadMeta(true);
  assert.equal(store.getSnapshot().meta.kind, 'success');
  assert.equal(tmServiceBasis(store.getSnapshot().meta, saved).currentTermsDbRevision, null);
});

test('confirming against a live review and a matching /api/meta writes the real basis and reads back verified_fresh', () => {
  const basis = tmServiceBasis(success(), liveSnapshot());
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

  const nextGame = tmServiceBasis(success({ game_version: '3.8.0' }), liveSnapshot());
  const stale = matchTranslationMemory([outcome.entry], '共鸣效率提高 10%', 'en', nextGame)[0];
  assert.equal(stale.freshness, TM_FRESHNESS_STALE);
  assert.deepEqual(stale.staleReasons, [TM_STALE_GAME_VERSION]);
  assert.equal(stale.needsRecheck, true);
});
