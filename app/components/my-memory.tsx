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
  serializeTranslationMemory,
  tmNow,
  type TmDirection,
  type TmEntry,
  type TmFile,
  type TmMatch,
} from '../../lib/translation-memory';
import { useUiLanguage } from './ui-language-context';

type Feedback = { kind: 'notice' | 'error'; text: string } | null;

type Props = {
  source: string;
  target: string;
  direction: TmDirection;
  currentTermsDbRevision?: string | null;
  currentGameVersion?: string | null;
  entries: TmEntry[];
  setEntries: Dispatch<SetStateAction<TmEntry[]>>;
  onApplySuggestion: (targetText: string) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

const LIST_PREVIEW_CAP = 50;

/**
 * Explicit in-memory Translation Memory panel (`wuwaterm-tm-v1`).
 *
 * Strictly in React page state: zero localStorage/sessionStorage/IndexedDB, zero API uploads,
 * zero embedding into `.wuwaterm` manuscripts, and only human/imported confirmed entries.
 */
export function MyMemory({
  source,
  target,
  direction,
  currentTermsDbRevision = null,
  currentGameVersion = null,
  entries,
  setEntries,
  onApplySuggestion,
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
  const fileBox = useRef<HTMLInputElement>(null);

  const deferredSource = useDeferredValue(source);
  const matches = useMemo(
    () =>
      matchTranslationMemory(entries, deferredSource, direction, {
        currentTermsDbRevision,
        currentGameVersion,
      }),
    [entries, deferredSource, direction, currentTermsDbRevision, currentGameVersion],
  );
  const directionLabel = direction === 'en' ? t.directionEn : t.directionZh;

  const notice = (text: string) => setFeedback({ kind: 'notice', text });
  const failure = (text: string) => setFeedback({ kind: 'error', text });
  const errorText = (error: unknown) => {
    if (!(error instanceof TranslationMemoryError)) return t.errors.importFailed;
    const base = (t.errors as Record<string, string>)[error.code] ?? t.errors.importFailed;
    return `${base}${error.detail ? ` (${error.detail})` : ''} ${t.errors.importFailed}`;
  };

  function applyReplace(file: TmFile) {
    setEntries(file.entries);
    setPending(null);
    notice(fill(t.notices.imported, { n: file.entries.length }));
  }

  function applyMerge(file: TmFile) {
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
        applyReplace(parsed);
      }
    } catch (error) {
      failure(errorText(error));
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
      failure(errorText(error));
    }
  }

  function confirmCurrent() {
    const outcome = confirmTranslationMemoryEntry(entries, {
      sourceText: source,
      targetText: target,
      direction,
      origin: TM_ORIGIN_HUMAN,
      termsDbRevision: currentTermsDbRevision,
      gameVersion: currentGameVersion,
    });
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
    if (outcome.status !== 'invalid') return;
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

  function applySuggestion(match: TmMatch) {
    onApplySuggestion(match.entry.target_text);
    notice(match.needsRecheck ? t.notices.appliedRecheck : t.notices.applied);
  }

  function removeAt(index: number) {
    setEntries(list => list.filter((_, i) => i !== index));
    notice(t.notices.removed);
  }

  const visibleEntries = entries.slice(0, LIST_PREVIEW_CAP);

  return (
    <section className="my-memory" data-open={open ? 'true' : 'false'} aria-labelledby="my-memory-title">
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
        <p className="field-hint my-terms-note">{t.memoryNote}</p>
        <p className="field-hint my-terms-note">{t.referenceNote}</p>
        <div className="my-terms-actions">
          <button type="button" className="secondary-button" onClick={() => fileBox.current?.click()}>
            {t.importButton}
          </button>
          <button type="button" className="secondary-button" onClick={exportFile}>
            {t.exportButton}
          </button>
        </div>
        <div className="my-terms-actions">
          <button
            type="button"
            className="secondary-button my-memory-confirm-btn"
            disabled={!source.trim() || !target.trim()}
            onClick={confirmCurrent}
          >
            {t.confirmButton}
          </button>
        </div>
        <input
          ref={fileBox}
          className="visually-hidden"
          type="file"
          tabIndex={-1}
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
              <button type="button" className="secondary-button" onClick={() => applyMerge(pending)}>
                {t.mergeConfirm}
              </button>
              <button type="button" className="secondary-button" onClick={() => applyReplace(pending)}>
                {t.replaceConfirm}
              </button>
              <button type="button" className="secondary-button" onClick={() => setPending(null)}>
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
                  <button type="button" className="secondary-button" onClick={() => applySuggestion(match)}>
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
                    <button type="button" className="text-button" onClick={() => removeAt(idx)}>
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
