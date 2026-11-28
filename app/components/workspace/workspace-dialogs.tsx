'use client';

import type { RefObject } from 'react';
import { fill, msg } from '../../../lib/messages';
import { fragmentOccurrences, spliceOccurrence } from '../../../lib/target-revision.js';
import type { UiLanguage } from '../../../lib/ui-language';
import type {
  Candidate,
  Choice,
  DocumentPhase,
  Draft,
  ErrorState,
  Finding,
  PendingWorkfile,
  Snapshot,
  Span,
} from '../../../lib/workbench-model';
import { Excerpt } from './workspace-excerpt';

export type RevisionIntent = {
  snapshot: Snapshot;
  generation: number;
  draft: Draft;
  choices: Choice[];
  imported: Choice[];
  finding: Finding;
  candidate: Candidate;
  trigger: HTMLButtonElement;
  fragment: string;
  selected: Span | null;
};

export type PendingReplacement =
  | { kind: 'text'; text: string }
  | { kind: 'query'; text: string }
  | { kind: 'workfile'; workfile: PendingWorkfile };

type Props = {
  lang: UiLanguage;
  direction: 'en' | 'zh';
  target: string;
  phase: DocumentPhase;
  translating: boolean;
  saveView: string;
  error: ErrorState | null;
  errorTextValue: string;
  revision: RevisionIntent | null;
  revisionDialog: RefObject<HTMLDialogElement | null>;
  fragmentBox: RefObject<HTMLTextAreaElement | null>;
  onUpdateRevision: (intent: RevisionIntent) => void;
  onCancelRevision: () => void;
  onConfirmRevision: () => void;
  leaveDialog: RefObject<HTMLDialogElement | null>;
  stayLeaveButton: RefObject<HTMLButtonElement | null>;
  onDismissLeave: () => void;
  onSave: () => void;
  onResolveConflictsAndSave: () => void;
  onExportProseTxt: () => void;
  onLeaveAnyway: () => void;
  pendingImport: PendingReplacement | null;
  importDialog: RefObject<HTMLDialogElement | null>;
  keepImportButton: RefObject<HTMLButtonElement | null>;
  onCancelImport: () => void;
  onConfirmImport: (pending: PendingReplacement) => void;
};

