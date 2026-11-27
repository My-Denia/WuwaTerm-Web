// Document-level editing, choices, undo/redo, target revision, and single-request
// check/translate operations for WorkbenchController. Zero React imports.
import {
  REPORT_V4,
  REPORT_V5,
  REVIEW_FEATURE_AMBIGUOUS_MENTION,
  makeChoice,
  mentionId,
  reconcileChoices,
  recoverSpan,
  remapForFreeEdit,
  remapForSplice,
  validAlignments,
  validReport,
  validSpan,
} from './manuscript.js';
import { highlightSegments, revisionOf } from './review-report.js';
import { CAPABILITY_TRANSLATION_CONTEXT } from './semantic-review.js';
import { diffSplice } from './semantic-run.js';
import { emptySemantic, freshSemantic, mapSemanticEdit } from './semantic-state.js';
import { spliceOccurrence } from './target-revision.js';
import { applySegmentSuggestionResult, segmentParagraphs, type TmApplySegmentResult } from './tm-segment.ts';
import { scalarOffset } from './workbench-model.ts';
import type {
  Candidate, Draft, ErrorState, Finding, NoticeState, PendingWorkfile, Report,
  SemanticState, Snapshot, Span, TargetRevisionCommand, TargetRevisionResult,
} from './workbench-model.ts';
import {
  EMPTY_DRAFT,
  MAX_CHOICES,
  MAX_UNDO,
  TYPING_COALESCE_MS,
  alignmentNotice,
  appendInvalidations,
  chars,
  detailOf,
  documentSignature,
  failureFields,
  invalidationsOf,
  isRunActive,
  workPresent,
  type UndoEntry,
  type WorkbenchHost,
  type WorkbenchSnapshot,
} from './workbench-store.ts';
import { REVIEW_REQUEST_LIMIT } from './workbench-transport.ts';

export function editDraft(host: WorkbenchHost, next: Draft, message: NoticeState = ''): void {
  const state = host.getState();
  const before = state.draft;
  const { history } = host.pushUndo();
  host.rt.docAbort?.abort();
  host.rt.docAbort = null;
  host.rt.docGeneration += 1;
  const nextSemantic = mapSemanticEdit(state.semantic, before, next) as SemanticState;
  host.setState({
    history,
    phase: 'idle',
    translating: false,
    error: null,
    generation: host.rt.docGeneration,
    inFlight: false,
    draft: next,
    semantic: nextSemantic,
    alignmentInvalidations: [],
    notice: message,
    tmReceipt: null,
  });
}

