'use client';

import { FormEvent, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  FILTERS, filterFindings, findingVerdictCounts, reconcileActiveId,
} from '../../lib/review-navigation.js';
import { summarizeReviewParts } from '../../lib/review-report.js';
import {
  basisOf, compareReports, reconcileChoices, sameBasis,
} from '../../lib/manuscript.js';
import { fill, msg } from '../../lib/messages';
import { downloadFile } from '../../lib/download-file';
import { isAmbiguousMention, isLong, sessionReviewFeatures } from '../../lib/long-review';
import { judgedReport, layerTwoCounts, layerTwoRows, structureSummary, structureViews } from '../../lib/structure-layer';
import { CAPABILITY_STRUCTURE_CHECK } from '../../lib/structure-check.js';
import { useRuntime, useRuntimeStore } from '../../lib/runtime-provider';
import { numberLocale } from '../../lib/ui-language';
import { isSelfHosted } from '../../lib/ui-runtime';
import { resolveTmAutoReuseBasisFromRuntime } from '../../lib/tm-live-provenance';
import { semanticSegmentViews } from '../../lib/semantic-state.js';
import { semanticMsg } from '../../lib/semantic-messages';
import { createWorkbenchController, documentSignature, isRunActive, workPresent } from '../../lib/workbench-controller';
import type { PairView, PendingWorkfile, Span } from '../../lib/workbench-model';
import type { EditorEdit, EditorSurfaceHandle } from './editor-surface';
import { INITIAL_MY_TERMS_PERSISTED, type MyTermsPersisted } from './my-terms';
import type { QuickTermLookupPersisted, QuickTermLookupRequestManager } from './quick-term-lookup';
import { RuntimeStatus } from './runtime-status';
import { useUiLanguage } from './ui-language-context';
import { useCanonicalAndLeaveGuard } from './workspace/use-canonical-guard';
import { useRevisionDialog } from './workspace/use-revision-dialog';
import { useTermbaseWorkspace } from './workspace/use-termbase-workspace';
import { useTmWorkspace } from './workspace/use-tm-workspace';
import { WorkspaceDialogs, type PendingReplacement } from './workspace/workspace-dialogs';
import { WorkspaceEditorPane } from './workspace/workspace-editor-pane';
import { buildWorkspaceHighlights } from './workspace/workspace-highlights';
import { WorkspaceInspector, WorkspaceQuickSide, type SharedToolsProps } from './workspace/workspace-inspector';
import { formatWorkspaceStatus } from './workspace/workspace-status';
import { WorkspaceTermTrack } from './workspace/workspace-term-track';

/**
 * The one document workspace. A single controller holds the draft, history, reports and semantic state; quick translation
 * and manuscript review are two layouts of that same document. The editors stay mounted across a mode switch, so moving to
 * manuscript mode (a long text, an imported manuscript, or the user's choice) keeps the texts, history, caret and IME state.
 */
