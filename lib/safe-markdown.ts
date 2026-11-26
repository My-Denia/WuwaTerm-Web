// Lightweight, dependency-free, XSS-safe Markdown AST parser for reading preview.
// Produces a pure data tree rendered exclusively as React elements — never HTML strings
// and never dangerouslySetInnerHTML. Raw HTML tags stay literal text, and links allow only
// explicit http:// or https:// URLs.

export type InlineNode =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; children: InlineNode[] }
  | { type: 'em'; children: InlineNode[] }
  | { type: 'del'; children: InlineNode[] }
  | { type: 'link'; href: string; children: InlineNode[] }
  | { type: 'br' };

export type BlockNode =
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; children: InlineNode[] }
  | { type: 'paragraph'; children: InlineNode[] }
  | { type: 'code_block'; lang: string; text: string }
  | { type: 'blockquote'; children: BlockNode[] }
  | { type: 'ul'; items: InlineNode[][] }
  | { type: 'ol'; start: number; items: InlineNode[][] }
  | { type: 'hr' };

const MAX_INLINE_DEPTH = 4;
const MAX_BLOCKQUOTE_DEPTH = 4;
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

/**
 * Returns a normalized http(s) URL or null for anything else (javascript:, data:,
 * vbscript:, protocol-relative //, control characters, malformed URLs).
 */
export function safeMarkdownHref(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || CONTROL_CHAR.test(trimmed)) return null;
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function pushText(out: InlineNode[], text: string) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.type === 'text') last.text += text;
  else out.push({ type: 'text', text });
}

function isWordChar(ch: string | undefined): boolean {
  return !!ch && /[\p{L}\p{N}]/u.test(ch);
}

/** Find a closing delimiter that is not escaped and not immediately preceded by whitespace. */
function findClosing(text: string, from: number, marker: string, requireBoundary = false): number {
  let i = from;
  while (i < text.length) {
    if (text[i] === '\\' && i + 1 < text.length) {
      i += 2;
      continue;
    }
    if (text[i] === '`') {
      const endTick = text.indexOf('`', i + 1);
      if (endTick < 0) break;
      i = endTick + 1;
      continue;
    }
    if (text.startsWith(marker, i)) {
      const prev = text[i - 1];
      const next = text[i + marker.length];
      if (prev && !/\s/.test(prev) && (!requireBoundary || !isWordChar(next))) {
        return i;
      }
    }
    i += 1;
  }
  return -1;
}

/** Parse Markdown inline syntax into safe AST nodes without catastrophic backtracking. */
export function parseInline(text: string, depth = 0): InlineNode[] {
  const out: InlineNode[] = [];
  let i = 0;

  while (i < text.length) {
    const ch = text[i]!;

    // Explicit line break preserved inside paragraphs.
    if (ch === '\n') {
      out.push({ type: 'br' });
      i += 1;
      continue;
    }

    // Backslash escape for ASCII punctuation.
    if (ch === '\\' && i + 1 < text.length && /[\\`*_{}[\]()#+\-.!~]/.test(text[i + 1]!)) {
      pushText(out, text[i + 1]!);
      i += 2;
      continue;
    }

    // Inline code span: `...` or ``...``
    if (ch === '`') {
      let ticks = 1;
      while (text[i + ticks] === '`') ticks += 1;
      const delim = '`'.repeat(ticks);
      const close = text.indexOf(delim, i + ticks);
      if (close > i + ticks) {
        const inner = text.slice(i + ticks, close).replace(/\n/g, ' ');
        out.push({ type: 'code', text: inner });
        i = close + ticks;
        continue;
      }
      pushText(out, delim);
      i += ticks;
      continue;
    }

    // Link: [label](url)
    if (ch === '[' && depth < MAX_INLINE_DEPTH) {
      const closeBracket = findLinkBracketEnd(text, i + 1);
      if (closeBracket > i + 1 && text[closeBracket + 1] === '(') {
        const closeParen = findLinkParenEnd(text, closeBracket + 2);
        if (closeParen > closeBracket + 2) {
          const label = text.slice(i + 1, closeBracket);
          const rawHref = text.slice(closeBracket + 2, closeParen).trim();
          const href = safeMarkdownHref(rawHref);
          if (href) {
            out.push({ type: 'link', href, children: parseInline(label, depth + 1) });
            i = closeParen + 1;
            continue;
          }
        }
      }
    }

    if (depth < MAX_INLINE_DEPTH) {
      // Bold + italic: ***text***
      if (text.startsWith('***', i) && text[i + 3] && !/\s/.test(text[i + 3]!)) {
        const close = findClosing(text, i + 3, '***');
        if (close > i + 3) {
          out.push({
            type: 'strong',
            children: [{ type: 'em', children: parseInline(text.slice(i + 3, close), depth + 1) }],
          });
          i = close + 3;
          continue;
        }
      }

      // Bold: **text** or __text__
      if ((text.startsWith('**', i) || (text.startsWith('__', i) && !isWordChar(text[i - 1])))
        && text[i + 2] && !/\s/.test(text[i + 2]!)) {
        const marker = text.slice(i, i + 2);
        const close = findClosing(text, i + 2, marker, marker === '__');
        if (close > i + 2) {
          out.push({ type: 'strong', children: parseInline(text.slice(i + 2, close), depth + 1) });
          i = close + 2;
          continue;
        }
      }

      // Strikethrough: ~~text~~
      if (text.startsWith('~~', i) && text[i + 2] && !/\s/.test(text[i + 2]!)) {
        const close = findClosing(text, i + 2, '~~');
        if (close > i + 2) {
          out.push({ type: 'del', children: parseInline(text.slice(i + 2, close), depth + 1) });
          i = close + 2;
          continue;
        }
      }

      // Italic: *text* or _text_ (never split snake_case identifiers)
      if ((ch === '*' || (ch === '_' && !isWordChar(text[i - 1])))
        && text[i + 1] && text[i + 1] !== ch && !/\s/.test(text[i + 1]!)) {
        const close = findClosing(text, i + 1, ch, ch === '_');
        if (close > i + 1) {
          out.push({ type: 'em', children: parseInline(text.slice(i + 1, close), depth + 1) });
          i = close + 1;
          continue;
        }
      }
    }

    pushText(out, ch);
    i += 1;
  }

  return out;
}

function findLinkBracketEnd(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === '\\' && i + 1 < text.length) { i += 1; continue; }
    if (text[i] === '\n') return -1;
    if (text[i] === '[') depth += 1;
    else if (text[i] === ']') {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return -1;
}

function findLinkParenEnd(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '\\' && i + 1 < text.length) { i += 1; continue; }
    if (ch === '\n' || /\s/.test(ch)) return -1;
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return -1;
}

const HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*#*$/;
const FENCE_RE = /^(`{3,}|~{3,})([^\s`~]*)[ \t]*$/;
const HR_RE = /^(?:-[ \t]*){3,}$|^(?:\*[ \t]*){3,}$|^(?:_[ \t]*){3,}$/;
const UL_RE = /^[ \t]{0,3}[-*+][ \t]+(.*)$/;
const OL_RE = /^[ \t]{0,3}(\d{1,9})[.)][ \t]+(.*)$/;
const QUOTE_RE = /^[ \t]{0,3}>[ \t]?(.*)$/;

function isBlockStarter(line: string): boolean {
  return HEADING_RE.test(line) || FENCE_RE.test(line) || HR_RE.test(line)
    || UL_RE.test(line) || OL_RE.test(line) || QUOTE_RE.test(line);
}

/** Parse a Markdown document into block AST nodes. */
export function parseMarkdown(source: string, depth = 0): BlockNode[] {
  if (!source) return [];
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: BlockNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // Fenced code block
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const fenceChar = marker[0]!;
      const lang = fence[2] ?? '';
      const body: string[] = [];
      i += 1;
      while (i < lines.length) {
        const candidate = lines[i]!.trim();
        if (candidate.length >= marker.length && [...candidate].every(c => c === fenceChar)) {
          i += 1;
          break;
        }
        body.push(lines[i]!);
        i += 1;
      }
      blocks.push({ type: 'code_block', lang, text: body.join('\n') });
      continue;
    }

    // ATX heading
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = heading[1]!.length as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ type: 'heading', level, children: parseInline(heading[2]!.trim()) });
      i += 1;
      continue;
    }

    // Horizontal rule
    if (HR_RE.test(line.trim())) {
      blocks.push({ type: 'hr' });
      i += 1;
      continue;
    }

    // Blockquote
    if (QUOTE_RE.test(line) && depth < MAX_BLOCKQUOTE_DEPTH) {
      const quoted: string[] = [];
      while (i < lines.length) {
        const match = QUOTE_RE.exec(lines[i]!);
        if (!match) break;
        quoted.push(match[1]!);
        i += 1;
      }
      blocks.push({ type: 'blockquote', children: parseMarkdown(quoted.join('\n'), depth + 1) });
      continue;
    }

    // Unordered list
    if (UL_RE.test(line)) {
      const items: InlineNode[][] = [];
      while (i < lines.length) {
        const match = UL_RE.exec(lines[i]!);
        if (!match) break;
        items.push(parseInline(match[1]!));
        i += 1;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }

    // Ordered list
    const olFirst = OL_RE.exec(line);
    if (olFirst) {
      const start = Math.max(1, Number(olFirst[1]!) || 1);
      const items: InlineNode[][] = [];
      while (i < lines.length) {
        const match = OL_RE.exec(lines[i]!);
        if (!match) break;
        items.push(parseInline(match[2]!));
        i += 1;
      }
      blocks.push({ type: 'ol', start, items });
      continue;
    }

    // Paragraph (consecutive non-empty non-block lines)
    const paraLines: string[] = [line];
    i += 1;
    while (i < lines.length && lines[i]!.trim() && !isBlockStarter(lines[i]!)) {
      paraLines.push(lines[i]!);
      i += 1;
    }
    blocks.push({ type: 'paragraph', children: parseInline(paraLines.join('\n')) });
  }

  return blocks;
}
