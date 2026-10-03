import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { type LoadedPdf, loadPdf } from '../pdf/render.js';
import { downloadUrl, openAttachmentViewer } from '../attachment-viewer.js';
import { NOT_AVAILABLE_OFFLINE, unavailableOffline, whenBackOnline } from '../offline-file.js';
import { Button } from './Button';
import { ExpandIcon } from './icons.js';
import { collectPreviewTargets } from './preview-targets.js';

interface PdfPreviewProps {
  /** Attachment API URL, produced by the markdown pipeline. */
  src: string;
  /** Link text from the markdown, shown as the caption. */
  label: string;
}

/** Width the page is rasterized at; the canvas is scaled down by CSS on narrow panes. */
const RENDER_WIDTH = 520;

/** `unavailable`: offline, and the file is not on this device. Not an error: see `offline-file.ts`. */
type Status = 'idle' | 'loading' | 'ready' | 'error' | 'unavailable';

/**
 * First page of a PDF, rendered inline, with the rest available on request.
 *
 * The first page is the useful default: most notes in a real Evernote export are a single
 * scanned document, so one page is the whole thing. Rendering the rest only when asked
 * keeps a note carrying nine PDFs from rasterizing dozens of pages nobody looked at.
 */
export function PdfPreview({ src, label }: PdfPreviewProps) {
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState(0);
  /** How many pages have been drawn so far. Starts at one; "Show all" raises it. */
  const [shown, setShown] = useState(1);

  /** Bumped to open the document again, once a connection that was missing is back. */
  const [attempt, setAttempt] = useState(0);

  const host = useRef<HTMLDivElement>(null);
  const pdf = useRef<LoadedPdf | null>(null);
  /** Pages already drawn, so a re-render never repaints work that is done. */
  const drawn = useRef(new Set<number>());

  // Open the document once per src, and release the worker's copy on unmount.
  useEffect(() => {
    let cancelled = false;
    let stopWaiting: (() => void) | undefined;
    const controller = new AbortController();

    setStatus('loading');
    setError(null);
    drawn.current = new Set();
    setShown(1);

    loadPdf(src, controller.signal)
      .then((doc) => {
        if (cancelled) {
          doc.destroy();
          return;
        }
        pdf.current = doc;
        setPageCount(doc.pageCount);
        setStatus('ready');
      })
      .catch((err: Error) => {
        if (cancelled || err.name === 'AbortError') return;
        if (unavailableOffline(err)) {
          setStatus('unavailable');
          // Asked for again when the connection returns, by opening the document anew.
          stopWaiting = whenBackOnline(() => setAttempt((n) => n + 1));
          return;
        }
        setError(err.message);
        setStatus('error');
      });

    return () => {
      cancelled = true;
      stopWaiting?.();
      controller.abort();
      pdf.current?.destroy();
      pdf.current = null;
    };
  }, [src, attempt]);

  /**
   * Draws any page that is due but not yet painted.
   *
   * Keyed off a ref rather than state so a repaint of the component never redraws a page:
   * rasterizing is the expensive part, and the canvases persist in the DOM.
   */
  const drawPending = useCallback(async () => {
    const doc = pdf.current;
    const container = host.current;
    if (!doc || !container) return;

    for (let n = 1; n <= Math.min(shown, doc.pageCount); n += 1) {
      if (drawn.current.has(n)) continue;
      const canvas = container.querySelector<HTMLCanvasElement>(`canvas[data-page="${n}"]`);
      if (!canvas) continue;

      drawn.current.add(n);
      try {
        await doc.renderPage(n, canvas, RENDER_WIDTH);
      } catch {
        // One unrenderable page should not blank the pages around it.
        drawn.current.delete(n);
      }
    }
  }, [shown]);

  useEffect(() => {
    if (status === 'ready') void drawPending();
  }, [status, shown, drawPending]);

  const remaining = pageCount - shown;

  /**
   * The full-screen viewer, from the head's button or a click on the page itself.
   *
   * The page is the target people reach for — see `.pdf-preview-canvas` — and the button
   * is the one the keyboard can reach and the one that says what a click would do. The
   * viewer is handed every attachment in the pane, found from the pane this sits in, so
   * it can page to the others.
   */
  const expand = (event: SyntheticEvent<HTMLElement>) =>
    openAttachmentViewer(
      { kind: 'pdf', src, label },
      collectPreviewTargets(event.currentTarget.closest('.preview')),
    );

  return (
    <div className="pdf-preview" data-src={src} data-label={label}>
      <div className="pdf-preview-head">
        <span className="pdf-preview-name">{label}</span>
        <span className="pdf-preview-actions">
          {status === 'ready' && pageCount > 1 && (
            <span className="muted small">
              {shown === pageCount ? `${pageCount} pages` : `Page 1 of ${pageCount}`}
            </span>
          )}
          {status === 'ready' && remaining > 0 && (
            <Button variant="quiet" size="small" onClick={() => setShown(pageCount)}>
              Show all {pageCount} pages
            </Button>
          )}
          {/*
              This said "Open" and pointed at the inline URL, on the theory that the
              browser's own viewer had search and print. It never did here: attachment
              responses carry a sandbox CSP, under which Chrome refuses to render a PDF
              and saves it instead. So it was a download wearing another name. Now it
              says what it does, and the full-screen viewer is the way to read the file.
          */}
          <a href={downloadUrl(src)} download={label} className="link small">
            Download
          </a>
          {status === 'ready' && (
            <button
              type="button"
              className="icon-btn pdf-preview-expand"
              aria-label="Full screen"
              title="Full screen"
              onClick={expand}
            >
              <ExpandIcon />
            </button>
          )}
        </span>
      </div>

      {status === 'loading' && <p className="muted small">Rendering…</p>}
      {status === 'error' && <p className="bad small">Couldn't render this PDF. {error}</p>}
      {status === 'unavailable' && <p className="file-unavailable">{NOT_AVAILABLE_OFFLINE}</p>}

      <div className="pdf-preview-pages" ref={host}>
        {status === 'ready' &&
          Array.from({ length: Math.min(shown, pageCount) }, (_, i) => (
            <canvas
              key={i + 1}
              data-page={i + 1}
              className="pdf-preview-canvas"
              onClick={expand}
            />
          ))}
      </div>
    </div>
  );
}
