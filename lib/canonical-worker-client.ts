// Debounced Web Worker client for canonical manuscript serialization.
// Small drafts compute asynchronously on a microtask without spawning a Worker
// (avoiding unnecessary worker script fetches during lightweight quick-mode work);
// large or multi-segment manuscripts offload to a dedicated module Worker.
// Transparently falls back to synchronous canonicalOf() in Node/test/SSR or on
// async Worker error, preserving exact canonical results for in-flight requests.
// Zero React imports.
import { canonicalOf } from './workbench-store.ts';
import type { Choice, Draft, SemanticState, SessionBasis, Snapshot } from './workbench-model.ts';

export const WORKER_OFFLOAD_CHAR_THRESHOLD = 4000;

export type CanonicalInput = {
  draft: Draft;
  choices: Choice[];
  reports: Snapshot[];
  semantic: SemanticState;
  basis: SessionBasis;
};

export type CanonicalComputer = {
  /** Compute canonical manuscript asynchronously (off-main-thread when Worker is available and needed). */
  compute(input: CanonicalInput): Promise<string | null>;
  /** Compute canonical manuscript synchronously (for save/leave-guard confirmation). */
  computeSync(input: CanonicalInput): string | null;
  /** Terminate any backing Worker and cancel pending waiters cleanly. */
  dispose(): void;
};

export type CanonicalComputerOptions = {
  disableWorker?: boolean;
  /** Override threshold (in UTF-16 code units) for spawning the Web Worker; defaults to WORKER_OFFLOAD_CHAR_THRESHOLD. */
  offloadCharThreshold?: number;
  /** Injectable Worker constructor for deterministic unit testing of async error fallback. */
  workerFactory?: () => Worker;
};

type PendingResolver = {
  input: CanonicalInput;
  resolve: (value: string | null) => void;
};

export function shouldOffloadCanonicalToWorker(
  input: CanonicalInput,
  charThreshold = WORKER_OFFLOAD_CHAR_THRESHOLD,
): boolean {
  const textLen = input.draft.source.length + input.draft.target.length;
  return textLen >= charThreshold
    || input.reports.length > 2
    || input.semantic.long.records.length > 0
    || input.semantic.results.length > 2;
}

function runSync(input: CanonicalInput): string | null {
  return canonicalOf(input.draft, input.choices, input.reports, input.semantic, input.basis);
}

export function createCanonicalComputer(options: CanonicalComputerOptions = {}): CanonicalComputer {
  const charThreshold = options.offloadCharThreshold ?? WORKER_OFFLOAD_CHAR_THRESHOLD;
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
    const entries = [...pending.entries()];
    pending.clear();
    for (const [, entry] of entries) {
      if (disposed) {
        entry.resolve(null);
      } else {
        entry.resolve(runSync(entry.input));
      }
    }
  }

  function ensureWorker(): Worker | null {
    if (disposed || workerBroken) return null;
    if (worker) return worker;
    if (!options.workerFactory && (typeof window === 'undefined' || typeof Worker === 'undefined')) {
      workerBroken = true;
      return null;
    }
    try {
      const instance = options.workerFactory
        ? options.workerFactory()
        : new Worker(new URL('./canonical.worker.ts', import.meta.url), { type: 'module' });
      instance.addEventListener('message', (event: MessageEvent<{ id: number; canonical: string | null }>) => {
        const entry = pending.get(event.data.id);
        if (!entry) return;
        pending.delete(event.data.id);
        entry.resolve(event.data.canonical);
      });
      instance.addEventListener('error', () => {
        failWorkerToFallback();
      });
      instance.addEventListener('messageerror', () => {
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
      if (!shouldOffloadCanonicalToWorker(input, charThreshold)) {
        return Promise.resolve().then(() => (disposed ? null : runSync(input)));
      }
      const instance = ensureWorker();
      if (!instance) {
        return Promise.resolve().then(() => (disposed ? null : runSync(input)));
      }
      const id = ++nextId;
      return new Promise<string | null>(resolve => {
        pending.set(id, { input, resolve });
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
          resolve(disposed ? null : runSync(input));
        }
      });
    },
    computeSync(input: CanonicalInput): string | null {
      return runSync(input);
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
