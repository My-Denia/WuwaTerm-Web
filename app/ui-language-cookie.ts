import type { UiLanguage } from '../lib/ui-language';
import { workbenchBasePath } from '../lib/ui-runtime';

// The interface-language preference is the site's only browser-storage write.
export function persistUiLanguage(value: UiLanguage): void {
  if (value !== 'zh' && value !== 'en') return;
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  const path = workbenchBasePath() || '/';
  document.cookie = `wuwaterm-lang=${value}; Max-Age=31536000; Path=${path}; SameSite=Lax${secure}`;
}
