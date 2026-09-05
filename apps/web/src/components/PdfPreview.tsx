import { useCallback, useEffect, useRef, useState } from 'react';
import { type LoadedPdf, loadPdf } from '../pdf/render.js';
import { Button } from './Button';

interface PdfPreviewProps {
  /** Attachment API URL, produced by the markdown pipeline. */
  src: string;
  /** Link text from the markdown, shown as the caption. */
  label: string;
}

/** Width the page is rasterized at; the canvas is scaled down by CSS on narrow panes. */
const RENDER_WIDTH = 520;

type Status = 'idle' | 'loading' | 'ready' | 'error';

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

  const host = useRef<HTMLDivElement>(null);
  const pdf = useRef<LoadedPdf | null>(null);
  /** Pages already drawn, so a re-render never repaints work that is done. */
  const drawn = useRef(new Set<number>());

  // Open the document once per src, and release the worker's copy on unmount.
  useEffect(() => {
    let cancelled = false;
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
        setError(err.message);
        setStatus('error');
      });

    return () => {
      cancelled = true;
      controller.abort();
      pdf.current?.destroy();
      pdf.current = null;
    };
  }, [src]);

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

  return (
    <div className="pdf-preview">
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
          {/* Always available: the browser's own viewer has search and print. */}
          <a href={src} target="_blank" rel="noreferrer noopener" className="link small">
            Open
          </a>
        </span>
      </div>

      {status === 'loading' && <p className="muted small">Rendering…</p>}
      {status === 'error' && <p className="bad small">Couldn't render this PDF. {error}</p>}

      <div className="pdf-preview-pages" ref={host}>
        {status === 'ready' &&
          Array.from({ length: Math.min(shown, pageCount) }, (_, i) => (
            <canvas key={i + 1} data-page={i + 1} className="pdf-preview-canvas" />
          ))}
      </div>
    </div>
  );
}
