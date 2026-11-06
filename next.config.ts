import type { NextConfig } from 'next';

const selfhost = process.env.WUWATERM_BUILD_TARGET === 'selfhost';
const basePath = selfhost ? (process.env.NEXT_PUBLIC_WUWATERM_BASE_PATH || '') : '';
if (basePath && !/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/u.test(basePath)) {
  throw new Error('Invalid self-host base path');
}

const nextConfig: NextConfig = selfhost ? {
  output: 'standalone',
  // Vinext uses .next for its own generated route types. Keep the Next
  // standalone build and its type validator separate from that output.
  distDir: '.next-selfhost',
  typescript: { tsconfigPath: 'tsconfig.selfhost.json' },
  basePath,
  // Apply the private gate before any automatic slash redirect.
  skipTrailingSlashRedirect: true,
  env: {
    NEXT_PUBLIC_WUWATERM_SELFHOST: '1',
    NEXT_PUBLIC_WUWATERM_BASE_PATH: basePath,
  },
  webpack(config) {
    // The public adapter dynamically imports this built-in in Cloudflare.
    // Leave it external in the Node build; the public import is never used by
    // the initialized self-host runtime.
    config.externals.push(({ request }: { request?: string }, callback: (error?: Error | null, result?: string) => void) => {
      if (request === 'cloudflare:workers') callback(null, 'commonjs cloudflare:workers');
      else callback();
    });
    return config;
  },
} : {};

export default nextConfig;
