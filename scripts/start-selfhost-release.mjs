// The downloaded bundle keeps this launcher beside the generated server.
if (process.platform !== 'linux' || process.arch !== 'x64' || Number(process.versions.node.split('.')[0]) !== 24) {
  throw new Error('This bundle requires Node 24 on Linux x64');
}
process.env.HOSTNAME = process.env.WUWATERM_WEB_BIND || '127.0.0.1';
process.env.PORT ||= '3000';
await import('./server.js');
