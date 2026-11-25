import { documentMetadata } from '@/lib/public-metadata';
import { msg } from '@/lib/messages';
import { readUiLanguage } from '../ui-language-server';
import { LimitsBody } from '../components/limits-body';
import { RuntimeProvider } from '@/lib/runtime-provider';
import { isSelfHosted } from '@/lib/ui-runtime';

export async function generateMetadata() {
  const m = msg(await readUiLanguage());
  return documentMetadata(m.limits.title, m.limits.description, '/limits');
}
export default function Limits() {
  // Only a self-hosted instance shows its own live allowances here; the public page states the published ceilings.
  return <RuntimeProvider pool={isSelfHosted()}><LimitsBody /></RuntimeProvider>;
}
