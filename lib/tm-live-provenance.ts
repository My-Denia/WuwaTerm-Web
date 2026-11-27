// Four-tier live service provenance for translation memory (ADR 0023 / MY-491):
// 1. Browse history & 2. Manual reference apply (`tmDisplayMatchBasis`): may use `lastKnown` game_version ONLY to flag
//    `known_stale` drift on display, and NEVER grants `verified_fresh` without fresh live server dictionary identity.
// 3. Human confirm (`tmConfirmBasis`): records ONLY genuinely fresh live service provenance; when live identity is
//    idle, loading, error, or TTL-expired, BOTH `currentTermsDbRevision` and `currentGameVersion` are `null` (P1-02).
// 4. Auto batch reuse / incremental skip (`tmAutoReuseBasis`): requires fresh live server dictionary identity
//    (`/api/dictionary` when supported, else fresh `/api/meta` + trusted live `/api/reviews`); fails closed otherwise.
import { TM_LIMITS } from './translation-memory.ts';
import {
  DICTIONARY_FRESH_TTL_MS,
  META_FRESH_TTL_MS,
  type DictionaryIdentity,
  type DictionaryView,
  type MetaView,
  type Provenance,
  type RuntimeStore,
} from './runtime-store.ts';
import type { Snapshot } from './workbench-model.ts';

export type TmServiceBasis = {
  currentTermsDbRevision: string | null;
  currentGameVersion: string | null;
};

export type TmLiveProvenanceOptions = {
  now?: number;
  freshTtlMs?: number;
  dictionaryFreshTtlMs?: number;
};

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

/**
 * Sanitizes a raw game version string into a `wuwaterm-tm-v1` compatible value, or `null` when absent/invalid.
 *
 * `source_commit` names the dictionary build, not the game, so it is never substituted. Surrounding whitespace is
 * trimmed; blank, a case-insensitive `"unavailable"` sentinel, any C0/C1 control character, an isolated surrogate,
 * or a value outside the entry field's 1..128 scalar bounds returns `null`.
 */
export function sanitizeGameVersion(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (CONTROL.test(raw) || LONE_SURROGATE.test(raw)) return null;
  const value = raw.trim();
  if (value.length === 0 || value.toLowerCase() === 'unavailable') return null;
  const length = Array.from(value).length;
  return length >= TM_LIMITS.revision.min && length <= TM_LIMITS.revision.max ? value : null;
}

function knownProvenance(meta: MetaView): Provenance | null {
  if (meta.kind === 'success') return meta.data;
  if (meta.kind === 'loading' || meta.kind === 'error') return meta.lastKnown;
  return null;
}

function knownDictionary(dictionary: DictionaryView): DictionaryIdentity | null {
  if (dictionary.kind === 'success') return dictionary.data;
  if (dictionary.kind === 'loading' || dictionary.kind === 'error') return dictionary.lastKnown;
  return null;
}

/**
 * The game version the last confirmed `/api/meta` read reports (including `lastKnown` for display-only drift checks).
 */
export function liveGameVersion(meta: MetaView): string | null {
  const provenance = knownProvenance(meta);
  return provenance ? sanitizeGameVersion(provenance.game_version) : null;
}

/**
 * True only when `/api/dictionary` is in a confirmed `success` state whose `fetchedAt` is still within the freshness TTL.
 */
export function isDictionaryFresh(
  dictionary: DictionaryView,
  options: TmLiveProvenanceOptions = {},
): dictionary is Extract<DictionaryView, { kind: 'success' }> {
  if (dictionary.kind !== 'success') return false;
  if (typeof dictionary.fetchedAt !== 'number' || !Number.isFinite(dictionary.fetchedAt)) return false;
  const now = options.now ?? Date.now();
  const ttlMs = options.dictionaryFreshTtlMs ?? options.freshTtlMs ?? DICTIONARY_FRESH_TTL_MS;
  return now >= dictionary.fetchedAt && now - dictionary.fetchedAt < ttlMs;
}

/**
 * True only when `/api/meta` is in a confirmed `success` state whose `fetchedAt` is still within the freshness TTL.
 */
export function isMetaFresh(
  meta: MetaView,
  options: TmLiveProvenanceOptions = {},
): meta is Extract<MetaView, { kind: 'success' }> {
  if (meta.kind !== 'success') return false;
  if (typeof meta.fetchedAt !== 'number' || !Number.isFinite(meta.fetchedAt)) return false;
  const now = options.now ?? Date.now();
  const ttlMs = options.freshTtlMs ?? META_FRESH_TTL_MS;
  return now >= meta.fetchedAt && now - meta.fetchedAt < ttlMs;
}

/**
 * Legacy fallback dictionary revision from fresh `/api/meta` + trusted live `/api/reviews` matching
 * `(schema_version, source_commit, term_count)`.
 */
export function liveTermsDbRevision(
  meta: MetaView,
  latest: Snapshot | null,
  options: TmLiveProvenanceOptions = {},
): string | null {
  if (!latest?.trusted) return null;
  if (!isMetaFresh(meta, options)) return null;
  const seen = latest.report.dictionary;
  if (typeof seen.revision !== 'string' || seen.revision.length === 0) return null;
  const live = meta.data;
  if (seen.schema_version !== live.schema_version
    || seen.source_commit !== live.source_commit
    || seen.term_count !== live.term_count) {
    return null;
  }
  return seen.revision;
}

