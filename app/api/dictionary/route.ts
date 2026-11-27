import { proxyDictionaryRequest, runtimeEnvironment } from '../../../lib/wuwaterm-proxy.js';

export const dynamic = 'force-dynamic';

function wantsFreshRevalidation(request?: Request): boolean {
  if (!request) return false;
  const cacheControl = request.headers.get('cache-control') ?? '';
  if (cacheControl.split(',').some(token => token.trim().toLowerCase() === 'no-cache')) {
    return true;
  }
  try {
    return new URL(request.url).searchParams.get('refresh') === '1';
  } catch {
    return false;
  }
}

export async function GET(request?: Request): Promise<Response> {
  return proxyDictionaryRequest({
    environment: await runtimeEnvironment(),
    forceRefresh: wantsFreshRevalidation(request),
  });
}
