import {
  parseSemanticReviewRequest,
  proxySemanticReviewRequest,
  runtimeEnvironment,
} from '@/lib/wuwaterm-proxy.js';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const parsed = await parseSemanticReviewRequest(request);
  if (!parsed.ok) return parsed.response;
  return proxySemanticReviewRequest({ environment: await runtimeEnvironment(), input: parsed.input });
}
