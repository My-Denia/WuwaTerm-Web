'use client';

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  FILTERS, filterFindings, findingVerdictCounts, reconcileActiveId, compactScalarContext,
} from '../../lib/review-navigation.js';
import { highlightSegments, summarizeReviewParts } from '../../lib/review-report.js';
import {
  basisOf, compareReports, leaveGuardActive, manuscriptSaveView,
  reconcileChoices, sameBasis,
} from '../../lib/manuscript.js';
import { spliceOccurrence, fragmentOccurrences } from '../../lib/target-revision.js';
import { categoryLabel, labelJoiner } from '../../lib/dictionary-labels';
import { failureDetails, fill, msg, summarySentence } from '../../lib/messages';
import { downloadFile } from '../../lib/download-file';
import { isAmbiguousMention, isLong, sessionReviewFeatures } from '../../lib/long-review';
import { judgedReport, layerTwoCounts, layerTwoRows, structureSummary, structureViews } from '../../lib/structure-layer';
import { CAPABILITY_STRUCTURE_CHECK } from '../../lib/structure-check.js';
import { useRuntime, useRuntimeStore } from '../../lib/runtime-provider';
import { numberLocale } from '../../lib/ui-language';
import { semanticSegmentViews } from '../../lib/semantic-state.js';
import { semanticMsg } from '../../lib/semantic-messages';
import { inferDirection } from '../../lib/termbase';
import {
  canonicalOf, createWorkbenchController, documentSignature, isRunActive, workPresent,
} from '../../lib/workbench-controller';
import type { Candidate, Choice, Draft, Finding, PairView, PendingWorkfile, Snapshot, Span } from '../../lib/workbench-model';
import { EditorSurfaceAdapter, type EditorEdit, type EditorSurfaceHandle } from './editor-surface';
import { MyTerms } from './my-terms';
import { QuickTermLookup } from './quick-term-lookup';
import { RequestId } from './request-feedback';
import { RuntimeStatus } from './runtime-status';
import { useUiLanguage } from './ui-language-context';
import { SemanticWorkbench } from './semantic-workbench';
import { StructureLayer, StyleLayer } from './review-layers';

