import { acquirePdf, releasePdf } from './pdf/render.js';
import { chevronLeftMarkup, chevronRightMarkup, closeIconMarkup } from './components/icons.js';

/**
 * An attachment shown on its own, at the size of the screen.
 *
 * The inline renderings are sized for reading *around*: a page rasterized at 420–520px
 * so a note carrying nine scans is still a note. This is for reading *the thing itself*.
 * Most of a real Evernote export is scanned paper, and at inline width the line items on
 * a receipt are seven pixels tall — the point of opening it is to read them.
 *
 * Built without React, on purpose. It is called from the preview pane, which is React,
 * and from the rich editor's widgets, which are plain DOM inside CodeMirror and cannot
 * mount a component. One implementation reachable from both is what keeps the two modes
 * agreeing on what opening an attachment does — the same reason `usePdfAttachments` is
 * one hook rather than two filters. `pdf/render.ts` makes the same choice for the same
 * callers.
 *
 * A `<dialog>` opened with `showModal()`, like `Sheet`: the top layer, the inertness of
 * the page behind, the scrim, Escape, the back gesture and the return of focus to the
 * control that opened it are all the platform's. What is left is the shape, which is the
 * whole screen.
 *
 * Not the browser's own viewer. Attachment responses carry `Content-Security-Policy:
 * sandbox`, under which the built-in PDF viewer refuses to render and the browser saves
 * the file instead — so a link to the PDF is a download, not a way to read it. The
 * Android app's WebView has no second window to open one in at all. Rasterizing here,
 * with the document already parsed for the inline preview, works in both places.
 */
export type ViewerTarget =
  | { kind: 'image'; src: string; alt: string }
  | { kind: 'pdf'; src: string; label: string };

/**
 * Widest a page is rasterized at, in CSS pixels.
 *
 * A letter page at this width, drawn at 2× on a retina screen, resolves body text and the
 * small print under it. Wider costs memory faster than it gains legibility — the same
 * reasoning as the 2× cap in `renderPage` — and a page that is wider than the screen is
 * scaled down by CSS anyway.
 */
const MAX_PAGE_WIDTH = 1200;

/**
 * The one viewer open at a time, so a second open replaces the first rather than stacking
 * two modal dialogs the user has to close in turn.
 */
let current: HTMLDialogElement | null = null;

/**
 * How long after opening a click inside the viewer is ignored, in milliseconds.
 *
 * The viewer opens synchronously on the click that asked for it, so the second click of
 * a double-click lands inside the dialog at the same spot on the screen — on the image,
 * where it would jump to actual size, or beside it, where it would close what had only
 * just opened. People who double-click out of habit saw it flash and vanish. Longer than
 * the platform's double-click interval, which is 500ms on most systems, and short enough
 * that a deliberate second click after looking is never swallowed.
 */
const OPENING_GRACE_MS = 600;

