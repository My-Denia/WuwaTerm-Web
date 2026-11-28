import { isAmbiguousMention, termSegments } from '../../../lib/long-review';
import { highlightSegments } from '../../../lib/review-report.js';
import type { judgedReport, StructureView } from '../../../lib/structure-layer';
import {
  scalarOffset,
  type Draft,
  type LongState,
  type Placed,
  type SessionBasis,
  type Snapshot,
} from '../../../lib/workbench-model';
import type { EditorHighlight } from '../editor-surface';

export type WorkspaceHighlightInput = {
  source: string;
  target: string;
  draft: Draft;
  basis: SessionBasis;
  reviewFeatures: string[] | null;
  current: boolean;
  judged: ReturnType<typeof judgedReport> | null;
  latest: Snapshot | null;
  longDocument: boolean;
  long: LongState;
  layer1: StructureView[];
  placed: Placed[];
  activeSemanticId: string | null;
};

type HighlightMessages = {
  rules: Record<string, string>;
  categories: Record<string, string>;
};

export function buildWorkspaceHighlights(
  snap: WorkspaceHighlightInput,
  quick: boolean,
  currentSource: string,
  currentTarget: string,
  labels: HighlightMessages,
): { sourceHighlights: EditorHighlight[]; targetHighlights: EditorHighlight[] } {
  if (quick) return { sourceHighlights: [], targetHighlights: [] };
  // Never paint deferred highlights computed for a previous text onto freshly edited text.
  if (snap.source !== currentSource || snap.target !== currentTarget) {
    return { sourceHighlights: [], targetHighlights: [] };
  }
  const CAP = 400;
  const src: EditorHighlight[] = [];
  const tgt: EditorHighlight[] = [];
  const pushSrc = (h: EditorHighlight) => {
    if (src.length >= CAP) return;
    if (h.expectedText !== undefined && !highlightSegments(snap.source, { start: h.start, end: h.end, text: h.expectedText })) return;
    src.push(h);
  };
  const pushTgt = (h: EditorHighlight) => {
    if (tgt.length >= CAP) return;
    if (h.expectedText !== undefined && !highlightSegments(snap.target, { start: h.start, end: h.end, text: h.expectedText })) return;
    tgt.push(h);
  };

  if (snap.judged && snap.current && snap.latest && snap.latest.source === snap.source && snap.latest.target === snap.target) {
    for (const f of snap.judged.report.findings) {
      const kind = f.verdict === 'confirmed_conflict' ? 'term-conflict'
        : f.verdict === 'verified_constraint' ? 'term-verified' : 'term-review';
      pushSrc({ start: f.source_span.start, end: f.source_span.end, kind, title: f.source_span.text, expectedText: f.source_span.text });
      if (f.target_span) {
        pushTgt({ start: f.target_span.start, end: f.target_span.end, kind, title: f.target_span.text, expectedText: f.target_span.text });
      }
    }
  } else if (snap.longDocument) {
    const segs = termSegments(snap.long, { draft: snap.draft, basis: snap.basis, features: snap.reviewFeatures });
    for (const seg of segs) {
      if (seg.state !== 'current' && seg.state !== 'saved') continue;
      for (const f of seg.report.findings) {
        if (isAmbiguousMention(f)) continue;
        const resolvedKind = f.verdict === 'confirmed_conflict' ? 'term-conflict'
          : f.verdict === 'verified_constraint' ? 'term-verified' : 'term-review';
        pushSrc({
          start: scalarOffset(seg.source_start + f.source_span.start),
          end: scalarOffset(seg.source_start + f.source_span.end),
          kind: resolvedKind,
          title: f.source_span.text,
          expectedText: f.source_span.text,
        });
        if (f.target_span) {
          pushTgt({
            start: scalarOffset(seg.target_start + f.target_span.start),
            end: scalarOffset(seg.target_start + f.target_span.end),
            kind: resolvedKind,
            title: f.target_span.text,
            expectedText: f.target_span.text,
          });
        }
      }
    }
  }

  for (const view of snap.layer1) {
    if (!view.result || !view.checkable) continue;
    for (const f of view.result.findings) {
      const label = labels.rules[f.rule_id] ?? f.rule_id;
      if (f.source_span) {
        pushSrc({ start: f.source_span.start, end: f.source_span.end, kind: 'structure', title: label, expectedText: f.source_span.text });
      }
      if (f.target_span) {
        pushTgt({ start: f.target_span.start, end: f.target_span.end, kind: 'structure', title: label, expectedText: f.target_span.text });
      }
    }
  }

  for (const p of snap.placed) {
    if (p.stale) continue;
    const kind = p.id === snap.activeSemanticId ? 'semantic-active' : 'semantic';
    const title = labels.categories[p.issue.category] ?? p.issue.category;
    if (p.live.source_span) {
      pushSrc({ start: p.live.source_span.start, end: p.live.source_span.end, kind, title, expectedText: p.live.source_span.text });
    }
    if (p.live.target_span) {
      pushTgt({ start: p.live.target_span.start, end: p.live.target_span.end, kind, title, expectedText: p.live.target_span.text });
    }
  }

  return { sourceHighlights: src, targetHighlights: tgt };
}
