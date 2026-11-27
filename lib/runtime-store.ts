// The page's one source of runtime data: the pool snapshot, the negotiated capabilities, the authoritative dictionary
// identity (`/api/dictionary`), and the dictionary provenance (`/api/meta`).
// Every view and the document controller read it here, so a page load asks for each at most once. React-free, so the
// request accounting is testable without a browser; lib/runtime-provider.tsx binds it to the page.
import { isPool, type Pool } from './pool-snapshot.ts';
import { CAPABILITY_DICTIONARY_IDENTITY } from './semantic-review.js';
import { workbenchPath } from './ui-runtime.ts';

export type PoolView = { kind: 'off' } | { kind: 'loading' } | { kind: 'success'; data: Pool } | { kind: 'error' };

export type Provenance = {
  schema_version: string | null;
  source_commit: string | null;
  game_version: string | null;
  resource_version: string | null;
  changelist: string | null;
  term_count: number;
  request_id: string;
};

export type DictionaryIdentity = {
  revision: string;
  schema_version: string | null;
  source_commit: string | null;
  game_version: string | null;
  term_count: number;
  request_id: string;
};

export const META_FRESH_TTL_MS = 10 * 60 * 1000;
export const META_ERROR_RETRY_COOLDOWN_MS = 30 * 1000;
export const DICTIONARY_FRESH_TTL_MS = 10 * 60 * 1000;
/** Fixed 30s cooldown after a failed `/api/dictionary` read before a non-forced refresh retries. */
export const DICTIONARY_ERROR_RETRY_COOLDOWN_MS = 30 * 1000;

export type MetaView =
  | { kind: 'idle' }
  // A re-read keeps the last successful provenance so a reader displaying historical TM matches can keep detecting
  // game-version drift without conferring `verified_fresh` or stamping `lastKnown` on new confirmations.
  | { kind: 'loading'; lastKnown: Provenance | null }
  | { kind: 'success'; data: Provenance; fetchedAt: number }
  | { kind: 'error'; lastKnown: Provenance | null; failedAt: number };

export type DictionaryView =
  | { kind: 'idle' }
  | { kind: 'loading'; lastKnown: DictionaryIdentity | null }
  | { kind: 'success'; data: DictionaryIdentity; fetchedAt: number }
  | { kind: 'unsupported' }
  | { kind: 'error'; lastKnown: DictionaryIdentity | null; failedAt: number };

export type RuntimeSnapshot = {
  pool: PoolView;
  /** null until the first read finishes; [] when it failed. */
  capabilities: string[] | null;
  meta: MetaView;
  dictionary: DictionaryView;
};

export type RuntimeFetch = (path: string, init: RequestInit) => Promise<Response>;

const PROVENANCE_KEYS = [
  'changelist', 'game_version', 'request_id', 'resource_version',
  'schema_version', 'source_commit', 'term_count',
];
const DICTIONARY_KEYS = [
  'game_version', 'request_id', 'revision', 'schema_version', 'source_commit', 'term_count',
];
const HEX64 = /^[0-9a-f]{64}$/u;

function nullable(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length > 0 && value.length <= 256);
}

export function isProvenance(value: unknown): value is Provenance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join('\u0000') !== [...PROVENANCE_KEYS].sort().join('\u0000')) return false;
  return nullable(record.schema_version)
    && nullable(record.source_commit)
    && nullable(record.game_version)
    && nullable(record.resource_version)
    && nullable(record.changelist)
    && Number.isInteger(record.term_count)
    && (record.term_count as number) >= 0
    && typeof record.request_id === 'string'
    && record.request_id.length > 0;
}

export function isDictionaryIdentity(value: unknown): value is DictionaryIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join('\u0000') !== [...DICTIONARY_KEYS].sort().join('\u0000')) return false;
  return typeof record.revision === 'string'
    && HEX64.test(record.revision)
    && nullable(record.schema_version)
    && nullable(record.source_commit)
    && nullable(record.game_version)
    && Number.isInteger(record.term_count)
    && (record.term_count as number) >= 0
    && typeof record.request_id === 'string'
    && record.request_id.length > 0;
}

async function json(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return null; }
}

export type RuntimeStoreOptions = {
  fetch?: RuntimeFetch;
  /** Whether this page reads the pool at all (the public limits page shows the published ceilings instead). */
  pool?: boolean;
  now?: () => number;
  metaFreshTtlMs?: number;
  metaErrorRetryCooldownMs?: number;
  dictionaryFreshTtlMs?: number;
  dictionaryErrorRetryCooldownMs?: number;
};

export class RuntimeStore {
  private readonly fetcher: RuntimeFetch;
  private readonly poolEnabled: boolean;
  private readonly now: () => number;
  private readonly metaFreshTtlMs: number;
  private readonly metaErrorRetryCooldownMs: number;
  private readonly dictionaryFreshTtlMs: number;
  private readonly dictionaryErrorRetryCooldownMs: number;
  private state: RuntimeSnapshot;
  private readonly listeners = new Set<() => void>();
  private started = false;
  private poolAbort: AbortController | null = null;
  private capabilitiesPromise: Promise<string[]> | null = null;
  private capabilitiesEpoch = 0;
  private capabilitiesLoaded = false;
  private capabilitiesFailedAt: number | null = null;
  private metaPromise: Promise<void> | null = null;
  private metaEpoch = 0;
  private dictionaryPromise: Promise<void> | null = null;
  private dictionaryEpoch = 0;

