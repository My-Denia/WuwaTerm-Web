'use client';

import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { RuntimeStore, type RuntimeSnapshot } from './runtime-store';

const RuntimeContext = createContext<RuntimeStore | null>(null);

/**
 * Holds the page's one RuntimeStore. The store outlives React's development double mount, and `start` is idempotent, so
 * a page load reads the pool once and capabilities once however many views ask.
 */
export function RuntimeProvider({ children, pool = true }: { children: ReactNode; pool?: boolean }) {
  const [store] = useState(() => new RuntimeStore({ pool }));
  useEffect(() => { store.start(); }, [store]);
  return <RuntimeContext.Provider value={store}>{children}</RuntimeContext.Provider>;
}

export function useRuntimeStore(): RuntimeStore {
  const store = useContext(RuntimeContext);
  if (!store) throw new Error('useRuntimeStore must be used inside RuntimeProvider');
  return store;
}

export function useRuntime(): RuntimeSnapshot {
  const store = useRuntimeStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
