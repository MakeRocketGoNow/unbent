import { Fragment, useMemo } from 'react';
import { PDF_EMBED_CLASS, renderMarkdown } from '@unbent/shared';
import { usePdfAttachments } from '../usePdfAttachments.js';
import { PdfPreview } from './PdfPreview.js';

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
    <div className="preview">
      {segments.map((seg, i) => (
        <Fragment key={i}>
          {seg.html && <div dangerouslySetInnerHTML={{ __html: seg.html }} />}
          {seg.pdf && <PdfPreview src={seg.pdf.src} label={seg.pdf.label} />}
        </Fragment>
      ))}
    </div>
  );
}
