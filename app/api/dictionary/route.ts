import { proxyDictionaryRequest, runtimeEnvironment } from '@/lib/wuwaterm-proxy.js';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return proxyDictionaryRequest({ environment: await runtimeEnvironment() });
}
