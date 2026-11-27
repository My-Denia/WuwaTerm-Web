import { proxyMetaRequest, runtimeEnvironment } from '../../../lib/wuwaterm-proxy.js';

export const dynamic = 'force-dynamic';

function wantsFreshRevalidation(request: Request): boolean {
  try {
    return new URL(request.url).searchParams.get('refresh') === '1';
  } catch {
    return false;
  }
}

export async function GET(request: Request): Promise<Response> {
  return proxyMetaRequest({
    environment: await runtimeEnvironment(),
    forceRefresh: wantsFreshRevalidation(request),
  });
}