/** The last segment of a URL's path, decoded — the stored filename, for an attachment. */
function filenameOf(src: string): string {
  const path = src.split('?')[0] ?? '';
  const name = path.slice(path.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/** The label for an attachment whose markdown gave it none: its filename, decoded. */
export function labelFor(target: ViewerTarget): string {
  const given = target.kind === 'image' ? target.alt : target.label;
  if (given.trim()) return given.trim();
  return filenameOf(target.src) || 'Attachment';
}

/**
 * Whether the URL is one of this note's stored files, served by the API.
 *
 * A rich-mode image can also be a remote one — a web clip's picture at its own address.
 * The API's `?download=1` means nothing to another host, and a browser ignores the
 * `download` attribute across origins, so a Download link for one would open the picture
 * in a tab and call it a download. Better no link than a lying one.
 */
function isAttachment(src: string): boolean {
  return src.startsWith('/api/notes/');
}

/**
 * The attachment's URL in the form that saves the file.
 *
 * The API serves an attachment inline unless asked otherwise, and `?download=1` is the
 * ask — the same form the Attachments panel links to. A plain link rather than a fetch:
 * it middle-clicks, it copies, and the Android app's WebView hands it to the platform's
 * download manager with the session attached, which is how that app downloads anything.
 */
export function downloadUrl(src: string): string {
  return `${src}${src.includes('?') ? '&' : '?'}download=1`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string) {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

/**
 * A horizontal swipe has to travel this far, in CSS pixels, to turn a page.
 *
 * Long enough that a thumb settling on the screen is not a page turn; short enough that
 * the gesture people know from every photo viewer works without being exaggerated.
 */
const SWIPE_MIN_PX = 60;

/**
 * Opens the viewer on one attachment, with the others it can page to.
 *
 * `siblings` is every attachment the note shows, in reading order, and `target` is one of
 * them; a caller with only the one passes nothing and gets no paging. A paperless-office
 * note is often several scans of one thing — the receipts from a trip, a form scanned as
 * three pictures — and closing, scrolling and reopening between them is the friction a
 * viewer exists to remove. Keep and legacy Evernote both page across a note's images.
 *
 * The set is what the *body* renders, not the Attachments panel's list: that list carries
 * files the body never references and types the viewer cannot show. Closing removes the
 * dialog; nothing persists.
 */
export function openAttachmentViewer(
  target: ViewerTarget,
  siblings: readonly ViewerTarget[] = [target],
): HTMLDialogElement {
  current?.close();

  // The target is found by URL, which is how the set was built; a caller whose set does
  // not contain it is handed the single-attachment viewer rather than a wrong neighbour.
  let index = siblings.findIndex((s) => s.src === target.src);
  const set = index === -1 ? [target] : siblings;
  if (index === -1) index = 0;
  const paged = set.length > 1;

  const dialog = el('dialog', 'viewer');

  const head = el('div', 'viewer-head');
  const name = el('span', 'viewer-name');
  head.appendChild(name);

  /**
   * The paging controls, only when there is somewhere to page to.
   *
   * Most notes in a real export are a single scan, and arrows beside a count of one read
   * as clutter. Real buttons rather than overlays on the picture's edges: a control that
   * says where it goes, and one a Tab can reach. No wrap-around — a disabled arrow at the
   * end says "this is the last one", where wrapping would silently start over.
   */
  const prev = el('button', 'icon-btn viewer-prev');
  const next = el('button', 'icon-btn viewer-next');
  const position = el('span', 'viewer-position');
  if (paged) {
    const nav = el('span', 'viewer-nav');
    prev.type = 'button';
    prev.setAttribute('aria-label', 'Previous attachment');
    prev.innerHTML = chevronLeftMarkup();
    next.type = 'button';
    next.setAttribute('aria-label', 'Next attachment');
    next.innerHTML = chevronRightMarkup();
    nav.appendChild(prev);
    nav.appendChild(position);
    nav.appendChild(next);
    head.appendChild(nav);
  }

  const meta = el('span', 'viewer-meta');
  head.appendChild(meta);
  // Once per view rather than on every inline attachment: saving is the rarer action,
  // and a second control on every picture's corner would turn a note of photographs
  // into a note of buttons. Here it is the natural next step after looking.
  const download = el('a', 'link viewer-download');
  download.textContent = 'Download';
  const close = el('button', 'icon-btn viewer-close');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  close.innerHTML = closeIconMarkup();
  head.appendChild(close);

  /**
   * The scrollable area, and the thing that takes focus when the viewer opens.
   *
   * `showModal()` would focus the close button, which is the first focusable thing. Focus
   * here instead so the arrow keys, Space and Page Down scroll the pages straight away —
   * the reason the viewer was opened — and the close button is one Tab away rather than
   * in the way. Programmatic focus draws no ring; a keyboard user who tabs to it will.
   */
  const body = el('div', 'viewer-body');
  body.tabIndex = -1;

  dialog.appendChild(head);
  dialog.appendChild(body);

  const openedAt = Date.now();
  /** True while the click that opened the viewer may still be echoing — see the grace. */
  const stillOpening = () => Date.now() - openedAt < OPENING_GRACE_MS;

  // The empty space around the content is the backdrop here, since the dialog itself
  // fills the screen: a click on it closes, the way a lightbox's scrim does. A click on
  // the content does not — for an image, that is the zoom toggle.
  body.addEventListener('click', (event) => {
    if (event.target === body && !stillOpening()) dialog.close();
  });
  close.addEventListener('click', () => dialog.close());

  let teardown = () => {};

  /**
   * Shows the attachment at `i`, replacing whatever the body held.
   *
   * The dialog itself stays: paging must not close and reopen it, which would drop the
   * platform's focus return and let the back gesture's state slip. A PDF's document is
   * released before the next attachment is acquired, so a note of nine scans never holds
   * nine parsed documents in the worker at once.
   */
  const show = (i: number) => {
    teardown();
    body.replaceChildren();
    index = i;
    const item = set[i]!;
    const label = labelFor(item);

    dialog.setAttribute('aria-label', label);
    name.textContent = label;
    name.title = label;
    meta.textContent = '';

    // Saved under the stored filename, not the caption: an image's alt text is a
    // description, and a file called "Scan of a sample invoice" with no extension is
    // not what anyone asked for. Only for this note's stored files — see `isAttachment`.
    if (isAttachment(item.src)) {
      download.href = downloadUrl(item.src);
      download.setAttribute('download', filenameOf(item.src));
      head.insertBefore(download, close);
    } else {
      download.remove();
    }

    if (paged) {
      position.textContent = `${i + 1} of ${set.length}`;
      prev.disabled = i === 0;
      next.disabled = i === set.length - 1;
    }

    teardown =
      item.kind === 'image' ? mountImage(body, item, stillOpening) : mountPdf(body, meta, item);
  };

  const step = (by: number) => {
    const to = index + by;
    if (to < 0 || to >= set.length) return;
    show(to);
    body.scrollTo(0, 0);
  };

  if (paged) {
    prev.addEventListener('click', () => step(-1));
    next.addEventListener('click', () => step(1));

    /**
     * Left and right page; up and down still scroll. Not while the body scrolls
     * sideways — an image at actual size is panned with the arrow keys, and stealing
     * them there would trade a pan for a page turn nobody asked for.
     */
    dialog.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      if (body.scrollWidth > body.clientWidth) return;
      event.preventDefault();
      step(event.key === 'ArrowLeft' ? -1 : 1);
    });

    /**
     * A horizontal swipe pages, the gesture every photo viewer has taught. Judged on the
     * whole gesture rather than as it goes, so a vertical scroll through a PDF is never
     * mistaken for it, and only while the body has no sideways scroll of its own, for the
     * same reason as the arrow keys.
     */
    let touchStart: { x: number; y: number } | null = null;
    body.addEventListener(
      'touchstart',
      (event) => {
        const t = event.touches[0];
        touchStart = t && event.touches.length === 1 ? { x: t.clientX, y: t.clientY } : null;
      },
      { passive: true },
    );
    body.addEventListener(
      'touchend',
      (event) => {
        const start = touchStart;
        touchStart = null;
        const t = event.changedTouches[0];
        if (!start || !t || body.scrollWidth > body.clientWidth) return;
        const dx = t.clientX - start.x;
        const dy = t.clientY - start.y;
        if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy) * 2) return;
        step(dx < 0 ? 1 : -1);
      },
      { passive: true },
    );
  }

  dialog.addEventListener('close', () => {
    teardown();
    dialog.remove();
    if (current === dialog) current = null;
  });

  show(index);
  document.body.appendChild(dialog);
  current = dialog;
  dialog.showModal();
  body.focus();
  return dialog;
}