export function editText(
  host: WorkbenchHost,
  side: 'source' | 'target',
  value: string,
  options: { composing?: boolean; coalesce?: boolean } = {},
): void {
  const state = host.getState();
  const composing = options.composing === true;
  const allowCoalesce = options.coalesce !== false;
  if (host.rt.composition && host.rt.composition.side !== side) host.rt.composition = null;
  const open = host.rt.composition;
  if (open && !composing && value === state.draft[side]) {
    host.rt.composition = null;
    host.rt.activeTypingTx = null;
    return;
  }
  if (!open && value === state.draft[side]) return;
  const { draft, reports } = state;
  const latest = reports.at(-1) ?? null;
  const sourceDirtyForTranslation = side === 'source' ? Boolean(value.trim() && draft.target.trim()) : false;
  const before = state.draft;
  const base = open ? open.base : before;
  const baseInvalidations = open ? open.invalidations : state.alignmentInvalidations;
  const nextSource = side === 'source' ? value : draft.source;
  const nextTarget = side === 'target' ? value : draft.target;
  const remap = remapForFreeEdit(base.alignments, side, base.source, base.target, nextSource, nextTarget);
  const next: Draft = { ...draft, [side]: value, alignments: remap.alignments };
  const touched = remap.invalidated.length > 0 || remap.emptiedTargets.length > 0 || remap.fallbackAll;
  const message = alignmentNotice(base.alignments, remap) ?? (latest ? 'editedText' : '');
  const now = host.clock.now();
  const splice = diffSplice(before[side], value);
  const deltaLen = splice ? Math.max(splice.oldEnd - splice.start, splice.newEnd - splice.start) : 0;
  const top = state.history.at(-1);
  const typing = host.rt.activeTypingTx;
  const canCoalesce = allowCoalesce && !open && !composing && !touched
    && typing !== null
    && typing.side === side
    && now - typing.at <= TYPING_COALESCE_MS
    && deltaLen <= 1
    && top !== undefined
    && top.serial === typing.serial
    && !top.replacedDocument;
  let history = state.history;
  let serial = typing?.serial ?? 0;
  if (!open && !canCoalesce) {
    const pushed = host.pushUndo();
    history = pushed.history;
    serial = pushed.serial;
  }
  host.rt.future = [];
  host.rt.activeTypingTx = allowCoalesce && !composing && !open && !touched && deltaLen <= 1 ? { side, at: now, serial } : null;
  host.rt.docAbort?.abort();
  host.rt.docAbort = null;
  host.rt.docGeneration += 1;
  const fromBase = open !== null && open.mapped === state.semantic;
  const semanticBefore = fromBase ? open.base : before;
  const semanticSplice = fromBase ? diffSplice(open.base[side], value) : splice;
  const splices = {
    source: side === 'source' ? semanticSplice : null,
    target: side === 'target' ? semanticSplice : null,
  };
  const nextSemantic = mapSemanticEdit(fromBase ? open.semantic : state.semantic, semanticBefore, next, splices) as SemanticState;
  host.rt.composition = composing
    ? (open ? { ...open, mapped: nextSemantic } : { side, base: before, invalidations: baseInvalidations, semantic: state.semantic, mapped: nextSemantic })
    : null;
  host.setState({
    history,
    phase: 'idle',
    translating: false,
    error: null,
    generation: host.rt.docGeneration,
    inFlight: false,
    draft: next,
    semantic: nextSemantic,
    alignmentInvalidations: appendInvalidations(baseInvalidations, remap.invalidated),
    sourceDirtyForTranslation,
    notice: message,
    tmReceipt: null,
  });
}

export function setDirection(host: WorkbenchHost, direction: 'en' | 'zh'): void {
  const { draft } = host.getState();
  editDraft(host, { ...draft, direction, alignments: draft.alignments === null ? null : [] }, 'directionChanged');
}

export function recordAlignment(host: WorkbenchHost, sourceSpan: Span | null, targetSpan: Span | null, omit = false, whole = false): boolean {
  const { draft } = host.getState();
  const a = whole ? { start: scalarOffset(0), end: scalarOffset(chars(draft.source).length), text: draft.source } : sourceSpan;
  const b = omit ? null : whole ? { start: scalarOffset(0), end: scalarOffset(chars(draft.target).length), text: draft.target } : targetSpan;
  if (!a || (!omit && !b)) {
    host.setState({ notice: 'alignmentHint' });
    return false;
  }
  const next = [...(whole ? [] : draft.alignments ?? []), { source: a, target: b }]
    .sort((x, y) => x.source.start - y.source.start);
  if (!validAlignments(next, draft.source, draft.target)) {
    host.setState({ notice: 'alignmentInvalid' });
    return false;
  }
  editDraft(host, { ...draft, alignments: next }, 'alignmentRecorded');
  return true;
}

export function clearAlignments(host: WorkbenchHost): void {
  editDraft(host, { ...host.getState().draft, alignments: [] }, 'alignmentsCleared');
}

export function resetAlignments(host: WorkbenchHost): void {
  editDraft(host, { ...host.getState().draft, alignments: null }, 'alignmentsReset');
}

export function removeAlignment(host: WorkbenchHost, index: number): void {
  const { draft } = host.getState();
  if (!draft.alignments) return;
  editDraft(host, { ...draft, alignments: draft.alignments.filter((_, j) => index !== j) }, 'alignmentRemoved');
}

