import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown.js';

describe('setext underline vs nested list', () => {
  it('does not treat a deeper list marker as a setext underline', () => {
    const md = `- List 2
  - Can't indent
    - nested item
      -`;
    const out = renderMarkdown(md, { noteId: 'test' });
    expect(out).toContain('<li>nested item');
    expect(out).not.toMatch(/<h[1-6][^>]*>nested item/);
  });

  it('still renders intentional ATX headings', () => {
    expect(renderMarkdown('## Heading', { noteId: 'test' })).toContain('<h2>Heading</h2>');
  });
});
