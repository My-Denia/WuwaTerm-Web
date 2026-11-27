'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import { categoryLabel, reasonLabel } from '../../lib/dictionary-labels';
import { fill, msg } from '../../lib/messages';
import { useRuntimeStore } from '../../lib/runtime-provider';
import { workbenchPath } from '../../lib/ui-runtime';
import { setBrowserQuery, useTermQuery } from '../query-state';
import { FailureView, RequestId, type Failure } from './request-feedback';
import { useUiLanguage } from './ui-language-context';

export type TermMatch = { zh: string; en: string; category: string; reason: string; score: number };
export type TermsResult = { query: string; matches: TermMatch[]; request_id: string };
export type QuickTermLookupState = { kind: 'idle' } | { kind: 'loading' } | { kind: 'success'; data: TermsResult } | { kind: 'error'; error: Failure };
export type QuickTermLookupPersisted = { query: string; terms: QuickTermLookupState; seeded: boolean };
type State = QuickTermLookupState;

const FALLBACK: Failure = { status: 'unavailable', reason: 'site_response_invalid' };
function failure(value: unknown): value is Failure {
  return !!value && typeof value === 'object' && (value as Failure).status === 'unavailable' && typeof (value as Failure).reason === 'string';
}
async function payload(r: Response): Promise<unknown> { try { return await r.json(); } catch { return FALLBACK; } }
function isTerms(v: unknown): v is TermsResult {
  const x = v as TermsResult;
  return !!x && typeof x.request_id === 'string' && Array.isArray(x.matches)
    && x.matches.every(m => typeof m.zh === 'string' && typeof m.en === 'string' && typeof m.category === 'string' && typeof m.reason === 'string' && typeof m.score === 'number');
}

/**
 * The official term lookup. It owns only its query and results; the document is the workspace's. In quick mode a match can
 * be appended to the source and a query without matches can become the source; in manuscript mode the panel folds away so
 * the editors keep the focus, and it offers copying only.
 */
