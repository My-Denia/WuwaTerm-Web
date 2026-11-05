'use client';

import { useEffect, useState } from 'react';
import { POOL_LIMITS as limits } from '../../lib/shared-pool.js';
import { fill, msg } from '../../lib/messages';
import { isPool, type Pool } from '../../lib/pool-snapshot';
import { numberLocale } from '../../lib/ui-language';
import { isSelfHosted, workbenchPath } from '../../lib/ui-runtime';
import { useTermQuery, withQuery } from '../query-state';
import { useUiLanguage } from './ui-language-context';
import { LanguageToggle } from './language-toggle';

export function LimitsBody() {
  const { lang } = useUiLanguage();
  const m = msg(lang);
  const locale = numberLocale(lang);
  const termQuery = useTermQuery();
  const selfhost = isSelfHosted();
  const [instance, setInstance] = useState<{ kind: 'loading' | 'error' } | { kind: 'success'; data: Pool }>({ kind: 'loading' });
  // Keep the tab title in step with an in-place language switch.
  useEffect(() => { document.title = m.limits.title; }, [lang, m.limits.title]);
  useEffect(() => {
    if (!selfhost) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(workbenchPath('/api/pool'), { cache: 'no-store', signal: controller.signal });
        const value: unknown = await response.json();
        if (!controller.signal.aborted) setInstance(response.ok && isPool(value) && value.shared === false ? { kind: 'success', data: value } : { kind: 'error' });
      } catch { if (!controller.signal.aborted) setInstance({ kind: 'error' }); }
    })();
    return () => controller.abort();
  }, [selfhost]);
  const local = instance.kind === 'success' ? instance.data : null;
  const localUpstream = local?.upstream?.limit;
  const terms = selfhost ? local?.terms.limit : limits.termsPerDay;
  const translations = selfhost ? local?.translations.limit : limits.translationsPerDay;
  const characters = selfhost ? local?.characters.limit : limits.charactersPerDay;
  const reviews = selfhost ? local?.reviews.limit : limits.reviewsPerDay;
  const upstream = selfhost ? (Number.isSafeInteger(localUpstream) && (localUpstream ?? 0) > 0 ? localUpstream : undefined) : limits.upstreamPerMinute;
  return <main className="document"><div className="document-top"><a className="back-link" href={withQuery('/', termQuery)}>{m.nav.back}</a><LanguageToggle /></div><p className="eyebrow">{m.limits.eyebrow}</p><h1>{m.limits.h1}</h1><p className="document-lead">{m.limits.lead}</p>
    <section><h2>{m.limits.s1h}</h2><table><thead><tr><th>{m.limits.tableFeature}</th><th>{m.limits.tableCeiling}</th></tr></thead><tbody>
      <tr><td>{m.limits.rowTerms}</td><td>{terms === undefined ? '—' : fill(m.limits.rowTermsCeiling, { n: terms })}</td></tr>
      <tr><td>{m.limits.rowTranslation}</td><td>{translations === undefined || characters === undefined ? '—' : fill(m.limits.rowTranslationCeiling, { n: translations, chars: characters.toLocaleString(locale) })}</td></tr>
      <tr><td>{m.limits.rowReview}</td><td>{reviews === undefined ? '—' : fill(m.limits.rowReviewCeiling, { n: reviews })}</td></tr>
      <tr><td>{m.limits.rowAll}</td><td>{upstream === undefined ? '—' : fill(m.limits.rowAllCeiling, { n: upstream })}</td></tr>
      <tr><td>{m.limits.rowWindow}</td><td>{selfhost ? m.limits.rowWindowCeiling : fill(m.limits.rowWindowCeiling, { n: limits.translationsPerMinute })}</td></tr>
    </tbody></table>{selfhost && instance.kind !== 'success' && <p role="status">{instance.kind === 'loading' ? m.pool.loading : m.pool.unavailable}</p>}<p>{m.limits.s1p}</p></section>
    <section><h2>{m.limits.s2h}</h2><p>{m.limits.s2p}</p></section>
    <section><h2>{m.limits.s3h}</h2><p>{m.limits.s3p1}</p><p>{m.limits.s3p2}</p></section>
    <section><h2>{m.limits.s4h}</h2><p>{m.limits.s4p1}</p><p>{m.limits.s4p2}</p></section>
    <section><h2>{m.limits.s5h}</h2><p>{m.limits.s5p1}</p><p>{m.limits.s5p2}</p></section>
    <footer><a href={withQuery('/privacy', termQuery)}>{m.limits.footerPrivacy}</a> · {m.limits.footerUpdated}</footer>
  </main>;
}
