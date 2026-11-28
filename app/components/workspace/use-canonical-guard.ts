'use client';

import { useEffect, useRef, useState } from 'react';
import { createCanonicalComputer, type CanonicalComputer } from '../../../lib/canonical-worker-client';
import { leaveGuardActive, manuscriptSaveView } from '../../../lib/manuscript.js';
import type { Choice, Draft, SemanticState, SessionBasis, Snapshot } from '../../../lib/workbench-model';

function unloadUrl(anchor: HTMLAnchorElement): string | null {
  if (anchor.hasAttribute('download') || anchor.target === '_blank') return null;
  const raw = anchor.getAttribute('href');
  if (!raw || raw.startsWith('#')) return null;
  let url: URL;
  try { url = new URL(anchor.href, window.location.href); } catch { return null; }
  if (url.origin === window.location.origin && url.pathname === window.location.pathname && url.search === window.location.search) return null;
  return url.href;
}

export function useCanonicalAndLeaveGuard(options: {
  holdsWork: boolean;
  draft: Draft;
  choices: Choice[];
  reports: Snapshot[];
  semantic: SemanticState;
  basis: SessionBasis;
  importedCanonical: string | null;
  downloadedCanonical: string | null;
  resetSignal: number;
  checkInFlight: boolean;
}) {
  const {
    holdsWork, draft, choices, reports, semantic, basis,
    importedCanonical, downloadedCanonical, resetSignal, checkInFlight,
  } = options;

  const [pendingLeaveUrl, setPendingLeaveUrl] = useState<string | null>(null);
  const leaveDialog = useRef<HTMLDialogElement>(null);
  const stayLeaveButton = useRef<HTMLButtonElement>(null);
  const leaveBypass = useRef(false);

  const canonicalComputerRef = useRef<CanonicalComputer | null>(null);
  const canonicalGenRef = useRef(0);
  const canonicalPendingRef = useRef(false);
  const prevSavedMarkersRef = useRef({ importedCanonical, downloadedCanonical, resetSignal });
  const [canonicalState, setCanonicalState] = useState<{
    value: string | null;
    computed: boolean;
    forDraft: Draft | null;
    forChoices: Choice[] | null;
    forReports: Snapshot[] | null;
    forSemantic: SemanticState | null;
    forBasis: SessionBasis | null;
  }>({
    value: null,
    computed: false,
    forDraft: null,
    forChoices: null,
    forReports: null,
    forSemantic: null,
    forBasis: null,
  });

  useEffect(() => {
    const computer = createCanonicalComputer();
    canonicalComputerRef.current = computer;
    return () => {
      computer.dispose();
      canonicalComputerRef.current = null;
    };
  }, []);

  // Offload expensive canonicalOf() serialization/validation to a debounced Web Worker
  // (small drafts stay on a microtask with zero Worker network overhead) and bind
  // each result strictly to its exact manuscript snapshot.
  useEffect(() => {
    if (!holdsWork) {
      canonicalGenRef.current += 1;
      canonicalPendingRef.current = false;
      const timer = setTimeout(() => {
        setCanonicalState(prev => (!prev.computed && prev.value === null ? prev : {
          value: null,
          computed: false,
          forDraft: null,
          forChoices: null,
          forReports: null,
          forSemantic: null,
          forBasis: null,
        }));
      }, 0);
      return () => clearTimeout(timer);
    }
    const gen = ++canonicalGenRef.current;
    canonicalPendingRef.current = true;
    const markersChanged =
      prevSavedMarkersRef.current.importedCanonical !== importedCanonical
      || prevSavedMarkersRef.current.downloadedCanonical !== downloadedCanonical
      || prevSavedMarkersRef.current.resetSignal !== resetSignal;
    prevSavedMarkersRef.current = { importedCanonical, downloadedCanonical, resetSignal };
    const delayMs = markersChanged ? 0 : 120;
    const inputSnap = { draft, choices, reports, semantic, basis };
    const timer = setTimeout(() => {
      const computer = canonicalComputerRef.current ?? createCanonicalComputer({ disableWorker: true });
      void computer.compute(inputSnap).then(result => {
        if (canonicalGenRef.current !== gen) return;
        canonicalPendingRef.current = false;
        setCanonicalState({
          value: result,
          computed: true,
          forDraft: inputSnap.draft,
          forChoices: inputSnap.choices,
          forReports: inputSnap.reports,
          forSemantic: inputSnap.semantic,
          forBasis: inputSnap.basis,
        });
      });
    }, delayMs);
    return () => clearTimeout(timer);
  }, [holdsWork, draft, choices, reports, semantic, basis, importedCanonical, downloadedCanonical, resetSignal]);

  const canonicalMatchesCurrent = canonicalState.computed
    && canonicalState.forDraft === draft
    && canonicalState.forChoices === choices
    && canonicalState.forReports === reports
    && canonicalState.forSemantic === semantic
    && canonicalState.forBasis === basis;
  const canonical = canonicalMatchesCurrent ? canonicalState.value : null;
  const saveView = !holdsWork
    ? 'empty'
    : !canonicalMatchesCurrent
      ? (importedCanonical !== null || downloadedCanonical !== null ? 'diverged' : 'page-only')
      : manuscriptSaveView({ holdsWork, canonical, importedCanonical, downloadedCanonical });
  const guard = leaveGuardActive({ view: saveView, checkInFlight });
  const liveLeaveGuardRef = useRef(() => guard);
  useEffect(() => {
    liveLeaveGuardRef.current = () => {
      if (!holdsWork) return checkInFlight;
      const latestCanonical = !canonicalMatchesCurrent || canonicalPendingRef.current
        ? (canonicalComputerRef.current ?? createCanonicalComputer({ disableWorker: true })).computeSync({ draft, choices, reports, semantic, basis })
        : canonicalState.value;
      const liveView = manuscriptSaveView({ holdsWork, canonical: latestCanonical, importedCanonical, downloadedCanonical });
      return leaveGuardActive({ view: liveView, checkInFlight });
    };
  });

  useEffect(() => {
    if (pendingLeaveUrl) {
      if (!leaveDialog.current?.open) leaveDialog.current?.showModal();
      stayLeaveButton.current?.focus();
    } else leaveDialog.current?.close();
  }, [pendingLeaveUrl]);

  useEffect(() => {
    function onClick(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (!(event.target instanceof Element)) return;
      const anchor = event.target.closest('a');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const url = unloadUrl(anchor);
      if (!url) return;
      if (!liveLeaveGuardRef.current()) return;
      event.preventDefault();
      event.stopPropagation();
      setPendingLeaveUrl(url);
    }
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  useEffect(() => {
    function onPageShow() { leaveBypass.current = false; setPendingLeaveUrl(null); }
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

  useEffect(() => {
    function onBeforeUnload(event: BeforeUnloadEvent) {
      if (leaveBypass.current) return;
      if (!liveLeaveGuardRef.current()) return;
      event.preventDefault();
      event.returnValue = '1';
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  function leaveAnyway() {
    const url = pendingLeaveUrl;
    if (!url) { setPendingLeaveUrl(null); return; }
    leaveBypass.current = true;
    window.location.assign(url);
  }

  return {
    canonical,
    saveView,
    guard,
    pendingLeaveUrl,
    setPendingLeaveUrl,
    leaveDialog,
    stayLeaveButton,
    leaveAnyway,
  };
}
