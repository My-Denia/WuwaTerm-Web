'use client';

import { fill, msg } from '../../lib/messages';
import { useUiLanguage } from './ui-language-context';

export type Failure = { status: 'unavailable'; reason: string; request_id?: string; retry_after_seconds?: number };

/** A refused or failed lookup: the cause, the wait the service asked for and the request id. */
export function FailureView({ value }: { value: Failure }) {
  const { lang } = useUiLanguage();
  const m = msg(lang);
  return <div className="error-panel" role="status">
    <p>{(m.tMsg as Record<string, string>)[value.reason] ?? m.translation.failureFallback}</p>
    {value.retry_after_seconds !== undefined && <p>{fill(value.retry_after_seconds >= 3600 ? m.translation.retryHours : m.translation.retrySeconds, { n: value.retry_after_seconds >= 3600 ? Math.ceil(value.retry_after_seconds / 3600) : Math.ceil(value.retry_after_seconds) })}</p>}
    {value.request_id && <RequestId value={value.request_id} />}
  </div>;
}

export function RequestId({ value }: { value: string }) {
  const { lang } = useUiLanguage();
  return <details className="request-id"><summary>{msg(lang).terms.requestId}</summary><code>{value}</code></details>;
}
