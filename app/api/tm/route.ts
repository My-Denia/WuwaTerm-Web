import {
  MAX_TM_BYTES,
  TM_FORMAT,
  TM_SCHEMA_VERSION,
  TranslationMemoryError,
  confirmTranslationMemoryEntry,
  mergeTranslationMemoryEntries,
  serializeTranslationMemory,
  tmNow,
  validateTranslationMemory,
  type TmConfirmCandidate,
  type TmConfirmResult,
  type TmEntry,
} from '../../../lib/translation-memory.ts';
import { runtimeEnvironment } from '../../../lib/wuwaterm-proxy.js';

export const dynamic = 'force-dynamic';

const JSON_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
  'x-robots-tag': 'noindex, nofollow, noarchive',
});

// Allow small JSON envelope overhead above the 8 MiB `wuwaterm-tm-v1` document cap.
const MAX_TM_REQUEST_BYTES = MAX_TM_BYTES + 16_384;

type TmStoreAdapter = {
  getVersion?: () => string;
  getSnapshot?: () => { entries: TmEntry[]; storageVersion: string };
  listEntries: () => TmEntry[];
  replaceEntries: (entries: TmEntry[]) => TmEntry[];
  runAtomic: <T>(
    transform: (current: TmEntry[], currentVersion: string) => { write: boolean; entries?: TmEntry[]; result: T },
  ) => T & { entries?: TmEntry[]; storageVersion?: string };
  deleteEntry: (identity: {
    direction: string;
    source_text: string;
    target_text: string;
    prev_source_hash: string | null;
    next_source_hash: string | null;
  }) => { deleted: boolean; entries: TmEntry[]; storageVersion?: string };
  clearEntries: () => TmEntry[] | { entries: TmEntry[]; storageVersion: string };
};

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function strictJsonContentType(value: string): boolean {
  return value.split(';', 1)[0]!.trim().toLowerCase() === 'application/json';
}

function resolveSelfhostStore(env: Record<string, unknown>): { mode: 'public' } | { mode: 'unavailable' } | { mode: 'selfhost'; store: TmStoreAdapter } {
  if (env.WUWATERM_RUNTIME_MODE !== 'selfhost') return { mode: 'public' };
  const store = env.TM_DB as TmStoreAdapter | undefined;
  if (!store || typeof store.listEntries !== 'function' || typeof store.runAtomic !== 'function') {
    return { mode: 'unavailable' };
  }
  return { mode: 'selfhost', store };
}

async function readBoundedText(request: Request, limit: number): Promise<{ ok: true; text: string } | { ok: false; status: number; reason: string }> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > limit) {
      return { ok: false, status: 413, reason: 'tm_too_large' };
    }
  }
  if (!request.body) return { ok: true, text: '' };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        try { void reader.cancel(); } catch { /* ignore */ }
        return { ok: false, status: 413, reason: 'tm_too_large' };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400, reason: 'site_invalid_request' };
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false, status: 400, reason: 'tm_not_json' };
  }
}

function validateFilePayload(payload: unknown): TmEntry[] {
  const normalized = payload && typeof payload === 'object' && !Array.isArray(payload) && Object.hasOwn(payload, 'format')
    ? payload
    : {
        format: TM_FORMAT,
        schema_version: TM_SCHEMA_VERSION,
        exported_at: tmNow(),
        entries: payload,
      };
  const clean = validateTranslationMemory(normalized);
  serializeTranslationMemory(clean);
  return clean.entries;
}

export async function GET(): Promise<Response> {
  const env = await runtimeEnvironment();
  const resolved = resolveSelfhostStore(env);
  if (resolved.mode === 'public') {
    return jsonResponse(404, { status: 'unavailable', mode: 'memory_only' });
  }
  if (resolved.mode === 'unavailable') {
    return jsonResponse(503, { status: 'unavailable', reason: 'tm_store_unavailable' });
  }
  try {
    const snap = typeof resolved.store.getSnapshot === 'function'
      ? resolved.store.getSnapshot()
      : { entries: resolved.store.listEntries(), storageVersion: resolved.store.getVersion?.() ?? '0' };
    return jsonResponse(200, {
      mode: 'selfhost_sqlite',
      entries: snap.entries,
      storageVersion: snap.storageVersion,
    });
  } catch {
    return jsonResponse(503, { status: 'unavailable', reason: 'tm_store_unavailable' });
  }
}