  constructor(options: RuntimeStoreOptions = {}) {
    this.fetcher = options.fetch ?? ((path, init) => fetch(workbenchPath(path), init));
    this.poolEnabled = options.pool ?? true;
    this.now = options.now ?? (() => Date.now());
    this.metaFreshTtlMs = options.metaFreshTtlMs ?? META_FRESH_TTL_MS;
    this.metaErrorRetryCooldownMs = options.metaErrorRetryCooldownMs ?? META_ERROR_RETRY_COOLDOWN_MS;
    this.dictionaryFreshTtlMs = options.dictionaryFreshTtlMs ?? DICTIONARY_FRESH_TTL_MS;
    this.dictionaryErrorRetryCooldownMs = options.dictionaryErrorRetryCooldownMs ?? DICTIONARY_ERROR_RETRY_COOLDOWN_MS;
    this.state = {
      pool: this.poolEnabled ? { kind: 'loading' } : { kind: 'off' },
      capabilities: null,
      meta: { kind: 'idle' },
      dictionary: { kind: 'idle' },
    };
  }

  readonly getSnapshot = (): RuntimeSnapshot => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private set(patch: Partial<RuntimeSnapshot>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Idempotent: the first call reads the pool; a second mount of the same page (React StrictMode) asks for nothing. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.refreshPool();
  }

  /** Read the pool again; a newer read replaces one still in flight. The last good snapshot stays visible meanwhile. */
  refreshPool(): void {
    if (!this.poolEnabled) return;
    this.poolAbort?.abort();
    const abort = new AbortController();
    this.poolAbort = abort;
    void (async () => {
      try {
        const response = await this.fetcher('/api/pool', { cache: 'no-store', signal: abort.signal });
        const value = await json(response);
        if (abort.signal.aborted) return;
        this.set({ pool: response.ok && isPool(value) ? { kind: 'success', data: value } : { kind: 'error' } });
      } catch {
        if (!abort.signal.aborted) this.set({ pool: { kind: 'error' } });
      } finally {
        if (this.poolAbort === abort) this.poolAbort = null;
      }
    })();
  }

  /**
   * The negotiated capabilities, read once per page on HTTP 200 and shared by every caller.
   * Transient errors (5xx / network failure) do NOT freeze capabilities forever: callers may retry after the
   * error cooldown or immediately with `force = true`.
   */
  capabilities(force = false): Promise<string[]> {
    if (this.capabilitiesLoaded) return Promise.resolve(this.state.capabilities ?? []);
    if (!force && this.capabilitiesPromise) return this.capabilitiesPromise;
    const now = this.now();
    if (!force && this.capabilitiesFailedAt !== null
      && now >= this.capabilitiesFailedAt
      && now - this.capabilitiesFailedAt < this.dictionaryErrorRetryCooldownMs) {
      return Promise.resolve([]);
    }
    const epoch = ++this.capabilitiesEpoch;
    const promise = (async () => {
      let list: string[] = [];
      let succeeded = false;
      try {
        const response = await this.fetcher('/api/capabilities', { cache: 'no-store' });
        const value = await json(response) as { capabilities?: unknown } | null;
        if (response.ok && Array.isArray(value?.capabilities)) {
          list = value.capabilities.filter((x): x is string => typeof x === 'string');
          succeeded = true;
        }
      } catch {
        list = [];
      }
      if (this.capabilitiesEpoch !== epoch) {
        return this.state.capabilities ?? list;
      }
      if (succeeded) {
        this.capabilitiesLoaded = true;
        this.capabilitiesFailedAt = null;
      } else {
        this.capabilitiesFailedAt = this.now();
      }
      this.set({ capabilities: list });
      return list;
    })();
    this.capabilitiesPromise = promise;
    void promise.finally(() => {
      if (this.capabilitiesPromise === promise) this.capabilitiesPromise = null;
    });
    return promise;
  }

