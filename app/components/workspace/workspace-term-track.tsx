'use client';

import type { ReactNode } from 'react';
import { categoryLabel, labelJoiner } from '../../../lib/dictionary-labels';
import type { compareReports } from '../../../lib/manuscript.js';
import { fill, msg, summarySentence } from '../../../lib/messages';
import { FILTERS } from '../../../lib/review-navigation.js';
import { highlightSegments, type summarizeReviewParts } from '../../../lib/review-report.js';
import { semanticMsg } from '../../../lib/semantic-messages';
import type { judgedReport } from '../../../lib/structure-layer';
import { findMatchingTermbaseEntry, type TermbaseDirection, type TermbaseEntry } from '../../../lib/termbase';
import type { UiLanguage } from '../../../lib/ui-language';
import type { WorkbenchController } from '../../../lib/workbench-controller';
import type { Candidate, DocumentPhase, Finding, Snapshot, Span } from '../../../lib/workbench-model';
import { ambiguousAdoptLabel } from '../semantic-workbench';
import { Excerpt } from './workspace-excerpt';

type Props = {
  lang: UiLanguage;
  doc: WorkbenchController;
  latest: Snapshot | null;
  judged: ReturnType<typeof judgedReport> | null;
  summaryParts: ReturnType<typeof summarizeReviewParts>;
  comparison: ReturnType<typeof compareReports> | null;
  current: boolean;
  source: string;
  target: string;
  direction: 'en' | 'zh';
  sourceLength: number;
  targetLength: number;
  sourceCompatible: boolean;
  phase: DocumentPhase;
  verdictFilter: (typeof FILTERS)[number]['id'];
  onVerdictFilterChange: (filter: (typeof FILTERS)[number]['id']) => void;
  visibleFindings: Finding[];
  findingCounts: Record<string, number>;
  activeFindingId: string | null;
  activeVisibleIndex: number;
  onSelectFinding: (id: string) => void;
  onJumpTo: (side: 'source' | 'target', span: Span) => void;
  onOpenRevision: (finding: Finding, candidate: Candidate, trigger: HTMLButtonElement) => void;
  termbaseEntries: readonly TermbaseEntry[];
  onPromoteToTermbase: (item: { source: string; target: string; direction?: TermbaseDirection }) => void;
  longTerms: ReactNode;
};

