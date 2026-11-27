// Workfile import, save, conflict resolution, and TXT/JSON/Markdown export
// operations for WorkbenchController. Zero React imports.
import { longFromWorkfile, recordView, segmentInputs } from './long-review.ts';
import {
  MAX_V3_WORKFILE_BYTES,
  MAX_WORKFILE_BYTES,
  WORKFILE_FORMAT_V2,
  WORKFILE_FORMAT_V3,
  WORKFILE_FORMAT_V4,
  WORKFILE_FORMAT_V5,
  compareReports,
  leaveGuardActive,
  manuscriptSaveView,
  parseWorkfile,
  reconcileChoices,
  sanitizeDuplicateChoices,
  serializeWorkfile,
} from './manuscript.js';
import { isMarkdownReportExport, renderMarkdownReport, type MarkdownCurrency } from './markdown-report.ts';
import { emptySemantic } from './semantic-state.js';
import type { UiLanguage } from './ui-language.ts';
import { replaceWithText, replaceWithWorkfile } from './workbench-document-ops.ts';
import type {
  Draft, ExportArtifact, ImportFileLike, ImportOutcome, PendingWorkfile,
  Report, Resolution, SemanticState, Snapshot,
} from './workbench-model.ts';
import { semanticExport, semanticFromWorkfile } from './workbench-persistence.ts';
import {
  canonicalOf,
  cleanSnapshot,
  documentSignature,
  errorFrom,
  manuscriptBody,
  workPresent,
  type WorkbenchHost,
} from './workbench-store.ts';

export function shouldConfirmImport(host: WorkbenchHost): boolean {
  const { draft, choices, reports, semantic, basis, importedCanonical, downloadedCanonical } = host.getState();
  const canonical = canonicalOf(draft, choices, reports, semantic, basis);
  const holdsWork = workPresent(draft, choices, reports, semantic);
  const saveView = manuscriptSaveView({ holdsWork, canonical, importedCanonical, downloadedCanonical });
  return leaveGuardActive({ view: saveView });
}

