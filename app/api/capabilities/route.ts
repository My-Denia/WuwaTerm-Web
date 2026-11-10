import { proxyCapabilitiesRequest, runtimeEnvironment } from '@/lib/wuwaterm-proxy.js';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return proxyCapabilitiesRequest({ environment: await runtimeEnvironment() });
}
