// Debounced Web Worker client for canonical manuscript serialization.
// Transparently falls back to an async microtask in Node/test/SSR environments
// or if Worker construction fails, and exposes a synchronous flush helper for
// save/leave-guard boundaries. Zero React imports.
import { canonicalOf } from './workbench-store.ts';
import type { Choice, Draft, SemanticState, SessionBasis, Snapshot } from './workbench-model.ts';

export type CanonicalInput = {
  draft: Draft;
  choices: Choice[];
  reports: Snapshot[];
  semantic: SemanticState;
  basis: SessionBasis;
};

export type CanonicalComputer = {
  /** Compute canonical manuscript asynchronously (off-main-thread when Worker is available). */
  compute(input: CanonicalInput): Promise<string | null>;
  /** Compute canonical manuscript synchronously (for save/leave-guard confirmation). */
  computeSync(input: CanonicalInput): string | null;
  /** Terminate any backing Worker and reject/cancel pending waiters cleanly. */
  dispose(): void;
};

type PendingResolver = {
  resolve: (value: string | null) => void;
};

export function createCanonicalComputer(options: { disableWorker?: boolean } = {}): CanonicalComputer {
  let worker: Worker | null = null;
  let workerBroken = options.disableWorker === true;
  let nextId = 0;
  let disposed = false;
  const pending = new Map<number, PendingResolver>();

  function failWorkerToFallback() {
    workerBroken = true;
    if (worker) {
      try { worker.terminate(); } catch { /* ignore */ }
      worker = null;
    }
    for (const [id, entry] of pending) {
      pending.delete(id);
      entry.resolve(null);
    }
  }

  function ensureWorker(): Worker | null {
    if (disposed || workerBroken) return null;
    if (worker) return worker;
    if (typeof window === 'undefined' || typeof Worker === 'undefined') {
      workerBroken = true;
      return null;
    }
    try {
      const instance = new Worker(new URL('./canonical.worker.ts', import.meta.url), { type: 'module' });
      instance.addEventListener('message', (event: MessageEvent<{ id: number; canonical: string | null }>) => {
        const entry = pending.get(event.data.id);
        if (!entry) return;
        pending.delete(event.data.id);
        entry.resolve(event.data.canonical);
      });
      instance.addEventListener('error', () => {
        failWorkerToFallback();
      });
      worker = instance;
      return worker;
    } catch {
      workerBroken = true;
      return null;
    }
  }

  return {
    compute(input: CanonicalInput): Promise<string | null> {
      if (disposed) return Promise.resolve(null);
      const instance = ensureWorker();
      if (!instance) {
        return Promise.resolve().then(() => {
          if (disposed) return null;
          return canonicalOf(input.draft, input.choices, input.reports, input.semantic, input.basis);
        });
      }
      const id = ++nextId;
      return new Promise<string | null>(resolve => {
        pending.set(id, { resolve });
        try {
          instance.postMessage({
            id,
            draft: input.draft,
            choices: input.choices,
            reports: input.reports,
            semantic: input.semantic,
            basis: input.basis,
          });
        } catch {
          pending.delete(id);
          failWorkerToFallback();
          resolve(canonicalOf(input.draft, input.choices, input.reports, input.semantic, input.basis));
        }
      });
    },
    computeSync(input: CanonicalInput): string | null {
      return canonicalOf(input.draft, input.choices, input.reports, input.semantic, input.basis);
    },
    dispose(): void {
      disposed = true;
      if (worker) {
        try { worker.terminate(); } catch { /* ignore */ }
        worker = null;
      }
      pending.clear();
    },
  };
}
