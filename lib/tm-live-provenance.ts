// The live service basis the in-memory translation memory compares its entries against: the dictionary revision the
// current session's own `/api/reviews` answer was given, and the game version `/api/meta` reports for the running
// service. Kept apart from the review history: an imported `.wuwaterm` manuscript's report is saved evidence from an
// older session, never the running service's current basis.
import { TM_LIMITS } from './translation-memory.ts';
import { META_FRESH_TTL_MS, type MetaView, type Provenance } from './runtime-store.ts';
import type { Snapshot } from './workbench-model.ts';

export type TmServiceBasis = {
  currentTermsDbRevision: string | null;
  currentGameVersion: string | null;
};

export type TmLiveProvenanceOptions = {
  now?: number;
  freshTtlMs?: number;
};

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

/**
 * The service provenance this page has actually confirmed: a successful read, or the last one a later read in flight or
 * failed. A re-read never revives a revision or game version the last confirmed read withdrew, and a failed re-read does
 * not throw away what the running service already reported.
 */
function knownProvenance(meta: MetaView): Provenance | null {
  if (meta.kind === 'success') return meta.data;
  if (meta.kind === 'loading' || meta.kind === 'error') return meta.lastKnown;
  return null;
}

/**
 * The game version the last confirmed `/api/meta` read reports, or null when it cannot be used as a TM basis.
 *
 * `source_commit` names the dictionary build, not the game, so it is never substituted. Surrounding whitespace is
 * trimmed and the trimmed value is what a TM entry records and compares; blank, a case-insensitive `"unavailable"`
 * sentinel, any C0/C1 control character, an isolated surrogate, or a value outside the entry field's 1..128 scalar
 * bounds is "not reported". The result always fits a `wuwaterm-tm-v1` revision field, so writing or matching an entry
 * cannot fail on it.
 */
export function liveGameVersion(meta: MetaView): string | null {
  const provenance = knownProvenance(meta);
  if (!provenance) return null;
  const raw = provenance.game_version;
  if (typeof raw !== 'string') return null;
  if (CONTROL.test(raw) || LONE_SURROGATE.test(raw)) return null;
  const value = raw.trim();
  if (value.length === 0 || value.toLowerCase() === 'unavailable') return null;
  const length = Array.from(value).length;
  return length >= TM_LIMITS.revision.min && length <= TM_LIMITS.revision.max ? value : null;
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
 * The dictionary revision a TM entry confirmed now may record, or null when no fresh live service basis exists.
 *
 * `latest.trusted` is true only for a report this session received from `/api/reviews` and validated; reports restored
 * from an imported manuscript are untrusted and keep their saved revision for display only. Only a fresh (`success`
 * within `META_FRESH_TTL_MS`) `/api/meta` read that agrees on `(schema_version, source_commit, term_count)` grants a
 * live revision; `idle`, `loading`, `error` (even with `lastKnown`), or expired `success` all return `null` so a stale
 * or failed metadata state never confers `verified_fresh` or revives a withdrawn revision.
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
