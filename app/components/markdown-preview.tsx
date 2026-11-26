'use client';

import { forwardRef, Fragment, useMemo, type ReactNode, type UIEventHandler } from 'react';
import { parseMarkdown, type BlockNode, type InlineNode } from '../../lib/safe-markdown';

type Props = {
  value: string;
  emptyText: string;
  ariaLabel: string;
  onScroll?: UIEventHandler<HTMLDivElement>;
};

function renderInlines(nodes: readonly InlineNode[], prefix: string): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${prefix}-${index}`;
    switch (node.type) {
      case 'text':
        return <Fragment key={key}>{node.text}</Fragment>;
      case 'code':
        return <code key={key}>{node.text}</code>;
      case 'strong':
        return <strong key={key}>{renderInlines(node.children, key)}</strong>;
      case 'em':
        return <em key={key}>{renderInlines(node.children, key)}</em>;
      case 'del':
        return <del key={key}>{renderInlines(node.children, key)}</del>;
      case 'link':
        return <a key={key} href={node.href} target="_blank" rel="noopener noreferrer nofollow">{renderInlines(node.children, key)}</a>;
      case 'br':
        return <br key={key} />;
    }
  });
}

function renderBlocks(blocks: readonly BlockNode[], prefix: string): ReactNode[] {
  return blocks.map((block, index) => {
    const key = `${prefix}-${index}`;
    switch (block.type) {
      case 'heading': {
        const content = renderInlines(block.children, key);
        if (block.level === 1) return <h3 key={key} className="md-h1">{content}</h3>;
        if (block.level === 2) return <h4 key={key} className="md-h2">{content}</h4>;
        if (block.level === 3) return <h5 key={key} className="md-h3">{content}</h5>;
        return <h6 key={key} className={`md-h${block.level}`}>{content}</h6>;
      }
      case 'paragraph':
        return <p key={key}>{renderInlines(block.children, key)}</p>;
      case 'code_block':
        return <pre key={key} className="md-code-block" data-lang={block.lang || undefined}><code>{block.text}</code></pre>;
      case 'blockquote':
        return <blockquote key={key} className="md-quote">{renderBlocks(block.children, key)}</blockquote>;
      case 'ul':
        return <ul key={key} className="md-list">{block.items.map((item, j) => <li key={`${key}-li-${j}`}>{renderInlines(item, `${key}-li-${j}`)}</li>)}</ul>;
      case 'ol':
        return <ol key={key} className="md-list" start={block.start === 1 ? undefined : block.start}>{block.items.map((item, j) => <li key={`${key}-li-${j}`}>{renderInlines(item, `${key}-li-${j}`)}</li>)}</ol>;
      case 'hr':
        return <hr key={key} className="md-hr" />;
    }
  });
}

/**
 * Safe read-only Markdown preview rendered strictly as React elements (never dangerouslySetInnerHTML).
 * Keeps the document's heading hierarchy clean (h3–h6) and allows only explicit http(s) links.
 */
export const MarkdownPreview = forwardRef<HTMLDivElement, Props>(function MarkdownPreview(
  { value, emptyText, ariaLabel, onScroll },
  ref,
) {
  const blocks = useMemo(() => parseMarkdown(value), [value]);
  return (
    <div
      ref={ref}
      className="markdown-preview"
      role="region"
      aria-label={ariaLabel}
      tabIndex={0}
      onScroll={onScroll}
    >
      {blocks.length === 0
        ? <p className="markdown-preview-empty">{emptyText}</p>
        : renderBlocks(blocks, 'b')}
    </div>
  );
});