export function applyMemorySuggestion(host: WorkbenchHost, activeIndex: number, suggestionText: string): TmApplySegmentResult {
  const { draft, reports } = host.getState();
  const sourceSegments = segmentParagraphs(draft.source);
  const outcome = applySegmentSuggestionResult(draft.target, sourceSegments, activeIndex, suggestionText, {
    source: draft.source,
    alignments: draft.alignments,
  });
  if (!outcome.applied) return outcome;
  const alignmentsChanged = JSON.stringify(outcome.alignments) !== JSON.stringify(draft.alignments);
  if (outcome.target === draft.target && !alignmentsChanged) return outcome;
  const latest = reports.at(-1) ?? null;
  const message = alignmentNotice(draft.alignments, {
    alignments: outcome.alignments,
    invalidated: outcome.invalidated,
    emptiedTargets: [],
    fallbackAll: false,
  }) ?? (latest ? 'editedText' : '');
  host.commit({
    draft: { ...draft, target: outcome.target, alignments: outcome.alignments },
    ...(outcome.splice ? { splices: { target: outcome.splice } } : {}),
    ...(outcome.invalidated.length ? { invalidated: outcome.invalidated } : {}),
    notice: message,
    remember: true,
    extraPatch: () => ({ tmReceipt: null }),
  });
  return outcome;
}

export function chooseFinding(host: WorkbenchHost, finding: Finding, candidate: Candidate | null): void {
  const { draft, choices, imported, reports } = host.getState();
  const latest = reports.at(-1) ?? null;
  const sourceCompatible = !!latest?.trusted && latest.source === draft.source && latest.direction === draft.direction;
  if (!sourceCompatible || !latest) return;
  const span = recoverSpan(latest.source, finding.source_span, draft.source);
  if (!span) return;
  const selected = makeChoice({
    source: draft.source, direction: draft.direction, alignments: draft.alignments,
    report: latest.report, finding: { ...finding, source_span: span }, candidate,
  });
  const existing = choices.findIndex(c => {
    const recovered = recoverSpan(c.source, c.source_span, draft.source);
    return !!recovered && mentionId(recovered) === mentionId(span);
  });
  if (existing < 0 && choices.length >= MAX_CHOICES) {
    host.setState({ notice: 'choiceLimit' });
    return;
  }
  const { history } = host.pushUndo();
  host.rt.docAbort?.abort();
  host.rt.docAbort = null;
  host.rt.docGeneration += 1;
  const nextChoices = existing < 0 ? [...choices, selected] : choices.map((c, i) => (i === existing ? selected : c));
  const nextImported = existing < 0 ? imported : imported.filter(c => c !== choices[existing]);
  host.setState({
    history,
    phase: 'idle',
    translating: false,
    error: null,
    generation: host.rt.docGeneration,
    inFlight: false,
    choices: nextChoices,
    imported: nextImported,
    notice: 'choiceStaged',
  });
}

export function removeChoice(host: WorkbenchHost, index: number): void {
  const { choices, imported } = host.getState();
  const targetChoice = choices[index];
  if (!targetChoice) return;
  const { history } = host.pushUndo();
  host.rt.docAbort?.abort();
  host.rt.docAbort = null;
  host.rt.docGeneration += 1;
  host.setState({
    history,
    phase: 'idle',
    translating: false,
    error: null,
    generation: host.rt.docGeneration,
    inFlight: false,
    choices: choices.filter((_, j) => index !== j),
    imported: imported.filter(c => c !== targetChoice),
  });
}

