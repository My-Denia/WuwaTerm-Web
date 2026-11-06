import { cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Next traces the server, but deliberately omits these browser assets.
const output = '.next-selfhost';
const standalone = join(output, 'standalone');
if (!existsSync(join(standalone, 'server.js'))) {
  throw new Error('Build the self-host standalone server before packaging assets');
}
cpSync(join(output, 'static'), join(standalone, output, 'static'), { recursive: true });
cpSync('public', join(standalone, 'public'), { recursive: true });