export async function importFile(host: WorkbenchHost, file?: ImportFileLike): Promise<ImportOutcome> {
  if (!file) return { status: 'ignored' };
  const attempt = ++host.rt.importAttempt;
  const curr = host.getState().error;
  if (curr && (curr.code === 'importInvalid' || curr.code === 'importReportExport' || curr.code?.startsWith('workfile_'))) {
    host.setState({ error: null });
  }
  if (file.size > (/\.(txt|md)$/iu.test(file.name) ? MAX_WORKFILE_BYTES : MAX_V3_WORKFILE_BYTES)) {
    if (!host.rt.disposed && host.rt.importAttempt === attempt) host.setState({ error: { code: 'workfile_too_large' } });
    return { status: 'error' };
  }
  const mine = host.rt.docGeneration;
  try {
    const bytes = await file.arrayBuffer();
    if (host.rt.disposed || host.rt.importAttempt !== attempt) return { status: 'ignored' };
    if (host.rt.docGeneration !== mine) {
      host.setState({ notice: 'importChangedDuringRead' });
      return { status: 'ignored' };
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (/\.(txt|md)$/iu.test(file.name)) {
      if (isMarkdownReportExport(text)) {
        host.setState({ error: { code: 'importReportExport' } });
        return { status: 'error' };
      }
      if (shouldConfirmImport(host)) {
        return { status: 'needs_confirm_text', pendingText: text };
      }
      replaceWithText(host, text);
      return { status: 'imported' };
    }
    let value;
    try {
      value = parseWorkfile(text);
    } catch (cause) {
      if ((cause as { code?: unknown } | null)?.code === 'workfile_unsupported_format'
        && /^\s*\{\s*"format"\s*:\s*"wuwaterm-result-v2"/u.test(text.slice(0, 256))) {
        host.setState({ error: { code: 'importReportExport' } });
        return { status: 'error' };
      }
      throw cause;
    }
    const nextDraft: Draft = { source: value.source, target: value.target, direction: value.direction, alignments: value.alignments };
    const nextChoices = value.choices;
    const nextReports: Snapshot[] = value.history.map((s: Draft & { report: Report; resolutions?: Resolution[] }) => ({
      ...s, resolutions: s.resolutions ?? null, trusted: false, signature: '',
    }));
    const withSemantic = value.format === WORKFILE_FORMAT_V2 || value.format === WORKFILE_FORMAT_V3 || value.format === WORKFILE_FORMAT_V4
      || value.format === WORKFILE_FORMAT_V5;
    const nextSemantic: SemanticState = {
      ...(withSemantic ? await semanticFromWorkfile(value) : emptySemantic() as SemanticState),
      long: longFromWorkfile(value),
    };
    if (host.rt.disposed || host.rt.importAttempt !== attempt) return { status: 'ignored' };
    if (host.rt.docGeneration !== mine) {
      host.setState({ notice: 'importChangedDuringRead' });
      return { status: 'ignored' };
    }
    const importedBody = canonicalOf(nextDraft, nextChoices, nextReports, nextSemantic, null);
    const pendingWorkfile: PendingWorkfile = {
      draft: nextDraft,
      choices: nextChoices,
      reports: nextReports,
      semantic: nextSemantic,
      importedBody,
    };
    if (shouldConfirmImport(host)) {
      return { status: 'needs_confirm_workfile', pendingWorkfile };
    }
    replaceWithWorkfile(host, pendingWorkfile);
    return { status: 'imported' };
  } catch (cause) {
    if (!host.rt.disposed && host.rt.importAttempt === attempt && host.rt.docGeneration === mine) {
      host.setState({ error: errorFrom(cause, 'importInvalid') });
    }
    return { status: 'error' };
  }
}

export function saveWorkfile(host: WorkbenchHost): ExportArtifact | null {
  const { draft, choices, reports, semantic, basis } = host.getState();
  try {
    const content = serializeWorkfile(manuscriptBody(draft, choices, reports, semantic, basis));
    host.rt.activeTypingTx = null;
    host.setState({ downloadedCanonical: content, error: null, notice: 'saved' });
    return { filename: 'wuwaterm-manuscript.json', content, mimeType: 'application/json' };
  } catch (cause) {
    const parsed = errorFrom(cause, 'saveFailed');
    host.setState({
      error: parsed?.code === 'workfile_duplicate_choices' ? { ...parsed, saveConflict: true } : parsed,
    });
    return null;
  }
}

export function resolveConflictingChoicesAndSave(host: WorkbenchHost): ExportArtifact | null {
  const state = host.getState();
  const { draft, choices, reports, semantic, basis } = state;
  const cleaned = sanitizeDuplicateChoices({
    source: draft.source,
    direction: draft.direction,
    choices,
    semantic_decisions: semantic.decisions,
    segments: semantic.long.records,
  });
  if (cleaned.dropped <= 0) {
    return saveWorkfile(host);
  }
  const { history } = host.pushUndo();
  const nextSemantic: SemanticState = {
    ...semantic,
    decisions: cleaned.semantic_decisions,
    long: { ...semantic.long, records: cleaned.segments },
  };
  host.rt.docAbort?.abort();
  host.rt.docAbort = null;
  host.rt.docGeneration += 1;
  try {
    const content = serializeWorkfile(manuscriptBody(draft, cleaned.choices, reports, nextSemantic, basis));
    host.setState({
      history,
      phase: 'idle',
      translating: false,
      inFlight: false,
      generation: host.rt.docGeneration,
      choices: cleaned.choices,
      imported: state.imported.filter(c => cleaned.choices.includes(c)),
      semantic: nextSemantic,
      downloadedCanonical: content,
      error: null,
      notice: 'resolvedConflictsSaved',
    });
    return { filename: 'wuwaterm-manuscript.json', content, mimeType: 'application/json' };
  } catch (cause) {
    const parsed = errorFrom(cause, 'saveFailed');
    host.setState({
      history,
      phase: 'idle',
      translating: false,
      inFlight: false,
      generation: host.rt.docGeneration,
      choices: cleaned.choices,
      imported: state.imported.filter(c => cleaned.choices.includes(c)),
      semantic: nextSemantic,
      error: parsed?.code === 'workfile_duplicate_choices' ? { ...parsed, saveConflict: true } : parsed,
    });
    return null;
  }
}

export function exportProseTxt(host: WorkbenchHost): ExportArtifact {
  const { source, target } = host.getState().draft;
  const content = target ? `${source}\n\n---\n\n${target}` : source;
  host.setState({ notice: 'exportProseTxt' });
  return { filename: 'wuwaterm-prose.txt', content, mimeType: 'text/plain;charset=utf-8' };
}

export function exportTxt(host: WorkbenchHost): ExportArtifact {
  host.setState({ notice: 'exportTxt' });
  return { filename: 'wuwaterm-translation.txt', content: host.getState().draft.target, mimeType: 'text/plain;charset=utf-8' };
}

function longResultsCurrent(host: WorkbenchHost): boolean {
  const { draft, semantic } = host.getState();
  const ctx = host.longCtx();
  const { long, items } = segmentInputs(draft);
  return long && items.length > 0 && items.every((item, i) => item.pair.status === 'ready'
    && recordView(semantic.long, i, ctx)?.state === 'current');
}

export function exportResult(host: WorkbenchHost): ExportArtifact {
  const { draft, choices, imported, reports, semantic, basis, phase } = host.getState();
  const latest = reports.at(-1) ?? null;
  const previous = reports.at(-2) ?? null;
  const reconciled = reconcileChoices(choices, draft, latest, imported);
  const ready = reconciled.flatMap(item => (item.resolution ? [item.resolution] : []));
  const current = !!latest?.trusted && latest.signature === documentSignature(draft, ready) && phase === 'success';
  const comparison = latest && previous ? compareReports(previous, latest) : null;
  const strip = (items: { label: string; reason: string }[]) => items.map(({ label, reason }) => ({ label, reason }));
  const long = segmentInputs(draft).long;
  const resultCurrent = long ? longResultsCurrent(host) : current;
  const content = JSON.stringify({
    format: 'wuwaterm-result-v2',
    ...draft,
    status: resultCurrent ? 'current_terminology_check' : 'requires_recheck',
    sentence_meaning_evaluated: false,
    report: latest && !long ? cleanSnapshot(latest) : null,
    report_is_current: resultCurrent,
    choices: choices.map((choice, i) => ({ ...choice, status: reconciled[i].status, reason: reconciled[i].reason })),
    changes: current && comparison ? {
      new: strip(comparison.new), resolved: strip(comparison.resolved),
      pending: strip(comparison.pending), incomparable: strip(comparison.incomparable),
    } : null,
    verified_stamp: { valid: false },
    ...semanticExport(draft, semantic, basis, host.reviewFeatures()).result,
  }, null, 2);
  host.setState({ notice: resultCurrent ? 'exportCurrent' : 'exportStale' });
  return { filename: 'wuwaterm-result.json', content, mimeType: 'application/json' };
}

export function exportMarkdown(host: WorkbenchHost, lang: UiLanguage = host.getState().lang): ExportArtifact {
  const { draft, choices, imported, reports, semantic, basis, phase } = host.getState();
  const latest = reports.at(-1) ?? null;
  const previous = reports.at(-2) ?? null;
  const reconciled = reconcileChoices(choices, draft, latest, imported);
  const ready = reconciled.flatMap(item => (item.resolution ? [item.resolution] : []));
  const current = !!latest?.trusted && latest.signature === documentSignature(draft, ready) && phase === 'success';
  const comparison = latest && previous ? compareReports(previous, latest) : null;
  const long = segmentInputs(draft).long;
  const parts = semanticExport(draft, semantic, basis, host.reviewFeatures());
  const currency: MarkdownCurrency = long
    ? (!parts.segmentTerms?.length ? 'none' : longResultsCurrent(host) ? 'current' : 'stale')
    : !latest ? 'none' : current ? 'current' : latest.trusted ? 'stale' : 'imported';
  const strip = (snapshot: Snapshot) => ({
    source: snapshot.source, target: snapshot.target, direction: snapshot.direction,
    report: snapshot.report, resolutions: snapshot.resolutions,
  });
  const content = renderMarkdownReport({
    draft: { source: draft.source, target: draft.target, direction: draft.direction },
    latest: latest && !long ? strip(latest) : null,
    previous: previous && !long ? strip(previous) : null,
    currency,
    choices,
    reconciled,
    comparison: long ? null : comparison,
    semantic: parts.markdown,
    segmentTerms: parts.segmentTerms,
  }, lang);
  host.setState({ notice: 'exportMarkdown' });
  return { filename: 'wuwaterm-report.md', content, mimeType: 'text/markdown;charset=utf-8' };
}
