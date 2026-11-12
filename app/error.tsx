"use client";

import Link from 'next/link';
import { useEffect } from 'react';
import { msg } from '@/lib/messages';
import { useUiLanguage } from './components/ui-language-context';

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { lang } = useUiLanguage();
  const m = msg(lang);
  useEffect(() => { console.error(error); }, [error]);
  return (
    <main id="top" className="site-main">
      <section className="workspace-card not-found-card">
        <p className="eyebrow">{m.errorPage.kicker}</p>
        <h1>{m.errorPage.title}</h1>
        <p className="card-intro">{m.errorPage.body}</p>
        <div className="error-actions">
          <button className="chip-button" type="button" onClick={reset}>{m.errorPage.retry}</button>
          <Link className="text-button" href="/">{m.errorPage.home}</Link>
        </div>
      </section>
    </main>
  );
}