/**
 * Legacy display-only helper retained for compatibility with callers that only have `MetaView` + `Snapshot`.
 */
export function tmServiceBasis(
  meta: MetaView,
  latest: Snapshot | null,
  options: TmLiveProvenanceOptions = {},
): TmServiceBasis {
  return {
    currentTermsDbRevision: liveTermsDbRevision(meta, latest, options),
    currentGameVersion: liveGameVersion(meta),
  };
}

/**
 * Tier 1 (Browse history) & Tier 2 (Manual reference apply):
 * - Allows historical / `lastKnown` `game_version` ONLY for detecting `known_stale` drift on display.
 * - NEVER grants `verified_fresh` unless fresh live server dictionary identity holds (`isDictionaryFresh` when
 *   supported, else `isMetaFresh` + trusted live `/api/reviews` matching `(schema_version, source_commit, term_count)`).
 */
export function tmDisplayMatchBasis(
  dictionary: DictionaryView,
  meta: MetaView,
  latest: Snapshot | null,
  options: TmLiveProvenanceOptions = {},
): TmServiceBasis {
  if (dictionary.kind === 'unsupported') {
    return {
      currentTermsDbRevision: liveTermsDbRevision(meta, latest, options),
      currentGameVersion: liveGameVersion(meta),
    };
  }
  if (isDictionaryFresh(dictionary, options)) {
    return {
      currentTermsDbRevision: dictionary.data.revision,
      currentGameVersion: sanitizeGameVersion(dictionary.data.game_version),
    };
  }
  const knownDict = knownDictionary(dictionary);
  return {
    currentTermsDbRevision: null,
    currentGameVersion: sanitizeGameVersion(knownDict?.game_version) ?? liveGameVersion(meta),
  };
}

/**
 * Tier 3 (Human confirm):
 * ONLY records genuinely fresh live service provenance!
 * - When `dictionary` is fresh `success`: uses `{ revision, sanitizeGameVersion(game_version) }`.
 * - On legacy servers (`dictionary.kind === 'unsupported'`): uses fresh `meta` + trusted live `/api/reviews` for
 *   revision and fresh `meta.data.game_version` for game version.
 * - Whenever live identity is `idle`, `loading`, `error`, or TTL-expired: BOTH `currentTermsDbRevision` AND
 *   `currentGameVersion` are `null` — NEVER writes `lastKnown` game_version as freshly confirmed (P1-02).
 */
export function tmConfirmBasis(
  dictionary: DictionaryView,
  meta: MetaView,
  latest: Snapshot | null,
  options: TmLiveProvenanceOptions = {},
): TmServiceBasis {
  if (isDictionaryFresh(dictionary, options)) {
    return {
      currentTermsDbRevision: dictionary.data.revision,
      currentGameVersion: sanitizeGameVersion(dictionary.data.game_version),
    };
  }
  if (dictionary.kind === 'unsupported' && isMetaFresh(meta, options)) {
    return {
      currentTermsDbRevision: liveTermsDbRevision(meta, latest, options),
      currentGameVersion: sanitizeGameVersion(meta.data.game_version),
    };
  }
  return {
    currentTermsDbRevision: null,
    currentGameVersion: null,
  };
}

/**
 * Tier 4 (Auto batch reuse / incremental skip):
 * Requires fresh live server dictionary identity (`isDictionaryFresh` -> `dictionary.data.revision` + fresh
 * `game_version`, or legacy fallback fresh `meta` + trusted live `review-v2`). Fails closed (`null`, `null`) whenever
 * live dictionary identity is unavailable, loading, errored, or expired.
 */
export function tmAutoReuseBasis(
  dictionary: DictionaryView,
  meta: MetaView,
  latest: Snapshot | null,
  options: TmLiveProvenanceOptions = {},
): TmServiceBasis {
  if (isDictionaryFresh(dictionary, options)) {
    return {
      currentTermsDbRevision: dictionary.data.revision,
      currentGameVersion: sanitizeGameVersion(dictionary.data.game_version),
    };
  }
  if (dictionary.kind === 'unsupported' && isMetaFresh(meta, options)) {
    const revision = liveTermsDbRevision(meta, latest, options);
    if (revision !== null) {
      return {
        currentTermsDbRevision: revision,
        currentGameVersion: sanitizeGameVersion(meta.data.game_version),
      };
    }
  }
  return {
    currentTermsDbRevision: null,
    currentGameVersion: null,
  };
}

/**
 * Resolves live dictionary identity from `RuntimeStore` before auto batch reuse.
 * Always forces a fresh verification (`loadDictionary(true)`, and `loadMeta(true)` on legacy servers) so backend
 * dictionary changes inside the 10-minute display TTL are never treated as valid for auto-reusing older TM entries.
 */
export async function resolveTmAutoReuseBasisFromRuntime(
  runtime: Pick<RuntimeStore, 'loadDictionary' | 'loadMeta' | 'getSnapshot'>,
  liveLatest: Snapshot | null,
  options: TmLiveProvenanceOptions = {},
): Promise<TmServiceBasis> {
  await runtime.loadDictionary(true);
  const afterDict = runtime.getSnapshot();
  if (afterDict.dictionary.kind === 'unsupported') {
    await runtime.loadMeta(true);
  }
  const liveSnap = runtime.getSnapshot();
  return tmAutoReuseBasis(liveSnap.dictionary, liveSnap.meta, liveLatest, options);
}
