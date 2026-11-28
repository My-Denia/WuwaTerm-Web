'use client';

import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { fill, msg } from '../../../lib/messages';
import type { PoolView } from '../../../lib/runtime-store';
import { semanticMsg } from '../../../lib/semantic-messages';
import type { structureSummary } from '../../../lib/structure-layer';
import type { TermbaseDirection, TermbaseEntry } from '../../../lib/termbase';
import type { TmActiveSegment, TmSegmentAlignmentStatus } from '../../../lib/tm-segment';
import type { TmEntry } from '../../../lib/translation-memory';
import type { UiLanguage } from '../../../lib/ui-language';
import type { WorkbenchController, WorkbenchSnapshot } from '../../../lib/workbench-controller';
import type { Span } from '../../../lib/workbench-model';
import { MyMemory, type ApplySuggestionOutcome, type TmDictionaryStatusView, type TmPersistenceAdapter } from '../my-memory';
import { MyTerms, type MyTermsPersisted, type TermbaseDraftSeed, type TermbaseExternalFeedback } from '../my-terms';
import { QuickTermLookup, type QuickTermLookupPersisted, type QuickTermLookupRequestManager } from '../quick-term-lookup';
import { StructureLayer, StyleLayer } from '../review-layers';
import { SemanticWorkbench } from '../semantic-workbench';

export type SharedToolsProps = {
  source: string;
  effectiveTermbaseDirection: TermbaseDirection;
  lookupPersisted: QuickTermLookupPersisted;
  onLookupPersistedChange: Dispatch<SetStateAction<QuickTermLookupPersisted>>;
  lookupRequestManager: QuickTermLookupRequestManager;
  onInsertTerm: (text: string) => void;
  onMoveQueryToSource: (text: string) => void;
  termbaseEntries: TermbaseEntry[];
  onTermbaseEntriesChange: Dispatch<SetStateAction<TermbaseEntry[]>>;
  termbaseOpen: boolean;
  onTermbaseOpenChange: Dispatch<SetStateAction<boolean>>;
  termbaseDraftSeed: TermbaseDraftSeed | null;
  termbaseFeedback: TermbaseExternalFeedback | null;
  myTermsPersisted: MyTermsPersisted;
  onMyTermsPersistedChange: Dispatch<SetStateAction<MyTermsPersisted>>;
  activeTmSegment: TmActiveSegment;
  tmAlignmentStatus: TmSegmentAlignmentStatus;
  currentTermsDbRevision: string | null;
  currentGameVersion: string | null;
  getDisplayTmBasis: () => { currentTermsDbRevision: string | null; currentGameVersion: string | null };
  getConfirmTmBasis: () => { currentTermsDbRevision: string | null; currentGameVersion: string | null };
  tmDictionaryStatus: TmDictionaryStatusView;
  selfHosted: boolean;
  tmStorageState: 'idle' | 'loading' | 'ready' | 'error';
  onRetryLoadTm?: () => void;
  tmPersistence?: TmPersistenceAdapter;
  tmEntries: TmEntry[];
  onTmEntriesChange: Dispatch<SetStateAction<TmEntry[]>>;
  onApplyMemorySuggestion: (text: string) => ApplySuggestionOutcome | boolean | void;
  onSelectTmSegment: (index: number) => void;
  tmOpen: boolean;
  onTmOpenChange: Dispatch<SetStateAction<boolean>>;
};

function LookupPanel({ quick, embedded, tools }: { quick: boolean; embedded?: boolean; tools: SharedToolsProps }) {
  return <QuickTermLookup
    quick={quick}
    embedded={embedded}
    persisted={tools.lookupPersisted}
    onPersistedChange={tools.onLookupPersistedChange}
    requestManager={tools.lookupRequestManager}
    onInsert={tools.onInsertTerm}
    onUseQuery={tools.onMoveQueryToSource}
  />;
}

function TermsPanel({ tools }: { tools: SharedToolsProps }) {
  return <MyTerms
    source={tools.source}
    direction={tools.effectiveTermbaseDirection}
    entries={tools.termbaseEntries}
    setEntries={tools.onTermbaseEntriesChange}
    open={tools.termbaseOpen}
    onOpenChange={tools.onTermbaseOpenChange}
    draftSeed={tools.termbaseDraftSeed}
    externalFeedback={tools.termbaseFeedback}
    persisted={tools.myTermsPersisted}
    onPersistedChange={tools.onMyTermsPersistedChange}
  />;
}

