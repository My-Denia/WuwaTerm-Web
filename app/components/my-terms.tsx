'use client';

import { FormEvent, useDeferredValue, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { downloadFile } from '../../lib/download-file';
import { fill, msg } from '../../lib/messages';
import {
  MAX_TERMBASE_BYTES, MAX_TERMBASE_ENTRIES, MATCH_TEXT_LIMIT, TERMBASE_DIRECTION_VALUES, TERMBASE_FORMAT, TERMBASE_KIND_VALUES,
  TermbaseError, matchTermbase, nextEntryId, parseTermbaseBytes, serializeTermbase, termbaseNow, validateTermbase,
} from '../../lib/termbase';
import type { Termbase, TermbaseDirection, TermbaseEntry, TermbaseKind } from '../../lib/termbase';
import { TERMBASE_LIMITS } from '../../lib/generated/termbase-contract';
import { useUiLanguage } from './ui-language-context';

type Draft = { source: string; target: string; direction: TermbaseDirection | null; kind: TermbaseKind; note: string };
type Feedback = { kind: 'notice' | 'error'; text: string } | null;

export type TermbaseDraftSeed = {
  key: number;
  source: string;
  target: string;
  direction: TermbaseDirection;
  kind: TermbaseKind;
  note?: string;
};

export type TermbaseExternalFeedback = {
  key: number;
  kind: 'notice' | 'error';
  text: string;
};

type Props = {
  source: string;
  direction: TermbaseDirection;
  entries: TermbaseEntry[];
  setEntries: Dispatch<SetStateAction<TermbaseEntry[]>>;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  draftSeed?: TermbaseDraftSeed | null;
  externalFeedback?: TermbaseExternalFeedback | null;
};

const BLANK: Draft = { source: '', target: '', direction: null, kind: 'community_term', note: '' };
const scalars = (text: string) => Array.from(text).length;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * The person's own term list, kept in React page memory and nowhere else: no storage, no request, no part of the
 * manuscript. It reads the current source text and the document's direction and lists which entries occur in it. Import
 * and export are explicit file actions; a reload empties the list.
 */
export function MyTerms({ source, direction, entries, setEntries, open: controlledOpen, onOpenChange, draftSeed, externalFeedback }: Props) {
  const { lang } = useUiLanguage();
  const t = msg(lang).termbase;
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = (next: boolean | ((prev: boolean) => boolean)) => {
    const resolved = typeof next === 'function' ? next(open) : next;
    if (onOpenChange) onOpenChange(resolved);
    else setLocalOpen(resolved);
  };
  const [draft, setDraft] = useState<Draft>(BLANK);
  const [editing, setEditing] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [pending, setPending] = useState<Termbase | null>(null);
  const fileBox = useRef<HTMLInputElement>(null);
  const sourceInput = useRef<HTMLInputElement>(null);
  const targetInput = useRef<HTMLInputElement>(null);
  const [seenSeed, setSeenSeed] = useState<number | null>(null);
  const [seenFeedback, setSeenFeedback] = useState<number | null>(null);

  if (draftSeed && draftSeed.key !== seenSeed) {
    setSeenSeed(draftSeed.key);
    setEditing(null);
    setDraft({
      source: draftSeed.source,
      target: draftSeed.target,
      direction: draftSeed.direction,
      kind: draftSeed.kind,
      note: draftSeed.note ?? '',
    });
  }
  if (externalFeedback && externalFeedback.key !== seenFeedback) {
    setSeenFeedback(externalFeedback.key);
    setFeedback({ kind: externalFeedback.kind, text: externalFeedback.text });
  }

  useEffect(() => {
    if (!draftSeed || !open) return;
    const focusTarget = draftSeed.source && !draftSeed.target ? targetInput.current : sourceInput.current;
    focusTarget?.focus();
    focusTarget?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [draftSeed, open]);

  const deferredSource = useDeferredValue(source);
  const found = useMemo(() => matchTermbase(entries, deferredSource, direction), [entries, deferredSource, direction]);
  const directionLabel = direction === 'en' ? t.directionEn : t.directionZh;
  const formDirection = draft.direction ?? direction;

  const notice = (text: string) => setFeedback({ kind: 'notice', text });
  const failure = (text: string) => setFeedback({ kind: 'error', text });
  const errorText = (error: unknown) => {
    if (!(error instanceof TermbaseError)) return t.errors.importFailed;
    const base = (t.errors as Record<string, string>)[error.code] ?? t.errors.importFailed;
    return `${base}${error.detail ? ` (${error.detail})` : ''} ${t.errors.importFailed}`;
  };

  function applyImport(termbase: Termbase) {
    setEntries(termbase.entries);
    setEditing(null);
    setDraft(BLANK);
    setPending(null);
    notice(fill(t.notices.imported, { n: termbase.entries.length }));
  }

  async function importFile(file?: File) {
    if (!file) return;
    setPending(null);
    try {
      if (file.size > MAX_TERMBASE_BYTES) throw new TermbaseError('termbase_too_large', `${file.size} bytes`);
      const termbase = parseTermbaseBytes(new Uint8Array(await file.arrayBuffer()));
      if (entries.length > 0) { setPending(termbase); setFeedback(null); } else applyImport(termbase);
    } catch (error) {
      failure(errorText(error));
    }
  }

  function exportFile() {
    try {
      const text = serializeTermbase({ format: TERMBASE_FORMAT, schema_version: 1, updated_at: termbaseNow(), entries });
      downloadFile('wuwaterm-termbase.json', text);
      notice(fill(t.notices.exported, { n: entries.length }));
    } catch (error) {
      failure(errorText(error));
    }
  }

  function fieldProblem(label: string, value: string, min: number, max: number): string | null {
    if (value.includes('\u0000') || LONE_SURROGATE.test(value)) return fill(t.errors.fieldInvalid, { field: label });
    const n = scalars(value);
    if (n < min) return fill(t.errors.fieldRequired, { field: label });
    if (n > max) return fill(t.errors.fieldTooLong, { field: label, max });
    return null;
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const source = draft.source.trim();
    const target = draft.target.trim();
    const note = draft.note.trim();
    const problem = fieldProblem(t.fieldSource, source, TERMBASE_LIMITS.source.min, TERMBASE_LIMITS.source.max)
      ?? fieldProblem(t.fieldTarget, target, TERMBASE_LIMITS.target.min, TERMBASE_LIMITS.target.max)
      ?? fieldProblem(t.fieldNote, note, TERMBASE_LIMITS.note.min, TERMBASE_LIMITS.note.max);
    if (problem) { failure(problem); return; }
    if (editing === null && entries.length >= MAX_TERMBASE_ENTRIES) { failure(t.errors.listFull); return; }
    const stamp = termbaseNow();
    const next = editing === null
      ? [...entries, { id: nextEntryId(entries), source, target, direction: formDirection, kind: draft.kind, note, updated_at: stamp }]
      : entries.map(e => (e.id === editing ? { ...e, source, target, direction: formDirection, kind: draft.kind, note, updated_at: stamp } : e));
    try {
      serializeTermbase({ format: TERMBASE_FORMAT, schema_version: 1, updated_at: stamp, entries: next });
    } catch (error) {
      failure(error instanceof TermbaseError && error.code === 'termbase_too_large' ? t.errors.listTooLarge : errorText(error));
      return;
    }
    setEntries(validateTermbase({ format: TERMBASE_FORMAT, schema_version: 1, updated_at: stamp, entries: next }).entries);
    notice(editing === null ? t.notices.added : t.notices.updated);
    setEditing(null);
    setDraft(BLANK);
  }

  function startEdit(entry: TermbaseEntry) {
    setEditing(entry.id);
    setDraft({ source: entry.source, target: entry.target, direction: entry.direction, kind: entry.kind, note: entry.note });
    setFeedback(null);
  }

  function cancelEdit() {
    setEditing(null);
    setDraft(BLANK);
    setFeedback(null);
  }

  function remove(id: string) {
    setEntries(list => list.filter(e => e.id !== id));
    if (editing === id) cancelEdit();
    notice(t.notices.removed);
  }

  return <section className="my-terms" data-open={open ? 'true' : 'false'} aria-labelledby="my-terms-title">
    <div className="lookup-heading">
      <h2 id="my-terms-title">{t.title}</h2>
      <button type="button" className="text-button" aria-expanded={open} aria-controls="my-terms-body" onClick={() => setOpen(value => !value)}>
        {open ? msg(lang).workspace.lookupHide : msg(lang).workspace.lookupShow}
      </button>
    </div>
    <p className="my-terms-counts" data-testid="my-terms-counts">
      {fill(t.entryCount, { n: entries.length })}{entries.length > 0 ? ` · ${fill(t.hitCount, { n: found.matches.length })}` : ''}
    </p>
    <div id="my-terms-body" hidden={!open}>
      <p className="field-hint my-terms-note">{t.memoryNote}</p>
      <p className="field-hint my-terms-note">{t.referenceNote}</p>
      <div className="my-terms-actions">
        <button type="button" className="secondary-button" onClick={() => fileBox.current?.click()}>{t.importButton}</button>
        <button type="button" className="secondary-button" onClick={exportFile}>{t.exportButton}</button>
      </div>
      <input ref={fileBox} className="visually-hidden" type="file" tabIndex={-1} accept=".json,application/json" aria-label={t.importAria}
        onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void importFile(file); }} />
      {pending && <div className="my-terms-confirm" role="group" aria-label={t.importButton}>
        <p>{fill(t.replacePrompt, { n: entries.length })}</p>
        <div className="my-terms-actions">
          <button type="button" className="secondary-button" onClick={() => applyImport(pending)}>{t.replaceConfirm}</button>
          <button type="button" className="secondary-button" onClick={() => setPending(null)}>{t.replaceKeep}</button>
        </div>
      </div>}
      {feedback && <p className={feedback.kind === 'error' ? 'my-terms-feedback my-terms-error' : 'my-terms-feedback'} role={feedback.kind === 'error' ? 'alert' : 'status'}>{feedback.text}</p>}

      <h3>{t.hitsTitle}</h3>
      <p className="field-hint">{fill(t.matchBasis, { direction: directionLabel })}</p>
      <div className="my-terms-hits" aria-live="polite">
        {found.matches.length === 0 ? <p className="lookup-empty">{t.hitsNone}</p> : found.matches.map(({ entry, count }) => <article className="my-terms-hit" key={entry.id}>
          <div className="term-pair"><strong>{entry.source}</strong><span>{entry.target}</span></div>
          <p className="my-terms-meta"><span className="my-terms-badge">{t.hitBadge}</span> {t.kinds[entry.kind]} · {fill(t.hitOccurrences, { n: count })}</p>
          {entry.note && <p className="my-terms-meta">{entry.note}</p>}
        </article>)}
      </div>
      {found.truncated && <p className="field-hint">{fill(t.hitsTruncated, { n: MATCH_TEXT_LIMIT.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US') })}</p>}

      <h3>{t.listTitle}</h3>
      {entries.length === 0 ? <p className="lookup-empty">{t.listEmpty}</p> : <ul className="my-terms-list">
        {entries.map(entry => <li key={entry.id}>
          <div className="term-pair"><strong>{entry.source}</strong><span>{entry.target}</span></div>
          <p className="my-terms-meta">{entry.direction === 'en' ? t.directionEn : t.directionZh} · {t.kinds[entry.kind]}</p>
          <div className="finding-actions">
            <button type="button" className="text-button" onClick={() => startEdit(entry)}>{t.edit}<span className="visually-hidden"> {entry.source}</span></button>
            <button type="button" className="text-button" onClick={() => remove(entry.id)}>{t.remove}<span className="visually-hidden"> {entry.source}</span></button>
          </div>
        </li>)}
      </ul>}

      <form className="my-terms-form" onSubmit={submit} aria-labelledby="my-terms-form-title">
        <h3 id="my-terms-form-title">{editing === null ? t.addTitle : fill(t.editTitle, { id: editing })}</h3>
        <label htmlFor="my-terms-source">{t.fieldSource}</label>
        <input ref={sourceInput} id="my-terms-source" value={draft.source} autoComplete="off" onChange={e => setDraft({ ...draft, source: e.target.value })} />
        <label htmlFor="my-terms-target">{t.fieldTarget}</label>
        <input ref={targetInput} id="my-terms-target" value={draft.target} autoComplete="off" onChange={e => setDraft({ ...draft, target: e.target.value })} />
        <label htmlFor="my-terms-direction">{t.fieldDirection}</label>
        <select id="my-terms-direction" value={formDirection} onChange={e => setDraft({ ...draft, direction: e.target.value as TermbaseDirection })}>
          {TERMBASE_DIRECTION_VALUES.map(value => <option key={value} value={value}>{value === 'en' ? t.directionOptionEn : t.directionOptionZh}</option>)}
        </select>
        <label htmlFor="my-terms-kind">{t.fieldKind}</label>
        <select id="my-terms-kind" value={draft.kind} onChange={e => setDraft({ ...draft, kind: e.target.value as TermbaseKind })}>
          {TERMBASE_KIND_VALUES.map(value => <option key={value} value={value}>{t.kinds[value]}</option>)}
        </select>
        <label htmlFor="my-terms-note">{t.fieldNote}</label>
        <input id="my-terms-note" value={draft.note} autoComplete="off" onChange={e => setDraft({ ...draft, note: e.target.value })} />
        <div className="my-terms-actions">
          <button type="submit">{editing === null ? t.add : t.update}</button>
          {editing !== null && <button type="button" className="secondary-button" onClick={cancelEdit}>{t.cancelEdit}</button>}
        </div>
      </form>
    </div>
  </section>;
}
