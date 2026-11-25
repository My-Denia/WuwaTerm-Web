'use client';

import { useEffect, useRef, useState } from 'react';
import { fill, msg } from '../../lib/messages';
import { useRuntime, useRuntimeStore } from '../../lib/runtime-provider';
import { CAPABILITY_TRANSLATION_CONTEXT } from '../../lib/semantic-review.js';
import { numberLocale } from '../../lib/ui-language';
import { useTermQuery, withQuery } from '../query-state';
import { DictionaryProvenance } from './dictionary-provenance';
import { useUiLanguage } from './ui-language-context';

export type SaveView = 'empty' | 'page-only' | 'matches-import' | 'matches-download' | 'diverged' | 'not-serializable';

/**
 * One compact line of what the workspace runs on: the pool snapshot, the dictionary, the negotiated capabilities and
 * whether the manuscript is saved. The explanations behind each (the shared-pool notice, every allowance, the dictionary
 * provenance and the product notes) sit in a drawer that opens on request, so the editors stay the page's focus.
 */
export function RuntimeStatus({ saveView, reportCommit }: { saveView: SaveView; reportCommit: string | null }) {
  const { lang } = useUiLanguage();
  const m = msg(lang);
  const w = m.workspace;
  const locale = numberLocale(lang);
  const runtime = useRuntimeStore();
  const { pool, capabilities, meta } = useRuntime();
  const termQuery = useTermQuery();
  const drawer = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    if (drawerOpen) { if (!drawer.current?.open) drawer.current?.showModal(); }
    else if (drawer.current?.open) drawer.current.close();
  }, [drawerOpen]);

  const dictionary = meta.kind === 'success'
    ? (meta.data.game_version && meta.data.game_version !== 'unavailable' ? meta.data.game_version : meta.data.source_commit?.slice(0, 12) ?? w.dictionaryUnread)
    : reportCommit ? reportCommit.slice(0, 12) : w.dictionaryUnread;
  const capabilityText = capabilities === null ? w.capabilitiesLoading
    : [w.capabilityTerms,
      ...(capabilities.includes('semantic-review-v1') ? [w.capabilitySemantic] : []),
      ...(capabilities.includes(CAPABILITY_TRANSLATION_CONTEXT) ? [w.capabilityContext] : [])].join(' · ');
  const data = pool.kind === 'success' ? pool.data : null;

  return <>
    <div className="runtime-status" role="group" aria-label={w.statusAria}>
      <div className="pool-strip status-item" aria-live="polite" aria-label={m.pool.stripAria}>
        <span className="status-label">{w.statusPool}</span>
        {data ? <span className="status-value">
          {w.poolTerms} <strong>{data.terms.remaining}</strong><small>/{data.terms.limit}</small>
          {' · '}{w.poolTranslations} <strong>{data.translation_enabled ? data.translations.remaining : w.poolClosed}</strong>{data.translation_enabled && <small>/{data.translations.limit}</small>}
          {' · '}{w.poolCharacters} <strong>{data.characters.remaining.toLocaleString(locale)}</strong>
          {' · '}{w.poolReviews} <strong>{data.reviews.remaining}</strong><small>/{data.reviews.limit}</small>
        </span> : <span className="status-value">{pool.kind === 'error' ? m.pool.unavailable : m.pool.loading}</span>}
        <button className="text-button" type="button" onClick={() => runtime.refreshPool()}>{m.pool.refresh}</button>
      </div>
      <div className="status-item"><span className="status-label">{w.statusDictionary}</span><span className="status-value">{dictionary}</span></div>
      <div className="status-item"><span className="status-label">{w.statusCapabilities}</span><span className="status-value">{capabilityText}</span></div>
      <div className="status-item" data-save={saveView}><span className="status-label">{w.statusSave}</span><span className="status-value">{w.saveShort[saveView]}</span></div>
      <button ref={opener} className="secondary-button status-details" type="button" aria-haspopup="dialog" onClick={() => setDrawerOpen(true)}>{w.details}</button>
    </div>
    <dialog ref={drawer} className="runtime-drawer" aria-labelledby="runtime-drawer-title" onClose={() => { setDrawerOpen(false); opener.current?.focus({ preventScroll: true }); }}>
      <div className="drawer-head">
        <h2 id="runtime-drawer-title">{w.drawerTitle}</h2>
        <button type="button" className="secondary-button" onClick={() => setDrawerOpen(false)}>{w.drawerClose}</button>
      </div>
      <section className="drawer-section" aria-label={m.pool.noticeAria}>
        <h3>{m.pool.noticeTitle}</h3>
        <p>{m.pool.noticeBody} <a href={withQuery('/limits', termQuery)}>{m.pool.noticeLink}</a></p>
        {data ? <dl className="drawer-pool">
          <div><dt>{m.pool.termsLabel}</dt><dd>{data.terms.remaining}{' / ' + data.terms.limit + m.pool.termsUnit}</dd></div>
          <div><dt>{m.pool.translationsLabel}</dt><dd>{data.translation_enabled ? `${data.translations.remaining} / ${data.translations.limit}` : m.pool.translationsClosed}</dd></div>
          <div><dt>{m.pool.charactersLabel}</dt><dd>{data.characters.remaining.toLocaleString(locale)}{m.pool.charactersUnit}</dd></div>
          <div><dt>{m.pool.reviewsLabel}</dt><dd>{fill('{n} / {limit}', { n: data.reviews.remaining, limit: data.reviews.limit })}{m.pool.termsUnit}</dd></div>
        </dl> : <p>{pool.kind === 'error' ? m.pool.unavailable : m.pool.loading}</p>}
        <p className="drawer-note">{m.pool.resetNote}</p>
      </section>
      <section className="drawer-section">
        <h3>{m.provenance.aria}</h3>
        <DictionaryProvenance />
      </section>
      <section className="drawer-section">
        <h3>{w.drawerAbout}</h3>
        <p>{m.translation.intro} {m.review.intro}</p>
        <ul className="drawer-notes">{m.productNotes.map((note, i) => <li key={i}><strong>{note.title}</strong><span>{note.body}</span></li>)}</ul>
      </section>
    </dialog>
  </>;
}