function MemoryPanel({ tools }: { tools: SharedToolsProps }) {
  return <MyMemory
    sourceText={tools.activeTmSegment.sourceText}
    targetText={tools.activeTmSegment.targetText}
    prevSource={tools.activeTmSegment.prevSource}
    nextSource={tools.activeTmSegment.nextSource}
    segmentIndex={tools.activeTmSegment.index}
    segmentTotal={tools.activeTmSegment.total}
    alignmentStatus={tools.tmAlignmentStatus}
    direction={tools.effectiveTermbaseDirection}
    currentTermsDbRevision={tools.currentTermsDbRevision}
    currentGameVersion={tools.currentGameVersion}
    getDisplayBasis={tools.getDisplayTmBasis}
    getConfirmBasis={tools.getConfirmTmBasis}
    dictionaryStatus={tools.tmDictionaryStatus}
    storageMode={tools.selfHosted ? 'selfhost_sqlite' : 'public_memory'}
    storageState={tools.tmStorageState}
    onRetryLoad={tools.onRetryLoadTm}
    persistence={tools.tmPersistence}
    entries={tools.tmEntries}
    setEntries={tools.onTmEntriesChange}
    onApplySuggestion={tools.onApplyMemorySuggestion}
    onSelectSegment={tools.onSelectTmSegment}
    open={tools.tmOpen}
    onOpenChange={tools.onTmOpenChange}
  />;
}

export function WorkspaceQuickSide({ tools }: { tools: SharedToolsProps }) {
  return <div className="workspace-side">
    <LookupPanel quick tools={tools} />
    <TermsPanel tools={tools} />
    <MemoryPanel tools={tools} />
  </div>;
}

type InspectorProps = {
  lang: UiLanguage;
  doc: WorkbenchController;
  snapshot: WorkbenchSnapshot;
  pool: PoolView;
  inspectorTab: 'review' | 'terms' | 'memory';
  onSelectTab: (tab: 'review' | 'terms' | 'memory') => void;
  reviewBadgeCount: number;
  reconciled: { status: string; reason: string; code?: string; resolution: unknown }[];
  readyCount: number;
  structureOn: boolean;
  semanticOn: boolean;
  layer1Summary: ReturnType<typeof structureSummary>;
  layer2: { listed: number; pending: number; high: number; medium: number; low: number; covered: number };
  termTotal: number;
  ambiguousTotal: number;
  styleOn: boolean;
  onStyleChange: (on: boolean) => void;
  onJumpTo: (side: 'source' | 'target', span: Span) => void;
  termTrack: (longTerms: ReactNode) => ReactNode;
  onPromoteToTermbase: (item: { source: string; target: string; direction?: TermbaseDirection }) => void;
  onActiveSemanticChange: (id: string | null) => void;
  tools: SharedToolsProps;
};

