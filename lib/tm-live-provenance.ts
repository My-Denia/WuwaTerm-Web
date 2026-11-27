// The live service basis the in-memory translation memory compares its entries against: the dictionary revision the
// current session's own `/api/reviews` answer was given, and the game version `/api/meta` reports for the running
// service. Kept apart from the review history: an imported `.wuwaterm` manuscript's report is saved evidence from an
// older session, never the running service's current basis.
import { TM_LIMITS } from './translation-memory.ts';
import type { MetaView } from './runtime-store.ts';
import type { Snapshot } from './workbench-model.ts';

export type TmServiceBasis = {
  currentTermsDbRevision: string | null;
  currentGameVersion: string | null;
};

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

/**
 * The game version `/api/meta` reports for the running service, or null when it cannot be used as a TM basis.
 *
 * Only a successful read with its own `game_version` counts: `source_commit` names the dictionary build, not the game,
 * so it is never substituted. `"unavailable"` (and any other value outside the entry field's bounds) is "not reported".
 */
export function liveGameVersion(meta: MetaView): string | null {
  if (meta.kind !== 'success') return null;
  const value = meta.data.game_version;
  if (typeof value !== 'string' || value === 'unavailable') return null;
  if (value.includes('\u0000') || LONE_SURROGATE.test(value)) return null;
  const length = Array.from(value).length;
  return length >= TM_LIMITS.revision.min && length <= TM_LIMITS.revision.max ? value : null;
}

/**
 * The dictionary revision a TM entry confirmed now may record, or null when no live service basis exists.
 *
 * `latest.trusted` is true only for a report this session received from `/api/reviews` and validated; reports restored
 * from an imported manuscript are untrusted and keep their saved revision for display only. A live report still only
 * describes the running service while `/api/meta` agrees on the dictionary identity drawn from the same snapshot:
 * `schema_version`, `source_commit` and `term_count`. A disagreement means the service's dictionary changed under the
 * review, so its revision is no current basis and TM freshness falls back to `provenance_unknown` (or `known_stale`
 * through the live game version). A failed or not-yet-read `/api/meta` does not disprove the live review; it only
 * leaves the game version unknown, which degrades freshness on its own.
 */
export function liveTermsDbRevision(meta: MetaView, latest: Snapshot | null): string | null {
  if (!latest?.trusted) return null;
  const seen = latest.report.dictionary;
  if (typeof seen.revision !== 'string' || seen.revision.length === 0) return null;
  if (meta.kind === 'success') {
    const live = meta.data;
    if (seen.schema_version !== live.schema_version
      || seen.source_commit !== live.source_commit
      || seen.term_count !== live.term_count) {
      return null;
    }
  }
  return seen.revision;
}

export function tmServiceBasis(meta: MetaView, latest: Snapshot | null): TmServiceBasis {
  return {
    currentTermsDbRevision: liveTermsDbRevision(meta, latest),
    currentGameVersion: liveGameVersion(meta),
  };
}
