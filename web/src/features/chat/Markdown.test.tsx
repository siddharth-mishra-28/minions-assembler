import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from './Markdown';

const sample = [
  '## Sample',
  '',
  '- First item',
  '- Second item',
  '- Third item',
  '',
  'Paragraph with `inline code` and **bold**.',
  '',
  '```javascript',
  'console.log("hello world");',
  '```',
].join('\n');

describe('Markdown chat rendering', () => {
  const html = renderToStaticMarkup(<Markdown>{sample}</Markdown>);

  it('renders headings, lists, and emphasis', () => {
    expect(html).toContain('<h2');
    expect(html).toContain('Sample');
    expect(html.match(/<li/g)).toHaveLength(3);
    expect(html).toContain('<strong');
    expect(html).toContain('bold');
  });

  it('renders inline code inline (not inside a code block)', () => {
    expect(html).toMatch(/<code[^>]*>inline code<\/code>/);
  });

  it('renders fenced code as a card with a language header and a copy button', () => {
    expect(html).toContain('language-javascript');
    expect(html).toMatch(/<span[^>]*>javascript<\/span>/);
    expect(html).toContain('hello world');
    expect(html).toContain('hljs');
    expect(html).toContain('aria-label="Copy"');
  });
});
