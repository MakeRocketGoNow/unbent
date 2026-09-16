import { describe, expect, it } from 'vitest';
import { collectPreviewTargets } from './preview-targets.js';

/**
 * The pane's rendered DOM is the source: the pipeline's image links and the inline PDF
 * viewers, in document order, which is reading order.
 */
describe('collectPreviewTargets', () => {
  function pane(html: string): HTMLElement {
    const div = document.createElement('div');
    div.className = 'preview';
    div.innerHTML = html;
    return div;
  }

  it('lists images and PDFs in document order', () => {
    const container = pane(`
      <p><a href="/api/n/files/one.png" class="unbent-zoom"><img src="/api/n/files/one.png" alt="one"></a></p>
      <div class="pdf-preview" data-src="/api/n/files/two.pdf" data-label="two"></div>
      <p><a href="https://example.com/three.png" class="unbent-zoom"><img alt=""></a></p>
    `);
    expect(collectPreviewTargets(container)).toEqual([
      { kind: 'image', src: '/api/n/files/one.png', alt: 'one' },
      { kind: 'pdf', src: '/api/n/files/two.pdf', label: 'two' },
      { kind: 'image', src: 'https://example.com/three.png', alt: '' },
    ]);
  });

  it('skips links and viewers with nothing to open', () => {
    const container = pane(`
      <p><a class="unbent-zoom"><img alt="no href"></a></p>
      <div class="pdf-preview"></div>
      <p><a href="/api/n/files/x.png" class="unbent-zoom"><img alt="x"></a></p>
    `);
    expect(collectPreviewTargets(container)).toEqual([
      { kind: 'image', src: '/api/n/files/x.png', alt: 'x' },
    ]);
  });

  it('returns nothing for no pane', () => {
    expect(collectPreviewTargets(null)).toEqual([]);
  });
});