function confirmableChoiceTarget(host: WorkbenchHost, index: number): { finding: Finding; candidate: Candidate | null } | null {
  const { draft, choices, reports } = host.getState();
  const choice = choices[index];
  const latest = reports.at(-1) ?? null;
  const sourceCompatible = !!latest?.trusted && latest.source === draft.source && latest.direction === draft.direction;
  if (!choice || !sourceCompatible || !latest || latest.report.truncated) return null;
  const span = recoverSpan(choice.source, choice.source_span, draft.source);
  if (!span) return null;
  const finding = latest.report.findings.find(f => f.id === mentionId(span));
  if (!finding) return null;
  if (choice.choice === 'not_a_term') return { finding, candidate: null };
  const candidate = choice.candidate
    ? finding.candidates.find(c => c.candidate_id === choice.candidate!.candidate_id
        && c.zh === choice.candidate!.zh && c.en === choice.candidate!.en && c.category === choice.candidate!.category) ?? null
    : null;
  return candidate ? { finding, candidate } : null;
}

export function canConfirmChoice(host: WorkbenchHost, index: number): boolean {
  return confirmableChoiceTarget(host, index) !== null;
}

export function confirmChoice(host: WorkbenchHost, index: number): boolean {
  const target = confirmableChoiceTarget(host, index);
  if (!target) return false;
  chooseFinding(host, target.finding, target.candidate);
  return true;
}

export function isRevisionEligible(host: WorkbenchHost, finding: Finding, candidate: Candidate): boolean {
  const { draft, reports } = host.getState();
  const latest = reports.at(-1) ?? null;
  return !!latest?.trusted && latest.report.rule_version === 'review-v2' && !latest.report.truncated
    && latest.source === draft.source && latest.target === draft.target && latest.direction === draft.direction
    && JSON.stringify(latest.alignments) === JSON.stringify(draft.alignments)
    && finding.target_span === null && validSpan(finding.source_span, draft.source)
    && latest.report.findings.includes(finding) && finding.candidates.includes(candidate);
}

function commitTargetSplice(host: WorkbenchHost, nextTarget: string, spliceStart: number, spliceEnd: number, replacementLength: number): void {
  const state = host.getState();
  const { draft, reports } = state;
  const latest = reports.at(-1) ?? null;
  const remap = remapForSplice(draft.alignments, 'target', draft.source, nextTarget, spliceStart, spliceEnd, replacementLength);
  const next: Draft = { ...draft, target: nextTarget, alignments: remap.alignments };
  const message = alignmentNotice(draft.alignments, remap) ?? (latest ? 'editedText' : '');
  const { history } = host.pushUndo();
  host.rt.docAbort?.abort();
  host.rt.docAbort = null;
  host.rt.docGeneration += 1;
  const nextSemantic = mapSemanticEdit(state.semantic, draft, next, {
    target: {
      start: scalarOffset(spliceStart),
      oldEnd: scalarOffset(spliceEnd),
      newEnd: scalarOffset(spliceStart + replacementLength),
    },
  }) as SemanticState;
  host.setState({
    history,
    phase: 'idle',
    translating: false,
    error: null,
    generation: host.rt.docGeneration,
    inFlight: false,
    draft: next,
    semantic: nextSemantic,
    alignmentInvalidations: appendInvalidations(state.alignmentInvalidations, remap.invalidated),
    sourceDirtyForTranslation: false,
    notice: message,
  });
}

export function applyTargetRevision(host: WorkbenchHost, input: TargetRevisionCommand): TargetRevisionResult {
  const state = host.getState();
  const latest = state.reports.at(-1) ?? null;
  const isCurrent = state.generation === input.generation
    && !state.inFlight
    && latest === input.snapshot
    && state.draft === input.draft
    && state.choices === input.choices
    && state.imported === input.imported
    && isRevisionEligible(host, input.finding, input.candidate);
  if (!isCurrent) {
    host.setState({ notice: 'revisionStale' });
    return { status: 'stale' };
  }
  const replacement = input.draft.direction === 'en' ? input.candidate.en : input.candidate.zh;
  const result = spliceOccurrence(state.draft.target, input.fragment, input.selected, replacement);
  if (result.error || result.target === undefined || !result.span) {
    return { status: 'invalid', error: result.error };
  }
  const selected = input.selected!;
  commitTargetSplice(host, result.target, selected.start, selected.end, chars(replacement).length);
  return { status: 'applied', target: result.target, span: result.span };
}

