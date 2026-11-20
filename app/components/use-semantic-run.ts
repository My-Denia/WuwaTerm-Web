'use client';

import { useEffect, useReducer, useRef, useState, type MutableRefObject } from 'react';
import { initialRun, nextToSend, runReducer } from '../../lib/semantic-run.js';

export type RunItem = { key: string; index: number; status: string; code: string | null; attempt?: number; waited?: number | null };
export type RunState = { kind: 'term' | 'semantic' | 'translate' | null; phase: string; items: RunItem[]; waitUntil: number | null; stopCode: string | null; stopRequestId?: string | null };
type RunKind = Exclude<RunState['kind'], null>;
type Runner = (item: RunItem, signal: AbortSignal, generation: number) => Promise<void>;

/** Owns the serial run, its timer and request lifetime. The callers own request meaning. */
export function useSemanticRun(resetSignal: number, documentEpoch: MutableRefObject<number>) {
  const [run, dispatch] = useReducer(runReducer as (state: RunState, event: Record<string, unknown>) => RunState, undefined, initialRun as () => RunState);
  const generation = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const inflight = useRef<{ key: string; attempt: number } | null>(null);
  const runners = useRef<Record<RunKind, Runner> | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const fail = (event: Record<string, unknown> & { now: number }) => { setNow(event.now); dispatch(event); };
  const isLive = (requestGeneration: number) => generation.current === requestGeneration;

  useEffect(() => {
    generation.current += 1;
    abort.current?.abort();
    abort.current = null;
    inflight.current = null;
  }, [resetSignal]);
  useEffect(() => () => { abort.current?.abort(); }, []);
  useEffect(() => {
    if (run.phase !== 'waiting' || run.waitUntil === null) return;
    const tick = () => {
      setNow(Date.now());
      if (Date.now() >= (run.waitUntil ?? 0)) dispatch({ type: 'resume' });
    };
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 1000);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [run.phase, run.waitUntil]);
  useEffect(() => {
    const item = nextToSend(run, inflight.current) as RunItem | null;
    if (!item || !runners.current) return;
    inflight.current = { key: item.key, attempt: (item.attempt ?? 0) + 1 };
    dispatch({ type: 'sent', key: item.key });
    const controller = new AbortController();
    abort.current = controller;
    const currentGeneration = generation.current;
    const currentEpoch = documentEpoch.current;
    const runner = runners.current[run.kind ?? 'semantic'];
    void runner(item, controller.signal, currentGeneration).catch(() => {
      if (generation.current === currentGeneration && documentEpoch.current === currentEpoch) {
        fail({ type: 'failed', key: item.key, code: 'requestFailed', classification: { action: 'stop' }, now: Date.now() });
      }
    }).finally(() => {
      if (abort.current === controller) abort.current = null;
    });
  }, [run, documentEpoch]);

  const start = (kind: RunKind, items: { key: string; index: number }[]) => {
    generation.current += 1;
    abort.current?.abort();
    inflight.current = null;
    dispatch({ type: 'start', kind, items });
  };
  return { run, dispatch, now, fail, isLive, start, runners };
}
