// Dedicated Web Worker for off-main-thread canonical manuscript serialization.
// Keeps keystroke latency flat on large manuscripts (up to 44 MiB v5 workfiles).
import { canonicalOf } from './workbench-store.ts';
import type { Choice, Draft, SemanticState, SessionBasis, Snapshot } from './workbench-model.ts';

type CanonicalWorkerRequest = {
  id: number;
  draft: Draft;
  choices: Choice[];
  reports: Snapshot[];
  semantic: SemanticState;
  basis: SessionBasis;
};

type CanonicalWorkerResponse = {
  id: number;
  canonical: string | null;
};

self.addEventListener('message', (event: MessageEvent<CanonicalWorkerRequest>) => {
  const { id, draft, choices, reports, semantic, basis } = event.data;
  const canonical = canonicalOf(draft, choices, reports, semantic, basis);
  const reply: CanonicalWorkerResponse = { id, canonical };
  self.postMessage(reply);
});