export function replaceTerm(host: WorkbenchHost, finding: Finding, candidate: Candidate): void {
  const { draft, reports } = host.getState();
  const latest = reports.at(-1) ?? null;
  const sourceCompatible = !!latest?.trusted && latest.source === draft.source && latest.direction === draft.direction;
  if (!latest || latest.target !== draft.target || !sourceCompatible || !finding.target_span) return;
  const parts = highlightSegments(draft.target, finding.target_span);
  const forms = finding.candidates.flatMap(c => [c.zh, c.en]);
  if (!parts || !forms.includes(finding.target_span.text)) return;
  const replacement = draft.direction === 'en' ? candidate.en : candidate.zh;
  const result = spliceOccurrence(draft.target, finding.target_span.text, finding.target_span, replacement);
  if (result.error === 'revisionTooLong') host.setState({ notice: 'revisionTooLong' });
  if (result.target !== undefined) {
    commitTargetSplice(host, result.target, finding.target_span.start, finding.target_span.end, chars(replacement).length);
  }
}

function applyStep(host: WorkbenchHost, patch: Partial<WorkbenchSnapshot>, step: UndoEntry): void {
  if (step.replacedDocument) {
    host.replaceDocumentState(patch, step.semantic);
    return;
  }
  host.rt.docAbort?.abort();
  host.rt.docAbort = null;
  host.rt.docGeneration += 1;
  host.setState({
    ...patch,
    phase: 'idle',
    translating: false,
    error: null,
    generation: host.rt.docGeneration,
    inFlight: false,
    semantic: step.semantic,
    tmReceipt: null,
  });
}

export function undoStep(host: WorkbenchHost): void {
  host.rt.activeTypingTx = null;
  host.rt.composition = null;
  const state = host.getState();
  const last = state.history.at(-1) as UndoEntry | undefined;
  if (!last) return;
  const nextHistory = state.history.slice(0, -1);
  const notice = last.reports ? 'undoWithReports' : 'undoLocal';
  const clearLastSemantic = state.lastSemanticAction?.marker === last.serial;
  const cp = state.documentCheckpoint;
  const clearCheckpoint = !!(last.replacedDocument && cp && cp.entry.serial !== undefined && cp.entry.serial === last.serial);
  const { draft, choices, imported, reports, semantic, alignmentInvalidations } = state;
  const redoEntry: UndoEntry = {
    draft, choices, imported, semantic, serial: last.serial, invalidations: alignmentInvalidations,
    ...(last.replacedDocument ? { reports, replacedDocument: true } : {}),
    ...(clearCheckpoint && cp ? { checkpoint: cp } : {}),
  };
  host.rt.future = [...host.rt.future.slice(-(MAX_UNDO - 1)), redoEntry];
  const basePatch: Partial<WorkbenchSnapshot> = {
    draft: last.draft,
    choices: last.choices,
    imported: last.imported,
    history: nextHistory,
    alignmentInvalidations: invalidationsOf(last),
    sourceDirtyForTranslation: false,
    ...(clearCheckpoint ? { documentCheckpoint: null } : {}),
    ...(last.reports ? { reports: last.reports } : {}),
    ...(clearLastSemantic ? { lastSemanticAction: null } : {}),
    notice,
  };
  applyStep(host, basePatch, last);
}

