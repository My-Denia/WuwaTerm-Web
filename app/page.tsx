import { DocumentWorkspace } from './components/document-workspace';
import { SiteChrome } from './components/site-chrome';
import { RuntimeProvider } from '../lib/runtime-provider';

export default function Home() {
  return (
    <main id="top" className="site-main">
      <RuntimeProvider>
        <SiteChrome>
          <DocumentWorkspace />
        </SiteChrome>
      </RuntimeProvider>
    </main>
  );
}
