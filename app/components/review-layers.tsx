'use client';

// Layer 1 (deterministic structure checks) and layer 3 (reserved style suggestions) of the layered review. Layer 2 is the semantic
// track in semantic-workbench.tsx. Nothing here is saved: the structure results live in the controller's session state, and the
// layer 3 switch is component state only (no browser storage).
import { useMemo, useState } from 'react';
import { compactScalarContext } from '../../lib/review-navigation.js';
import { highlightSegments } from '../../lib/review-report.js';
import { CAPABILITY_STRUCTURE_CHECK } from '../../lib/structure-check.js';
import { structurePlan, structureSummary, structureViews, type StructureView } from '../../lib/structure-layer';
import { fill, failureDetails, msg } from '../../lib/messages';
import { semanticMsg } from '../../lib/semantic-messages';
import type { PoolView } from '../../lib/runtime-store';
import type { UiLanguage } from '../../lib/ui-language';
import type { WorkbenchController, WorkbenchSnapshot } from '../../lib/workbench-controller';
import type { Span } from '../../lib/workbench-model';

/** Segments with findings listed at most; the rest are counted. */
const SEGMENTS_SHOWN = 60;

function Context({ text, span }: { text: string; span: Span }) {
  const compact = highlightSegments(text, span) ? compactScalarContext(text, span) : null;
  if (!compact) return <span className="review-excerpt">{span.text}</span>;
  return <span className="review-excerpt">{compact.clippedBefore ? '…' : null}{compact.before}<mark>{compact.hit}</mark>{compact.after}{compact.clippedAfter ? '…' : null}</span>;
}

export function StructureLayer({ doc, snapshot, lang, pool, locate }: {
  doc: WorkbenchController;
  snapshot: WorkbenchSnapshot;
  lang: UiLanguage;
  pool: PoolView;
  locate: (side: 'source' | 'target', span: Span) => void;
}) {
  const { draft, structure, capabilities } = snapshot;
  const l = semanticMsg(lang).layers;
  const m = msg(lang);
  const plan = useMemo(() => structurePlan(draft), [draft]);
  const views = useMemo(() => structureViews(draft, structure), [draft, structure]);
  if (!capabilities?.includes(CAPABILITY_STRUCTURE_CHECK)) return null;
  const summary = structureSummary(views);
  const running = structure.phase === 'running';
  const reviewsClosed = pool.kind === 'success' && pool.data.reviews.remaining === 0;
  const flagged = views.filter(v => v.result && (v.result.findings.length > 0 || v.result.omitted > 0));
  const shown = flagged.slice(0, SEGMENTS_SHOWN);
  const reason = structure.error ? ((m.rMsg as Record<string, string>)[structure.error.reason] ?? (m.tMsg as Record<string, string>)[structure.error.reason] ?? m.rMsg.fallback) : '';
  const details = structure.error ? failureDetails(lang, { kind: 'review', reason: structure.error.reason, requestId: structure.error.requestId }) : [];
  const ruleText = (rule: string) => l.rules[rule] ?? rule;
  const renderView = (view: StructureView) => {
    const result = view.result!;
    const layout = result.layout;
    const layoutOff = layout.source_paragraphs !== layout.target_paragraphs || layout.source_lines !== layout.target_lines;
    return <article className="structure-segment" key={view.index} data-segment={view.index} data-findings={result.findings.length}>
      <p className="result-summary"><strong>{fill(semanticMsg(lang).segmentLabel, { n: view.index + 1 })}</strong>
        {layoutOff ? <span className="structure-layout"> · {fill(l.l1Layout, { sp: layout.source_paragraphs, tp: layout.target_paragraphs, sl: layout.source_lines, tl: layout.target_lines })}</span> : null}</p>
      <ul className="structure-findings">
        {result.findings.map((finding, i) => {
          const span = finding.source_span ?? finding.target_span;
          const side: 'source' | 'target' = finding.source_span ? 'source' : 'target';
          return <li key={i} className="structure-finding" data-rule={finding.rule_id}>
            <span className="rule-badge" data-rule={finding.rule_id}>{ruleText(finding.rule_id)}</span>
            {span ? <>
              <span className="excerpt-tag">{side === 'source' ? l.l1SourceLabel : l.l1TargetLabel}</span>
              <Context text={side === 'source' ? draft.source : draft.target} span={span} />
              <button type="button" className="text-button" onClick={() => locate(side, span)}>{side === 'source' ? m.review.jumpSource : m.review.jumpTarget}</button>
            </> : null}
          </li>;
        })}
      </ul>
      {result.omitted > 0 && <p className="track-note">{fill(l.l1Omitted, { n: result.omitted })}</p>}
    </article>;
  };
  return <section className="layer-panel layer-structure" aria-labelledby="layer1-title" data-layer="1" data-phase={structure.phase}>
    <div className="track-head">
      <h3 id="layer1-title">{l.l1Title}</h3>
      <p className="track-note">{l.l1Note}</p>
    </div>
    {plan.items.length === 0 ? <p className="track-note">{l.l1None}</p> : <>
      <p className="run-estimate">{fill(l.l1Cost, { n: plan.batches.length })}</p>
      <div className="actions">
        <button type="button" className="secondary-button" disabled={running || reviewsClosed || plan.batches.length === 0} onClick={() => void doc.runStructureChecks()}>
          {running ? l.l1Running : fill(summary.checked ? l.l1Rerun : l.l1Run, { n: plan.items.length - plan.skipped.length })}
        </button>
      </div>
    </>}
    <div className="structure-status" role="status" aria-live="polite">
      {structure.phase === 'failed' && <p className="review-stale">{fill(l.l1Failed, { reason })}{details.length ? ` ${details.join(' ')}` : ''}</p>}
      {summary.checked > 0 && (summary.findings === 0 && summary.omitted === 0
        ? <p className="review-current">{fill(l.l1Clean, { checked: summary.checked })}</p>
        : <p>{fill(l.l1Summary, { checked: summary.checked, segments: summary.withFindings, n: summary.findings + summary.omitted })}</p>)}
      {summary.checked > 0 && summary.unchecked > 0 && <p className="track-note">{fill(l.l1Unchecked, { n: summary.unchecked })}</p>}
      {plan.skipped.length > 0 && <p className="track-note">{fill(l.l1Skipped, { n: plan.skipped.length })}</p>}
    </div>
    {shown.map(renderView)}
    {flagged.length > shown.length && <p className="track-note">{fill(semanticMsg(lang).longTermsMore, { n: flagged.length - shown.length })}</p>}
  </section>;
}

/** Layer 3: a reserved place for style suggestions. Off by default; switching it on sends nothing and stores nothing. */
export function StyleLayer({ lang }: { lang: UiLanguage }) {
  const l = semanticMsg(lang).layers;
  const [on, setOn] = useState(false);
  return <section className="layer-panel layer-style" aria-labelledby="layer3-title" data-layer="3" data-on={on ? 'true' : 'false'}>
    <div className="track-head">
      <h3 id="layer3-title">{l.l3Title}</h3>
    </div>
    <label className="inline-check"><input type="checkbox" checked={on} onChange={e => setOn(e.target.checked)} />{l.l3Toggle}</label>
    <p className="track-note">{on ? l.l3On : l.l3Off}</p>
  </section>;
}