export function redoStep(host: WorkbenchHost): boolean {
  host.rt.activeTypingTx = null;
  host.rt.composition = null;
  const step = host.rt.future.at(-1);
  if (!step) return false;
  host.rt.future = host.rt.future.slice(0, -1);
  const { draft, choices, imported, reports, semantic, history, alignmentInvalidations } = host.getState();
  const back: UndoEntry = {
    draft, choices, imported, semantic, serial: step.serial, invalidations: alignmentInvalidations,
    ...(step.replacedDocument ? { reports, replacedDocument: true } : {}),
  };
  applyStep(host, {
    draft: step.draft,
    choices: step.choices,
    imported: step.imported,
    history: [...history.slice(-(MAX_UNDO - 1)), back],
    alignmentInvalidations: invalidationsOf(step),
    sourceDirtyForTranslation: false,
    ...(step.reports ? { reports: step.reports } : {}),
    ...(step.checkpoint ? { documentCheckpoint: { ...step.checkpoint, entry: back } } : {}),
    notice: 'redoLocal',
  }, step);
  return true;
}

export function restoreDocumentCheckpoint(host: WorkbenchHost): boolean {
  const cp = host.getState().documentCheckpoint;
  if (!cp) return false;
  const { history } = host.pushDocumentUndo();
  const restored = cp.entry;
  host.replaceDocumentState({
    draft: restored.draft,
    choices: restored.choices,
    imported: restored.imported,
    ...(restored.reports ? { reports: restored.reports } : {}),
    alignmentInvalidations: invalidationsOf(restored),
    history,
    documentCheckpoint: null,
    importedCanonical: null,
    sourceDirtyForTranslation: false,
    notice: 'restoredCheckpoint',
  }, restored.semantic);
  return true;
}

export function replaceWithText(host: WorkbenchHost, text: string, notice: NoticeState = 'importedSourceText'): void {
  const { history: nextHistory, checkpoint } = host.pushDocumentUndo('replace');
  const textDraft: Draft = { source: text, target: '', direction: host.getState().draft.direction, alignments: null };
  host.replaceDocumentState({
    draft: textDraft,
    choices: [],
    imported: [],
    reports: [],
    history: nextHistory,
    documentCheckpoint: checkpoint,
    importedCanonical: null,
    sourceDirtyForTranslation: false,
    notice,
  }, freshSemantic(textDraft) as SemanticState);
}

export function replaceWithWorkfile(host: WorkbenchHost, pending: PendingWorkfile): void {
  const { history: nextHistory, checkpoint } = host.pushDocumentUndo('import');
  host.replaceDocumentState({
    draft: pending.draft,
    choices: pending.choices,
    imported: pending.choices,
    reports: pending.reports,
    history: nextHistory,
    documentCheckpoint: checkpoint,
    sourceDirtyForTranslation: false,
    importedCanonical: pending.importedBody,
    notice: 'imported',
    workspaceMode: 'manuscript',
  }, pending.semantic);
}

export function clearDraft(host: WorkbenchHost): boolean {
  const { draft, choices, reports, semantic } = host.getState();
  if (!workPresent(draft, choices, reports, semantic)) return false;
  const { history: nextHistory, checkpoint } = host.pushDocumentUndo('clear');
  host.replaceDocumentState({
    draft: EMPTY_DRAFT,
    choices: [],
    imported: [],
    reports: [],
    history: nextHistory,
    documentCheckpoint: checkpoint,
    sourceDirtyForTranslation: false,
    notice: 'clearedDraft',
  }, emptySemantic() as SemanticState);
  return true;
}