/**
 * An image, fitted to the screen, with a click to see it at its own pixels.
 *
 * Fit is the right first view: it answers "what is this" at a glance. The toggle exists
 * for the photo of a form or a whiteboard where the words only resolve at full size, and
 * it is offered only when there is more to see — a small image toggled to "actual size"
 * would not change, and a cursor promising zoom on it would be a lie.
 */
function mountImage(
  body: HTMLElement,
  target: { src: string; alt: string },
  stillOpening: () => boolean,
): () => void {
  const img = el('img', 'viewer-image');
  img.alt = target.alt;

  const status = el('p', 'viewer-status');
  status.textContent = 'Loading…';
  body.appendChild(status);
  body.appendChild(img);

  /** Whether the image has more pixels than the fitted view is showing. */
  const zoomable = () =>
    img.naturalWidth > img.clientWidth + 1 || img.naturalHeight > img.clientHeight + 1;

  img.addEventListener('load', () => {
    status.remove();
    if (zoomable()) img.classList.add('viewer-zoomable');
  });
  img.addEventListener('error', () => {
    status.textContent = "Couldn't load this image.";
  });

  img.addEventListener('click', (event) => {
    if (stillOpening()) return;
    const actual = img.classList.contains('viewer-actual');
    if (!actual && !zoomable()) return;

    // Where under the pointer the click landed, as a fraction of the image, so the same
    // spot is under the pointer after the image grows — zooming into the top-left corner
    // of a page when the click was on its bottom line is the wrong kind of surprise.
    const rect = img.getBoundingClientRect();
    const fx = (event.clientX - rect.left) / rect.width;
    const fy = (event.clientY - rect.top) / rect.height;

    img.classList.toggle('viewer-actual');
    if (actual) {
      body.scrollTo(0, 0);
      return;
    }
    const bodyRect = body.getBoundingClientRect();
    body.scrollTo(
      fx * img.clientWidth - (event.clientX - bodyRect.left),
      fy * img.clientHeight - (event.clientY - bodyRect.top),
    );
  });

  // Set last: a cached image can fire `load` synchronously on assignment in some
  // browsers, and the listener has to be there to hear it.
  img.src = target.src;

  return () => {};
}

