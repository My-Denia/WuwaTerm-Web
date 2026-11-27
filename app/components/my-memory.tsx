'use client';

import { useDeferredValue, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { downloadFile } from '../../lib/download-file';
import { fill, msg } from '../../lib/messages';
import {
  MAX_TM_BYTES,
  TM_FORMAT,
  TM_ORIGIN_HUMAN,
  TM_SCHEMA_VERSION,
  TranslationMemoryError,
  confirmTranslationMemoryEntry,
  matchTranslationMemory,
  mergeTranslationMemoryEntries,
  parseTranslationMemoryBytes,
  recheckTmMatchFreshness,
  serializeTranslationMemory,
  tmNow,
  type TmConfirmCandidate,
  type TmConfirmResult,
  type TmDirection,
  type TmEntry,
  type TmFile,
  type TmMatch,
} from '../../lib/translation-memory';
import type { TmSegmentAlignmentStatus } from '../../lib/tm-segment';
import { useUiLanguage } from './ui-language-context';

type Feedback = { kind: 'notice' | 'error'; text: string } | null;

export type ApplySuggestionOutcome = {
  applied: boolean;
  reason?:
    | 'replaced'
    | 'inserted'
    | 'unaligned_target'
    | 'target_fewer_paragraphs'
    | 'multi_paragraph_suggestion'
    | 'target_gap_occupied'
    | 'whitespace_target_alignment'
    | 'cleared_alignments_skip';
};

export type TmLiveBasis = {
  currentTermsDbRevision: string | null;
  currentGameVersion: string | null;
};

export type TmDictionaryStatusView = {
  kind: 'verified' | 'legacy' | 'loading' | 'unverified' | 'error';
  revision: string | null;
  gameVersion: string | null;
};

export type TmPersistenceAdapter = {
  confirm: (candidate: TmConfirmCandidate) => Promise<TmConfirmResult | { status: 'error'; message?: string }>;
  replace: (file: TmFile) => Promise<{ ok: true; entries: TmEntry[] } | { ok: false; error?: unknown }>;
  merge: (file: TmFile) => Promise<{ ok: true; entries: TmEntry[] } | { ok: false; error?: unknown }>;
  remove: (entry: TmEntry) => Promise<{ ok: true; entries: TmEntry[] } | { ok: false }>;
};

type Props = {
  sourceText: string;
  targetText: string;
  prevSource?: string | null;
  nextSource?: string | null;
  segmentIndex?: number;
  segmentTotal?: number;
  alignmentStatus: TmSegmentAlignmentStatus;
  direction: TmDirection;
  currentTermsDbRevision?: string | null;
  currentGameVersion?: string | null;
  getDisplayBasis?: () => TmLiveBasis;
  getConfirmBasis?: () => TmLiveBasis;
  dictionaryStatus?: TmDictionaryStatusView;
  storageMode?: 'public_memory' | 'selfhost_sqlite';
  storageState?: 'idle' | 'loading' | 'ready' | 'error';
  persistence?: TmPersistenceAdapter;
  entries: TmEntry[];
  setEntries: Dispatch<SetStateAction<TmEntry[]>>;
  onApplySuggestion: (targetText: string) => ApplySuggestionOutcome | boolean | void;
  onSelectSegment?: (index: number) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

const LIST_PREVIEW_CAP = 50;

/**
 * Translation Memory panel (`wuwaterm-tm-v1`).
 *
 * Public mode: strictly in React page memory (zero localStorage/sessionStorage/IndexedDB, zero API uploads,
 * zero embedding into `.wuwaterm` manuscripts).
 * Self-hosted mode: persists confirmed entries to the instance's private `/api/tm` SQLite store (`tm.sqlite3`),
 * completely separate from official `terms.db` and browser storage.
 */
export function MyMemory({
  sourceText,
  targetText,
  prevSource = null,
  nextSource = null,
  segmentIndex = 0,
  segmentTotal = 1,
  alignmentStatus,
  direction,
  currentTermsDbRevision = null,
  currentGameVersion = null,
  getDisplayBasis,
  getConfirmBasis,
  dictionaryStatus,
  storageMode = 'public_memory',
  storageState = 'ready',
  persistence,
  entries,
  setEntries,
  onApplySuggestion,
  onSelectSegment,
  open: controlledOpen,
  onOpenChange,
}: Props) {
  const { lang } = useUiLanguage();
  const m = msg(lang);
  const t = m.memory;
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = (next: boolean | ((prev: boolean) => boolean)) => {
    const resolved = typeof next === 'function' ? next(open) : next;
    if (onOpenChange) onOpenChange(resolved);
    else setLocalOpen(resolved);
  };

  const [feedback, setFeedback] = useState<Feedback>(null);
  const [pending, setPending] = useState<TmFile | null>(null);
  const [busy, setBusy] = useState(false);
  const fileBox = useRef<HTMLInputElement>(null);

  const currentQuery = useMemo(
    () => ({
      segmentIndex,
      sourceText,
      prevSource: prevSource ?? null,
      nextSource: nextSource ?? null,
    }),
    [segmentIndex, sourceText, prevSource, nextSource],
  );
  const deferredQuery = useDeferredValue(currentQuery);
  const matchesCurrentSegment =
    deferredQuery.segmentIndex === currentQuery.segmentIndex
    && deferredQuery.sourceText === currentQuery.sourceText
    && deferredQuery.prevSource === currentQuery.prevSource
    && deferredQuery.nextSource === currentQuery.nextSource;
  const matchBundle = useMemo(
    () => ({
      query: deferredQuery,
      matches: matchTranslationMemory(entries, deferredQuery.sourceText, direction, {
        prevSource: deferredQuery.prevSource,
        nextSource: deferredQuery.nextSource,
        currentTermsDbRevision,
        currentGameVersion,
      }),
    }),
    [entries, deferredQuery, direction, currentTermsDbRevision, currentGameVersion],
  );
  const matches = matchBundle.matches;
  const directionLabel = direction === 'en' ? t.directionEn : t.directionZh;
  const isMultiSegment = segmentTotal > 1;
  // `describeTmSegmentAlignment` is the single source of truth for alignment status.
  const targetHasMoreSegments = alignmentStatus.status === 'target_extra_paragraphs';
  const targetHasFewerSegments = alignmentStatus.status === 'target_fewer_paragraphs';
  const isTargetCursorUnaligned = alignmentStatus.status === 'target_cursor_unaligned';
  const alignmentBannerText = alignmentStatus.status === 'target_cursor_unaligned'
    ? t.segmentTargetCursorUnalignedHint
    : alignmentStatus.status === 'whitespace_target_alignment'
      ? t.segmentWhitespaceAlignmentHint
      : alignmentStatus.status === 'cleared_alignments_skip'
        ? t.segmentClearedSkipHint
        : alignmentStatus.status === 'target_extra_paragraphs'
          ? fill(t.segmentUnalignedHint, {
            sourceTotal: alignmentStatus.sourceTotal,
            targetTotal: alignmentStatus.targetTotal,
          })
          : alignmentStatus.status === 'target_fewer_paragraphs'
            ? fill(t.segmentFewerTargetHint, {
              sourceTotal: alignmentStatus.sourceTotal,
              targetTotal: alignmentStatus.targetTotal,
            })
            : alignmentStatus.status === 'alignment_ambiguous'
              ? t.segmentAmbiguousHint
              : alignmentStatus.status === 'target_gap_occupied'
                ? t.segmentGapOccupiedHint
                : null;

  const dictionaryStatusText = (() => {
    if (!dictionaryStatus) return null;
    const revShort = dictionaryStatus.revision ? dictionaryStatus.revision.slice(0, 12) : '';
    if (dictionaryStatus.kind === 'verified' && revShort) {
      return dictionaryStatus.gameVersion
        ? fill(t.dictionaryStatusVerified, { rev: revShort, game: dictionaryStatus.gameVersion })
        : fill(t.dictionaryStatusVerifiedNoGame, { rev: revShort });
    }
    if (dictionaryStatus.kind === 'legacy' && revShort) {
      return fill(t.dictionaryStatusLegacy, { rev: revShort });
    }
    if (dictionaryStatus.kind === 'loading') return t.dictionaryStatusLoading;
    if (dictionaryStatus.kind === 'error') return t.dictionaryStatusError;
    return t.dictionaryStatusUnverified;
  })();

  const notice = (text: string) => setFeedback({ kind: 'notice', text });
  const failure = (text: string) => setFeedback({ kind: 'error', text });
  const errorText = (error: unknown, fallback: string = t.errors.importFailed) => {
    if (!(error instanceof TranslationMemoryError)) return fallback;
    const base = (t.errors as Record<string, string>)[error.code] ?? fallback;
    return base === fallback
      ? base
      : `${base}${error.detail ? ` (${error.detail})` : ''} ${fallback}`;
  };

  const storageNotReady = storageMode === 'selfhost_sqlite' && storageState !== 'ready';
  const mutationsDisabled = busy || storageNotReady;

  function storageNotReadyMessage() {
    return storageState === 'loading' ? t.storageLoading : t.storageError;
  }

  async function applyReplace(file: TmFile) {
    if (storageNotReady) {
      failure(storageNotReadyMessage());
      setPending(null);
      return;
    }
    if (persistence) {
      setBusy(true);
      try {
        const res = await persistence.replace(file);
        if (!res.ok) {
          failure(res.error ? errorText(res.error) : t.storageError);
          setPending(null);
          return;
        }
        setEntries(res.entries);
        setPending(null);
        notice(fill(t.notices.imported, { n: file.entries.length }));
      } finally {
        setBusy(false);
      }
      return;
    }
    setEntries(file.entries);
    setPending(null);
    notice(fill(t.notices.imported, { n: file.entries.length }));
  }

  async function applyMerge(file: TmFile) {
    if (storageNotReady) {
      failure(storageNotReadyMessage());
      setPending(null);
      return;
    }
    if (persistence) {
      setBusy(true);
      try {
        const res = await persistence.merge(file);
        if (!res.ok) {
          failure(res.error ? errorText(res.error) : t.storageError);
          setPending(null);
          return;
        }
        setEntries(res.entries);
        setPending(null);
        notice(fill(t.notices.merged, { added: file.entries.length, total: res.entries.length }));
      } finally {
        setBusy(false);
      }
      return;
    }
    try {
      const merged = mergeTranslationMemoryEntries(entries, file.entries);
      setEntries(merged);
      setPending(null);
      notice(fill(t.notices.merged, { added: file.entries.length, total: merged.length }));
    } catch (error) {
      failure(errorText(error));
      setPending(null);
    }
  }

  async function importFile(file?: File) {
    if (!file) return;
    if (storageNotReady) {
      failure(storageNotReadyMessage());
      setPending(null);
      return;
    }
    setPending(null);
    try {
      if (file.size > MAX_TM_BYTES) {
        throw new TranslationMemoryError('tm_too_large', `${file.size} bytes`);
      }
      const parsed = parseTranslationMemoryBytes(new Uint8Array(await file.arrayBuffer()));
      if (entries.length > 0) {
        setPending(parsed);
        setFeedback(null);
      } else {
        await applyReplace(parsed);
      }
    } catch (error) {
      failure(errorText(error, t.errors.importFailed));
    }
  }

  function exportFile() {
    try {
      const text = serializeTranslationMemory({
        format: TM_FORMAT,
        schema_version: TM_SCHEMA_VERSION,
        exported_at: tmNow(),
        entries,
      });
      downloadFile('wuwaterm-tm.json', text);
      notice(fill(t.notices.exported, { n: entries.length }));
    } catch (error) {
      failure(errorText(error, t.errors.exportFailed));
    }
  }

  function reportConfirmInvalid(outcome: Extract<TmConfirmResult, { status: 'invalid' }>) {
    const fieldName = outcome.field === 'target'
      ? t.fieldTarget
      : outcome.field === 'note'
        ? t.fieldNote
        : t.fieldSource;
    if (outcome.error === 'list_full') failure(t.errors.listFull);
    else if (outcome.error === 'list_too_large') failure(t.errors.listTooLarge);
    else if (outcome.error === 'unconfirmed_origin') failure(t.errors.tm_unconfirmed_origin);
    else if (outcome.error === 'field_too_long') failure(fill(t.errors.fieldTooLong, { field: fieldName, max: outcome.max ?? 0 }));
    else if (outcome.error === 'field_required') failure(fill(t.errors.fieldRequired, { field: fieldName }));
    else failure(fill(t.errors.fieldInvalid, { field: fieldName }));
  }

  async function confirmCurrent() {
    if (storageNotReady) {
      failure(storageNotReadyMessage());
      return;
    }
    // Tier 3 (Human confirm): strictly fresh live provenance only; NEVER writes `lastKnown` on stale/error/idle (P1-02).
    const confirmBasis = getConfirmBasis
      ? getConfirmBasis()
      : { currentTermsDbRevision: null, currentGameVersion: null };
    const candidate: TmConfirmCandidate = {
      sourceText,
      targetText,
      direction,
      prevSource: prevSource ?? null,
      nextSource: nextSource ?? null,
      origin: TM_ORIGIN_HUMAN,
      termsDbRevision: confirmBasis.currentTermsDbRevision,
      gameVersion: confirmBasis.currentGameVersion,
    };

    if (persistence) {
      setBusy(true);
      try {
        const outcome = await persistence.confirm(candidate);
        if (outcome.status === 'added') {
          setEntries(outcome.entries);
          notice(t.notices.confirmedAdded);
        } else if (outcome.status === 'updated') {
          setEntries(outcome.entries);
          notice(fill(t.notices.confirmedUpdated, { count: outcome.entry.use_count }));
        } else if (outcome.status === 'invalid') {
          reportConfirmInvalid(outcome);
        } else {
          failure(t.storageError);
        }
      } finally {
        setBusy(false);
      }
      return;
    }

    const outcome = confirmTranslationMemoryEntry(entries, candidate);
    if (outcome.status === 'added') {
      setEntries(outcome.entries);
      notice(t.notices.confirmedAdded);
      return;
    }
    if (outcome.status === 'updated') {
      setEntries(outcome.entries);
      notice(fill(t.notices.confirmedUpdated, { count: outcome.entry.use_count }));
      return;
    }
    if (outcome.status === 'invalid') {
      reportConfirmInvalid(outcome);
    }
  }

  function applySuggestion(match: TmMatch, matchQuery: typeof deferredQuery) {
    if (isTargetCursorUnaligned) {
      failure(t.segmentTargetCursorUnalignedHint);
      return;
    }
    if (
      !matchesCurrentSegment
      || matchQuery.segmentIndex !== currentQuery.segmentIndex
      || matchQuery.sourceText !== currentQuery.sourceText
      || matchQuery.prevSource !== currentQuery.prevSource
      || matchQuery.nextSource !== currentQuery.nextSource
    ) {
      return;
    }
    // Tier 2 (Manual reference apply): recheck display freshness at click time.
    const liveBasis = getDisplayBasis ? getDisplayBasis() : { currentTermsDbRevision, currentGameVersion };
    const liveMatch = recheckTmMatchFreshness(match, liveBasis);
    const outcome = onApplySuggestion(match.entry.target_text);
    const applied = typeof outcome === 'boolean' ? outcome : outcome ? outcome.applied : true;
    if (!applied) {
      const reason = typeof outcome === 'object' && outcome ? outcome.reason : undefined;
      if (reason === 'multi_paragraph_suggestion') {
        failure(t.errors.multiParagraphSuggestion);
      } else if (reason === 'target_fewer_paragraphs' || targetHasFewerSegments) {
        failure(fill(t.errors.targetFewerParagraphs, {
          sourceTotal: alignmentStatus.sourceTotal,
          targetTotal: alignmentStatus.targetTotal,
        }));
      } else if (reason === 'target_gap_occupied') {
        failure(t.errors.targetGapOccupied);
      } else if (reason === 'whitespace_target_alignment') {
        failure(t.errors.whitespaceTargetAlignment);
      } else if (reason === 'cleared_alignments_skip') {
        failure(t.errors.clearedAlignmentsSkip);
      } else if (targetHasMoreSegments) {
        failure(fill(t.errors.segmentUnaligned, {
          sourceTotal: alignmentStatus.sourceTotal,
          targetTotal: alignmentStatus.targetTotal,
        }));
      } else {
        failure(t.errors.segmentAlignmentRequired);
      }
      return;
    }
    if (isMultiSegment) {
      notice(fill(liveMatch.needsRecheck ? t.notices.appliedSegmentRecheck : t.notices.appliedSegment, {
        i: segmentIndex + 1,
        n: segmentTotal,
      }));
      return;
    }
    notice(liveMatch.needsRecheck ? t.notices.appliedRecheck : t.notices.applied);
  }

  async function removeAt(index: number) {
    if (storageNotReady) {
      failure(storageNotReadyMessage());
      return;
    }
    const targetEntry = entries[index];
    if (!targetEntry) return;
    if (persistence) {
      setBusy(true);
      try {
        const res = await persistence.remove(targetEntry);
        if (!res.ok) {
          failure(t.storageError);
          return;
        }
        setEntries(res.entries);
        notice(t.notices.removed);
      } finally {
        setBusy(false);
      }
      return;
    }
    setEntries(list => list.filter((_, i) => i !== index));
    notice(t.notices.removed);
  }

  const visibleEntries = entries.slice(0, LIST_PREVIEW_CAP);

  return (
    <section
      className="my-memory"
      data-open={open ? 'true' : 'false'}
      data-storage-mode={storageMode}
      aria-labelledby="my-memory-title"
    >
      <div className="lookup-heading">
        <h2 id="my-memory-title">{t.title}</h2>
        <button
          type="button"
          className="text-button"
          aria-expanded={open}
          aria-controls="my-memory-body"
          onClick={() => setOpen(value => !value)}
        >
          {open ? m.workspace.lookupHide : m.workspace.lookupShow}
        </button>
      </div>
      <p className="my-terms-counts" data-testid="my-memory-counts">
        {fill(t.entryCount, { n: entries.length })}
        {entries.length > 0 ? ` · ${fill(t.hitCount, { n: matches.length })}` : ''}
      </p>
      <div id="my-memory-body" hidden={!open}>
        <div className="my-memory-status-strip" data-testid="my-memory-status">
          <span className="my-memory-status-pill" data-storage={storageMode}>
            {storageMode === 'selfhost_sqlite' ? t.storageBadgeSelfhost : t.storageBadgePublic}
          </span>
          {dictionaryStatusText && (
            <span
              className="my-memory-status-pill my-memory-dict-status"
              data-testid="my-memory-dictionary-status"
              data-dict-state={dictionaryStatus?.kind}
            >
              {t.dictionaryStatusLabel}: {dictionaryStatusText}
            </span>
          )}
        </div>
        {storageMode === 'selfhost_sqlite' && storageState === 'loading' && (
          <p className="field-hint my-terms-note" role="status">{t.storageLoading}</p>
        )}
        {storageMode === 'selfhost_sqlite' && storageState === 'error' && (
          <p className="my-terms-feedback my-terms-error" role="alert">{t.storageError}</p>
        )}
        <p className="field-hint my-terms-note">{t.memoryNote}</p>
        <p className="field-hint my-terms-note">{t.referenceNote}</p>
        {isMultiSegment && (
          <div
            className="my-memory-segment-bar"
            data-testid="my-memory-segment-scope"
            data-target-unaligned={isTargetCursorUnaligned ? 'true' : 'false'}
          >
            <span className="my-memory-segment-label">
              {isTargetCursorUnaligned
                ? fill(t.segmentScopeUnaligned, { n: segmentTotal })
                : fill(t.segmentScope, { i: segmentIndex + 1, n: segmentTotal })}
            </span>
            {onSelectSegment && (
              <div className="my-memory-segment-nav">
                <button
                  type="button"
                  className="text-button"
                  disabled={!isTargetCursorUnaligned && segmentIndex <= 0}
                  onClick={() => onSelectSegment(isTargetCursorUnaligned ? 0 : segmentIndex - 1)}
                >
                  {t.segmentPrev}
                </button>
                <button
                  type="button"
                  className="text-button"
                  disabled={!isTargetCursorUnaligned && segmentIndex >= segmentTotal - 1}
                  onClick={() => onSelectSegment(isTargetCursorUnaligned ? Math.min(segmentTotal - 1, 1) : segmentIndex + 1)}
                >
                  {t.segmentNext}
                </button>
              </div>
            )}
          </div>
        )}
        {alignmentBannerText && (
          <p
            className="my-memory-recheck-hint"
            data-testid="my-memory-alignment-hint"
            data-alignment-status={alignmentStatus.status}
            role="status"
          >
            {alignmentBannerText}
          </p>
        )}
        <div className="my-terms-actions">
          <button type="button" className="secondary-button" disabled={mutationsDisabled} onClick={() => fileBox.current?.click()}>
            {t.importButton}
          </button>
          <button type="button" className="secondary-button" disabled={mutationsDisabled} onClick={exportFile}>
            {t.exportButton}
          </button>
        </div>
        <div className="my-terms-actions">
          <button
            type="button"
            className="secondary-button my-memory-confirm-btn"
            disabled={mutationsDisabled || !sourceText.trim() || !targetText.trim() || isTargetCursorUnaligned}
            onClick={() => void confirmCurrent()}
          >
            {isMultiSegment ? t.confirmSegmentButton : t.confirmButton}
          </button>
        </div>
        <input
          ref={fileBox}
          className="visually-hidden"
          type="file"
          tabIndex={-1}
          disabled={mutationsDisabled}
          accept=".json,application/json"
          aria-label={t.importAria}
          onChange={event => {
            const file = event.target.files?.[0];
            event.target.value = '';
            void importFile(file);
          }}
        />
        {pending && (
          <div className="my-terms-confirm" role="group" aria-label={t.importButton}>
            <p>{fill(t.replacePrompt, { n: entries.length })}</p>
            <div className="my-terms-actions">
              <button type="button" className="secondary-button" disabled={mutationsDisabled} onClick={() => void applyMerge(pending)}>
                {t.mergeConfirm}
              </button>
              <button type="button" className="secondary-button" disabled={mutationsDisabled} onClick={() => void applyReplace(pending)}>
                {t.replaceConfirm}
              </button>
              <button type="button" className="secondary-button" disabled={busy} onClick={() => setPending(null)}>
                {t.replaceKeep}
              </button>
            </div>
          </div>
        )}
        {feedback && (
          <p
            className={feedback.kind === 'error' ? 'my-terms-feedback my-terms-error' : 'my-terms-feedback'}
            role={feedback.kind === 'error' ? 'alert' : 'status'}
          >
            {feedback.text}
          </p>
        )}

        <h3>{t.hitsTitle}</h3>
        <p className="field-hint">{fill(t.matchBasis, { direction: directionLabel })}</p>
        <div className="my-memory-hits" aria-live="polite">
          {matches.length === 0 ? (
            <p className="lookup-empty">{t.hitsNone}</p>
          ) : (
            matches.map((match, idx) => (
              <article
                className="my-memory-hit"
                key={`${match.entry.direction}:${match.entry.source_text}:${match.entry.target_text}:${idx}`}
                data-match-kind={match.matchKind}
                data-freshness={match.freshness}
                data-needs-recheck={match.needsRecheck ? 'true' : 'false'}
              >
                <div className="my-memory-badges">
                  <span className="my-terms-badge my-memory-kind-badge" data-kind={match.matchKind}>
                    {t.matchKinds[match.matchKind]}
                  </span>
                  {match.staleReasons.map(reason => (
                    <span className="my-memory-stale-badge" key={reason} data-stale={reason}>
                      {t.staleReasons[reason]}
                    </span>
                  ))}
                </div>
                <div className="term-pair">
                  <strong>{match.entry.target_text}</strong>
                  <span>{match.entry.source_text}</span>
                </div>
                <p className="my-terms-meta">
                  {fill(t.hitMeta, {
                    count: match.entry.use_count,
                    origin: t.origins[match.entry.origin],
                  })}
                </p>
                {match.needsRecheck && (
                  <p className="my-memory-recheck-hint">
                    {t.recheckHint}
                    {match.staleReasons.map(r => t.staleReasons[r]).join(' · ')}
                  </p>
                )}
                {match.entry.note && <p className="my-terms-meta">{match.entry.note}</p>}
                <div className="finding-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={!matchesCurrentSegment || isTargetCursorUnaligned}
                    onClick={() => applySuggestion(match, matchBundle.query)}
                  >
                    {t.applyButton}
                  </button>
                </div>
              </article>
            ))
          )}
        </div>

        <h3>{t.listTitle}</h3>
        {entries.length === 0 ? (
          <p className="lookup-empty">{t.listEmpty}</p>
        ) : (
          <>
            <ul className="my-terms-list my-memory-list">
              {visibleEntries.map((entry, idx) => (
                <li key={`${entry.direction}:${entry.created_at}:${idx}`}>
                  <div className="term-pair">
                    <strong>{entry.source_text}</strong>
                    <span>{entry.target_text}</span>
                  </div>
                  <p className="my-terms-meta">
                    {entry.direction === 'en' ? t.directionEn : t.directionZh} · {fill(t.hitMeta, { count: entry.use_count, origin: t.origins[entry.origin] })}
                  </p>
                  <div className="finding-actions">
                    <button type="button" className="text-button" disabled={mutationsDisabled} onClick={() => void removeAt(idx)}>
                      {t.remove}
                      <span className="visually-hidden"> {entry.source_text}</span>
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            {entries.length > LIST_PREVIEW_CAP && (
              <p className="field-hint">{fill(t.listTruncated, { shown: LIST_PREVIEW_CAP, total: entries.length })}</p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