export function QuickTermLookup({ quick, embedded = false, persisted, onPersistedChange, onInsert, onUseQuery }: {
  quick: boolean;
  embedded?: boolean;
  persisted?: QuickTermLookupPersisted;
  onPersistedChange?: (next: QuickTermLookupPersisted) => void;
  onInsert: (text: string) => void;
  onUseQuery: (query: string) => void;
}) {
  const { lang } = useUiLanguage();
  const m = msg(lang);
  const runtime = useRuntimeStore();
  const termQuery = useTermQuery();
  const [localQuery, setLocalQuery] = useState(persisted?.query ?? '');
  const [localTerms, setLocalTerms] = useState<State>(persisted?.terms ?? { kind: 'idle' });
  const query = persisted ? persisted.query : localQuery;
  const terms = persisted ? persisted.terms : localTerms;
  const persistedRef = useRef<QuickTermLookupPersisted>(persisted ?? { query: localQuery, terms: localTerms, seeded: false });
  useEffect(() => {
    persistedRef.current = persisted ?? { query: localQuery, terms: localTerms, seeded: persistedRef.current.seeded };
  }, [persisted, localQuery, localTerms]);

  const setQuery = (nextQuery: string) => {
    if (onPersistedChange) {
      const next = { ...persistedRef.current, query: nextQuery };
      persistedRef.current = next;
      onPersistedChange(next);
    } else {
      setLocalQuery(nextQuery);
    }
  };
  const setTerms = (nextTerms: State) => {
    if (onPersistedChange) {
      const next = { ...persistedRef.current, terms: nextTerms };
      persistedRef.current = next;
      onPersistedChange(next);
    } else {
      setLocalTerms(nextTerms);
    }
  };
  const [open, setOpen] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  // The URL q seeds the first lookup on mount only; later edits own the query.
  const seed = useRef<(text: string) => void>(() => {});
  useEffect(() => () => { controllerRef.current?.abort(); }, []);
  useEffect(() => {
    if (persistedRef.current.seeded) return;
    persistedRef.current = { ...persistedRef.current, seeded: true };
    if (onPersistedChange) onPersistedChange(persistedRef.current);
    const initial = new URLSearchParams(window.location.search).get('q');
    if (initial && initial.trim() && Array.from(initial.trim()).length <= 200) {
      const trimmed = initial.trim();
      const timer = setTimeout(() => {
        setQuery(trimmed);
        seed.current(trimmed);
      }, 0);
      return () => clearTimeout(timer);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runLookup(text: string) {
    const trimmed = text.trim();
    if (!trimmed || Array.from(trimmed).length > 200) return;
    setBrowserQuery(trimmed);
    controllerRef.current?.abort();
    const controller = new AbortController(); controllerRef.current = controller;
    setTerms({ kind: 'loading' });
    try {
      const r = await fetch(workbenchPath('/api/terms') + '?q=' + encodeURIComponent(trimmed), { cache: 'no-store', signal: controller.signal });
      const v = await payload(r);
      if (controller.signal.aborted || controllerRef.current !== controller) return;
      setTerms(r.ok && isTerms(v) ? { kind: 'success', data: v } : { kind: 'error', error: failure(v) ? v : FALLBACK });
      runtime.refreshPool();
    } catch { if (!controller.signal.aborted) setTerms({ kind: 'error', error: FALLBACK }); }
    finally { if (controllerRef.current === controller) controllerRef.current = null; }
  }
  useEffect(() => { seed.current = text => { void runLookup(text); }; });
  function submit(event: FormEvent) {
    event.preventDefault();
    void runLookup(query);
  }
  function clearQuery() {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setQuery('');
    setTerms({ kind: 'idle' });
    setBrowserQuery(null);
  }
  function change(value: string) {
    setQuery(value);
    setTerms({ kind: 'idle' });
    if (!value.trim()) {
      controllerRef.current?.abort();
      controllerRef.current = null;
    }
    // The URL q stands for the submitted lookup whose results this edit just cleared; drop it so no link or refresh can
    // resurrect it. The next submit sets a fresh q.
    if (termQuery) setBrowserQuery(null);
  }

  const shown = quick || embedded || open;
  return <section className={`term-lookup${embedded ? ' inspector-section' : ''}`} data-open={shown ? 'true' : 'false'} aria-labelledby="terms-title">
    <div className="lookup-heading">
      <h2 id="terms-title" tabIndex={-1}>{m.terms.title}</h2>
      {!quick && !embedded && <button type="button" className="text-button" aria-expanded={open} aria-controls="term-lookup-body" onClick={() => setOpen(value => !value)}>{open ? m.workspace.lookupHide : m.workspace.lookupShow}</button>}
    </div>
    <div id="term-lookup-body" hidden={!shown}>
      <form onSubmit={submit}>
        <label htmlFor="term-query" className="visually-hidden">{m.terms.label}</label>
        <div className="input-row">
          <div className="input-wrap">
            <input id="term-query" value={query} onChange={e => change(e.target.value)} placeholder={m.terms.placeholder} autoComplete="off" disabled={terms.kind === 'loading'} />
            {query && <button type="button" className="clear-input" aria-label={m.terms.clearQuery} onClick={clearQuery}>✕</button>}
          </div>
          <button type="submit" disabled={!query.trim() || Array.from(query.trim()).length > 200 || terms.kind === 'loading'}>{terms.kind === 'loading' ? m.terms.buttonLoading : m.terms.buttonIdle}</button>
        </div>
        <p className="field-hint">{m.terms.hint}</p>
      </form>
      <TermsView state={terms} quick={quick} onUseQuery={() => onUseQuery(query)} onInsert={onInsert} />
    </div>
  </section>;
}

function TermsView({ state, quick, onUseQuery, onInsert }: { state: State; quick: boolean; onUseQuery: () => void; onInsert: (text: string) => void }) {
  const { lang } = useUiLanguage();
  const m = msg(lang);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  async function copyText(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(current => current === key ? null : current), 2000);
    } catch { /* clipboard unavailable: the text stays selectable */ }
  }

  if (state.kind === 'idle') return <p className="lookup-empty">{m.terms.emptyBody}</p>;
  if (state.kind === 'loading') return <p className="lookup-empty" role="status">{m.terms.loading}</p>;
  if (state.kind === 'error') return <FailureView value={state.error} />;
  if (!state.data.matches.length) return <div className="lookup-empty"><p>{m.terms.noneFound}</p>{quick && <button className="text-button" type="button" onClick={onUseQuery}>{m.terms.noneAction}</button>}</div>;
  const chip = (key: string) => `chip-button ${copiedKey === key ? 'chip-copied' : ''}`;
  return <div className="terms-results" aria-live="polite">
    <p className="result-summary">{fill(m.terms.matchesFound, { n: state.data.matches.length })}</p>
    {state.data.matches.map((match, i) => <article className="term-result" key={i}>
      <div className="term-pair"><strong>{match.zh}</strong><span>{match.en}</span></div>
      <dl><div><dt>{m.terms.category}</dt><dd>{categoryLabel(lang, match.category)}</dd></div><div><dt>{m.terms.matchReason}</dt><dd>{reasonLabel(lang, match.reason)}</dd></div><div><dt>{m.terms.matchScore}</dt><dd>{match.score}</dd></div></dl>
      <div className="term-actions">
        <button type="button" className={chip(`${i}-zh`)} onClick={() => void copyText(`${i}-zh`, match.zh)}>{copiedKey === `${i}-zh` ? m.terms.copied : m.terms.copyZh}</button>
        <button type="button" className={chip(`${i}-en`)} onClick={() => void copyText(`${i}-en`, match.en)}>{copiedKey === `${i}-en` ? m.terms.copied : m.terms.copyEn}</button>
        <button type="button" className={chip(`${i}-pair`)} onClick={() => void copyText(`${i}-pair`, `${match.zh} (${match.en})`)}>{copiedKey === `${i}-pair` ? m.terms.copied : m.terms.copyPair}</button>
        {quick && <button type="button" className="chip-button" onClick={() => onInsert(match.zh)}>{m.terms.useInTranslation}</button>}
      </div>
    </article>)}
    <RequestId value={state.data.request_id} />
  </div>;
}