/**
 * Every page of a PDF, one under the other, drawn as they come into view.
 *
 * The inline widgets draw one page and stop; here the reader has asked for the document,
 * so every page is laid out at once — but only rasterized as it approaches the viewport,
 * since a forty-page scan opened to check its first line should not cost forty renders.
 * Each undrawn page holds a letter-sized placeholder so the column has its full height
 * from the start and the scrollbar tells the truth about how long the document is.
 *
 * The document comes through `acquirePdf`, so opening the viewer on a PDF the inline
 * preview has already parsed costs no second fetch or parse, and the release on close
 * hands it back rather than destroying it out from under that preview.
 */
function mountPdf(
  body: HTMLElement,
  meta: HTMLElement,
  target: { src: string; label: string },
): () => void {
  const status = el('p', 'viewer-status');
  status.textContent = 'Rendering…';
  const pages = el('div', 'viewer-pages');
  body.appendChild(status);
  body.appendChild(pages);

  let released = false;
  let observer: IntersectionObserver | null = null;

  acquirePdf(target.src)
    .then((doc) => {
      if (released) return;
      status.remove();
      meta.textContent = `${doc.pageCount} page${doc.pageCount === 1 ? '' : 's'}`;

      // Measured once, when the viewer opens. A page rasterized for this width is scaled
      // down by CSS if the window later shrinks, and a window that grows keeps the pages
      // it has rather than redrawing all of them for the extra inches.
      const width = Math.max(1, Math.min(pages.clientWidth, MAX_PAGE_WIDTH));

      const draw = (canvas: HTMLCanvasElement) => {
        const n = Number(canvas.dataset['page']);
        doc.renderPage(n, canvas, width).then(
          () => canvas.classList.add('viewer-page-drawn'),
          () => {
            // One unrenderable page keeps its placeholder rather than blanking the column.
          },
        );
      };

      // Without an observer to wait on (jsdom, an old WebView) every page is drawn at once.
      observer =
        typeof IntersectionObserver === 'undefined'
          ? null
          : new IntersectionObserver(
              (entries) => {
                for (const entry of entries) {
                  if (!entry.isIntersecting) continue;
                  observer?.unobserve(entry.target);
                  draw(entry.target as HTMLCanvasElement);
                }
              },
              // A screen's worth of margin either way, so the next page is drawn while the
              // current one is being read rather than as it arrives.
              { root: body, rootMargin: '100% 0px' },
            );

      for (let n = 1; n <= doc.pageCount; n += 1) {
        const canvas = el('canvas', 'viewer-page');
        canvas.dataset['page'] = String(n);
        canvas.style.width = `${width}px`;
        pages.appendChild(canvas);
        if (observer) observer.observe(canvas);
        else draw(canvas);
      }
    })
    .catch((err: Error) => {
      if (released) return;
      status.textContent = `Couldn't render this PDF. ${err.message}`;
    });

  return () => {
    released = true;
    observer?.disconnect();
    releasePdf(target.src);
  };
}