export async function POST(request: Request): Promise<Response> {
  const env = await runtimeEnvironment();
  const resolved = resolveSelfhostStore(env);
  if (resolved.mode === 'public') {
    return jsonResponse(404, { status: 'unavailable', mode: 'memory_only' });
  }
  if (resolved.mode === 'unavailable') {
    return jsonResponse(503, { status: 'unavailable', reason: 'tm_store_unavailable' });
  }
  if (!strictJsonContentType(request.headers.get('content-type') ?? '')) {
    return jsonResponse(400, { status: 'unavailable', reason: 'site_invalid_request' });
  }
  const raw = await readBoundedText(request, MAX_TM_REQUEST_BYTES);
  if (!raw.ok) {
    return jsonResponse(raw.status, { status: 'invalid', code: raw.reason });
  }
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw.text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return jsonResponse(400, { status: 'unavailable', reason: 'site_invalid_request' });
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return jsonResponse(400, { status: 'invalid', code: 'tm_not_json' });
  }

  const action = body.action;
  try {
    if (action === 'confirm') {
      const candidate = body.candidate;
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        return jsonResponse(400, { status: 'unavailable', reason: 'site_invalid_request' });
      }
      const c = candidate as Record<string, unknown>;
      if (typeof c.sourceText !== 'string' || typeof c.targetText !== 'string' || (c.direction !== 'en' && c.direction !== 'zh')) {
        return jsonResponse(400, { status: 'invalid', error: 'field_invalid' });
      }
      const confirmInput: TmConfirmCandidate = {
        sourceText: c.sourceText,
        targetText: c.targetText,
        direction: c.direction,
        prevSource: typeof c.prevSource === 'string' || c.prevSource === null ? c.prevSource : null,
        nextSource: typeof c.nextSource === 'string' || c.nextSource === null ? c.nextSource : null,
        ...(c.origin !== undefined ? { origin: String(c.origin) } : {}),
        termsDbRevision: typeof c.termsDbRevision === 'string' || c.termsDbRevision === null ? c.termsDbRevision : null,
        gameVersion: typeof c.gameVersion === 'string' || c.gameVersion === null ? c.gameVersion : null,
        ...(typeof c.note === 'string' ? { note: c.note } : {}),
      };
      const result = resolved.store.runAtomic<TmConfirmResult>(current => {
        const outcome = confirmTranslationMemoryEntry(current, confirmInput);
        if (outcome.status === 'invalid') {
          return { write: false, result: outcome };
        }
        return {
          write: true,
          entries: outcome.entries,
          result: outcome,
        };
      });
      if (result.status === 'invalid') {
        const status = result.error === 'list_too_large' ? 413 : 400;
        return jsonResponse(status, { mode: 'selfhost_sqlite', ...result });
      }
      return jsonResponse(200, {
        mode: 'selfhost_sqlite',
        status: result.status,
        entry: result.entry,
        entries: result.entries,
        storageVersion: result.storageVersion ?? '0',
      });
    }

    if (action === 'replace') {
      const validated = validateFilePayload(body.file ?? body.entries);
      const forceReplace = body.forceReplace === true;
      const expectedVersion = typeof body.expectedVersion === 'string' ? body.expectedVersion : null;
      const outcome = resolved.store.runAtomic<{ conflict: boolean; entries: TmEntry[] }>((current, currentVersion) => {
        const currentVersionNum = Number(currentVersion);
        const versionRequired = !Number.isFinite(currentVersionNum) || currentVersionNum > 0;
        const versionMissing = versionRequired && expectedVersion === null;
        const versionMismatch = expectedVersion !== null && expectedVersion !== currentVersion;
        const unconfirmedOverwrite = !forceReplace && current.length > 0;
        if (versionMissing || versionMismatch || unconfirmedOverwrite) {
          return { write: false, result: { conflict: true, entries: current } };
        }
        return { write: true, entries: validated, result: { conflict: false, entries: validated } };
      });
      if (outcome.conflict) {
        return jsonResponse(409, {
          status: 'conflict',
          code: 'tm_storage_conflict',
          mode: 'selfhost_sqlite',
          entries: outcome.entries,
          storageVersion: outcome.storageVersion ?? '0',
        });
      }
      return jsonResponse(200, {
        mode: 'selfhost_sqlite',
        entries: outcome.entries,
        storageVersion: outcome.storageVersion ?? '0',
      });
    }

    if (action === 'merge') {
      const incoming = validateFilePayload(body.file ?? body.entries);
      const result = resolved.store.runAtomic(current => {
        const merged = mergeTranslationMemoryEntries(current, incoming);
        return { write: true, entries: merged, result: { merged: incoming.length } };
      });
      return jsonResponse(200, {
        mode: 'selfhost_sqlite',
        entries: result.entries,
        storageVersion: result.storageVersion ?? '0',
      });
    }

    if (action === 'delete') {
      const entry = body.entry;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return jsonResponse(400, { status: 'unavailable', reason: 'site_invalid_request' });
      }
      const e = entry as Record<string, unknown>;
      if ((e.direction !== 'en' && e.direction !== 'zh')
        || typeof e.source_text !== 'string'
        || typeof e.target_text !== 'string'
        || (e.prev_source_hash !== null && typeof e.prev_source_hash !== 'string')
        || (e.next_source_hash !== null && typeof e.next_source_hash !== 'string')) {
        return jsonResponse(400, { status: 'unavailable', reason: 'site_invalid_request' });
      }
      const outcome = resolved.store.deleteEntry({
        direction: e.direction,
        source_text: e.source_text,
        target_text: e.target_text,
        prev_source_hash: e.prev_source_hash,
        next_source_hash: e.next_source_hash,
      });
      return jsonResponse(200, {
        mode: 'selfhost_sqlite',
        deleted: outcome.deleted,
        entries: outcome.entries,
        storageVersion: outcome.storageVersion ?? '0',
      });
    }

    if (action === 'clear') {
      const cleared = resolved.store.clearEntries();
      const entries = Array.isArray(cleared) ? cleared : cleared.entries;
      const storageVersion = Array.isArray(cleared) ? (resolved.store.getVersion?.() ?? '0') : cleared.storageVersion;
      return jsonResponse(200, { mode: 'selfhost_sqlite', entries, storageVersion });
    }

    return jsonResponse(400, { status: 'unavailable', reason: 'site_invalid_request' });
  } catch (error) {
    if (error instanceof TranslationMemoryError) {
      const status = error.code === 'tm_too_large' ? 413 : 400;
      return jsonResponse(status, { status: 'invalid', code: error.code, detail: error.detail });
    }
    return jsonResponse(503, { status: 'unavailable', reason: 'tm_store_unavailable' });
  }
}