export async function checkDocument(host: WorkbenchHost, withChoices = true, options: { reviewsClosed?: boolean } = {}): Promise<void> {
  const { draft, choices, imported, reports } = host.getState();
  const { source, target, direction, alignments } = draft;
  const validInput = !!source.trim() && !!target.trim() && chars(source).length <= 2000 && chars(target).length <= 2000;
  if (!validInput || options.reviewsClosed) return;

  const latest = reports.at(-1) ?? null;
  const reconciled = reconcileChoices(choices, draft, latest, imported);
  const ready = reconciled.flatMap(item => (item.resolution ? [item.resolution] : []));

  host.discardInFlight();
  const mine = host.rt.docGeneration;
  const abort = new AbortController();
  host.rt.docAbort = abort;
  const resolutions = withChoices ? ready : [];
  const submitted = draft;
  const submittedSignature = documentSignature(submitted, resolutions);
  host.setState({ phase: 'loading', notice: null, inFlight: true });

  const body = {
    source, target, direction, review_version: 'review-v2',
    ...(alignments === null ? {} : { alignments }),
    ...(resolutions.length && latest ? {
      resolutions,
      resolution_context: {
        source_revision: latest.report.source_revision,
        rule_version: latest.report.rule_version,
        dictionary_revision: latest.report.dictionary.revision,
        matcher_revision: latest.report.matcher_revision,
      },
    } : {}),
  };
  if (new TextEncoder().encode(JSON.stringify(body)).length > REVIEW_REQUEST_LIMIT) {
    if (host.rt.docAbort === abort) host.rt.docAbort = null;
    host.setState({ phase: 'error', error: { code: 'bodyTooLarge' }, inFlight: false });
    return;
  }

  try {
    const features = host.getState().capabilities === null && host.rt.capabilitiesPromise
      ? await host.requestFeatures()
      : host.reviewFeatures() ?? [];
    if (host.rt.disposed || abort.signal.aborted || host.rt.docGeneration !== mine) return;
    const { response, value } = await host.post('/api/reviews', body, { signal: abort.signal, reviewFeatures: features.length ? features : true });
    if (host.rt.disposed || abort.signal.aborted || host.rt.docGeneration !== mine) return;
    if (!response.ok) {
      const reason = value && typeof value === 'object' && 'reason' in value && typeof value.reason === 'string' ? value.reason : '';
      throw Object.assign(new Error(), { gahReason: reason, gahDetail: failureFields(response, value) });
    }
    if (!validReport(value, source, target, features.includes(REVIEW_FEATURE_AMBIGUOUS_MENTION) ? REPORT_V5 : REPORT_V4)) {
      throw Object.assign(new Error(), { gahCode: 'responseInvalid' });
    }
    const report = value as Report;
    if (report.rule_version !== 'review-v2'
      || !/^[0-9a-f]{64}$/u.test(report.matcher_revision ?? '')
      || report.source_revision !== await revisionOf(source)
      || report.target_revision !== await revisionOf(target)) {
      throw Object.assign(new Error(), { gahCode: 'responseBasisMismatch' });
    }
    if (host.rt.disposed || abort.signal.aborted || host.rt.docGeneration !== mine) return;
    const snapshot: Snapshot = { ...submitted, report, trusted: true, signature: submittedSignature, resolutions };
    host.setState({
      reports: [...host.getState().reports.slice(-1), snapshot],
      phase: 'success',
      notice: 'checked',
      inFlight: false,
    });
    host.onPoolRefresh();
  } catch (cause) {
    if (!host.rt.disposed && !abort.signal.aborted && host.rt.docGeneration === mine) {
      const nextError: ErrorState = cause instanceof Error && 'gahReason' in cause
        ? { reason: String((cause as Error & { gahReason?: unknown }).gahReason), kind: 'review', ...detailOf(cause) }
        : cause instanceof Error && 'gahCode' in cause
          ? { code: String((cause as Error & { gahCode?: unknown }).gahCode) }
          : { code: 'requestFailed' };
      host.setState({ phase: 'error', error: nextError, inFlight: false });
      host.onPoolRefresh();
    }
  } finally {
    if (host.rt.docAbort === abort) host.rt.docAbort = null;
  }
}