export function DocumentWorkspace() {
  const { lang } = useUiLanguage();
  const runtime = useRuntimeStore();
  const { pool, capabilities: runtimeCapabilities } = useRuntime();
  const selfHosted = isSelfHosted();
  const [doc] = useState(() => createWorkbenchController({
    initialLang: lang,
    fetchCapabilities: () => runtime.capabilities(),
    onPoolRefresh: () => runtime.refreshPool(),
    resolveTmAutoReuseBasis: (liveLatest) => resolveTmAutoReuseBasisFromRuntime(runtime, liveLatest),
  }));
  const snapshot = useSyncExternalStore(doc.subscribe, doc.getSnapshot, doc.getSnapshot);
  const {
    draft, choices, imported, reports, semantic, basis, capabilities,
    phase, translating, notice, error, importedCanonical, downloadedCanonical,
    run, pairTranslating, generation, inFlight, workspaceMode, autoDirection,
  } = snapshot;
  const { source, target, direction, alignments } = draft;
  const quick = workspaceMode === 'quick';

  const [pendingImport, setPendingImport] = useState<PendingReplacement | null>(null);
  const [styleOn, setStyleOn] = useState(false);
  const [waitTick, setWaitTick] = useState<{ since: number; now: number } | null>(null);
  useEffect(() => {
    if (!translating) return;
    const since = Date.now();
    const timer = setInterval(() => setWaitTick({ since, now: Date.now() }), 1000);
    return () => { clearInterval(timer); setWaitTick(null); };
  }, [translating]);
  const waitedSeconds = translating && waitTick ? Math.floor((waitTick.now - waitTick.since) / 1000) : 0;

  const importDialog = useRef<HTMLDialogElement>(null);
  const keepImportButton = useRef<HTMLButtonElement>(null);
  const [verdictFilter, setVerdictFilter] = useState<(typeof FILTERS)[number]['id']>('actionable');
  const [canonicalFindingId, setCanonicalFindingId] = useState<string | null>(null);
  const [copied, setCopied] = useState<'done' | 'failed' | null>(null);
  const [syncScroll, setSyncScroll] = useState(true);
  const [markdownPreview, setMarkdownPreview] = useState(false);
  const [editorLayout, setEditorLayout] = useState<'split' | 'stacked'>('split');
  const [inspectorTab, setInspectorTab] = useState<'review' | 'terms' | 'memory'>('review');
  const [activeSemanticId, setActiveSemanticId] = useState<string | null>(null);
  const [lookupPersisted, setLookupPersisted] = useState<QuickTermLookupPersisted>({ query: '', terms: { kind: 'idle' }, seeded: false });
  const lookupControllerRef = useRef<AbortController | null>(null);
  const lookupRequestManager = useMemo<QuickTermLookupRequestManager>(() => ({
    set(next) { lookupControllerRef.current?.abort(); lookupControllerRef.current = next; },
    isCurrent(controller) { return lookupControllerRef.current === controller; },
    clearIfCurrent(controller) { if (lookupControllerRef.current === controller) lookupControllerRef.current = null; },
  }), []);
  const [myTermsPersisted, setMyTermsPersisted] = useState<MyTermsPersisted>(INITIAL_MY_TERMS_PERSISTED);
  useEffect(() => () => { lookupControllerRef.current?.abort(); lookupControllerRef.current = null; }, []);

  const syncSuspended = useRef(false);
  const syncSuspendRaf = useRef<number | null>(null);
  const sourceEditor = useRef<EditorSurfaceHandle>(null);
  const targetEditor = useRef<EditorSurfaceHandle>(null);
  const fileBox = useRef<HTMLInputElement>(null);

  useEffect(() => { doc.activate(); void doc.loadCapabilities(); return () => doc.dispose(); }, [doc]);
  useEffect(() => { doc.setLang(lang); }, [doc, lang]);
  useEffect(() => { if (runtimeCapabilities !== null) doc.setCapabilities(runtimeCapabilities); }, [doc, runtimeCapabilities]);
  useEffect(() => () => { if (syncSuspendRaf.current !== null) cancelAnimationFrame(syncSuspendRaf.current); }, []);

  const suspendScrollSync = useCallback(() => {
    syncSuspended.current = true;
    if (syncSuspendRaf.current !== null) cancelAnimationFrame(syncSuspendRaf.current);
    syncSuspendRaf.current = requestAnimationFrame(() => {
      syncSuspendRaf.current = requestAnimationFrame(() => {
        syncSuspended.current = false;
        syncSuspendRaf.current = null;
      });
    });
  }, []);
  const handleEditorScroll = useCallback((origin: 'source' | 'target', ratio: number) => {
    if (!syncScroll || syncSuspended.current) return;
    (origin === 'source' ? targetEditor : sourceEditor).current?.setScrollRatio(ratio);
  }, [syncScroll]);

  const latest = reports.at(-1) ?? null;
  const previous = reports.at(-2) ?? null;
  const tm = useTmWorkspace({
    doc, source, target, alignments, resetSignal: snapshot.resetSignal, latest, selfHosted,
    onFocusTarget: () => targetEditor.current?.focus(),
  });
  const termbase = useTermbaseWorkspace({
    lang, quick, autoDirection, source, direction,
    onOpenTermsInspector: () => setInspectorTab('terms'),
  });
  const rev = useRevisionDialog({
    doc, draft, choices, imported, reports, generation, inFlight,
    onRevealTarget: span => { suspendScrollSync(); targetEditor.current?.reveal(span); },
  });

  const reviewFeatures = useMemo(() => sessionReviewFeatures(capabilities), [capabilities]);
  const layer1 = useMemo(() => structureViews(draft, snapshot.structure), [draft, snapshot.structure]);
  const layer1Summary = structureSummary(layer1);
  const layer2 = useMemo(() => {
    const views = (semanticSegmentViews(draft, { results: semantic.results, long: semantic.long }, basis, reviewFeatures) as { items: PairView[] }).items;
    return layerTwoCounts(layerTwoRows(semantic, views, layer1));
  }, [draft, semantic, basis, reviewFeatures, layer1]);
  const judged = useMemo(() => (latest ? judgedReport(latest.report) : null), [latest]);
  const visibleFindings = judged ? filterFindings(judged.report.findings, verdictFilter) : [];
  const findingCounts = findingVerdictCounts(judged?.report.findings ?? []);
  const activeFindingId = reconcileActiveId(canonicalFindingId, visibleFindings);
  if (activeFindingId !== null && activeFindingId !== canonicalFindingId) setCanonicalFindingId(activeFindingId);
  const activeVisibleIndex = visibleFindings.findIndex(finding => finding.id === activeFindingId);

  const reconciled = reconcileChoices(choices, draft, latest, imported);
  const ready = reconciled.flatMap(item => (item.resolution ? [item.resolution] : []));
  const current = !!latest?.trusted && latest.signature === documentSignature(draft, ready) && phase === 'success';
  const sourceLength = Array.from(source).length;
  const targetLength = Array.from(target).length;
  const validInput = !!source.trim() && !!target.trim() && sourceLength <= 2000 && targetLength <= 2000;
  const reviewsClosed = pool.kind === 'success' && pool.data.reviews.remaining === 0;
  const longDocument = isLong(draft);
  const translationClosed = pool.kind === 'success' && (!pool.data.translation_enabled || pool.data.translations.remaining === 0 || pool.data.characters.remaining === 0);
  const sourceCompatible = !!latest?.trusted && latest.source === source && latest.direction === direction;
  const comparison = latest && previous ? compareReports(previous, latest) : null;
  const basisChanged = !!latest?.trusted && choices.some(choice => !sameBasis(choice.basis, basisOf(latest.report)));
  const holdsWork = workPresent(draft, choices, reports, semantic);
  const semanticRunActive = isRunActive(run, pairTranslating);
  const checkInFlight = phase === 'loading' || translating || semanticRunActive;

  const { saveView, guard, setPendingLeaveUrl, leaveDialog, stayLeaveButton, leaveAnyway } = useCanonicalAndLeaveGuard({
    holdsWork, draft, choices, reports, semantic, basis, importedCanonical, downloadedCanonical,
    resetSignal: snapshot.resetSignal, checkInFlight,
  });

  const m = msg(lang);
  const w = m.workspace;
  const sm = semanticMsg(lang);
  const locale = numberLocale(lang);
  const charCountText = quick
    ? fill(m.translation.charCount, { n: sourceLength.toLocaleString(locale) })
    : fill(m.review.charCounts, { s: sourceLength.toLocaleString(locale), t: targetLength.toLocaleString(locale) });
  const { saveStateText, noticeText, errorTextValue, errorDetails } = formatWorkspaceStatus({
    lang, saveView, notice, error, sourceLength,
  });

  useEffect(() => {
    if (!activeFindingId) return;
    document.querySelector(`[data-mention-id="${CSS.escape(activeFindingId)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeFindingId]);
  useEffect(() => {
    if (pendingImport !== null) {
      if (!importDialog.current?.open) importDialog.current?.showModal();
      keepImportButton.current?.focus();
    } else importDialog.current?.close();
  }, [pendingImport]);

  function toggleMarkdownPreview() {
    const sourceRatio = sourceEditor.current?.scrollRatio() ?? null;
    const targetRatio = targetEditor.current?.scrollRatio() ?? null;
    setMarkdownPreview(prev => !prev);
    requestAnimationFrame(() => {
      if (sourceRatio !== null) sourceEditor.current?.setScrollRatio(sourceRatio);
      if (targetRatio !== null) targetEditor.current?.setScrollRatio(targetRatio);
    });
  }
  function jumpTo(side: 'source' | 'target', span: Span) {
    tm.setTmCursor({ kind: 'offset', side, offset: span.start });
    suspendScrollSync();
    if (markdownPreview) {
      setMarkdownPreview(false);
      requestAnimationFrame(() => {
        suspendScrollSync();
        (side === 'source' ? sourceEditor : targetEditor).current?.reveal(span);
      });
      return;
    }
    (side === 'source' ? sourceEditor : targetEditor).current?.reveal(span);
  }
  const editSide = (side: 'source' | 'target') => (value: string, edit: EditorEdit) =>
    doc.editText(side, value, edit.composing ? { composing: true } : {});
  function addAlignment(omit = false, whole = false) {
    doc.recordAlignment(whole ? null : sourceEditor.current?.selection() ?? null, omit || whole ? null : targetEditor.current?.selection() ?? null, omit, whole);
  }
  function insertTerm(text: string) {
    const cur = doc.getSnapshot().draft.source;
    doc.editText('source', cur ? cur + ' ' + text : text);
    sourceEditor.current?.focus();
  }
  function moveQueryToSource(text: string) {
    if (!text.trim()) return;
    if (doc.replacementNeedsConfirm()) { setPendingImport({ kind: 'query', text }); return; }
    doc.replaceWithText(text, 'movedQuery');
    sourceEditor.current?.focus();
  }
  function replaceWithText(text: string, noticeValue?: string) {
    importDialog.current?.close(); setPendingImport(null); doc.replaceWithText(text, noticeValue);
  }
  function replaceWithWorkfile(workfile: PendingWorkfile) {
    importDialog.current?.close(); setPendingImport(null); doc.replaceWithWorkfile(workfile);
  }
  async function importFile(file?: File) {
    const outcome = await doc.importFile(file);
    if (outcome.status === 'needs_confirm_text') setPendingImport({ kind: 'text', text: outcome.pendingText });
    else if (outcome.status === 'needs_confirm_workfile') setPendingImport({ kind: 'workfile', workfile: outcome.pendingWorkfile });
  }
  async function copyTranslation() {
    try { await navigator.clipboard.writeText(target); setCopied('done'); } catch { setCopied('failed'); }
  }
  function save() { const out = doc.save(); if (out) downloadFile(out.filename, out.content, out.mimeType); }
  function resolveConflictsAndSave() { const out = doc.resolveConflictingChoicesAndSave(); if (out) downloadFile(out.filename, out.content, out.mimeType); }
  function exportProseTxt() { const out = doc.exportProseTxt(); downloadFile(out.filename, out.content, out.mimeType); }

  const summaryParts = judged ? summarizeReviewParts(judged.report) : null;
  const structureOn = !!capabilities?.includes(CAPABILITY_STRUCTURE_CHECK);
  const semanticOn = !!capabilities?.includes('semantic-review-v1');
  const ambiguousTotal = (judged?.ambiguous.length ?? 0)
    + semantic.long.records.reduce((n, r) => n + (r.result?.findings.filter(isAmbiguousMention).length ?? 0), 0);
  const termTotal = (judged?.report.findings.length ?? 0)
    + semantic.long.records.reduce((n, r) => n + (r.result?.findings.filter(f => !isAmbiguousMention(f)).length ?? 0), 0);

  const highlightInput = useMemo(() => ({
    source, target, draft, basis, reviewFeatures, current, judged, latest,
    longDocument, long: semantic.long, layer1, placed: semantic.placed, activeSemanticId,
  }), [source, target, draft, basis, reviewFeatures, current, judged, latest, longDocument, semantic.long, layer1, semantic.placed, activeSemanticId]);
  const deferredHighlightInput = useDeferredValue(highlightInput);
  const { sourceHighlights, targetHighlights } = useMemo(
    () => buildWorkspaceHighlights(deferredHighlightInput, quick, source, target, { rules: sm.layers.rules, categories: sm.categories }),
    [quick, deferredHighlightInput, source, target, sm.layers.rules, sm.categories],
  );

  const reviewBadgeCount = (layer1Summary.findings + layer1Summary.omitted) + (longDocument ? termTotal : findingCounts.actionable) + layer2.pending;
  const selectInspectorTab = (tab: 'review' | 'terms' | 'memory') => {
    setInspectorTab(tab);
    if (tab === 'terms') termbase.setTermbaseOpen(true);
    if (tab === 'memory') tm.setTmOpen(true);
  };

  const sharedTools: SharedToolsProps = {
    source,
    effectiveTermbaseDirection: termbase.effectiveTermbaseDirection,
    lookupPersisted, onLookupPersistedChange: setLookupPersisted, lookupRequestManager,
    onInsertTerm: insertTerm, onMoveQueryToSource: moveQueryToSource,
    termbaseEntries: termbase.termbaseEntries, onTermbaseEntriesChange: termbase.setTermbaseEntries,
    termbaseOpen: termbase.termbaseOpen, onTermbaseOpenChange: termbase.setTermbaseOpen,
    termbaseDraftSeed: termbase.termbaseDraftSeed, termbaseFeedback: termbase.termbaseFeedback,
    myTermsPersisted, onMyTermsPersistedChange: setMyTermsPersisted,
    activeTmSegment: tm.activeTmSegment, tmAlignmentStatus: tm.tmAlignmentStatus,
    currentTermsDbRevision: tm.tmDisplayBasis.currentTermsDbRevision, currentGameVersion: tm.tmDisplayBasis.currentGameVersion,
    getDisplayTmBasis: tm.getDisplayTmBasis, getConfirmTmBasis: tm.getConfirmTmBasis,
    tmDictionaryStatus: tm.tmDictionaryStatus, selfHosted, tmStorageState: tm.tmStorageState,
    onRetryLoadTm: selfHosted ? () => void tm.loadSelfhostTm() : undefined,
    tmPersistence: tm.tmPersistence, tmEntries: tm.tmEntries, onTmEntriesChange: tm.setTmEntries,
    onApplyMemorySuggestion: tm.applyMemorySuggestion, onSelectTmSegment: index => tm.setTmCursor({ kind: 'index', index }),
    tmOpen: tm.tmOpen, onTmOpenChange: tm.setTmOpen,
  };

  const termTrack = (longTerms: ReactNode): ReactNode => <WorkspaceTermTrack
    lang={lang} doc={doc} latest={latest} judged={judged} summaryParts={summaryParts} comparison={comparison}
    current={current} source={source} target={target} direction={direction} sourceLength={sourceLength} targetLength={targetLength}
    sourceCompatible={sourceCompatible} phase={phase} verdictFilter={verdictFilter} onVerdictFilterChange={setVerdictFilter}
    visibleFindings={visibleFindings} findingCounts={findingCounts} activeFindingId={activeFindingId}
    activeVisibleIndex={activeVisibleIndex} onSelectFinding={setCanonicalFindingId} onJumpTo={jumpTo}
    onOpenRevision={rev.openRevision} termbaseEntries={termbase.termbaseEntries}
    onPromoteToTermbase={termbase.promoteToTermbase} longTerms={longTerms}
  />;

  return <section className="document-workspace" data-mode={workspaceMode} aria-labelledby="workspace-title">
    <WorkspaceDialogs
      lang={lang} direction={direction} target={target} phase={phase} translating={translating}
      saveView={saveView} error={error} errorTextValue={errorTextValue}
      revision={rev.revision} revisionDialog={rev.revisionDialog} fragmentBox={rev.fragmentBox}
      onUpdateRevision={rev.updateRevision} onCancelRevision={() => rev.cancelRevision()} onConfirmRevision={rev.confirmRevision}
      leaveDialog={leaveDialog} stayLeaveButton={stayLeaveButton} onDismissLeave={() => setPendingLeaveUrl(null)}
      onSave={save} onResolveConflictsAndSave={resolveConflictsAndSave} onExportProseTxt={exportProseTxt} onLeaveAnyway={leaveAnyway}
      pendingImport={pendingImport} importDialog={importDialog} keepImportButton={keepImportButton}
      onCancelImport={() => setPendingImport(null)}
      onConfirmImport={pending => {
        if (pending.kind === 'text') replaceWithText(pending.text);
        else if (pending.kind === 'query') { replaceWithText(pending.text, 'movedQuery'); sourceEditor.current?.focus(); }
        else replaceWithWorkfile(pending.workfile);
      }}
    />
    <header className="workspace-head">
      <div className="workspace-heading">
        <h1 id="workspace-title" tabIndex={-1}>{m.hero.title}<span>{m.hero.titleAccent}</span></h1>
        <p>{m.hero.subtitle}</p>
      </div>
      <div className="mode-switch" role="group" aria-label={w.modeAria}>
        <button type="button" aria-pressed={quick} disabled={!quick && longDocument} title={!quick && longDocument ? w.modeQuickLocked : undefined} onClick={() => doc.setWorkspaceMode('quick')}>{w.modeQuick}</button>
        <button type="button" aria-pressed={!quick} onClick={() => doc.setWorkspaceMode('manuscript')}>{w.modeManuscript}</button>
      </div>
    </header>
    <div className="workspace-grid">
      <div className="manuscript-workspace">
        <WorkspaceEditorPane
          lang={lang} doc={doc} snapshot={snapshot} pool={pool} quick={quick}
          sourceLength={sourceLength} targetLength={targetLength} charCountText={charCountText}
          validInput={validInput} reviewsClosed={reviewsClosed} translationClosed={translationClosed}
          semanticRunActive={semanticRunActive} holdsWork={holdsWork} basisChanged={basisChanged}
          waitedSeconds={waitedSeconds} copied={copied} saveStateText={saveStateText} guard={guard}
          noticeText={noticeText} errorTextValue={errorTextValue} errorDetails={errorDetails}
          termbaseFeedback={termbase.termbaseFeedback} editorLayout={editorLayout}
          onToggleEditorLayout={() => setEditorLayout(prev => (prev === 'split' ? 'stacked' : 'split'))}
          syncScroll={syncScroll} onToggleSyncScroll={() => setSyncScroll(value => !value)}
          markdownPreview={markdownPreview} onToggleMarkdownPreview={toggleMarkdownPreview}
          onPromoteSelection={() => termbase.promoteSelectionToTermbase(() => sourceEditor.current?.selection() ?? null, () => targetEditor.current?.selection() ?? null)}
          activeTmSegment={tm.activeTmSegment} sourceHighlights={sourceHighlights} targetHighlights={targetHighlights}
          sourceEditor={sourceEditor} targetEditor={targetEditor} fileBox={fileBox}
          onSubmit={(e: FormEvent) => { e.preventDefault(); void doc.check(true, { reviewsClosed }); }}
          onTranslateQuick={(e: FormEvent) => { e.preventDefault(); setCopied(null); void doc.translateInReview({ translationClosed }); }}
          onCheckFreshBasis={() => void doc.check(false, { reviewsClosed })}
          onTranslateInReview={() => { setCopied(null); void doc.translateInReview({ translationClosed }); }}
          onEditorScroll={handleEditorScroll}
          onCursorChange={(side, offset) => tm.setTmCursor(prev => (prev?.kind === 'offset' && prev.side === side && prev.offset === offset ? prev : { kind: 'offset', side, offset }))}
          onEditSide={editSide} onCopyTranslation={() => void copyTranslation()} onAddAlignment={addAlignment}
          onImportFile={file => void importFile(file)}
          onClearDraft={() => { if (doc.clearDraft()) sourceEditor.current?.focus(); }}
          onSave={save} onResolveConflictsAndSave={resolveConflictsAndSave} onExportProseTxt={exportProseTxt}
          onExportTxt={() => { const out = doc.exportTxt(); downloadFile(out.filename, out.content, out.mimeType); }}
          onExportResult={() => { const out = doc.exportResult(); downloadFile(out.filename, out.content, out.mimeType); }}
          onExportMarkdown={() => { const out = doc.exportMarkdown(lang); downloadFile(out.filename, out.content, out.mimeType); }}
        />
        {!quick && <WorkspaceInspector
          lang={lang} doc={doc} snapshot={snapshot} pool={pool} inspectorTab={inspectorTab}
          onSelectTab={selectInspectorTab} reviewBadgeCount={reviewBadgeCount} reconciled={reconciled}
          readyCount={ready.length} structureOn={structureOn} semanticOn={semanticOn}
          layer1Summary={layer1Summary} layer2={layer2} termTotal={termTotal} ambiguousTotal={ambiguousTotal}
          styleOn={styleOn} onStyleChange={setStyleOn} onJumpTo={jumpTo} termTrack={termTrack}
          onPromoteToTermbase={termbase.promoteToTermbase} onActiveSemanticChange={setActiveSemanticId} tools={sharedTools}
        />}
      </div>
      {quick && <WorkspaceQuickSide tools={sharedTools} />}
    </div>
    <RuntimeStatus saveView={saveView} reportCommit={latest?.report.dictionary.source_commit ?? null} />
  </section>;
}