export function WorkspaceInspector({
  lang,
  doc,
  snapshot,
  pool,
  inspectorTab,
  onSelectTab,
  reviewBadgeCount,
  reconciled,
  readyCount,
  structureOn,
  semanticOn,
  layer1Summary,
  layer2,
  termTotal,
  ambiguousTotal,
  styleOn,
  onStyleChange,
  onJumpTo,
  termTrack,
  onPromoteToTermbase,
  onActiveSemanticChange,
  tools,
}: InspectorProps) {
  const m = msg(lang);
  const w = m.workspace;
  const sm = semanticMsg(lang);
  const { choices, semantic, phase } = snapshot;
  const reasonText = (item: { reason: string; code?: string }) =>
    ((m.choiceReasons as Record<string, string>)[item.code ?? ''] ?? item.reason);
  const scrollTo = (selector: string) => document.querySelector(selector)?.scrollIntoView({ block: 'start' });

  return <aside className="manuscript-review-pane workspace-inspector" aria-label={w.inspectorAria}>
    <div className="inspector-tabs" role="tablist" aria-label={w.inspectorAria} data-testid="inspector-tabs">
      <button
        type="button"
        role="tab"
        id="inspector-tab-review"
        aria-selected={inspectorTab === 'review'}
        aria-controls="inspector-panel-review"
        data-inspector-tab="review"
        onClick={() => onSelectTab('review')}
      >
        <span>{w.inspectorReview}</span>
        {reviewBadgeCount > 0 && <span className="inspector-badge">{reviewBadgeCount}</span>}
      </button>
      <button
        type="button"
        role="tab"
        id="inspector-tab-terms"
        aria-selected={inspectorTab === 'terms'}
        aria-controls="inspector-panel-terms"
        data-inspector-tab="terms"
        onClick={() => onSelectTab('terms')}
      >
        <span>{w.inspectorTerms}</span>
        {tools.termbaseEntries.length > 0 && <span className="inspector-badge">{tools.termbaseEntries.length}</span>}
      </button>
      <button
        type="button"
        role="tab"
        id="inspector-tab-memory"
        aria-selected={inspectorTab === 'memory'}
        aria-controls="inspector-panel-memory"
        data-inspector-tab="memory"
        onClick={() => onSelectTab('memory')}
      >
        <span>{w.inspectorMemory}</span>
        {tools.tmEntries.length > 0 && <span className="inspector-badge">{tools.tmEntries.length}</span>}
      </button>
    </div>
    <div
      id="inspector-panel-review"
      role="tabpanel"
      aria-labelledby="inspector-tab-review"
      className="inspector-panel"
      hidden={inspectorTab !== 'review'}
    >
      {choices.length > 0 && <div className="choice-records"><h3>{fill(m.review.choiceHeader, { ready: readyCount, pending: choices.length - readyCount })}</h3>
        {choices.map((choice, i) => {
          const canConfirm = reconciled[i].status === 'pending' && reconciled[i].code !== 'duplicate_position' && doc.canConfirmChoice(i);
          return <div className="choice-record" key={i}><p>{choice.candidate ? fill(m.review.choicePair, { span: choice.source_span.text, zh: choice.candidate.zh, en: choice.candidate.en }) : fill(m.review.choiceNotTerm, { span: choice.source_span.text })} — {reconciled[i].status === 'applicable' ? m.review.choiceApplicable : m.review.choicePending}</p><p>{reasonText(reconciled[i])}</p><div className="finding-actions">{canConfirm && <button type="button" className="text-button" disabled={phase === 'loading'} onClick={() => doc.confirmChoice(i)}>{m.review.choiceConfirm}</button>}<button type="button" className="text-button" onClick={() => doc.removeChoice(i)}>{m.review.choiceRemove}</button></div></div>;
        })}
      </div>}
      {(semanticOn || structureOn) && <div className="issue-overview layer-overview" role="group" aria-label={sm.overviewAria}>
        {structureOn && <button type="button" className="secondary-button" data-layer="1" onClick={() => scrollTo('#layer1-title')}>
          {layer1Summary.checked ? fill(sm.layers.ovL1, { n: layer1Summary.findings + layer1Summary.omitted }) : sm.layers.ovL1None}</button>}
        <button type="button" className="secondary-button" onClick={() => scrollTo('#term-track-title')}>{fill(sm.overviewTerms, { n: termTotal })}</button>
        {ambiguousTotal > 0 && <button type="button" className="secondary-button" data-ambiguous={ambiguousTotal} onClick={() => scrollTo('details.ambiguous-mentions')}>{fill(sm.layers.ovAmbiguous, { n: ambiguousTotal })}</button>}
        {semanticOn && <button type="button" className="secondary-button" data-layer="2" onClick={() => scrollTo('#semantic-title')}>{layer2.listed + layer2.covered || semantic.results.length ? fill(sm.overviewSemantic, { n: layer2.listed, pending: layer2.pending }) : sm.overviewSemanticNone}</button>}
        {semanticOn && layer2.high + layer2.medium > 0 && <span className="overview-note" data-buckets={`${layer2.high}:${layer2.medium}`}>{fill(sm.layers.ovBuckets, { high: layer2.high, medium: layer2.medium })}</span>}
        {semanticOn && layer2.low > 0 && <span className="overview-note" data-low={layer2.low}>{fill(sm.layers.ovLow, { n: layer2.low })}</span>}
        {semanticOn && layer2.covered > 0 && <span className="overview-note" data-covered={layer2.covered}>{fill(sm.layers.ovCovered, { n: layer2.covered })}</span>}
        <button type="button" className="secondary-button" data-layer="3" data-on={styleOn ? 'true' : 'false'} onClick={() => scrollTo('#layer3-title')}>{styleOn ? sm.layers.ovL3On : sm.layers.ovL3Off}</button>
      </div>}
      <StructureLayer doc={doc} snapshot={snapshot} lang={lang} pool={pool} locate={onJumpTo} />
      <SemanticWorkbench
        doc={doc}
        snapshot={snapshot}
        lang={lang}
        pool={pool}
        locate={onJumpTo}
        termTrack={termTrack}
        termbaseEntries={tools.termbaseEntries}
        onPromoteToTermbase={onPromoteToTermbase}
        onActiveSemanticChange={onActiveSemanticChange}
      />
      <StyleLayer lang={lang} on={styleOn} setOn={onStyleChange} />
    </div>
    <div
      id="inspector-panel-terms"
      role="tabpanel"
      aria-labelledby="inspector-tab-terms"
      className="inspector-panel inspector-stack"
      hidden={inspectorTab !== 'terms'}
    >
      <LookupPanel quick={false} embedded tools={tools} />
      <TermsPanel tools={tools} />
    </div>
    <div
      id="inspector-panel-memory"
      role="tabpanel"
      aria-labelledby="inspector-tab-memory"
      className="inspector-panel inspector-stack"
      hidden={inspectorTab !== 'memory'}
    >
      <MemoryPanel tools={tools} />
    </div>
  </aside>;
}
