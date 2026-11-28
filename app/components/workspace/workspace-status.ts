import { failureDetails, msg } from '../../../lib/messages';
import { semanticMsg } from '../../../lib/semantic-messages';
import type { UiLanguage } from '../../../lib/ui-language';
import type { ErrorState, NoticeState } from '../../../lib/workbench-model';

export function formatWorkspaceStatus(options: {
  lang: UiLanguage;
  saveView: string;
  notice: NoticeState;
  error: ErrorState | null;
  sourceLength: number;
}) {
  const { lang, saveView, notice, error, sourceLength } = options;
  const m = msg(lang);
  const sm = semanticMsg(lang);

  const saveStateText = {
    empty: m.review.saveStateEmpty,
    'page-only': m.review.saveStatePageOnly,
    'matches-import': m.review.saveStateMatchesImport,
    'matches-download': m.review.saveStateMatchesDownload,
    diverged: m.review.saveStateDiverged,
    'not-serializable': m.review.saveStateNotSerializable,
  }[saveView] ?? '';

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

  const errorDetails = error?.kind ? failureDetails(lang, {
    kind: error.kind,
    reason: error.reason,
    requestId: error.requestId,
    retryAfter: error.retryAfter,
    waitedSeconds: error.waitedSeconds,
    textLength: sourceLength,
  }) : [];

  return { saveStateText, noticeText, errorTextValue, errorDetails };
}