export function WorkspaceDialogs({
  lang,
  direction,
  target,
  phase,
  translating,
  saveView,
  error,
  errorTextValue,
  revision,
  revisionDialog,
  fragmentBox,
  onUpdateRevision,
  onCancelRevision,
  onConfirmRevision,
  leaveDialog,
  stayLeaveButton,
  onDismissLeave,
  onSave,
  onResolveConflictsAndSave,
  onExportProseTxt,
  onLeaveAnyway,
  pendingImport,
  importDialog,
  keepImportButton,
  onCancelImport,
  onConfirmImport,
}: Props) {
  const m = msg(lang);
  const w = m.workspace;
  const occurrences: Span[] = revision ? fragmentOccurrences(target, revision.fragment) : [];
  const revisionReplacement = revision ? (direction === 'en' ? revision.candidate.en : revision.candidate.zh) : '';
  const revisionPreview = revision?.selected ? spliceOccurrence(target, revision.fragment, revision.selected, revisionReplacement) : null;

  return <>
    <dialog className="handoff-dialog revision-dialog" ref={revisionDialog} aria-labelledby="revision-title" aria-describedby="revision-description" onCancel={onCancelRevision}>
      <h3 id="revision-title">{m.review.revisionTitle}</h3>
      <p id="revision-description">{m.review.revisionDescription}</p>
      {revision && <>
        <p>{fill(m.review.spanRange, { start: revision.finding.source_span.start + 1, end: revision.finding.source_span.end })}</p>
        <Excerpt text={revision.draft.source} span={revision.finding.source_span} missing={m.review.excerptMissingTarget} />
        <p className="revision-pair">{revision.candidate.zh} ↔ {revision.candidate.en}<br />{m.review.revisionReplacement}: <strong>{revisionReplacement}</strong></p>
        <p>{m.review.revisionAlignments}</p>
        <label htmlFor="revision-fragment">{m.review.revisionFragment}</label>
        <textarea id="revision-fragment" ref={fragmentBox} rows={2} value={revision.fragment} onChange={event => onUpdateRevision({ ...revision, fragment: event.target.value, selected: null })} />
        <details><summary>{m.review.revisionFullTarget}</summary><p className="review-excerpt">{target}</p></details>
        <p role="status" aria-live="polite">{!revision.fragment.trim() ? m.review.revisionEnter : occurrences.length ? fill(m.review.revisionMatches, { n: occurrences.length }) : m.review.revisionNoMatches}</p>
        <fieldset className="revision-occurrences"><legend>{m.review.revisionOccurrences}</legend>
          {occurrences.map((span, index) => <label className="revision-occurrence" key={`${span.start}:${span.end}`}>
            <input type="radio" name="revision-occurrence" value={`${span.start}:${span.end}`} checked={revision.selected?.start === span.start && revision.selected?.end === span.end} onChange={() => onUpdateRevision({ ...revision, selected: span })} />
            <span>{fill(m.review.revisionPosition, { i: index + 1, start: span.start + 1, end: span.end })}<Excerpt text={target} span={span} missing={m.review.excerptMissingTarget} /></span>
          </label>)}
        </fieldset>
        {revision.selected && <div className="revision-preview"><p>{m.review.revisionPreview}</p><p className="review-excerpt"><del>{revision.selected.text}</del> → <ins>{revisionReplacement}</ins></p></div>}
        {revisionPreview?.error && <p role="alert">{(m.review as Record<string, unknown>)[revisionPreview.error] as string}</p>}
        <div className="actions">
          <button type="button" className="secondary-button" onClick={onCancelRevision}>{m.review.revisionCancel}</button>
          <button type="button" className="primary-button" disabled={!revisionPreview || !!revisionPreview.error} onClick={onConfirmRevision}>{m.review.revisionConfirm}</button>
        </div>
      </>}
    </dialog>
    <dialog className="handoff-dialog" ref={leaveDialog} aria-labelledby="leave-title" aria-describedby="leave-description" onCancel={onDismissLeave}>
      <h3 id="leave-title">{m.review.leaveTitle}</h3>
      <div id="leave-description">
        {(phase === 'loading' || translating) && <p>{m.review.leaveInFlight}</p>}
        <p>{saveView === 'matches-download' ? m.review.leaveDownload : m.review.leaveUnsaved}</p>
      </div>
      {error && <p role="alert">{errorTextValue}</p>}
      {error?.saveConflict && <div className="actions save-conflict-actions"><button type="button" className="secondary-button" onClick={onResolveConflictsAndSave}>{m.review.resolveConflictsAndSave}</button><button type="button" className="secondary-button" onClick={onExportProseTxt}>{m.review.exportProseTxt}</button></div>}
      <div className="actions">
        <button ref={stayLeaveButton} type="button" className="primary-button" onClick={onDismissLeave}>{m.review.leaveStay}</button>
        <button type="button" className="secondary-button" onClick={onSave}>{m.review.leaveSaveStay}</button>
        <button type="button" className="secondary-button" onClick={onLeaveAnyway}>{m.review.leaveAnyway}</button>
      </div>
    </dialog>
    <dialog className="handoff-dialog" ref={importDialog} aria-labelledby="import-replace-title" aria-describedby="import-replace-description" onCancel={onCancelImport}>
      <h3 id="import-replace-title">{pendingImport?.kind === 'workfile' ? m.review.workfileReplaceTitle : pendingImport?.kind === 'query' ? w.queryReplaceTitle : m.review.importReplaceTitle}</h3>
      <p id="import-replace-description">{pendingImport?.kind === 'workfile' ? m.review.workfileReplaceBody : pendingImport?.kind === 'query' ? w.queryReplaceBody : m.review.importReplaceBody}</p>
      <div className="actions">
        <button ref={keepImportButton} type="button" className="secondary-button" onClick={onCancelImport}>{m.review.dialogKeep}</button>
        <button type="button" className="secondary-button" onClick={() => {
          if (pendingImport) onConfirmImport(pendingImport);
        }}>{pendingImport?.kind === 'query' ? w.queryReplaceConfirm : m.review.importReplaceConfirm}</button>
      </div>
    </dialog>
  </>;
}