  /**
   * Authoritative server dictionary identity (`GET /api/dictionary`, capability `dictionary-identity-v1`):
   * - checks `capabilities()` first; distinguishes a transient `/api/capabilities` error (`error`, retryable)
   *   from a verified HTTP 200 capability list lacking `dictionary-identity-v1` (`unsupported`);
   * - non-forced in-flight reads are shared by joining the existing promise;
   * - `success` is reused within `dictionaryFreshTtlMs` and refreshed once expired;
   * - `error` respects the fixed 30s `dictionaryErrorRetryCooldownMs` and retries once elapsed;
   * - `force = true` never reuses a non-forced in-flight promise, appends `?refresh=1` to bypass the BFF proxy
   *   cache, and prevents stale out-of-order responses from overwriting newer state.
   */
  loadDictionary(force = false): Promise<void> {
    if (!force && this.dictionaryPromise) return this.dictionaryPromise;
    const current = this.state.dictionary;
    const now = this.now();
    if (!force) {
      if (current.kind === 'unsupported') {
        return Promise.resolve();
      }
      if (current.kind === 'success' && now >= current.fetchedAt && now - current.fetchedAt < this.dictionaryFreshTtlMs) {
        return Promise.resolve();
      }
      if (current.kind === 'error' && now >= current.failedAt && now - current.failedAt < this.dictionaryErrorRetryCooldownMs) {
        return Promise.resolve();
      }
    }
    const epoch = ++this.dictionaryEpoch;
    const promise = (async () => {
      try {
        const caps = await this.capabilities(force);
        if (this.dictionaryEpoch !== epoch) return;
        if (!this.capabilitiesLoaded) {
          const lastKnown = this.lastKnownDictionary();
          this.set({ dictionary: { kind: 'error', lastKnown, failedAt: this.now() } });
          return;
        }
        if (!caps.includes(CAPABILITY_DICTIONARY_IDENTITY)) {
          this.set({ dictionary: { kind: 'unsupported' } });
          return;
        }
        const lastKnown = this.lastKnownDictionary();
        this.set({ dictionary: { kind: 'loading', lastKnown } });
        const response = await this.fetcher(
          force ? '/api/dictionary?refresh=1' : '/api/dictionary',
          { cache: 'no-store' },
        );
        const value = await json(response);
        if (this.dictionaryEpoch !== epoch) return;
        const at = this.now();
        if (response.ok && isDictionaryIdentity(value)) {
          this.set({ dictionary: { kind: 'success', data: value, fetchedAt: at } });
        } else if (
          response.status === 503
          && value && typeof value === 'object' && !Array.isArray(value)
          && (value as { reason?: unknown }).reason === 'dictionary_identity_unavailable'
        ) {
          this.set({ dictionary: { kind: 'unsupported' } });
        } else {
          this.set({ dictionary: { kind: 'error', lastKnown, failedAt: at } });
        }
      } catch {
        if (this.dictionaryEpoch !== epoch) return;
        const lastKnown = this.lastKnownDictionary();
        this.set({ dictionary: { kind: 'error', lastKnown, failedAt: this.now() } });
      } finally {
        if (this.dictionaryEpoch === epoch) this.dictionaryPromise = null;
      }
    })();
    this.dictionaryPromise = promise;
    return promise;
  }

  /**
   * The dictionary provenance. Each read counts against the dictionary-info quota, so it is read only on request:
   * - non-forced in-flight reads are shared by joining the existing promise;
   * - `success` is reused within `metaFreshTtlMs` and refreshed once expired;
   * - `error` respects `metaErrorRetryCooldownMs` and retries automatically once the cooldown elapses;
   * - `force = true` never reuses a non-forced in-flight promise, appends `?refresh=1`, and prevents stale
   *   out-of-order responses from overwriting newer state.
   */
  loadMeta(force = false): Promise<void> {
    if (!force && this.metaPromise) return this.metaPromise;
    const current = this.state.meta;
    const now = this.now();
    if (!force) {
      if (current.kind === 'success' && now >= current.fetchedAt && now - current.fetchedAt < this.metaFreshTtlMs) {
        return Promise.resolve();
      }
      if (current.kind === 'error' && now >= current.failedAt && now - current.failedAt < this.metaErrorRetryCooldownMs) {
        return Promise.resolve();
      }
    }
    const epoch = ++this.metaEpoch;
    const lastKnown = this.lastKnownMeta();
    this.set({ meta: { kind: 'loading', lastKnown } });
    const promise = (async () => {
      try {
        const response = await this.fetcher(
          force ? '/api/meta?refresh=1' : '/api/meta',
          { cache: 'no-store' },
        );
        const value = await json(response);
        if (this.metaEpoch !== epoch) return;
        const at = this.now();
        this.set({
          meta: response.ok && isProvenance(value)
            ? { kind: 'success', data: value, fetchedAt: at }
            : { kind: 'error', lastKnown, failedAt: at },
        });
      } catch {
        if (this.metaEpoch !== epoch) return;
        this.set({ meta: { kind: 'error', lastKnown, failedAt: this.now() } });
      } finally {
        if (this.metaEpoch === epoch) this.metaPromise = null;
      }
    })();
    this.metaPromise = promise;
    return promise;
  }

  /** The latest confirmed dictionary identity of this page load, if any. */
  private lastKnownDictionary(): DictionaryIdentity | null {
    const dictionary = this.state.dictionary;
    if (dictionary.kind === 'success') return dictionary.data;
    if (dictionary.kind === 'loading' || dictionary.kind === 'error') return dictionary.lastKnown;
    return null;
  }

  /** The latest confirmed provenance of this page load, if any; a read in flight or a failed re-read does not erase it. */
  private lastKnownMeta(): Provenance | null {
    const meta = this.state.meta;
    if (meta.kind === 'success') return meta.data;
    if (meta.kind === 'loading' || meta.kind === 'error') return meta.lastKnown;
    return null;
  }
}
