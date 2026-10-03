import { Fragment, useMemo, type MouseEvent, type SyntheticEvent } from 'react';
import { IMAGE_ZOOM_CLASS, PDF_EMBED_CLASS, renderMarkdown } from '@unbent/shared';
import { usePdfAttachments } from '../usePdfAttachments.js';
import { openAttachmentViewer } from '../attachment-viewer.js';
import { standInForImage } from '../offline-file.js';
import { PdfPreview } from './PdfPreview.js';
import { collectPreviewTargets } from './preview-targets.js';

interface PreviewProps {
  markdown: string;
  noteId: string;
}

/** One PDF viewer pulled out of the rendered HTML, with the HTML that preceded it. */
interface Segment {
  html: string;
  pdf?: { src: string; label: string };
}

/**
 * Splits rendered HTML at each marked PDF link.
 *
 * Done on the string rather than by mutating the DOM afterwards: the container's content is
 * owned by `dangerouslySetInnerHTML`, so nodes swapped in by an effect are discarded the
 * next time React re-renders it. Slicing here means React renders the viewers itself and
 * they survive as ordinary children.
 *
 * The anchors this matches are produced by the shared pipeline after sanitization, so their
 * attributes are already trusted — note content cannot forge one.
 */
function splitOnPdfLinks(html: string): Segment[] {
  const anchor = new RegExp(`<a[^>]*class="[^"]*${PDF_EMBED_CLASS}[^"]*"[^>]*>(.*?)</a>`, 'gis');
  const segments: Segment[] = [];
  let last = 0;

  for (const match of html.matchAll(anchor)) {
    const href = /href="([^"]*)"/i.exec(match[0])?.[1];
    if (!href) continue;

    segments.push({
      html: html.slice(last, match.index),
      pdf: {
        // The pipeline emits real URLs; only `&` is entity-encoded by the stringifier.
        src: href.replace(/&amp;/g, '&'),
        label: (match[1] ?? '').replace(/<[^>]*>/g, '').trim() || 'PDF',
      },
    });
    last = match.index + match[0].length;
  }

  segments.push({ html: html.slice(last) });
  return segments;
}

/**
 * A click on an image opens it in the viewer.
 *
 * Delegated from the pane rather than bound per image: the images are in HTML the pane
 * renders as a string, so there is no element to hand a listener to. The pipeline wrapped
 * each in a link to itself (`rehypeLinkImages`); an ordinary click on that link becomes
 * the viewer, and a modified one — middle, ⌘, ctrl, shift — is left to the browser, which
 * is what those modifiers mean on any link.
 */
function onPreviewClick(event: MouseEvent<HTMLDivElement>) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return;
  }
  const link = (event.target as Element).closest<HTMLAnchorElement>(`a.${IMAGE_ZOOM_CLASS}`);
  if (!link || !event.currentTarget.contains(link)) return;
  const img = link.querySelector('img');
  const src = link.getAttribute('href');
  if (!src) return;

  event.preventDefault();
  openAttachmentViewer(
    { kind: 'image', src, alt: img?.alt ?? '' },
    collectPreviewTargets(event.currentTarget),
  );
}

/**
 * A picture in the pane that failed to load with no connection says so in a line, where a
 * broken-image icon would be, and is asked for again when the connection returns.
 *
 * On the capture phase, because `error` does not bubble and the images are in HTML the
 * pane renders as a string — the same reason the click above is delegated. A picture that
 * failed for any other reason is left as the browser draws it, as before.
 */
function onPreviewImageError(event: SyntheticEvent<HTMLDivElement>) {
  const img = event.target;
  if (!(img instanceof HTMLImageElement) || img.hidden) return;
  standInForImage(img, img.alt);
}

/**
 * Rendered markdown. The HTML is produced by the shared pipeline, which runs
 * rehype-sanitize — dangerouslySetInnerHTML is safe here only because of that, so the two
 * must never be separated.
 *
 * PDF attachment links become inline viewers. They are React children rather than markup in
 * the HTML string, because the sanitizer must keep rejecting embed elements from note
 * content: the only way a viewer appears is if this component puts one there.
 */
export function Preview({ markdown, noteId }: PreviewProps) {
  // Shared with the rich editor, so the two panes agree on what is a document.
  const pdfFilenames = usePdfAttachments(noteId);

  const segments = useMemo(
    () => splitOnPdfLinks(renderMarkdown(markdown, { noteId, pdfFilenames })),
    [markdown, noteId, pdfFilenames],
  );

  return (
    <div className="preview" onClick={onPreviewClick} onErrorCapture={onPreviewImageError}>
      {segments.map((seg, i) => (
        <Fragment key={i}>
          {seg.html && <div dangerouslySetInnerHTML={{ __html: seg.html }} />}
          {seg.pdf && <PdfPreview src={seg.pdf.src} label={seg.pdf.label} />}
        </Fragment>
      ))}
    </div>
  );
}
