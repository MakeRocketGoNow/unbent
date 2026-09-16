import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadUrl, labelFor, openAttachmentViewer } from './attachment-viewer.js';

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

/**
 * Moves the clock past the opening grace, during which the viewer ignores clicks on its
 * body and image so the tail of a double-click cannot close or zoom it. Only `Date` is
 * faked: `settle` still needs a real `setTimeout`.
 */
function afterOpening() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 1_000);
}

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
    vi.useRealTimers();
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

  it('offers a stored file as a download, under its filename', () => {
    const dialog = openAttachmentViewer({
      kind: 'image',
      src: '/api/notes/n/files/my%20scan.png',
      alt: 'Scan of a sample invoice',
    });
    const link = dialog.querySelector<HTMLAnchorElement>('a.viewer-download');
    expect(link?.getAttribute('href')).toBe('/api/notes/n/files/my%20scan.png?download=1');
    expect(link?.getAttribute('download')).toBe('my scan.png');
    expect(link?.textContent).toBe('Download');
  });

  /** Another host ignores our query and the browser ignores `download` across origins. */
  it('offers no download for a remote image', () => {
    const dialog = openAttachmentViewer({
      kind: 'image',
      src: 'https://example.com/logo.png',
      alt: 'logo',
    });
    expect(dialog.querySelector('a.viewer-download')).toBeNull();
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
    afterOpening();
    dialog.querySelector<HTMLImageElement>('.viewer-image')?.click();
    expect(dialog.open).toBe(true);
    dialog.querySelector<HTMLElement>('.viewer-body')?.click();
    expect(dialog.open).toBe(false);
  });

  /**
   * The second click of a double-click arrives after the viewer has opened and lands
   * inside it. Beside the image it would close the viewer; on the image it would zoom.
   * Neither may happen while the opening click is still echoing.
   */
  it('ignores the tail of the click that opened it', () => {
    const dialog = openAttachmentViewer({ kind: 'image', src: '/api/x/photo.png', alt: '' });
    const img = dialog.querySelector<HTMLImageElement>('.viewer-image') as HTMLImageElement;
    const body = dialog.querySelector<HTMLElement>('.viewer-body') as HTMLElement;
    Object.defineProperty(img, 'naturalWidth', { value: 4000 });
    Object.defineProperty(img, 'naturalHeight', { value: 3000 });
    // jsdom has no `scrollTo` on elements; the zoom scrolls to the clicked point.
    body.scrollTo = vi.fn();

    img.click();
    expect(img.classList.contains('viewer-actual')).toBe(false);
    body.click();
    expect(dialog.open).toBe(true);

    afterOpening();
    img.click();
    expect(img.classList.contains('viewer-actual')).toBe(true);
    expect(body.scrollTo).toHaveBeenCalled();
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

describe('paging', () => {
  const three = [
    { kind: 'image' as const, src: '/api/notes/n/files/one.png', alt: 'one' },
    { kind: 'pdf' as const, src: '/api/notes/n/files/two.pdf', label: 'two' },
    { kind: 'image' as const, src: 'https://example.com/three.png', alt: 'three' },
  ];

  /** Opens on the middle attachment of three, with the scroll jsdom lacks stubbed. */
  function openPaged(at = 1) {
    const dialog = openAttachmentViewer(three[at]!, three);
    const body = dialog.querySelector<HTMLElement>('.viewer-body') as HTMLElement;
    body.scrollTo = vi.fn();
    return dialog;
  }

  const position = (d: HTMLDialogElement) => d.querySelector('.viewer-position')?.textContent;
  const prevButton = (d: HTMLDialogElement) =>
    d.querySelector<HTMLButtonElement>('.viewer-prev') as HTMLButtonElement;
  const nextButton = (d: HTMLDialogElement) =>
    d.querySelector<HTMLButtonElement>('.viewer-next') as HTMLButtonElement;
  const key = (d: HTMLDialogElement, k: string) =>
    d.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

  beforeEach(() => {
    stubDialog();
    acquirePdf.mockClear();
    releasePdf.mockClear();
    pageCount = 1;
  });

  afterEach(() => {
    for (const d of dialogs()) (d as HTMLDialogElement).close();
    document.body.innerHTML = '';
  });

  it('shows no paging for a lone attachment', () => {
    const dialog = openAttachmentViewer(three[0]!);
    expect(dialog.querySelector('.viewer-nav')).toBeNull();
  });

  it('shows where it is in the set', () => {
    const dialog = openPaged(1);
    expect(position(dialog)).toBe('2 of 3');
    expect(dialog.getAttribute('aria-label')).toBe('two');
  });

  it('pages with the buttons and stops at the ends', () => {
    const dialog = openPaged(1);
    nextButton(dialog).click();
    expect(position(dialog)).toBe('3 of 3');
    expect(dialog.getAttribute('aria-label')).toBe('three');
    expect(nextButton(dialog).disabled).toBe(true);
    expect(prevButton(dialog).disabled).toBe(false);

    prevButton(dialog).click();
    prevButton(dialog).click();
    expect(position(dialog)).toBe('1 of 3');
    expect(prevButton(dialog).disabled).toBe(true);
  });

  it('pages with the arrow keys', () => {
    const dialog = openPaged(0);
    key(dialog, 'ArrowRight');
    expect(position(dialog)).toBe('2 of 3');
    key(dialog, 'ArrowLeft');
    expect(position(dialog)).toBe('1 of 3');
    key(dialog, 'ArrowLeft');
    expect(position(dialog)).toBe('1 of 3');
  });

  it('pages with a horizontal swipe, and not with a vertical one', () => {
    const dialog = openPaged(0);
    const body = dialog.querySelector<HTMLElement>('.viewer-body') as HTMLElement;
    const swipe = (dx: number, dy: number) => {
      const start = new Event('touchstart');
      Object.defineProperty(start, 'touches', { value: [{ clientX: 200, clientY: 300 }] });
      body.dispatchEvent(start);
      const end = new Event('touchend');
      Object.defineProperty(end, 'changedTouches', {
        value: [{ clientX: 200 + dx, clientY: 300 + dy }],
      });
      body.dispatchEvent(end);
    };
    swipe(0, -200);
    expect(position(dialog)).toBe('1 of 3');
    swipe(-120, 10);
    expect(position(dialog)).toBe('2 of 3');
    swipe(120, -10);
    expect(position(dialog)).toBe('1 of 3');
  });

  /**
   * The pager is the control about to be used again, so it must not move when the page
   * count or the download link appear or vanish: those sit to its left, and it sits
   * against the close button.
   */
  it('keeps the pager beside the close button, after the items that come and go', () => {
    const dialog = openPaged(0);
    const order = () =>
      [...(dialog.querySelector('.viewer-head')?.children ?? [])].map((c) => c.className);
    expect(order()).toEqual([
      'viewer-name',
      'viewer-meta',
      'link viewer-download',
      'viewer-nav',
      'icon-btn viewer-close',
    ]);
    // The remote image drops its download link; the pager stays where it was.
    nextButton(dialog).click();
    nextButton(dialog).click();
    expect(order()).toEqual(['viewer-name', 'viewer-meta', 'viewer-nav', 'icon-btn viewer-close']);
  });

  it('swaps the content and the download link as it pages', () => {
    const dialog = openPaged(0);
    expect(dialog.querySelector('img.viewer-image')).not.toBeNull();
    expect(dialog.querySelector('a.viewer-download')?.getAttribute('download')).toBe('one.png');

    nextButton(dialog).click();
    expect(dialog.querySelector('img.viewer-image')).toBeNull();
    expect(dialog.querySelector('.viewer-pages')).not.toBeNull();
    expect(dialog.querySelector('a.viewer-download')?.getAttribute('download')).toBe('two.pdf');

    // The remote image has no download to offer.
    nextButton(dialog).click();
    expect(dialog.querySelector('a.viewer-download')).toBeNull();
  });

  it('releases a PDF when paging away from it', async () => {
    const dialog = openPaged(1);
    await settle();
    expect(acquirePdf).toHaveBeenCalledWith('/api/notes/n/files/two.pdf');
    expect(releasePdf).not.toHaveBeenCalled();
    nextButton(dialog).click();
    expect(releasePdf).toHaveBeenCalledWith('/api/notes/n/files/two.pdf');
  });

  it('falls back to the lone attachment when it is not in the set', () => {
    const dialog = openAttachmentViewer(
      { kind: 'image', src: '/api/notes/n/files/elsewhere.png', alt: '' },
      three,
    );
    expect(dialog.querySelector('.viewer-nav')).toBeNull();
    expect(dialog.getAttribute('aria-label')).toBe('elsewhere.png');
  });
});

describe('downloadUrl', () => {
  it('asks the API to save rather than show', () => {
    expect(downloadUrl('/api/n/files/x.pdf')).toBe('/api/n/files/x.pdf?download=1');
    expect(downloadUrl('/api/n/files/x.pdf?v=2')).toBe('/api/n/files/x.pdf?v=2&download=1');
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
