import { IMAGE_ZOOM_CLASS } from '@unbent/shared';
import type { ViewerTarget } from '../attachment-viewer.js';

/**
 * Every attachment the preview pane shows, in reading order, for the viewer to page
 * through.
 *
 * Read from the rendered DOM rather than re-parsed from the markdown: the pane already
 * decided what is a picture and what is a document, and document order is reading order.
 * Images are the links the pipeline wrapped them in (`rehypeLinkImages`); PDFs are the
 * inline viewers, which carry their source and caption as data attributes for this.
 * Unlike the rich editor, the pane renders the whole note, so nothing is scrolled out of
 * existence here.
 */
export function collectPreviewTargets(container: Element | null): ViewerTarget[] {
  if (!container) return [];
  const targets: ViewerTarget[] = [];
  for (const node of container.querySelectorAll(`a.${IMAGE_ZOOM_CLASS}, .pdf-preview[data-src]`)) {
    if (node instanceof HTMLAnchorElement) {
      const src = node.getAttribute('href');
      if (!src) continue;
      targets.push({ kind: 'image', src, alt: node.querySelector('img')?.alt ?? '' });
    } else if (node instanceof HTMLElement) {
      const src = node.dataset['src'];
      if (!src) continue;
      targets.push({ kind: 'pdf', src, label: node.dataset['label'] ?? '' });
    }
  }
  return targets;
}
