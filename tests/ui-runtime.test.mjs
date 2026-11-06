import assert from 'node:assert/strict';
import test from 'node:test';
import { isSelfHosted, workbenchBasePath, workbenchPath } from '../lib/ui-runtime.ts';
import { msg } from '../lib/messages.ts';

test('public mode keeps root paths and the existing trial copy', () => {
  process.env.NEXT_PUBLIC_WUWATERM_SELFHOST = '';
  process.env.NEXT_PUBLIC_WUWATERM_BASE_PATH = '/ignored';
  assert.equal(isSelfHosted(), false);
  assert.equal(workbenchBasePath(), '');
  assert.equal(workbenchPath('/api/terms'), '/api/terms');
  assert.equal(msg('en').nav.betaBadge, 'Anonymous beta');
  assert.equal(msg('zh').nav.betaBadge, '匿名公测');
});

test('self-host paths and copy reflect a private instance at root and under a prefix', () => {
  process.env.NEXT_PUBLIC_WUWATERM_SELFHOST = '1';
  process.env.NEXT_PUBLIC_WUWATERM_BASE_PATH = '';
  assert.equal(workbenchPath('/api/reviews'), '/api/reviews');
  process.env.NEXT_PUBLIC_WUWATERM_BASE_PATH = '/api';
  assert.equal(workbenchPath('/'), '/api/');
  assert.equal(workbenchPath('/api/reviews'), '/api/api/reviews');
  assert.equal(msg('en').nav.betaBadge, 'Self-hosted');
  assert.match(msg('en').privacy.s2p3, /session cookie/u);
  assert.match(msg('en').privacy.s4p2, /model provider/u);
  assert.match(msg('zh').privacy.s2p3, /会话 cookie/u);
  assert.match(msg('zh').privacy.s4p2, /模型服务/u);
  assert.equal(msg('en').limits.rowWindowCeiling, 'Configured by the instance administrator');
  process.env.NEXT_PUBLIC_WUWATERM_SELFHOST = '';
  process.env.NEXT_PUBLIC_WUWATERM_BASE_PATH = '';
});
