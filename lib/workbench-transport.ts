import { classifyFailure } from './semantic-run.js';
import { workbenchPath } from './ui-runtime.ts';

export const REVIEW_FEATURES = 'dense-128,reason-v1';
export const REVIEW_REQUEST_LIMIT = 65_536;

/**
 * The X-WuwaTerm-Review-Features value of a review: always dense-128 and reason-v1, and the session's recorded features
 * (ambiguous-mention-v1, which needs reason-v1) after them. `true` asks for the base pair only.
 */
export function reviewFeatureHeader(features: boolean | readonly string[]): string {
  const extra = Array.isArray(features) ? features.filter(token => token === 'ambiguous-mention-v1') : [];
  return [REVIEW_FEATURES, ...extra].join(',');
}

/** Send one workbench request. Callers decide when its result is still applicable. */
export async function postWorkbench(path: string, body: object, options: { signal?: AbortSignal; reviewFeatures?: boolean | readonly string[]; allowInvalidJson?: boolean } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.reviewFeatures) headers['X-WuwaTerm-Review-Features'] = reviewFeatureHeader(options.reviewFeatures);
  const response = await fetch(workbenchPath(path), {
    method: 'POST', headers, cache: 'no-store', body: JSON.stringify(body), signal: options.signal,
  });
  let value: unknown;
  if (options.allowInvalidJson) {
    try { value = await response.json(); } catch { value = null; }
  } else {
    value = await response.json();
  }
  return { response, value };
}

/** Translate a failed response to the existing serial-run actions. */
export function runFailure(response: Response, body: Record<string, unknown> | null) {
  const reason = typeof body?.reason === 'string' ? body.reason : 'fallback';
  const header = Number(response.headers.get('retry-after'));
  const retry = typeof body?.retry_after_seconds === 'number' ? body.retry_after_seconds : Number.isFinite(header) && header > 0 ? header : undefined;
  const requestId = typeof body?.request_id === 'string' && body.request_id ? body.request_id : undefined;
  return { code: reason, ...(requestId ? { requestId } : {}), classification: classifyFailure({ status: response.status, reason, retryAfterSeconds: retry }) };
}
