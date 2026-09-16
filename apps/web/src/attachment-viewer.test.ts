import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { labelFor, openAttachmentViewer } from './attachment-viewer.js';

/**
 * pdf.js never runs here — jsdom has no canvas — so the document is a stub that reports a
 * page count and records what was asked of it. What these tests are about is the dialog:
 * that it opens and closes cleanly, that one replaces another, and that a PDF's document
 * is acquired on open and released on close.
 */
const renderPage = vi.fn(async () => {});
let pageCount = 1;
const acquirePdf = vi.fn(async (_url: string) => ({ pageCount, renderPage, destroy: () => {} }));
const releasePdf = vi.fn((_url: string) => {});

vi.mock('./pdf/render.js', () => ({
  acquirePdf: (url: string) => acquirePdf(url),
  releasePdf: (url: string) => releasePdf(url),
}));

/**
 * jsdom ships no `showModal`/`close`. These stubs track `open` and fire `close` the way the
 * platform does, which is what the viewer's teardown listens for.
 */
function stubDialog() {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const dialogs = () => document.querySelectorAll('dialog.viewer');

describe('openAttachmentViewer', () => {
  beforeEach(() => {
    stubDialog();
    acquirePdf.mockClear();
    releasePdf.mockClear();
    renderPage.mockClear();
    pageCount = 1;
  });

  afterEach(() => {
    for (const d of dialogs()) (d as HTMLDialogElement).close();
    document.body.innerHTML = '';
  });

  it('opens a modal dialog named for the attachment', () => {
    const dialog = openAttachmentViewer({ kind: 'image', src: '/api/x/photo.png', alt: 'A photo' });
    expect(dialog.open).toBe(true);
    expect(dialog.getAttribute('aria-label')).toBe('A photo');
    expect(dialog.querySelector('.viewer-name')?.textContent).toBe('A photo');
    expect(dialog.querySelector<HTMLImageElement>('img.viewer-image')?.getAttribute('src')).toBe(
      '/api/x/photo.png',
    );
  });

  it('removes itself from the document when closed', () => {
    const dialog = openAttachmentViewer({ kind: 'image', src: '/api/x/photo.png', alt: '' });
    expect(dialogs()).toHaveLength(1);
    dialog.close();
    expect(dialogs()).toHaveLength(0);
  });

  it('closes from its button', () => {
    const dialog = openAttachmentViewer({ kind: 'image', src: '/api/x/photo.png', alt: '' });
    dialog.querySelector<HTMLButtonElement>('.viewer-close')?.click();
    expect(dialog.open).toBe(false);
    expect(dialogs()).toHaveLength(0);
  });

  it('closes on a click beside the content, not on it', () => {
    const dialog = openAttachmentViewer({ kind: 'image', src: '/api/x/photo.png', alt: '' });
    dialog.querySelector<HTMLImageElement>('.viewer-image')?.click();
    expect(dialog.open).toBe(true);
    dialog.querySelector<HTMLElement>('.viewer-body')?.click();
    expect(dialog.open).toBe(false);
  });

  it('replaces an open viewer rather than stacking a second', () => {
    openAttachmentViewer({ kind: 'image', src: '/api/x/one.png', alt: 'one' });
    openAttachmentViewer({ kind: 'image', src: '/api/x/two.png', alt: 'two' });
    expect(dialogs()).toHaveLength(1);
    expect(dialogs()[0]?.getAttribute('aria-label')).toBe('two');
  });

  it('acquires a PDF on open and lays out every page', async () => {
    pageCount = 3;
    const dialog = openAttachmentViewer({ kind: 'pdf', src: '/api/x/scan.pdf', label: 'Scan' });
    expect(acquirePdf).toHaveBeenCalledWith('/api/x/scan.pdf');
    await settle();
    expect(dialog.querySelectorAll('canvas.viewer-page')).toHaveLength(3);
    expect(dialog.querySelector('.viewer-meta')?.textContent).toBe('3 pages');
    // No IntersectionObserver in jsdom, so every page draws at once.
    expect(renderPage).toHaveBeenCalledTimes(3);
  });

  it('releases the PDF when closed', async () => {
    const dialog = openAttachmentViewer({ kind: 'pdf', src: '/api/x/scan.pdf', label: 'Scan' });
    await settle();
    expect(releasePdf).not.toHaveBeenCalled();
    dialog.close();
    expect(releasePdf).toHaveBeenCalledWith('/api/x/scan.pdf');
  });

  it('releases a PDF closed before it opened, and draws nothing into it', async () => {
    pageCount = 2;
    const dialog = openAttachmentViewer({ kind: 'pdf', src: '/api/x/scan.pdf', label: 'Scan' });
    dialog.close();
    await settle();
    expect(releasePdf).toHaveBeenCalledWith('/api/x/scan.pdf');
    expect(renderPage).not.toHaveBeenCalled();
  });

  it('reports a PDF that will not open', async () => {
    acquirePdf.mockRejectedValueOnce(new Error('404 Not Found'));
    const dialog = openAttachmentViewer({ kind: 'pdf', src: '/api/x/gone.pdf', label: 'Gone' });
    await settle();
    expect(dialog.querySelector('.viewer-status')?.textContent).toContain('404 Not Found');
  });
});

describe('labelFor', () => {
  it('prefers the caption the markdown gave', () => {
    expect(labelFor({ kind: 'pdf', src: '/api/n/files/x.pdf', label: 'Tax return' })).toBe(
      'Tax return',
    );
    expect(labelFor({ kind: 'image', src: '/api/n/files/x.png', alt: 'Whiteboard' })).toBe(
      'Whiteboard',
    );
  });

  it('falls back to the decoded filename', () => {
    expect(
      labelFor({ kind: 'pdf', src: '/api/n/files/Treatment%20Plan.pdf?x=1', label: '' }),
    ).toBe('Treatment Plan.pdf');
    expect(labelFor({ kind: 'image', src: '/api/n/files/my%20photo.png', alt: '  ' })).toBe(
      'my photo.png',
    );
  });

  it('survives a malformed escape', () => {
    expect(labelFor({ kind: 'image', src: '/api/n/files/100%.png', alt: '' })).toBe('100%.png');
  });
});
