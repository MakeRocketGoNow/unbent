import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '@unbent/shared';
import { markSourceLine } from './Preview.js';

/**
 * The byline a clipped page opens with, which the reading view draws as a byline rather
 * than as the article's first paragraph. Run through the real pipeline, since what is
 * matched is the HTML it writes.
 */
function render(markdown: string): string {
  return markSourceLine(renderMarkdown(markdown, { noteId: 'n', pdfFilenames: new Set() }));
}

describe('markSourceLine', () => {
  it('marks the line a clip opens with', () => {
    const html = render('Clipped from [Acme & Co](https://example.com/a), by Pat Example\n\nThe article.');
    expect(html.startsWith('<p class="preview-source">Clipped from <a')).toBe(true);
    expect(html.match(/preview-source/g)).toHaveLength(1);
  });

  it('leaves the words alone anywhere but the top', () => {
    const html = render('An intro.\n\nClipped from [Acme](https://example.com/a)');
    expect(html).not.toContain('preview-source');
  });

  it('leaves a first line with no link alone', () => {
    expect(render('Clipped from a magazine, by hand.')).not.toContain('preview-source');
  });
});