export function WorkspaceTermTrack({
  lang,
  doc,
  latest,
  judged,
  summaryParts,
  comparison,
  current,
  source,
  target,
  direction,
  sourceLength,
  targetLength,
  sourceCompatible,
  phase,
  verdictFilter,
  onVerdictFilterChange,
  visibleFindings,
  findingCounts,
  activeFindingId,
  activeVisibleIndex,
  onSelectFinding,
  onJumpTo,
  onOpenRevision,
  termbaseEntries,
  onPromoteToTermbase,
  longTerms,
}: Props) {
  const m = msg(lang);
  const sm = semanticMsg(lang);
  const comparisonGroups = ([['new', m.review.comparisonNew], ['resolved', m.review.comparisonResolved], ['pending', m.review.comparisonPending], ['incomparable', m.review.comparisonIncomparable]] as const)
    .map(([key, label]) => ({ key, label, items: comparison ? comparison[key] : [] }));

  return <section className="term-track" aria-labelledby="term-track-title">
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
        {FILTERS.map(item => <button key={item.id} type="button" className="secondary-button" aria-pressed={verdictFilter === item.id} onClick={() => onVerdictFilterChange(item.id)}>{(m.review.filters as Record<string, string>)[item.id] ?? item.label} {findingCounts[item.id] ?? 0}</button>)}
      </div>
      <div className="finding-nav" role="group" aria-label={m.review.navAria}>
        <button type="button" className="secondary-button" disabled={activeVisibleIndex <= 0} onClick={() => { const previousFinding = visibleFindings[activeVisibleIndex - 1]; if (previousFinding) onSelectFinding(previousFinding.id); }}>{m.review.navPrev}</button>
        <button type="button" className="secondary-button" disabled={activeVisibleIndex < 0 || activeVisibleIndex >= visibleFindings.length - 1} onClick={() => { const nextFinding = visibleFindings[activeVisibleIndex + 1]; if (nextFinding) onSelectFinding(nextFinding.id); }}>{m.review.navNext}</button>
        <p className="finding-position">{fill(m.review.position, { i: activeVisibleIndex < 0 ? 0 : activeVisibleIndex + 1, n: visibleFindings.length })}</p>
      </div>
      <div className="review-findings">{judged!.report.findings.length === 0 && <p>{m.review.noFindings}</p>}
        {verdictFilter === 'actionable' && findingCounts.verified_constraint > 0 && (
          <div className="hidden-confirmed-bar" role="status" data-hidden-confirmed={findingCounts.verified_constraint}>
            <span>{fill(visibleFindings.length === 0 ? m.review.hiddenConfirmedAll : m.review.hiddenConfirmedNotice, { n: findingCounts.verified_constraint })}</span>
            <button type="button" className="text-button" onClick={() => onVerdictFilterChange('all')}>{m.review.showAllConfirmed}</button>
          </div>
        )}
        {visibleFindings.length === 0 && judged!.report.findings.length > 0 && !(verdictFilter === 'actionable' && findingCounts.verified_constraint > 0) && <p>{m.review.noFindingsFiltered}</p>}
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
              <button className="text-button" type="button" disabled={!sourceLocated} onClick={() => onJumpTo('source', finding.source_span)}>{m.review.jumpSource}</button>
              <button className="text-button" type="button" disabled={!targetLocated} onClick={() => { if (finding.target_span) onJumpTo('target', finding.target_span); }}>{m.review.jumpTarget}</button>
            </div>
            {finding.candidates.map((candidate: Candidate) => {
              const pairSource = direction === 'en' ? candidate.zh : candidate.en;
              const pairTarget = direction === 'en' ? candidate.en : candidate.zh;
              const inTermbase = !!findMatchingTermbaseEntry(termbaseEntries, { source: pairSource, target: pairTarget, direction });
              return <div className="term-pair" key={candidate.candidate_id}><strong>{candidate.zh}</strong><span>{candidate.en}</span><small>{m.terms.category}{labelJoiner(lang)}{categoryLabel(lang, candidate.category)}</small>
                <div className="finding-actions">
                  <button className="text-button" type="button" disabled={!sourceCompatible || phase === 'loading' || latest.report.truncated} onClick={() => doc.choose(finding, candidate)}>{m.review.adopt}</button>
                  {targetLocated && <button className="text-button" type="button" disabled={!sourceCompatible || phase === 'loading'} onClick={() => doc.replaceTerm(finding, candidate)}>{m.review.replace}</button>}
                  {finding.target_span === null && <button className="text-button" type="button" disabled={phase === 'loading' || !doc.isRevisionEligible(finding, candidate)} onClick={event => onOpenRevision(finding, candidate, event.currentTarget)}>{m.review.revisionOpen}</button>}
                  <button className="text-button" type="button" onClick={() => onPromoteToTermbase({ source: pairSource, target: pairTarget, direction })}>{inTermbase ? m.termbase.alreadyInTermbase : m.termbase.promoteButton}</button>
                </div>
                <details className="candidate-sources"><summary>{m.review.viewSources}</summary>
                  <ul>{candidate.sources.map(item => <li key={`${item.source_file}\u0000${item.source_id}`}><span>{item.source_file}</span><span>{item.source_id}</span></li>)}</ul>
                </details>
              </div>;
            })}
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
              {finding.candidates.map((candidate: Candidate) => <button key={candidate.candidate_id} className="text-button" type="button" disabled={!sourceCompatible || phase === 'loading' || latest.report.truncated} onClick={() => doc.choose(finding, candidate)}>{ambiguousAdoptLabel(lang, candidate, finding.candidates)}</button>)}
              <button className="text-button" type="button" disabled={!sourceCompatible || phase === 'loading'} onClick={() => doc.choose(finding, null)}>{sm.ambiguous.ignore}</button>
              <button className="text-button" type="button" disabled={!sourceLocated} onClick={() => onJumpTo('source', finding.source_span)}>{m.review.jumpSource}</button>
            </div>
          </article>;
        })}
      </details>}
    </> : sourceLength > 2000 || targetLength > 2000 ? null : <p className="translation-placeholder">{m.review.placeholder}</p>}
    {longTerms}
  </section>;
}
