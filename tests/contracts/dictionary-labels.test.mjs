import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { CATEGORY_LABEL_KEYS, REASON_LABEL_KEYS, categoryLabel, reasonLabel } from '../../lib/dictionary-labels.ts';
import { requireWindowsRoot } from './windows-source.mjs';

const root = process.env.WUWATERM_BACKEND_ROOT;
assert.ok(root, 'Set WUWATERM_BACKEND_ROOT to the pinned backend checkout');
const read = name => readFileSync(join(root, name), 'utf8');
const windowsRoot = requireWindowsRoot();

function categoryOrderKeys() {
  const source = read('src/wuwaterm/constants.py');
  const block = source.match(/CATEGORY_ORDER = \{([\s\S]*?)\n\}/);
  assert.ok(block, 'CATEGORY_ORDER block missing');
  return [...block[1].matchAll(/"([^"]+)":/g)].map(match => match[1]);
}

function lookupReasonLiterals() {
  const source = read('src/wuwaterm/lookup.py');
  const found = new Set([...source.matchAll(/reason="([^"]+)"/g)].map(match => match[1]));
  for (const line of source.split('\n')) {
    const match = line.match(/return .+, "([^"]+)"\s*$/);
    if (match) found.add(match[1]);
  }
  return [...found];
}

function clientAssignments(prefix) {
  const source = readFileSync(join(windowsRoot, 'src/wuwaterm_client/strings.py'), 'utf8');
  return Object.fromEntries([...source.matchAll(new RegExp(`^${prefix}(\\w+) = "([^"]+)"`, 'gm'))].map(match => [match[1], match[2]]));
}

test('category and reason maps equal the service keys and the desktop Chinese copy', () => {
  assert.deepEqual([...CATEGORY_LABEL_KEYS].sort(), categoryOrderKeys().sort());
  assert.deepEqual([...REASON_LABEL_KEYS].sort(), lookupReasonLiterals().sort());

  const categories = clientAssignments('CATEGORY_LABEL_');
  assert.deepEqual(Object.keys(categories).map(name => name.toLowerCase()).sort(), [...CATEGORY_LABEL_KEYS].sort());
  for (const [name, text] of Object.entries(categories)) {
    assert.equal(categoryLabel('zh', name.toLowerCase()), text);
  }

  const reasons = {
    EXACT: 'exact',
    PINYIN_FULL: 'pinyin',
    PINYIN_INITIALS: 'pinyin-abbrev',
    PINYIN_PREFIX: 'pinyin-prefix',
    PINYIN_CONTAINS: 'pinyin-substring',
    FUZZY: 'fuzzy',
    LOW_SCORE: 'low-score',
  };
  const clientReasons = clientAssignments('REASON_LABEL_');
  assert.deepEqual(Object.keys(clientReasons).sort(), Object.keys(reasons).sort());
  for (const [name, key] of Object.entries(reasons)) {
    assert.equal(reasonLabel('zh', key), clientReasons[name]);
  }
});
