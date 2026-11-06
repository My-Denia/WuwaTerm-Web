// These two values are fixed by the self-host build; neither contains secrets.
// Public Sites builds leave them unset and retain the root-mounted UI.
export function isSelfHosted(): boolean {
  return process.env.NEXT_PUBLIC_WUWATERM_SELFHOST === '1';
}

export function workbenchBasePath(): string {
  return isSelfHosted() ? (process.env.NEXT_PUBLIC_WUWATERM_BASE_PATH || '') : '';
}

// Call only with an application-relative absolute path, before adding a query.
export function workbenchPath(path: string): string {
  return `${workbenchBasePath()}${path}`;
}
