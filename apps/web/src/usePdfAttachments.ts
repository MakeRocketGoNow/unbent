import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { attachmentsQuery } from './queries.js';

/**
 * Which of a note's files are PDFs, according to the type stored on the attachment row.
 *
 * Both renderers decide whether to draw an inline document viewer by the `.pdf` on the end
 * of a link's path. That is right for anything uploaded through the editor, where the name
 * came off a real file, and wrong for an import: Evernote's `<file-name>` is a display
 * label, so a real export carries PDFs called `Menu Card`. The attachment row records
 * the declared content type, which is the only thing that knows better.
 *
 * A hook rather than a filter written out at each call site, because the rich editor and
 * the preview pane must agree — a note that renders as a document in one and a bare link
 * in the other is the bug this exists to prevent. React Query dedupes the fetch, so asking
 * from both panes of one note costs a single request.
 *
 * Empty until the list arrives. A miss is a link drawn as a link, which is what happened
 * before this existed; the viewer appears when the answer does.
 */
export function usePdfAttachments(noteId: string): ReadonlySet<string> {
  const { data: files } = useQuery(attachmentsQuery(noteId));

  return useMemo(
    () =>
      new Set(
        (files ?? [])
          .filter((f) => f.contentType === 'application/pdf')
          .map((f) => f.filename),
      ),
    [files],
  );
}
