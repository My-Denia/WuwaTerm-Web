'use client';

import type { FormEvent, RefObject } from 'react';
import { fill, msg } from '../../../lib/messages';
import type { PoolView } from '../../../lib/runtime-store';
import type { TmActiveSegment } from '../../../lib/tm-segment';
import type { UiLanguage } from '../../../lib/ui-language';
import type { WorkbenchController, WorkbenchSnapshot } from '../../../lib/workbench-controller';
import type { ScalarOffset } from '../../../lib/workbench-model';
import { EditorSurfaceAdapter, type EditorEdit, type EditorHighlight, type EditorSurfaceHandle } from '../editor-surface';
import type { TermbaseExternalFeedback } from '../my-terms';
import { RequestId } from '../request-feedback';

type Props = {
  lang: UiLanguage;
  doc: WorkbenchController;
  snapshot: WorkbenchSnapshot;
  pool: PoolView;
  quick: boolean;
  sourceLength: number;
  targetLength: number;
  charCountText: string;
  validInput: boolean;
  reviewsClosed: boolean;
  translationClosed: boolean;
  semanticRunActive: boolean;
  holdsWork: boolean;
  basisChanged: boolean;
  waitedSeconds: number;
  copied: 'done' | 'failed' | null;
  saveStateText: string;
  guard: boolean;
  noticeText: string;
  errorTextValue: string;
  errorDetails: string[];
  termbaseFeedback: TermbaseExternalFeedback | null;
  editorLayout: 'split' | 'stacked';
  onToggleEditorLayout: () => void;
  syncScroll: boolean;
  onToggleSyncScroll: () => void;
  markdownPreview: boolean;
  onToggleMarkdownPreview: () => void;
  onPromoteSelection: () => void;
  activeTmSegment: TmActiveSegment;
  sourceHighlights: EditorHighlight[];
  targetHighlights: EditorHighlight[];
  sourceEditor: RefObject<EditorSurfaceHandle | null>;
  targetEditor: RefObject<EditorSurfaceHandle | null>;
  fileBox: RefObject<HTMLInputElement | null>;
  onSubmit: (event: FormEvent) => void;
  onTranslateQuick: (event: FormEvent) => void;
  onCheckFreshBasis: () => void;
  onTranslateInReview: () => void;
  onEditorScroll: (origin: 'source' | 'target', ratio: number) => void;
  onCursorChange: (side: 'source' | 'target', offset: ScalarOffset) => void;
  onEditSide: (side: 'source' | 'target') => (value: string, edit: EditorEdit) => void;
  onCopyTranslation: () => void;
  onAddAlignment: (omit?: boolean, whole?: boolean) => void;
  onImportFile: (file?: File) => void;
  onClearDraft: () => void;
  onSave: () => void;
  onResolveConflictsAndSave: () => void;
  onExportProseTxt: () => void;
  onExportTxt: () => void;
  onExportResult: () => void;
  onExportMarkdown: () => void;
};

