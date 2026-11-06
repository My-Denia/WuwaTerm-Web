import { NextResponse, type NextRequest } from 'next/server';
import { createPrivateGate } from './lib/runtime/private-auth.js';

let admit: ReturnType<typeof createPrivateGate> | undefined;

export async function proxy(request: NextRequest) {
  if (process.env.NEXT_PUBLIC_WUWATERM_SELFHOST !== '1') return NextResponse.next();
  admit ??= createPrivateGate(process.env, process.env.NEXT_PUBLIC_WUWATERM_BASE_PATH || '');
  const decision = await admit(request);
  if (decision.status !== 200) {
    return new NextResponse('Unavailable', {
      status: decision.status,
      headers: { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow, noarchive' },
    });
  }
  const headers = new Headers(request.headers);
  headers.delete('x-wuwaterm-edge');
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('cache-control', 'no-store');
  response.headers.set('x-robots-tag', 'noindex, nofollow, noarchive');
  if (decision.cookie) response.headers.append('set-cookie', decision.cookie);
  return response;
}