export async function translateInReviewDocument(host: WorkbenchHost, options: { translationClosed?: boolean } = {}): Promise<void> {
  const state = host.getState();
  const { draft, phase, translating, tmPreparing, run, pairTranslating, sourceDirtyForTranslation } = state;
  const { source, target, direction, alignments } = draft;
  if (
    !source.trim()
    || chars(source).length > 2000
    || phase === 'loading'
    || translating
    || tmPreparing
    || isRunActive(run, pairTranslating)
    || options.translationClosed
  ) return;
  const tmEntries = host.currentTmEntries();
  if (
    state.workspaceMode === 'manuscript'
    && segmentParagraphs(source).length > 1
    && tmEntries.length > 0
  ) {
    if (!target.trim() && alignments === null) {
      await host.startTranslateRun();
      return;
    }
    if (sourceDirtyForTranslation && !!target.trim()) {
      const handled = await host.startIncrementalTmTranslateRun(draft, tmEntries, true, {
        requireReuse: true,
        stageUntilFirstSuccess: true,
      });
      if (handled) return;
    }
  }

  host.discardInFlight();
  const mine = host.rt.docGeneration;
  const abort = new AbortController();
  host.rt.docAbort = abort;
  host.setState({ translating: true, notice: null, inFlight: true, tmReceipt: null });
  const startedAt = host.clock.now();

  const auto = host.getState().workspaceMode === 'quick' && host.getState().autoDirection;
  try {
    const known = host.getState().capabilities ?? await (host.rt.capabilitiesPromise ?? Promise.resolve([]));
    if (host.rt.disposed || abort.signal.aborted || host.rt.docGeneration !== mine) return;
    const context = known.includes(CAPABILITY_TRANSLATION_CONTEXT) ? { context: {} } : {};
    const body = auto ? { text: source, ...context } : { text: source, to: direction, ...context };
    const { response, value } = await host.post('/api/translations', body, { signal: abort.signal });
    if (host.rt.disposed || abort.signal.aborted || host.rt.docGeneration !== mine) return;
    if (!response.ok || !value || typeof value !== 'object' || typeof (value as { text?: unknown }).text !== 'string') {
      const reason = value && typeof value === 'object' && 'reason' in value && typeof (value as { reason?: unknown }).reason === 'string'
        ? String((value as { reason: string }).reason) : '';
      throw Object.assign(new Error(), { gahReason: reason, gahDetail: failureFields(response, value) });
    }
    const reply = value as { text: string; kind?: unknown; direction?: unknown; dictionary_miss?: unknown; request_id?: unknown };
    const translated = reply.text;
    const replied = reply.direction === 'en' || reply.direction === 'zh' ? reply.direction : null;
    const current = host.getState();
    const before = current.draft;
    const nextDirection = auto && replied ? replied : before.direction;
    const { history } = host.pushUndo();
    const translatedDraft: Draft = { ...before, target: translated, direction: nextDirection, alignments: alignments === null ? null : [] };
    const nextSemantic = mapSemanticEdit(current.semantic, before, translatedDraft) as SemanticState;
    const kind = reply.kind === 'noop' || reply.kind === 'exact' || reply.kind === 'fuzzy' || reply.kind === 'llm' ? reply.kind : null;
    host.setState({
      history,
      draft: translatedDraft,
      semantic: nextSemantic,
      translating: false,
      inFlight: false,
      sourceDirtyForTranslation: false,
      notice: alignments !== null ? 'editedAlignments' : current.workspaceMode === 'quick' ? null : 'translatedInReview',
      lastTranslation: {
        source, text: translated, kind, direction: nextDirection,
        dictionaryMiss: reply.dictionary_miss === true,
        requestId: typeof reply.request_id === 'string' && reply.request_id ? reply.request_id : null,
      },
    });
    host.onPoolRefresh();
  } catch (cause) {
    if (!host.rt.disposed && !abort.signal.aborted && host.rt.docGeneration === mine) {
      const nextError: ErrorState = cause instanceof Error && 'gahReason' in cause
        ? { reason: String((cause as Error & { gahReason?: unknown }).gahReason), kind: 'translation', ...detailOf(cause),
          waitedSeconds: Math.max(0, Math.round((host.clock.now() - startedAt) / 1000)) }
        : { code: 'requestFailed' };
      host.setState({ translating: false, inFlight: false, error: nextError });
      host.onPoolRefresh();
    }
  } finally {
    if (host.rt.docAbort === abort) host.rt.docAbort = null;
  }
}
