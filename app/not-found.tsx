import Link from 'next/link';
import { msg } from '@/lib/messages';
import { uiLanguageOrZh } from '@/lib/ui-language';
import { readUiLanguage } from './ui-language-server';

export default async function NotFound() {
  const m = msg(uiLanguageOrZh(await readUiLanguage()));
  return (
    <main id="top" className="site-main">
      <section className="workspace-card not-found-card">
        <p className="eyebrow">{m.notFound.kicker}</p>
        <h1>{m.notFound.title}</h1>
        <p className="card-intro">{m.notFound.body}</p>
        <Link className="chip-button" href="/">{m.notFound.home}</Link>
      </section>
    </main>
  );
}
