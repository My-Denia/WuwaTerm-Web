'use client';

import { useState } from 'react';
import { msg } from '../../lib/messages';
import { useRuntime, useRuntimeStore } from '../../lib/runtime-provider';
import { numberLocale } from '../../lib/ui-language';
import { useUiLanguage } from './ui-language-context';

/**
 * The dictionary data the running service reports. Each read counts against the dictionary-info quota, so the runtime store
 * reads it only when asked here and keeps it: collapsing and opening again shows the kept reading without a request.
 */
export function DictionaryProvenance() {
  const { lang } = useUiLanguage();
  const m = msg(lang);
  const runtime = useRuntimeStore();
  const { meta } = useRuntime();
  const [open, setOpen] = useState(false);

  function reported(value: string | null): string {
    if (value === null) return m.provenance.notProvided;
    if (value === 'unavailable') return m.provenance.notRecorded;
    return value;
  }

  function plain(value: string | null): string {
    return value === null ? m.provenance.plainNotProvided : value;
  }

  function load(force: boolean) {
    setOpen(true);
    void runtime.loadMeta(force);
  }

  return (
    <section className="provenance" id="provenance-section" aria-label={m.provenance.aria}>
      <p>{m.provenance.intro}</p>
      <div className="provenance-actions">
        <button className="secondary-button" type="button" onClick={() => load(false)}>{m.provenance.open}</button>
      </div>
      {open && (
        <>
          <p>{m.provenance.quotaNote}</p>
          {meta.kind === 'loading' && <p role="status">{m.provenance.loading}</p>}
          {meta.kind === 'error' && <p role="status">{m.provenance.error}</p>}
          {meta.kind === 'success' && (
            <dl>
              <div className="provenance-row"><dt>{m.provenance.game}</dt><dd>{reported(meta.data.game_version)}</dd></div>
              <div className="provenance-row"><dt>{m.provenance.resource}</dt><dd>{reported(meta.data.resource_version)}</dd></div>
              <div className="provenance-row"><dt>{m.provenance.changelist}</dt><dd>{reported(meta.data.changelist)}</dd></div>
              <div className="provenance-row"><dt>{m.provenance.sourceCommit}</dt><dd>{plain(meta.data.source_commit)}</dd></div>
              <div className="provenance-row"><dt>{m.provenance.terms}</dt><dd>{meta.data.term_count.toLocaleString(numberLocale(lang))}</dd></div>
              <div className="provenance-row"><dt>{m.provenance.schema}</dt><dd>{plain(meta.data.schema_version)}</dd></div>
              <div className="provenance-row"><dt>{m.provenance.requestId}</dt><dd>{meta.data.request_id}</dd></div>
            </dl>
          )}
          <div className="provenance-actions">
            <button className="secondary-button" type="button" disabled={meta.kind === 'loading'} onClick={() => load(true)}>{m.provenance.reread}</button>
            <button className="secondary-button" type="button" onClick={() => setOpen(false)}>{m.provenance.collapse}</button>
          </div>
        </>
      )}
    </section>
  );
}
