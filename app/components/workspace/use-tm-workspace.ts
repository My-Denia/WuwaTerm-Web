'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRuntime, useRuntimeStore } from '../../../lib/runtime-provider';
import { DICTIONARY_FRESH_TTL_MS, META_FRESH_TTL_MS } from '../../../lib/runtime-store';
import {
  isDictionaryFresh,
  isMetaFresh,
  sanitizeGameVersion,
  tmConfirmBasis,
  tmDisplayMatchBasis,
} from '../../../lib/tm-live-provenance';
import { describeTmSegmentAlignment, resolveActiveSegment, type TmSegmentCursor } from '../../../lib/tm-segment';
import {
  TranslationMemoryError,
  type TmConfirmCandidate,
  type TmConfirmResult,
  type TmEntry,
  type TmErrorCode,
  type TmFile,
} from '../../../lib/translation-memory';
import { workbenchPath } from '../../../lib/ui-runtime';
import type { WorkbenchController } from '../../../lib/workbench-controller';
import type { Alignment, Snapshot } from '../../../lib/workbench-model';
import type { TmDictionaryStatusView, TmPersistenceAdapter } from '../my-memory';

export function useTmWorkspace(options: {
  doc: WorkbenchController;
  source: string;
  target: string;
  alignments: Alignment[] | null;
  resetSignal: number;
  latest: Snapshot | null;
  selfHosted: boolean;
  onFocusTarget: () => void;
}) {
  const { doc, source, target, alignments, resetSignal, latest, selfHosted, onFocusTarget } = options;
  const runtime = useRuntimeStore();
  const { meta, dictionary } = useRuntime();

  const [tmEntries, setTmEntries] = useState<TmEntry[]>([]);
  const [tmStorageState, setTmStorageState] = useState<'idle' | 'loading' | 'ready' | 'error'>(selfHosted ? 'loading' : 'ready');
  const tmStorageVersionRef = useRef<string | null>(null);
  const [tmOpen, setTmOpen] = useState(false);
  const [tmCursor, setTmCursor] = useState<TmSegmentCursor | null>(null);
  const [, setTmTtlVersion] = useState(0);
  const [tmResetSeen, setTmResetSeen] = useState(resetSignal);

  if (tmResetSeen !== resetSignal) {
    setTmResetSeen(resetSignal);
    setTmCursor(null);
  }

  const activeTmSegment = useMemo(
    () => resolveActiveSegment(source, target, tmCursor, alignments),
    [source, target, tmCursor, alignments],
  );
  const tmAlignmentStatus = useMemo(
    () => describeTmSegmentAlignment(source, target, activeTmSegment, alignments),
    [source, target, activeTmSegment, alignments],
  );

  // Self-hosted instances load persisted confirmed TM entries from private `/api/tm` on mount;
  // public Cloudflare Web stays strictly in React page memory and never calls `/api/tm`.
  useEffect(() => {
    doc.setTmEntries(tmEntries);
  }, [doc, tmEntries]);

  const loadSelfhostTm = useCallback(async () => {
    if (!selfHosted) return;
    setTmStorageState('loading');
    try {
      const response = await fetch(workbenchPath('/api/tm'), { cache: 'no-store' });
      if (!response.ok) {
        setTmStorageState('error');
        return;
      }
      const value = await response.json() as { entries?: unknown; storageVersion?: unknown };
      if (Array.isArray(value?.entries)) {
        tmStorageVersionRef.current = typeof value.storageVersion === 'string' ? value.storageVersion : null;
        setTmEntries(value.entries as TmEntry[]);
        setTmStorageState('ready');
      } else {
        setTmStorageState('error');
      }
    } catch {
      setTmStorageState('error');
    }
  }, [selfHosted]);

  useEffect(() => {
    if (!selfHosted) return;
    let active = true;
    void (async () => {
      try {
        const response = await fetch(workbenchPath('/api/tm'), { cache: 'no-store' });
        if (!active) return;
        if (!response.ok) {
          setTmStorageState('error');
          return;
        }
        const value = await response.json() as { entries?: unknown; storageVersion?: unknown };
        if (!active) return;
        if (Array.isArray(value?.entries)) {
          tmStorageVersionRef.current = typeof value.storageVersion === 'string' ? value.storageVersion : null;
          setTmEntries(value.entries as TmEntry[]);
          setTmStorageState('ready');
        } else {
          setTmStorageState('error');
        }
      } catch {
        if (active) setTmStorageState('error');
      }
    })();
    return () => { active = false; };
  }, [selfHosted]);

  useEffect(() => {
    if (!tmOpen) return;
    void (async () => {
      await runtime.loadDictionary();
      if (runtime.getSnapshot().dictionary.kind === 'unsupported') {
        await runtime.loadMeta();
      }
    })();
  }, [runtime, tmOpen]);

  useEffect(() => {
    if (!tmOpen) return;
    let remaining = -1;
    if (dictionary.kind === 'success') {
      remaining = dictionary.fetchedAt + DICTIONARY_FRESH_TTL_MS - Date.now();
    } else if (dictionary.kind === 'unsupported' && meta.kind === 'success') {
      remaining = meta.fetchedAt + META_FRESH_TTL_MS - Date.now();
    }
    if (remaining <= 0) return;
    const timer = setTimeout(() => {
      setTmTtlVersion(v => v + 1);
    }, remaining + 1);
    return () => clearTimeout(timer);
  }, [tmOpen, dictionary, meta]);

  // Tier 1 / 2 display basis: fresh `/api/dictionary` when supported, else legacy `/api/meta` + trusted live review.
  const tmDisplayBasis = tmDisplayMatchBasis(dictionary, meta, latest);
  const tmDictionaryStatus: TmDictionaryStatusView = (() => {
    if (dictionary.kind === 'loading') return { kind: 'loading', revision: null, gameVersion: null };
    if (isDictionaryFresh(dictionary)) {
      return {
        kind: 'verified',
        revision: dictionary.data.revision,
        gameVersion: sanitizeGameVersion(dictionary.data.game_version),
      };
    }
    if (dictionary.kind === 'error') return { kind: 'error', revision: null, gameVersion: null };
    if (dictionary.kind === 'unsupported') {
      if (meta.kind === 'loading') return { kind: 'loading', revision: null, gameVersion: null };
      if (meta.kind === 'error') return { kind: 'error', revision: null, gameVersion: null };
      if (tmDisplayBasis.currentTermsDbRevision) {
        return {
          kind: 'legacy',
          revision: tmDisplayBasis.currentTermsDbRevision,
          gameVersion: tmDisplayBasis.currentGameVersion,
        };
      }
      return { kind: 'unverified', revision: null, gameVersion: null };
    }
    return { kind: 'unverified', revision: null, gameVersion: null };
  })();

  const getDisplayTmBasis = useCallback(() => {
    const live = runtime.getSnapshot();
    const liveLatest = doc.getSnapshot().reports.at(-1) ?? null;
    if (
      (live.dictionary.kind === 'success' && !isDictionaryFresh(live.dictionary))
      || (live.dictionary.kind === 'unsupported' && live.meta.kind === 'success' && !isMetaFresh(live.meta))
    ) {
      setTmTtlVersion(v => v + 1);
    }
    return tmDisplayMatchBasis(live.dictionary, live.meta, liveLatest);
  }, [runtime, doc]);

  const getConfirmTmBasis = useCallback(() => {
    const live = runtime.getSnapshot();
    const liveLatest = doc.getSnapshot().reports.at(-1) ?? null;
    if (
      (live.dictionary.kind === 'success' && !isDictionaryFresh(live.dictionary))
      || (live.dictionary.kind === 'unsupported' && live.meta.kind === 'success' && !isMetaFresh(live.meta))
    ) {
      setTmTtlVersion(v => v + 1);
    }
    return tmConfirmBasis(live.dictionary, live.meta, liveLatest);
  }, [runtime, doc]);

  const tmPersistence = useMemo<TmPersistenceAdapter | undefined>(() => {
    if (!selfHosted) return undefined;
    const postTm = async (payload: object) => fetch(workbenchPath('/api/tm'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify(payload),
    });
    const toTmError = (value: unknown) => {
      if (value && typeof value === 'object' && typeof (value as { code?: unknown }).code === 'string') {
        const v = value as { code: TmErrorCode; detail?: string };
        return new TranslationMemoryError(v.code, typeof v.detail === 'string' ? v.detail : '');
      }
      return undefined;
    };
    return {
      async confirm(candidate: TmConfirmCandidate): Promise<TmConfirmResult | { status: 'error' }> {
        try {
          const response = await postTm({ action: 'confirm', candidate });
          const value = await response.json() as Record<string, unknown>;
          if (response.ok && (value.status === 'added' || value.status === 'updated') && Array.isArray(value.entries)) {
            if (typeof value.storageVersion === 'string') tmStorageVersionRef.current = value.storageVersion;
            setTmStorageState('ready');
            return {
              status: value.status,
              entry: value.entry as TmEntry,
              entries: value.entries as TmEntry[],
            };
          }
          if (value.status === 'invalid' && typeof value.error === 'string') {
            return value as unknown as TmConfirmResult;
          }
          return { status: 'error' };
        } catch {
          return { status: 'error' };
        }
      },
      async replace(file: TmFile, optionsArg?: { force?: boolean }) {
        try {
          const response = await postTm({
            action: 'replace',
            file,
            forceReplace: optionsArg?.force === true,
            expectedVersion: tmStorageVersionRef.current,
          });
          const value = await response.json() as Record<string, unknown>;
          if (response.ok && Array.isArray(value.entries)) {
            if (typeof value.storageVersion === 'string') tmStorageVersionRef.current = value.storageVersion;
            setTmStorageState('ready');
            return { ok: true as const, entries: value.entries as TmEntry[] };
          }
          if (response.status === 409 && Array.isArray(value.entries)) {
            if (typeof value.storageVersion === 'string') tmStorageVersionRef.current = value.storageVersion;
            setTmStorageState('ready');
            return { ok: false as const, conflict: true as const, entries: value.entries as TmEntry[] };
          }
          return { ok: false as const, error: toTmError(value) };
        } catch {
          return { ok: false as const };
        }
      },
      async merge(file: TmFile) {
        try {
          const response = await postTm({ action: 'merge', file });
          const value = await response.json() as Record<string, unknown>;
          if (response.ok && Array.isArray(value.entries)) {
            if (typeof value.storageVersion === 'string') tmStorageVersionRef.current = value.storageVersion;
            setTmStorageState('ready');
            return { ok: true as const, entries: value.entries as TmEntry[] };
          }
          return { ok: false as const, error: toTmError(value) };
        } catch {
          return { ok: false as const };
        }
      },
      async remove(entry: TmEntry) {
        try {
          const response = await postTm({
            action: 'delete',
            entry: {
              direction: entry.direction,
              source_text: entry.source_text,
              target_text: entry.target_text,
              prev_source_hash: entry.prev_source_hash,
              next_source_hash: entry.next_source_hash,
            },
          });
          const value = await response.json() as Record<string, unknown>;
          if (response.ok && Array.isArray(value.entries)) {
            if (typeof value.storageVersion === 'string') tmStorageVersionRef.current = value.storageVersion;
            setTmStorageState('ready');
            return { ok: true as const, entries: value.entries as TmEntry[] };
          }
          return { ok: false as const };
        } catch {
          return { ok: false as const };
        }
      },
    };
  }, [selfHosted]);

  function applyMemorySuggestion(suggestionText: string) {
    const outcome = doc.applyMemorySuggestion(activeTmSegment.index, suggestionText);
    if (!outcome.applied) return outcome;
    setTmCursor({ kind: 'index', index: activeTmSegment.index });
    onFocusTarget();
    return outcome;
  }

  return {
    tmEntries,
    setTmEntries,
    tmStorageState,
    tmOpen,
    setTmOpen,
    setTmCursor,
    activeTmSegment,
    tmAlignmentStatus,
    tmDisplayBasis,
    tmDictionaryStatus,
    loadSelfhostTm,
    getDisplayTmBasis,
    getConfirmTmBasis,
    tmPersistence,
    applyMemorySuggestion,
  };
}
