'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkbenchController } from '../../../lib/workbench-controller';
import type { Candidate, Choice, Draft, Finding, Snapshot, Span } from '../../../lib/workbench-model';
import type { RevisionIntent } from './workspace-dialogs';

export function useRevisionDialog(options: {
  doc: WorkbenchController;
  draft: Draft;
  choices: Choice[];
  imported: Choice[];
  reports: Snapshot[];
  generation: number;
  inFlight: boolean;
  onRevealTarget: (span: Span) => void;
}) {
  const { doc, draft, choices, imported, reports, generation, inFlight, onRevealTarget } = options;
  const [revision, setRevision] = useState<RevisionIntent | null>(null);
  const revisionRef = useRef<RevisionIntent | null>(null);
  const revisionDialog = useRef<HTMLDialogElement>(null);
  const fragmentBox = useRef<HTMLTextAreaElement>(null);

  const cancelRevision = useCallback((message = '') => {
    const intent = revisionRef.current;
    revisionRef.current = null;
    setRevision(null);
    revisionDialog.current?.close();
    if (intent?.trigger.isConnected) intent.trigger.focus({ preventScroll: true });
    if (message) doc.setNotice(message);
  }, [doc]);

  const updateRevision = useCallback((intent: RevisionIntent) => {
    revisionRef.current = intent;
    setRevision(intent);
  }, []);

  useEffect(() => {
    const intent = revisionRef.current;
    if (intent && (draft !== intent.draft || choices !== intent.choices || imported !== intent.imported
      || reports.at(-1) !== intent.snapshot || generation !== intent.generation || inFlight)) {
      cancelRevision('revisionStale');
    }
  }, [draft, choices, imported, reports, generation, inFlight, cancelRevision]);

  useEffect(() => {
    if (revision) {
      if (!revisionDialog.current?.open) {
        revisionDialog.current?.showModal();
        fragmentBox.current?.focus();
      }
    } else {
      revisionDialog.current?.close();
    }
  }, [revision]);

  const openRevision = useCallback((finding: Finding, candidate: Candidate, trigger: HTMLButtonElement) => {
    const now = doc.getSnapshot();
    const latestSnap = now.reports.at(-1) ?? null;
    if (now.inFlight || now.phase === 'loading' || !doc.isRevisionEligible(finding, candidate) || !latestSnap) return;
    updateRevision({
      snapshot: latestSnap,
      generation: now.generation,
      draft: now.draft,
      choices: now.choices,
      imported: now.imported,
      finding,
      candidate,
      trigger,
      fragment: '',
      selected: null,
    });
  }, [doc, updateRevision]);

  const confirmRevision = useCallback(() => {
    const intent = revisionRef.current;
    if (!intent) return;
    const outcome = doc.applyTargetRevision(intent);
    if (outcome.status === 'stale') { cancelRevision(); return; }
    if (outcome.status !== 'applied') return;
    cancelRevision();
    requestAnimationFrame(() => onRevealTarget(outcome.span));
  }, [doc, cancelRevision, onRevealTarget]);

  return {
    revision,
    revisionDialog,
    fragmentBox,
    cancelRevision,
    updateRevision,
    openRevision,
    confirmRevision,
  };
}
