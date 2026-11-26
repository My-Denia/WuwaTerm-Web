import assert from 'node:assert/strict';
import test from 'node:test';

import { parseInline, parseMarkdown, safeMarkdownHref } from '../lib/safe-markdown.ts';

test('safeMarkdownHref allows only explicit http(s) URLs and rejects unsafe schemes', () => {
  assert.equal(safeMarkdownHref('https://example.com/guide?a=1#top'), 'https://example.com/guide?a=1#top');
  assert.equal(safeMarkdownHref('http://example.com/a'), 'http://example.com/a');
  assert.equal(safeMarkdownHref('javascript:alert(1)'), null);
  assert.equal(safeMarkdownHref('JAVASCRIPT:alert(1)'), null);
  assert.equal(safeMarkdownHref('java\tscript:alert(1)'), null);
  assert.equal(safeMarkdownHref('data:text/html,<script>alert(1)</script>'), null);
  assert.equal(safeMarkdownHref('vbscript:msgbox(1)'), null);
  assert.equal(safeMarkdownHref('//evil.example/x'), null);
  assert.equal(safeMarkdownHref('file:///etc/passwd'), null);
  assert.equal(safeMarkdownHref(''), null);
});

test('parseMarkdown parses headings, lists, blockquotes, code blocks, hr, and inline formatting', () => {
  const md = [
    '# 2.4 版本攻略',
    '',
    '欢迎阅读 **今汐** 与 *声骸* 以及 ***共鸣解放*** 和 ~~旧写法~~，内联 `Resonance_Liberation`。',
    '单行换行保留。',
    '',
    '- 第一条：[官方说明](https://example.com/notes)',
    '- 第二条：保留 `foo_bar_baz` 与普通 foo_bar_baz 下划线',
    '',
    '1. 步骤一',
    '2. 步骤二',
    '',
    '> 提示：请核对术语。',
    '',
    '```txt',
    'plain <script>not executed</script>',
    '```',
    '',
    '---',
  ].join('\n');

  const blocks = parseMarkdown(md);
  assert.deepEqual(blocks.map(b => b.type), ['heading', 'paragraph', 'ul', 'ol', 'blockquote', 'code_block', 'hr']);
  assert.equal(blocks[0].level, 1);
  assert.deepEqual(blocks[0].children, [{ type: 'text', text: '2.4 版本攻略' }]);

  const para = blocks[1];
  assert.equal(para.children.some(n => n.type === 'strong'), true);
  assert.equal(para.children.some(n => n.type === 'em'), true);
  assert.equal(para.children.some(n => n.type === 'del'), true);
  assert.equal(para.children.some(n => n.type === 'code' && n.text === 'Resonance_Liberation'), true);
  assert.equal(para.children.some(n => n.type === 'br'), true);

  const ul = blocks[2];
  assert.equal(ul.items.length, 2);
  assert.equal(ul.items[0].some(n => n.type === 'link' && n.href === 'https://example.com/notes'), true);
  // snake_case identifiers stay literal text rather than turning into italics
  assert.equal(ul.items[1].some(n => n.type === 'em'), false);

  const ol = blocks[3];
  assert.equal(ol.start, 1);
  assert.equal(ol.items.length, 2);

  assert.equal(blocks[4].children[0].type, 'paragraph');
  assert.equal(blocks[5].lang, 'txt');
  assert.equal(blocks[5].text, 'plain <script>not executed</script>');
});

test('raw HTML and unsafe link protocols remain literal text with zero XSS nodes', () => {
  const payload = '<script>alert(1)</script> <img src=x onerror=alert(1)> [click](javascript:alert(1)) [data](data:text/html,hi)';
  const blocks = parseMarkdown(payload);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'paragraph');
  assert.equal(blocks[0].children.every(n => n.type === 'text'), true);
  assert.equal(blocks[0].children[0].text, payload);
});

test('adversarial repeated markers parse quickly in linear/bounded time', () => {
  const hostile = '*'.repeat(4000) + '['.repeat(2000) + '`'.repeat(1000);
  const start = Date.now();
  const nodes = parseInline(hostile);
  assert.ok(Date.now() - start < 500, 'parser should finish well under 500ms');
  assert.ok(nodes.length > 0);
});