export function WorkspaceEditorPane({
  lang,
  doc,
  snapshot,
  pool,
  quick,
  sourceLength,
  targetLength,
  charCountText,
  validInput,
  reviewsClosed,
  translationClosed,
  semanticRunActive,
  holdsWork,
  basisChanged,
  waitedSeconds,
  copied,
  saveStateText,
  guard,
  noticeText,
  errorTextValue,
  errorDetails,
  termbaseFeedback,
  editorLayout,
  onToggleEditorLayout,
  syncScroll,
  onToggleSyncScroll,
  markdownPreview,
  onToggleMarkdownPreview,
  onPromoteSelection,
  activeTmSegment,
  sourceHighlights,
  targetHighlights,
  sourceEditor,
  targetEditor,
  fileBox,
  onSubmit,
  onTranslateQuick,
  onCheckFreshBasis,
  onTranslateInReview,
  onEditorScroll,
  onCursorChange,
  onEditSide,
  onCopyTranslation,
  onAddAlignment,
  onImportFile,
  onClearDraft,
  onSave,
  onResolveConflictsAndSave,
  onExportProseTxt,
  onExportTxt,
  onExportResult,
  onExportMarkdown,
}: Props) {
  const m = msg(lang);
  const w = m.workspace;
  const {
    draft, choices, reports, history, documentCheckpoint,
    phase, translating, sourceDirtyForTranslation, notice, error,
    autoDirection, lastTranslation, redoCount,
  } = snapshot;
  const { source, target, direction, alignments } = draft;
  const latest = reports.at(-1) ?? null;
  // The last whole-text translation describes the editors only while both texts are still the ones it produced.
  const quickResult = lastTranslation && lastTranslation.source === source && lastTranslation.text === target ? lastTranslation : null;
  const translatePrimary = !!source.trim() && !target.trim();
  // Over 2,000 characters the whole-text check and translation are disabled; the segment panel's run buttons are the main action.
  const longInput = sourceLength > 2000 || targetLength > 2000;
  const kindLabel = quickResult?.kind
    ? ({ exact: m.translation.kindExact, fuzzy: m.translation.kindFuzzy, noop: m.translation.kindNoop, llm: m.translation.kindLlm })[quickResult.kind]
    : null;

  return <div className="manuscript-editor-pane">
    {!quick && !latest && !source.trim() && !target.trim() && choices.length === 0 && (
      <ol className="guide-steps" aria-label={m.review.guideAria} role="list">
        {m.review.guide.map((step, i) => <li key={i}><strong>{step.title}</strong><span>{step.body}</span></li>)}
      </ol>
    )}
    <form onSubmit={quick ? onTranslateQuick : onSubmit}>
      <div className="editor-toolbar" role="group" aria-label={w.editorToolbarAria}>
        {!quick && (
          <button
            type="button"
            className="secondary-button toolbar-toggle layout-toggle"
            aria-pressed={editorLayout === 'split'}
            data-editor-layout={editorLayout}
            onClick={onToggleEditorLayout}
          >
            {editorLayout === 'split' ? w.layoutSplit : w.layoutStacked}
          </button>
        )}
        <button
          type="button"
          className="secondary-button toolbar-toggle"
          aria-pressed={syncScroll}
          data-sync-scroll={syncScroll ? 'on' : 'off'}
          onClick={onToggleSyncScroll}
        >
          {w.syncScroll}
        </button>
        <button
          type="button"
          className="secondary-button toolbar-toggle"
          aria-pressed={markdownPreview}
          data-markdown-preview={markdownPreview ? 'on' : 'off'}
          onClick={onToggleMarkdownPreview}
        >
          {w.markdownPreview}
        </button>
        <button
          type="button"
          className="secondary-button toolbar-toggle"
          onClick={onPromoteSelection}
        >
          {m.termbase.promoteSelection}
        </button>
        {!quick && activeTmSegment.total > 1 && (
          <span className="toolbar-segment-pill" data-testid="editor-segment-indicator">
            {fill(w.segmentIndicator, { i: activeTmSegment.index + 1, n: activeTmSegment.total })}
          </span>
        )}
      </div>
      {!quick && (sourceHighlights.length > 0 || targetHighlights.length > 0) && (
        <div className="highlight-legend" role="note" aria-label={w.highlightLegendAria}>
          <span className="legend-dot legend-term">{w.highlightLegendTerm}</span>
          <span className="legend-dot legend-conflict">{w.highlightLegendConflict}</span>
          <span className="legend-dot legend-structure">{w.highlightLegendStructure}</span>
          <span className="legend-dot legend-semantic">{w.highlightLegendSemantic}</span>
        </div>
      )}
      <div className="editor-panes" data-layout={quick ? 'split' : editorLayout}>
        <div className="editor-pane">
          <div className="label-row">
            <label id="review-source-label" htmlFor="review-source">{m.review.sourceLabel}</label>
            <select aria-label={quick ? m.translation.directionAria : m.review.directionAria} value={quick && autoDirection ? 'auto' : direction} onChange={e => {
              const value = e.target.value as 'auto' | 'en' | 'zh';
              if (quick) doc.setQuickDirection(value);
              else if (value !== 'auto') doc.setDirection(value);
            }}>
              {quick && <option value="auto">{m.translation.directionAuto}</option>}
              <option value="en">{quick ? m.translation.directionToEn : m.review.directionEn}</option>
              <option value="zh">{quick ? m.translation.directionToZh : m.review.directionZh}</option>
            </select>
          </div>
          <EditorSurfaceAdapter
            ref={sourceEditor}
            id="review-source"
            labelledBy="review-source-label"
            value={source}
            rows={6}
            placeholder={quick ? m.translation.placeholder : m.review.sourcePlaceholder}
            enhanced={!quick}
            highlights={sourceHighlights}
            preview={markdownPreview}
            previewEmptyText={w.markdownPreviewEmpty}
            previewAriaLabel={w.markdownSourcePreviewAria}
            onScrollRatio={ratio => onEditorScroll('source', ratio)}
            onCursorChange={offset => onCursorChange('source', offset)}
            onEdit={onEditSide('source')}
            onUndo={() => doc.undo()}
            onRedo={() => doc.redo()}
          />
        </div>
        <div className="editor-pane">
          <div className="label-row">
            <label id="review-target-label" htmlFor="review-target">{quick ? w.targetLabel : m.review.targetLabel}</label>
            {quick && !!target && <button type="button" className="text-button" onClick={onCopyTranslation}>{copied === 'done' ? m.translation.copied : m.translation.copy}</button>}
          </div>
          <EditorSurfaceAdapter
            ref={targetEditor}
            id="review-target"
            labelledBy="review-target-label"
            value={target}
            rows={6}
            placeholder={quick ? m.translation.idlePlaceholder : m.review.targetPlaceholder}
            enhanced={!quick}
            highlights={targetHighlights}
            preview={markdownPreview}
            previewEmptyText={w.markdownPreviewEmpty}
            previewAriaLabel={w.markdownTargetPreviewAria}
            onScrollRatio={ratio => onEditorScroll('target', ratio)}
            onCursorChange={offset => onCursorChange('target', offset)}
            onEdit={onEditSide('target')}
            onUndo={() => doc.undo()}
            onRedo={() => doc.redo()}
          />
        </div>
      </div>
      <div className="field-hint">
        <span>{m.review.hintSafety}{!quick && <span className="shortcut-hint"> · {w.shortcutBar}</span>}</span>
        <span aria-live="polite">{charCountText}</span>
      </div>
      {!quick && (sourceLength > 2000 || targetLength > 2000) && <p role="status">{m.review.longManuscript}</p>}
      {quick && translationClosed && <p className="notice-state">{pool.kind === 'success' && !pool.data.translation_enabled ? m.tMsg.translation_disabled : m.tMsg.translation_pool_exhausted}</p>}
      {!quick && <details className="alignment-panel"><summary>{alignments === null ? m.review.alignmentSummaryNone : fill(m.review.alignmentSummaryCount, { n: alignments.length })}</summary>
        <p>{m.review.alignmentIntro}</p>
        <div className="actions">
          <button type="button" className="secondary-button" onClick={() => onAddAlignment()}>{m.review.alignmentConfirm}</button>
          <button type="button" className="secondary-button" onClick={() => onAddAlignment(true)}>{m.review.alignmentOmit}</button>
          <button type="button" className="secondary-button" disabled={!validInput} onClick={() => onAddAlignment(false, true)}>{m.review.alignmentWhole}</button>
          <button type="button" className="secondary-button" onClick={() => doc.clearAlignments()}>{m.review.alignmentClear}</button>
          <button type="button" className="secondary-button" onClick={() => doc.resetAlignments()}>{m.review.alignmentReset}</button>
        </div>
        {alignments?.map((a, i) => <div className="alignment-row" key={i}><p>{fill(m.review.alignmentRowSource, { start: a.source.start + 1, end: a.source.end, text: a.source.text })}</p><p>{a.target ? fill(m.review.alignmentRowTarget, { start: a.target.start + 1, end: a.target.end, text: a.target.text }) : m.review.alignmentRowOmit}</p><button type="button" className="text-button" onClick={() => doc.removeAlignment(i)}>{m.review.alignmentRemove}</button></div>)}
      </details>}
      {!quick && <div className="review-quota">
        {pool.kind === 'success' ? <>
          <p>{fill(m.review.quotaSnapshot, { n: pool.data.reviews.remaining, limit: pool.data.reviews.limit })}</p>
          {reviewsClosed && <p>{m.rMsg.reviews_pool_exhausted}</p>}
        </> : <p>{pool.kind === 'error' ? m.pool.unavailable : m.pool.loading}</p>}
      </div>}
      <div className="actions">
        {quick ? <>
          <button type="submit" disabled={!source.trim() || sourceLength > 2000 || phase === 'loading' || translating || translationClosed}>{translating ? m.translation.submitLoading : m.translation.submitIdle}</button>
          {translating && <button className="secondary-button" type="button" onClick={() => doc.cancelWait()}>{m.translation.cancelWait}</button>}
          <button className="secondary-button" type="button" onClick={() => fileBox.current?.click()}>{m.translation.importFile}</button>
          <button className="secondary-button" type="button" onClick={() => doc.setWorkspaceMode('manuscript')}>{w.openManuscript}</button>
        </> : <>
          <button type="submit" className={translatePrimary || longInput ? 'secondary-button' : undefined} disabled={!validInput || phase === 'loading' || translating || reviewsClosed}>{phase === 'loading' ? m.review.checkLoading : m.review.checkIdle}</button>
          <button className="secondary-button" type="button" disabled={!validInput || phase === 'loading' || translating || reviewsClosed} onClick={onCheckFreshBasis}>{m.review.freshBasis}</button>
          {((!!source.trim() && (!target.trim() || sourceDirtyForTranslation)) || translating) && <button className={translatePrimary && !longInput ? undefined : 'secondary-button'} type="button" disabled={!source.trim() || sourceLength > 2000 || phase === 'loading' || translating || semanticRunActive || snapshot.tmPreparing || translationClosed} onClick={onTranslateInReview}>{translating || snapshot.tmPreparing ? m.review.translateLoading : target.trim() ? m.review.translateUpdate : m.review.translateIdle}</button>}
          {(phase === 'loading' || translating) && <button className="secondary-button" type="button" onClick={() => doc.cancelWait()}>{m.review.cancelWait}</button>}
        </>}
        <button className="secondary-button" type="button" onClick={() => doc.undo()} disabled={!history.length}>{m.review.undo}</button>
        <button className="secondary-button" type="button" onClick={() => doc.redo()} disabled={redoCount === 0}>{w.redo}</button>
      </div>
    </form>
    {/* One hidden file input for both modes, opened by the visible import buttons and kept out of the tab order. */}
    <input ref={fileBox} className="visually-hidden" type="file" tabIndex={-1} accept=".json,.txt,.md,application/json,text/plain,text/markdown" aria-label={m.review.importFileAria} onChange={e => {
      const file = e.target.files?.[0];
      e.target.value = '';
      onImportFile(file);
    }} />
    {quick && translating && <p className="notice-state" role="status">{m.translation.loadingStatus}</p>}
    {quick && translating && waitedSeconds >= 2 && <p className="notice-state wait-elapsed" data-waited={waitedSeconds}>{fill(m.translation.loadingElapsed, { n: waitedSeconds })}</p>}
    {quick && quickResult && <div className="translation-result" aria-live="polite">
      <div className="result-meta">{kindLabel && <span>{kindLabel}</span>}<span>{quickResult.direction === 'en' ? m.translation.directionEn : m.translation.directionZh}</span></div>
      {quickResult.dictionaryMiss && <p className="field-hint">{m.translation.dictionaryMiss}</p>}
      {copied === 'failed' && <p role="status">{m.translation.copyFailed}</p>}
      {quickResult.requestId && <RequestId value={quickResult.requestId} />}
    </div>}
    {!quick && <>
      <p className="manuscript-save-state" role="status">{saveStateText}{guard ? ` ${m.review.saveStateLeaveNote}` : ''}</p>
      <div className="actions draft-actions">
        <div className="draft-primary-actions">
          <button type="button" className="secondary-button" onClick={onClearDraft} disabled={!holdsWork}>{m.review.clearDraft}</button>
          <button type="button" className="secondary-button" onClick={onSave}>{m.review.save}</button>
          <button type="button" className="secondary-button" onClick={() => fileBox.current?.click()}>{m.review.import}</button>
          {documentCheckpoint && <button type="button" className="secondary-button" onClick={() => doc.restoreDocumentCheckpoint()}>{m.review.restoreCheckpoint}</button>}
        </div>
        <div className="export-actions">
          <button type="button" className="secondary-button" onClick={onExportTxt}>{m.review.exportTxt}</button>
          <button type="button" className="secondary-button" onClick={onExportResult}>{m.review.exportResult}</button>
          <button type="button" className="secondary-button" onClick={onExportMarkdown}>{m.review.exportMarkdown}</button>
        </div>
      </div>
    </>}
    {termbaseFeedback && <p className={termbaseFeedback.kind === 'error' ? 'termbase-promote-status termbase-promote-error' : 'termbase-promote-status'} role={termbaseFeedback.kind === 'error' ? 'alert' : 'status'}>{termbaseFeedback.text}</p>}
    {notice && <p className="notice-state" role="status">{noticeText}</p>}
    {!quick && alignments !== null && alignments.length === 0 && <div className="alignment-recovery" role="region" aria-label={m.review.alignmentRecoveryAria}>
      <p>{m.review.alignmentEmptyPrompt}</p>
      <div className="actions">
        <button type="button" className="secondary-button" disabled={!validInput || phase === 'loading'} onClick={() => onAddAlignment(false, true)}>{m.review.alignmentReconfirmWhole}</button>
        <button type="button" className="secondary-button" disabled={phase === 'loading'} onClick={() => doc.resetAlignments()}>{m.review.alignmentFallbackReset}</button>
      </div>
    </div>}
    {error && <div className="error-panel" role="alert"><p>{errorTextValue}</p>{errorDetails.map(line => <p key={line} className="error-detail">{line}</p>)}{error.saveConflict && <div className="actions save-conflict-actions"><button type="button" className="secondary-button" onClick={onResolveConflictsAndSave}>{m.review.resolveConflictsAndSave}</button><button type="button" className="secondary-button" onClick={onExportProseTxt}>{m.review.exportProseTxt}</button></div>}</div>}
    {!quick && phase === 'loading' && <p role="status">{m.review.loadingStatus}</p>}
    {!quick && basisChanged && <p className="review-stale">{m.review.staleBasis}</p>}
  </div>;
}