type RevisionIntent = {
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
type PendingReplacement = { kind: 'text'; text: string } | { kind: 'query'; text: string } | { kind: 'workfile'; workfile: PendingWorkfile };

function Excerpt({ text, span, missing }: { text: string; span: Span | null; missing: string }) {
  const { lang } = useUiLanguage();
  const located = span ? highlightSegments(text, span) : null;
  const compact = located && span ? compactScalarContext(text, span) : null;
  if (!located || !compact) return <p className="review-excerpt">{missing}</p>;
  return <>
    <p className="review-excerpt">{compact.clippedBefore ? '…' : null}{compact.before}<mark>{compact.hit}</mark>{compact.after}{compact.clippedAfter ? '…' : null}</p>
    {(compact.clippedBefore || compact.clippedAfter) && <details className="review-context"><summary>{msg(lang).review.viewFullContext}</summary>
      <p className="review-excerpt">{located.before}<mark>{located.hit}</mark>{located.after}</p>
    </details>}
  </>;
}

function unloadUrl(anchor: HTMLAnchorElement): string | null {
  if (anchor.hasAttribute('download') || anchor.target === '_blank') return null;
  const raw = anchor.getAttribute('href');
  if (!raw || raw.startsWith('#')) return null;
  let url: URL;
  try { url = new URL(anchor.href, window.location.href); } catch { return null; }
  if (url.origin === window.location.origin && url.pathname === window.location.pathname && url.search === window.location.search) return null;
  return url.href;
}

/**
 * The one document workspace. A single controller holds the draft, history, reports and semantic state; quick translation
 * and manuscript review are two layouts of that same document. The editors stay mounted across a mode switch, so moving to
 * manuscript mode (a long text, an imported manuscript, or the user's choice) keeps the texts, history, caret and IME state.
 */
export function DocumentWorkspace() {
  const { lang } = useUiLanguage();
  const runtime = useRuntimeStore();
  const { pool } = useRuntime();
  const [doc] = useState(() => createWorkbenchController({
    initialLang: lang,
    fetchCapabilities: () => runtime.capabilities(),
    onPoolRefresh: () => runtime.refreshPool(),
  }));
  const snapshot = useSyncExternalStore(doc.subscribe, doc.getSnapshot, doc.getSnapshot);
  const {
    draft, choices, imported, reports, history, documentCheckpoint, semantic, basis, capabilities,
    phase, translating, sourceDirtyForTranslation, notice, error,
    importedCanonical, downloadedCanonical, run, pairTranslating, generation, inFlight,
    workspaceMode, autoDirection, lastTranslation, redoCount,
  } = snapshot;
  const { source, target, direction, alignments } = draft;
  const quick = workspaceMode === 'quick';

  const [pendingImport, setPendingImport] = useState<PendingReplacement | null>(null);
  const [styleOn, setStyleOn] = useState(false);
  const importDialog = useRef<HTMLDialogElement>(null);
  const keepImportButton = useRef<HTMLButtonElement>(null);
  const [pendingLeaveUrl, setPendingLeaveUrl] = useState<string | null>(null);
  const [verdictFilter, setVerdictFilter] = useState<(typeof FILTERS)[number]['id']>('all');
  const [canonicalFindingId, setCanonicalFindingId] = useState<string | null>(null);
  const [copied, setCopied] = useState<'done' | 'failed' | null>(null);
  const [revision, setRevision] = useState<RevisionIntent | null>(null);
  const revisionRef = useRef<RevisionIntent | null>(null);
  const revisionDialog = useRef<HTMLDialogElement>(null);
  const fragmentBox = useRef<HTMLTextAreaElement>(null);
  const sourceEditor = useRef<EditorSurfaceHandle>(null);
  const targetEditor = useRef<EditorSurfaceHandle>(null);
  const fileBox = useRef<HTMLInputElement>(null);
  const leaveDialog = useRef<HTMLDialogElement>(null);
  const stayLeaveButton = useRef<HTMLButtonElement>(null);
  const leaveBypass = useRef(false);

  useEffect(() => {
    doc.activate();
    void doc.loadCapabilities();
    return () => doc.dispose();
  }, [doc]);
  useEffect(() => {
    doc.setLang(lang);
  }, [doc, lang]);

  const latest = reports.at(-1) ?? null;
  const previous = reports.at(-2) ?? null;
  const reviewFeatures = useMemo(() => sessionReviewFeatures(capabilities), [capabilities]);
  const layer1 = useMemo(() => structureViews(draft, snapshot.structure), [draft, snapshot.structure]);
  const layer1Summary = structureSummary(layer1);
  const layer2 = useMemo(() => {
    const views = (semanticSegmentViews(draft, { results: semantic.results, long: semantic.long }, basis, reviewFeatures) as { items: PairView[] }).items;
    return layerTwoCounts(layerTwoRows(semantic, views, layer1));
  }, [draft, semantic, basis, reviewFeatures, layer1]);
  // Ambiguous one-character names (ambiguous-mention-v1) are listed apart, folded, and never counted with the judged findings.
  const judged = useMemo(() => (latest ? judgedReport(latest.report) : null), [latest]);
  const visibleFindings = judged ? filterFindings(judged.report.findings, verdictFilter) : [];
  const findingCounts = findingVerdictCounts(judged?.report.findings ?? []);
  const activeFindingId = reconcileActiveId(canonicalFindingId, visibleFindings);
  if (activeFindingId !== null && activeFindingId !== canonicalFindingId) {
    setCanonicalFindingId(activeFindingId);
  }
  const activeVisibleIndex = visibleFindings.findIndex(finding => finding.id === activeFindingId);
  const reconciled = reconcileChoices(choices, draft, latest, imported);
  const ready = reconciled.flatMap(item => (item.resolution ? [item.resolution] : []));
  const current = !!latest?.trusted && latest.signature === documentSignature(draft, ready) && phase === 'success';
  const sourceLength = Array.from(source).length;
  const targetLength = Array.from(target).length;
  const validInput = !!source.trim() && !!target.trim() && sourceLength <= 2000 && targetLength <= 2000;
  const reviewsClosed = pool.kind === 'success' && pool.data.reviews.remaining === 0;
  const longDocument = isLong(draft);
  // The last whole-text translation describes the editors only while both texts are still the ones it produced.
  const quickResult = lastTranslation && lastTranslation.source === source && lastTranslation.text === target ? lastTranslation : null;
  const translationClosed = pool.kind === 'success' && (!pool.data.translation_enabled || pool.data.translations.remaining === 0 || pool.data.characters.remaining === 0);
  const sourceCompatible = !!latest?.trusted && latest.source === source && latest.direction === direction;
  const comparison = latest && previous ? compareReports(previous, latest) : null;
  const basisChanged = !!latest?.trusted && choices.some(choice => !sameBasis(choice.basis, basisOf(latest.report)));
  const canonical = useMemo(() => canonicalOf(draft, choices, reports, semantic, basis), [draft, choices, reports, semantic, basis]);
  const holdsWork = workPresent(draft, choices, reports, semantic);
  const saveView = manuscriptSaveView({ holdsWork, canonical, importedCanonical, downloadedCanonical });
  const semanticRunActive = isRunActive(run, pairTranslating);
  const guard = leaveGuardActive({ view: saveView, checkInFlight: phase === 'loading' || translating || semanticRunActive });
  const m = msg(lang);
  const w = m.workspace;
  const saveStateText = {
    empty: m.review.saveStateEmpty,
    'page-only': m.review.saveStatePageOnly,
    'matches-import': m.review.saveStateMatchesImport,
    'matches-download': m.review.saveStateMatchesDownload,
    diverged: m.review.saveStateDiverged,
    'not-serializable': m.review.saveStateNotSerializable,
  }[saveView];
  const locale = numberLocale(lang);
  const reasonText = (item: { reason: string; code?: string }) =>
    ((m.choiceReasons as Record<string, string>)[item.code ?? ''] ?? item.reason);
  const sm = semanticMsg(lang);
  const translationNotice = (value: string) => {
    const at = value.indexOf('#');
    const reason = at < 0 ? value : value.slice(0, at);
    const requestId = at < 0 ? null : value.slice(at + 1);
    return [(m.tMsg as Record<string, string>)[reason] ?? m.rMsg.fallback, ...failureDetails(lang, { kind: 'translation', reason, requestId })].join(' ');
  };
  const noticeText = !notice ? ''
    : notice.startsWith('sem:') ? (sm.notices[notice.slice(4)] ?? '')
    : notice.startsWith('t:') ? translationNotice(notice.slice(2))
    : ((m.notices as Record<string, string>)[notice] ?? '');
  const errorTextValue = !error ? ''
    : error.saveConflict ? m.review.saveConflictBody
    : error.reason !== undefined && error.reason !== null ? ((m.rMsg as Record<string, string>)[error.reason] ?? (m.tMsg as Record<string, string>)[error.reason] ?? m.rMsg.fallback)
    : error.code && (m.errors as Record<string, string>)[error.code] ? (m.errors as Record<string, string>)[error.code]!
    : error.text ?? '';
  const errorDetails = error?.kind ? failureDetails(lang, { kind: error.kind, reason: error.reason, requestId: error.requestId, retryAfter: error.retryAfter }) : [];

  const cancelRevision = useCallback((message = '') => {
    const intent = revisionRef.current;
    revisionRef.current = null; setRevision(null); revisionDialog.current?.close();
    if (intent?.trigger.isConnected) intent.trigger.focus({ preventScroll: true });
    if (message) doc.setNotice(message);
  }, [doc]);
  function updateRevision(intent: RevisionIntent) { revisionRef.current = intent; setRevision(intent); }
  useEffect(() => {
    const intent = revisionRef.current;
    if (intent && (draft !== intent.draft || choices !== intent.choices || imported !== intent.imported
      || reports.at(-1) !== intent.snapshot || generation !== intent.generation || inFlight)) {
      cancelRevision('revisionStale');
    }
  }, [draft, choices, imported, reports, generation, inFlight, cancelRevision]);
  useEffect(() => {
    if (revision) {
      if (!revisionDialog.current?.open) { revisionDialog.current?.showModal(); fragmentBox.current?.focus(); }
    } else revisionDialog.current?.close();
  }, [revision]);
  const occurrences: Span[] = revision ? fragmentOccurrences(target, revision.fragment) : [];
  const revisionReplacement = revision ? (direction === 'en' ? revision.candidate.en : revision.candidate.zh) : '';
  const revisionPreview = revision?.selected ? spliceOccurrence(target, revision.fragment, revision.selected, revisionReplacement) : null;
  function openRevision(finding: Finding, candidate: Candidate, trigger: HTMLButtonElement) {
    const now = doc.getSnapshot();
    const latestSnap = now.reports.at(-1) ?? null;
    if (now.inFlight || now.phase === 'loading' || !doc.isRevisionEligible(finding, candidate) || !latestSnap) return;
    updateRevision({
      snapshot: latestSnap, generation: now.generation, draft: now.draft,
      choices: now.choices, imported: now.imported, finding, candidate, trigger, fragment: '', selected: null,
    });
  }
  function confirmRevision() {
    const intent = revisionRef.current;
    if (!intent) return;
    const outcome = doc.applyTargetRevision(intent);
    if (outcome.status === 'stale') { cancelRevision(); return; }
    if (outcome.status !== 'applied') return;
    cancelRevision();
    requestAnimationFrame(() => targetEditor.current?.reveal(outcome.span));
  }

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

  useEffect(() => {
    if (pendingLeaveUrl) {
      if (!leaveDialog.current?.open) leaveDialog.current?.showModal();
      stayLeaveButton.current?.focus();
    } else leaveDialog.current?.close();
  }, [pendingLeaveUrl]);

  useEffect(() => {
    if (!guard) return;
    function onClick(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (!(event.target instanceof Element)) return;
      const anchor = event.target.closest('a');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const url = unloadUrl(anchor);
      if (!url) return;
      event.preventDefault();
      event.stopPropagation();
      setPendingLeaveUrl(url);
    }
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [guard]);

  useEffect(() => {
    function onPageShow() { leaveBypass.current = false; setPendingLeaveUrl(null); }
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

  useEffect(() => {
    if (!guard) return;
    function onBeforeUnload(event: BeforeUnloadEvent) {
      if (leaveBypass.current) return;
      event.preventDefault();
      event.returnValue = '1';
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [guard]);

  async function check(withChoices = true) {
    await doc.check(withChoices, { reviewsClosed });
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    await check();
  }
  async function translateInReview() {
    setCopied(null);
    await doc.translateInReview({ translationClosed });
  }
  function translateQuick(event: FormEvent) {
    event.preventDefault();
    void translateInReview();
  }
  function jumpTo(side: 'source' | 'target', span: Span) {
    (side === 'source' ? sourceEditor : targetEditor).current?.reveal(span);
  }
  function editSide(side: 'source' | 'target') {
    return (value: string, edit: EditorEdit) => doc.editText(side, value, edit.composing ? { composing: true } : {});
  }
  function addAlignment(omit = false, whole = false) {
    const a = whole ? null : sourceEditor.current?.selection() ?? null;
    const b = omit || whole ? null : targetEditor.current?.selection() ?? null;
    doc.recordAlignment(a, b, omit, whole);
  }
  function insertTerm(text: string) {
    const current = doc.getSnapshot().draft.source;
    doc.editText('source', current ? current + ' ' + text : text);
    sourceEditor.current?.focus();
  }
  function moveQueryToSource(text: string) {
    if (!text.trim()) return;
    if (doc.replacementNeedsConfirm()) { setPendingImport({ kind: 'query', text }); return; }
    doc.replaceWithText(text, 'movedQuery');
    sourceEditor.current?.focus();
  }
  function replaceWithText(text: string, notice?: string) {
    importDialog.current?.close();
    setPendingImport(null);
    doc.replaceWithText(text, notice);
  }
  async function copyTranslation() {
    try { await navigator.clipboard.writeText(target); setCopied('done'); }
    catch { setCopied('failed'); }
  }
  function replaceWithWorkfile(workfile: PendingWorkfile) {
    importDialog.current?.close();
    setPendingImport(null);
    doc.replaceWithWorkfile(workfile);
  }
  async function importFile(file?: File) {
    const outcome = await doc.importFile(file);
    if (outcome.status === 'needs_confirm_text') setPendingImport({ kind: 'text', text: outcome.pendingText });
    else if (outcome.status === 'needs_confirm_workfile') setPendingImport({ kind: 'workfile', workfile: outcome.pendingWorkfile });
  }
  function clearDraft() {
    if (doc.clearDraft()) sourceEditor.current?.focus();
  }
  function save() {
    const out = doc.save();
    if (out) downloadFile(out.filename, out.content, out.mimeType);
  }
  function resolveConflictsAndSave() {
    const out = doc.resolveConflictingChoicesAndSave();
    if (out) downloadFile(out.filename, out.content, out.mimeType);
  }
  function exportProseTxt() {
    const out = doc.exportProseTxt();
    downloadFile(out.filename, out.content, out.mimeType);
  }
  function exportTxt() {
    const out = doc.exportTxt();
    downloadFile(out.filename, out.content, out.mimeType);
  }
  function exportResult() {
    const out = doc.exportResult();
    downloadFile(out.filename, out.content, out.mimeType);
  }
  function exportMarkdown() {
    const out = doc.exportMarkdown(lang);
    downloadFile(out.filename, out.content, out.mimeType);
  }

  const summaryParts = judged ? summarizeReviewParts(judged.report) : null;
  const comparisonGroups = ([['new', m.review.comparisonNew], ['resolved', m.review.comparisonResolved], ['pending', m.review.comparisonPending], ['incomparable', m.review.comparisonIncomparable]] as const)
    .map(([key, label]) => ({ key, label, items: comparison ? comparison[key] : [] }));
  // The review overview reads every layer from the same derivations the layers render from.
  const structureOn = !!capabilities?.includes(CAPABILITY_STRUCTURE_CHECK);
  const semanticOn = !!capabilities?.includes('semantic-review-v1');
  const ambiguousTotal = (judged?.ambiguous.length ?? 0)
    + semantic.long.records.reduce((n, r) => n + (r.result?.findings.filter(isAmbiguousMention).length ?? 0), 0);
  const scrollTo = (selector: string) => document.querySelector(selector)?.scrollIntoView({ block: 'start' });
  const termTotal = (judged?.report.findings.length ?? 0)
    + semantic.long.records.reduce((n, r) => n + (r.result?.findings.filter(f => !isAmbiguousMention(f)).length ?? 0), 0);
  const translatePrimary = !!source.trim() && !target.trim();

  const termTrack = (longTerms: ReactNode): ReactNode => <section className="term-track" aria-labelledby="term-track-title">
    <h3 id="term-track-title">{sm.termTrackTitle}</h3>
    <p className="track-note">{sm.termTrackNote}</p>
    {latest ? <>
      <div className="review-summary" aria-live="polite">
        {summaryParts ? <p>{summarySentence(summaryParts, lang)}</p> : <p>{m.summary.detailMissing}</p>}
        {current ? <p className="review-current">{m.review.summaryCurrent}</p> : <p className="review-stale">{latest.trusted ? m.review.summaryStale : m.review.summaryImported}</p>}
        <p>{fill(m.review.ruleLine, { rule: latest.report.rule_version, commit: latest.report.dictionary.source_commit?.slice(0, 12) ?? m.review.dictUnknown })}</p>
        {latest.report.truncated && <p className="review-stale review-truncated-note">{m.review.truncatedNote}</p>}
      </div>
      {comparison && <details className="report-changes" open><summary>{m.review.comparisonTitle}{current ? '' : m.review.comparisonSuffix}</summary>
        {comparisonGroups.map(group => <div key={group.key}><h4>{group.label} · {group.items.length}</h4>{group.items.map((item: { label: string; reason: string; code?: string; mention: { text: string; start: number; historical: boolean } }, i: number) => <p key={i}>{fill(item.mention.historical ? m.review.comparisonMentionHistorical : m.review.comparisonMention, { text: item.mention.text, n: item.mention.start + 1 })}：{((m.comparisonReasons as Record<string, string>)[item.code ?? ''] ?? item.reason)}</p>)}</div>)}
        <p>{m.review.comparisonNote}</p>
      </details>}
      <div className="finding-nav" role="group" aria-label={m.review.filterAria}>
        {FILTERS.map(item => <button key={item.id} type="button" className="secondary-button" aria-pressed={verdictFilter === item.id} onClick={() => setVerdictFilter(item.id)}>{(m.review.filters as Record<string, string>)[item.id] ?? item.label} {findingCounts[item.id as keyof typeof findingCounts]}</button>)}
      </div>
      <div className="finding-nav" role="group" aria-label={m.review.navAria}>
        <button type="button" className="secondary-button" disabled={activeVisibleIndex <= 0} onClick={() => { const previousFinding = visibleFindings[activeVisibleIndex - 1]; if (previousFinding) setCanonicalFindingId(previousFinding.id); }}>{m.review.navPrev}</button>
        <button type="button" className="secondary-button" disabled={activeVisibleIndex < 0 || activeVisibleIndex >= visibleFindings.length - 1} onClick={() => { const nextFinding = visibleFindings[activeVisibleIndex + 1]; if (nextFinding) setCanonicalFindingId(nextFinding.id); }}>{m.review.navNext}</button>
        <p className="finding-position">{fill(m.review.position, { i: activeVisibleIndex < 0 ? 0 : activeVisibleIndex + 1, n: visibleFindings.length })}</p>
      </div>
      <div className="review-findings">{judged!.report.findings.length === 0 && <p>{m.review.noFindings}</p>}
        {visibleFindings.length === 0 && judged!.report.findings.length > 0 && <p>{m.review.noFindingsFiltered}</p>}
        {visibleFindings.map((finding: Finding) => {
          const active = finding.id === activeFindingId;
          const sourceLocated = latest.source === source && highlightSegments(source, finding.source_span) !== null;
          const targetLocated = finding.target_span !== null && latest.target === target && highlightSegments(target, finding.target_span) !== null;
          return <article className="term-result" key={finding.id} data-mention-id={finding.id} data-active={active ? 'true' : 'false'} aria-current={active ? 'true' : undefined}><p className="result-summary">{active ? m.review.currentMark : ''}<span className={`verdict-badge verdict-${finding.verdict}`}>{(m.review.verdicts as Record<string, string>)[finding.verdict]}</span>{finding.candidates_truncated ? m.review.truncatedMark : ''}</p>
            {finding.reason && <p className="finding-reason" data-reason={finding.reason}>{fill(m.review.reasonLabel, { reason: (m.review.reasons as Record<string, string>)[finding.reason] ?? finding.reason })}</p>}
            <div className="excerpt-labeled">
              <span className="excerpt-tag">{m.review.excerptSourceLabel}</span>
              <Excerpt text={source} span={sourceLocated ? finding.source_span : null} missing={fill(m.review.excerptMissingSource, { text: finding.source_span.text })} />
            </div>
            <div className="excerpt-labeled">
              <span className="excerpt-tag">{m.review.excerptTargetLabel}</span>
              <Excerpt text={target} span={targetLocated ? finding.target_span : null} missing={m.review.excerptMissingTarget} />
            </div>
            <div className="finding-jumps">
              <button className="text-button" type="button" disabled={!sourceLocated} onClick={() => jumpTo('source', finding.source_span)}>{m.review.jumpSource}</button>
              <button className="text-button" type="button" disabled={!targetLocated} onClick={() => { if (finding.target_span) jumpTo('target', finding.target_span); }}>{m.review.jumpTarget}</button>
            </div>
            {finding.candidates.map((candidate: Candidate) => <div className="term-pair" key={candidate.candidate_id}><strong>{candidate.zh}</strong><span>{candidate.en}</span><small>{m.terms.category}{labelJoiner(lang)}{categoryLabel(lang, candidate.category)}</small>
              <div className="finding-actions">
                <button className="text-button" type="button" disabled={!sourceCompatible || phase === 'loading' || latest.report.truncated} onClick={() => doc.choose(finding, candidate)}>{m.review.adopt}</button>
                {targetLocated && <button className="text-button" type="button" disabled={!sourceCompatible || phase === 'loading'} onClick={() => doc.replaceTerm(finding, candidate)}>{m.review.replace}</button>}
                {finding.target_span === null && <button className="text-button" type="button" disabled={phase === 'loading' || !doc.isRevisionEligible(finding, candidate)} onClick={event => openRevision(finding, candidate, event.currentTarget)}>{m.review.revisionOpen}</button>}
              </div>
              <details className="candidate-sources"><summary>{m.review.viewSources}</summary>
                <ul>{candidate.sources.map(item => <li key={`${item.source_file}\u0000${item.source_id}`}><span>{item.source_file}</span><span>{item.source_id}</span></li>)}</ul>
              </details>
            </div>)}
            <details className="finding-basis"><summary>{m.review.findingBasis}</summary><p>{fill(m.review.spanRange, { start: finding.source_span.start + 1, end: finding.source_span.end })}</p><p>{finding.rule_id} · {finding.id}</p></details>
            <button className="text-button" type="button" disabled={!sourceCompatible || phase === 'loading'} onClick={() => doc.choose(finding, null)}>{m.review.notTerm}</button>
          </article>;
        })}
      </div>
      {judged && judged.ambiguous.length > 0 && <details className="ambiguous-mentions" data-count={judged.ambiguous.length}>
        <summary>{fill(sm.ambiguous.title, { n: judged.ambiguous.length })}</summary>
        <p className="track-note">{sm.ambiguous.note}</p>
        {judged.ambiguous.map((finding: Finding) => {
          const sourceLocated = latest.source === source && highlightSegments(source, finding.source_span) !== null;
          return <article className="term-result ambiguous-mention" key={finding.id} data-mention-id={finding.id}>
            <p className="result-summary"><span className="verdict-badge verdict-not_evaluated">{(m.review.verdicts as Record<string, string>).not_evaluated}</span> · {fill(sm.ambiguous.itemDocument, { text: finding.source_span.text, start: finding.source_span.start + 1, end: finding.source_span.end })}</p>
            <div className="excerpt-labeled">
              <span className="excerpt-tag">{m.review.excerptSourceLabel}</span>
              <Excerpt text={source} span={sourceLocated ? finding.source_span : null} missing={fill(m.review.excerptMissingSource, { text: finding.source_span.text })} />
            </div>
            <div className="finding-actions">
              {finding.candidates.map((candidate: Candidate) => <button key={candidate.candidate_id} className="text-button" type="button" disabled={!sourceCompatible || phase === 'loading' || latest.report.truncated} onClick={() => doc.choose(finding, candidate)}>{fill(sm.ambiguous.adopt, { zh: candidate.zh, en: candidate.en })}</button>)}
              <button className="text-button" type="button" disabled={!sourceCompatible || phase === 'loading'} onClick={() => doc.choose(finding, null)}>{sm.ambiguous.ignore}</button>
              <button className="text-button" type="button" disabled={!sourceLocated} onClick={() => jumpTo('source', finding.source_span)}>{m.review.jumpSource}</button>
            </div>
          </article>;
        })}
      </details>}
    </> : sourceLength > 2000 || targetLength > 2000 ? null : <p className="translation-placeholder">{m.review.placeholder}</p>}
    {longTerms}
  </section>;

  const kindLabel = quickResult?.kind
    ? ({ exact: m.translation.kindExact, fuzzy: m.translation.kindFuzzy, noop: m.translation.kindNoop, llm: m.translation.kindLlm })[quickResult.kind]
    : null;

  return <section className="document-workspace" data-mode={workspaceMode} aria-labelledby="workspace-title">
    <dialog className="handoff-dialog revision-dialog" ref={revisionDialog} aria-labelledby="revision-title" aria-describedby="revision-description" onCancel={() => cancelRevision()}>
      <h3 id="revision-title">{m.review.revisionTitle}</h3>
      <p id="revision-description">{m.review.revisionDescription}</p>
      {revision && <>
        <p>{fill(m.review.spanRange, { start: revision.finding.source_span.start + 1, end: revision.finding.source_span.end })}</p>
        <Excerpt text={revision.draft.source} span={revision.finding.source_span} missing={m.review.excerptMissingTarget} />
        <p className="revision-pair">{revision.candidate.zh} ↔ {revision.candidate.en}<br />{m.review.revisionReplacement}: <strong>{revisionReplacement}</strong></p>
        <p>{m.review.revisionAlignments}</p>
        <label htmlFor="revision-fragment">{m.review.revisionFragment}</label>
        <textarea id="revision-fragment" ref={fragmentBox} rows={2} value={revision.fragment} onChange={event => updateRevision({ ...revision, fragment: event.target.value, selected: null })} />
        <details><summary>{m.review.revisionFullTarget}</summary><p className="review-excerpt">{target}</p></details>
        <p role="status" aria-live="polite">{!revision.fragment.trim() ? m.review.revisionEnter : occurrences.length ? fill(m.review.revisionMatches, { n: occurrences.length }) : m.review.revisionNoMatches}</p>
        <fieldset className="revision-occurrences"><legend>{m.review.revisionOccurrences}</legend>
          {occurrences.map((span, index) => <label className="revision-occurrence" key={`${span.start}:${span.end}`}>
            <input type="radio" name="revision-occurrence" value={`${span.start}:${span.end}`} checked={revision.selected?.start === span.start && revision.selected?.end === span.end} onChange={() => updateRevision({ ...revision, selected: span })} />
            <span>{fill(m.review.revisionPosition, { i: index + 1, start: span.start + 1, end: span.end })}<Excerpt text={target} span={span} missing={m.review.excerptMissingTarget} /></span>
          </label>)}
        </fieldset>
        {revision.selected && <div className="revision-preview"><p>{m.review.revisionPreview}</p><p className="review-excerpt"><del>{revision.selected.text}</del> → <ins>{revisionReplacement}</ins></p></div>}
        {revisionPreview?.error && <p role="alert">{(m.review as Record<string, unknown>)[revisionPreview.error] as string}</p>}
        <div className="actions">
          <button type="button" className="secondary-button" onClick={() => cancelRevision()}>{m.review.revisionCancel}</button>
          <button type="button" disabled={!revisionPreview || !!revisionPreview.error} onClick={confirmRevision}>{m.review.revisionConfirm}</button>
        </div>
      </>}
    </dialog>
    <dialog className="handoff-dialog" ref={leaveDialog} aria-labelledby="leave-title" aria-describedby="leave-description" onCancel={() => setPendingLeaveUrl(null)}>
      <h3 id="leave-title">{m.review.leaveTitle}</h3>
      <div id="leave-description">
        {(phase === 'loading' || translating) && <p>{m.review.leaveInFlight}</p>}
        <p>{saveView === 'matches-download' ? m.review.leaveDownload : m.review.leaveUnsaved}</p>
      </div>
      {error && <p role="alert">{errorTextValue}</p>}
      {error?.saveConflict && <div className="actions save-conflict-actions"><button type="button" className="secondary-button" onClick={resolveConflictsAndSave}>{m.review.resolveConflictsAndSave}</button><button type="button" className="secondary-button" onClick={exportProseTxt}>{m.review.exportProseTxt}</button></div>}
      <div className="actions">
        <button ref={stayLeaveButton} type="button" onClick={() => setPendingLeaveUrl(null)}>{m.review.leaveStay}</button>
        <button type="button" className="secondary-button" onClick={save}>{m.review.leaveSaveStay}</button>
        <button type="button" className="secondary-button" onClick={() => { const url = pendingLeaveUrl; if (!url) { setPendingLeaveUrl(null); return; } leaveBypass.current = true; window.location.assign(url); }}>{m.review.leaveAnyway}</button>
      </div>
    </dialog>
    <dialog className="handoff-dialog" ref={importDialog} aria-labelledby="import-replace-title" aria-describedby="import-replace-description" onCancel={() => setPendingImport(null)}>
      <h3 id="import-replace-title">{pendingImport?.kind === 'workfile' ? m.review.workfileReplaceTitle : pendingImport?.kind === 'query' ? w.queryReplaceTitle : m.review.importReplaceTitle}</h3>
      <p id="import-replace-description">{pendingImport?.kind === 'workfile' ? m.review.workfileReplaceBody : pendingImport?.kind === 'query' ? w.queryReplaceBody : m.review.importReplaceBody}</p>
      <div className="actions">
        <button ref={keepImportButton} type="button" className="secondary-button" onClick={() => setPendingImport(null)}>{m.review.dialogKeep}</button>
        <button type="button" className="secondary-button" onClick={() => {
          if (pendingImport?.kind === 'text') replaceWithText(pendingImport.text);
          else if (pendingImport?.kind === 'query') { replaceWithText(pendingImport.text, 'movedQuery'); sourceEditor.current?.focus(); }
          else if (pendingImport?.kind === 'workfile') replaceWithWorkfile(pendingImport.workfile);
        }}>{pendingImport?.kind === 'query' ? w.queryReplaceConfirm : m.review.importReplaceConfirm}</button>
      </div>
    </dialog>
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
    <RuntimeStatus saveView={saveView} reportCommit={latest?.report.dictionary.source_commit ?? null} />
    <div className="workspace-grid">
      <div className="workspace-side">
        <QuickTermLookup quick={quick} onInsert={insertTerm} onUseQuery={moveQueryToSource} />
        <MyTerms source={source} direction={quick && autoDirection ? inferDirection(source) : direction} />
      </div>
      <div className="manuscript-workspace">
        <div className="manuscript-editor-pane">
          {!quick && !latest && !source.trim() && !target.trim() && choices.length === 0 && (
            <ol className="guide-steps" aria-label={m.review.guideAria} role="list">
              {m.review.guide.map((step, i) => <li key={i}><strong>{step.title}</strong><span>{step.body}</span></li>)}
            </ol>
          )}
          <form onSubmit={quick ? translateQuick : submit}>
            <div className="editor-panes">
              <div className="editor-pane">
                <div className="label-row">
                  <label htmlFor="review-source">{m.review.sourceLabel}</label>
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
                <EditorSurfaceAdapter ref={sourceEditor} id="review-source" value={source} rows={6} placeholder={quick ? m.translation.placeholder : m.review.sourcePlaceholder} onEdit={editSide('source')} />
              </div>
              <div className="editor-pane">
                <div className="label-row">
                  <label htmlFor="review-target">{quick ? w.targetLabel : m.review.targetLabel}</label>
                  {quick && !!target && <button type="button" className="text-button" onClick={() => void copyTranslation()}>{copied === 'done' ? m.translation.copied : m.translation.copy}</button>}
                </div>
                <EditorSurfaceAdapter ref={targetEditor} id="review-target" value={target} rows={6} placeholder={quick ? m.translation.idlePlaceholder : m.review.targetPlaceholder} onEdit={editSide('target')} />
              </div>
            </div>
            <div className="field-hint"><span>{m.review.hintSafety}</span><span aria-live="polite">{quick ? fill(m.translation.charCount, { n: sourceLength.toLocaleString(locale) }) : fill(m.review.charCounts, { s: sourceLength.toLocaleString(locale), t: targetLength.toLocaleString(locale) })}</span></div>
            {!quick && (sourceLength > 2000 || targetLength > 2000) && <p role="status">{m.review.longManuscript}</p>}
            {quick && translationClosed && <p className="notice-state">{pool.kind === 'success' && !pool.data.translation_enabled ? m.tMsg.translation_disabled : m.tMsg.translation_pool_exhausted}</p>}
            {!quick && <details className="alignment-panel"><summary>{alignments === null ? m.review.alignmentSummaryNone : fill(m.review.alignmentSummaryCount, { n: alignments.length })}</summary>
              <p>{m.review.alignmentIntro}</p>
              <div className="actions">
                <button type="button" className="secondary-button" onClick={() => addAlignment()}>{m.review.alignmentConfirm}</button>
                <button type="button" className="secondary-button" onClick={() => addAlignment(true)}>{m.review.alignmentOmit}</button>
                <button type="button" className="secondary-button" disabled={!validInput} onClick={() => addAlignment(false, true)}>{m.review.alignmentWhole}</button>
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
                <button type="submit" className={translatePrimary ? 'secondary-button' : undefined} disabled={!validInput || phase === 'loading' || translating || reviewsClosed}>{phase === 'loading' ? m.review.checkLoading : m.review.checkIdle}</button>
                <button className="secondary-button" type="button" disabled={!validInput || phase === 'loading' || translating || reviewsClosed} onClick={() => void check(false)}>{m.review.freshBasis}</button>
                {((!!source.trim() && (!target.trim() || sourceDirtyForTranslation)) || translating) && <button className={translatePrimary ? undefined : 'secondary-button'} type="button" disabled={!source.trim() || sourceLength > 2000 || phase === 'loading' || translating || translationClosed} onClick={() => void translateInReview()}>{translating ? m.review.translateLoading : target.trim() ? m.review.translateUpdate : m.review.translateIdle}</button>}
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
            void importFile(file);
          }} />
          {quick && translating && <p className="notice-state" role="status">{m.translation.loadingStatus}</p>}
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
                <button type="button" className="secondary-button" onClick={clearDraft} disabled={!holdsWork}>{m.review.clearDraft}</button>
                <button type="button" className="secondary-button" onClick={save}>{m.review.save}</button>
                <button type="button" className="secondary-button" onClick={() => fileBox.current?.click()}>{m.review.import}</button>
                {documentCheckpoint && <button type="button" className="secondary-button" onClick={() => doc.restoreDocumentCheckpoint()}>{m.review.restoreCheckpoint}</button>}
              </div>
              <div className="export-actions">
                <button type="button" className="secondary-button" onClick={exportTxt}>{m.review.exportTxt}</button>
                <button type="button" className="secondary-button" onClick={exportResult}>{m.review.exportResult}</button>
                <button type="button" className="secondary-button" onClick={exportMarkdown}>{m.review.exportMarkdown}</button>
              </div>
            </div>
          </>}
          {notice && <p className="notice-state" role="status">{noticeText}</p>}
          {!quick && alignments !== null && alignments.length === 0 && <div className="alignment-recovery" role="region" aria-label={m.review.alignmentRecoveryAria}>
            <p>{m.review.alignmentEmptyPrompt}</p>
            <div className="actions">
              <button type="button" className="secondary-button" disabled={!validInput || phase === 'loading'} onClick={() => addAlignment(false, true)}>{m.review.alignmentReconfirmWhole}</button>
              <button type="button" className="secondary-button" disabled={phase === 'loading'} onClick={() => doc.resetAlignments()}>{m.review.alignmentFallbackReset}</button>
            </div>
          </div>}
          {error && <div className="error-panel" role="alert"><p>{errorTextValue}</p>{errorDetails.map(line => <p key={line} className="error-detail">{line}</p>)}{error.saveConflict && <div className="actions save-conflict-actions"><button type="button" className="secondary-button" onClick={resolveConflictsAndSave}>{m.review.resolveConflictsAndSave}</button><button type="button" className="secondary-button" onClick={exportProseTxt}>{m.review.exportProseTxt}</button></div>}</div>}
          {!quick && phase === 'loading' && <p role="status">{m.review.loadingStatus}</p>}
          {!quick && basisChanged && <p className="review-stale">{m.review.staleBasis}</p>}
        </div>
        {!quick && <div className="manuscript-review-pane">
          {choices.length > 0 && <div className="choice-records"><h3>{fill(m.review.choiceHeader, { ready: ready.length, pending: choices.length - ready.length })}</h3>
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
          <StructureLayer doc={doc} snapshot={snapshot} lang={lang} pool={pool} locate={(side, span) => jumpTo(side, span)} />
          <SemanticWorkbench
            doc={doc}
            snapshot={snapshot}
            lang={lang}
            pool={pool}
            locate={(side, span) => jumpTo(side, span)}
            termTrack={termTrack}
          />
          <StyleLayer lang={lang} on={styleOn} setOn={setStyleOn} />
        </div>}
      </div>
    </div>
  </section>;
}
