// Do not inherit an unrelated HOSTNAME from the shell or container.
// A reverse proxy on the same host connects to this loopback listener.
process.env.HOSTNAME = process.env.WUWATERM_WEB_BIND || '127.0.0.1';
process.env.PORT ||= '3000';
await import('../.next-selfhost/standalone/server.js');
