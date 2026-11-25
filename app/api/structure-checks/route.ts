import {
  parseStructureCheckRequest,
  proxyStructureCheckRequest,
  runtimeEnvironment,
} from '@/lib/wuwaterm-proxy.js';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const parsed = await parseStructureCheckRequest(request);
  if (!parsed.ok) return parsed.response;
  return proxyStructureCheckRequest({ environment: await runtimeEnvironment(), input: parsed.input });
}
