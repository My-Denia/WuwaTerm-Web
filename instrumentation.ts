export async function register() {
  if (process.env.NEXT_PUBLIC_WUWATERM_SELFHOST !== '1') return;
  try {
    if (process.env.NEXT_RUNTIME !== 'nodejs') throw new Error('Self-host requires the Node runtime');
    const [{ validatePrivateConfiguration }, { initializeNodeEnvironment }] = await Promise.all([
      import('./lib/runtime/private-auth.js'),
      import('./lib/runtime/node.js'),
    ]);
    validatePrivateConfiguration(process.env, process.env.NEXT_PUBLIC_WUWATERM_BASE_PATH || '');
    initializeNodeEnvironment(process.env);
  } catch {
    // Next can keep its listener open after an instrumentation rejection.
    // Exit explicitly so a misconfigured private deployment cannot stay up.
    console.error('Self-host startup configuration is invalid');
    process.exit(1);
  }
}
