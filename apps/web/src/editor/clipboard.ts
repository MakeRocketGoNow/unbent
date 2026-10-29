import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  ATTACHMENT_PREFIX,
  attachmentUrl,
  mayHoldAbsoluteAttachmentLink,
  parseAbsoluteAttachmentUrl,
  relativeAttachmentPath,
} from '@unbent/shared';
import { decodePath, linksWithin, type DocumentLink } from './links.js';

/**
 * Attachment links across the clipboard.
 *
 * The editor is raw markdown, so copying a selection copies literally `![x](files/x.png)`,
 * a path that means something only inside this note. Pasted into another note it
 * resolved against that note's files and 404ed, silently, which read as the app losing
 * a picture. The Evernote habit this stands in for is cut in one note, paste in another,
 * and the file goes with the text.
 *
 * Two halves. On copy or cut, every same-note link in the selection is rewritten to its
 * absolute form, `/api/notes/<id>/files/<name>` with the origin in front, so the text
 * says which note's file it means: pasted back into Unbent it can be resolved, and
 * pasted anywhere else it is a real link. On paste, links that name another of the
 * user's notes are copied across on the server and rewritten to `files/…` under the
 * name the file got here. The bytes never pass through the browser: a scan is tens of
 * megabytes, and an R2 copy is one request.
 *
 * Why the clipboard carries text and not the bytes: a page can write only a handful of
 * types to the system clipboard (plain text, HTML, PNG), and a PDF is not one of them in
 * any browser. A self-describing link works for every kind of file and is faster besides.
 *
 * The links are found in the document's syntax tree, never by parsing the copied or
 * pasted text on its own (`links.ts` says why): a selection is rewritten where it lies
 * in the note, and pasted text is inserted first and read back from where it landed.
 *
 * Only the text form is touched. CodeMirror's own copy handler is left in charge of the
 * cases with nothing to rewrite: an empty selection copies the whole line, and the
 * handlers here decline those so that behaviour is not reimplemented.
 */
export interface ClipboardConfig {
  /** The note this editor holds; what a copied link names, and what a paste compares against. */
  noteId: string;
  /** Prepended to copied links so they are URLs outside the app. `location.origin` in a browser. */
  origin?: string;
  /**
   * Copies files from another note into this one. Resolves to the name each file got
   * here, by the name asked for. Absent (a read-only note), foreign links are left
   * absolute, which still open for the owner.
   */
  copyFrom?: (from: string, filenames: string[], move: boolean) => Promise<Map<string, string>>;
}

/**
 * A private clipboard flavour that marks text as cut rather than copied.
 *
 * The distinction is what makes cut-and-paste a move. It travels as a custom
 * `DataTransfer` type, which browsers keep alongside the text within the same browser
 * and drop everywhere else, so a paste from another app can only ever copy, which is
 * the safe reading of text whose provenance is unknown.
 */
export const CUT_FLAVOUR = 'application/x-unbent-cut';

export function attachmentClipboard(config: ClipboardConfig): Extension {
  return EditorView.domEventHandlers({
    copy(event, view) {
      return exportSelection(event, view, config, false);
    },
    cut(event, view) {
      if (!exportSelection(event, view, config, true)) return false;
      // The part of a cut the browser would have done had the event not been claimed.
      view.dispatch(view.state.replaceSelection(''), {
        scrollIntoView: true,
        userEvent: 'delete.cut',
      });
      return true;
    },
    paste(event, view) {
      const data = event.clipboardData;
      if (!data) return false;
      // Files alongside the text are the upload handler's, unless the text links a note's
      // file: the panel's copy of a picture carries both, and the link is the one to use.
      // Whether the text does is known for sure only once it is in the document (an
      // address in a code block is not a link), so this claims on the address's shape and
      // a paste that turns out to hold no link is a plain paste that cost a tree walk.
      const text = data.getData('text/plain');
      if (!text || !mayHoldAbsoluteAttachmentLink(text)) return false;
      event.preventDefault();
      void pasteWithAttachments(view, text, data.getData(CUT_FLAVOUR) === '1', config);
      return true;
    },
  });
}

/** A link in the document that names a note's file by its absolute address. */
interface AbsoluteLink extends DocumentLink {
  noteId: string;
  filename: string;
}

/** The absolute attachment links lying whole within `ranges`. */
function absoluteLinksWithin(
  view: EditorView,
  ranges: readonly { from: number; to: number }[],
): AbsoluteLink[] {
  const links: AbsoluteLink[] = [];
  for (const link of linksWithin(view.state, ranges)) {
    const ref = parseAbsoluteAttachmentUrl(link.url);
    if (ref) links.push({ ...link, ...ref });
  }
  return links;
}

/**
 * Puts the selection on the clipboard with its attachment links made absolute.
 *
 * Returns false, leaving the event to CodeMirror, whenever there is nothing to rewrite:
 * the selection is empty, or holds no attachment link. The ranges are joined the way
 * CodeMirror joins them, so a multi-cursor copy reads the same either way.
 */
function exportSelection(
  event: ClipboardEvent,
  view: EditorView,
  config: ClipboardConfig,
  cut: boolean,
): boolean {
  const data = event.clipboardData;
  if (!data) return false;
  const { state } = view;
  const ranges = state.selection.ranges.filter((range) => !range.empty);
  if (ranges.length === 0) return false;
  // The walk is spared for the common copy of prose: every same-note link spells
  // `files/` in its destination.
  if (!ranges.some((range) => state.sliceDoc(range.from, range.to).includes(ATTACHMENT_PREFIX))) return false;

  const links = linksWithin(state, ranges).filter((link) => link.url.startsWith(ATTACHMENT_PREFIX));
  if (links.length === 0) return false;

  const text = ranges
    .map((range) => {
      let out = '';
      let last = range.from;
      for (const link of links) {
        if (link.from < range.from || link.to > range.to) continue; // another range's
        const filename = decodePath(link.url.slice(ATTACHMENT_PREFIX.length));
        out += state.sliceDoc(last, link.urlFrom) + attachmentUrl(config.noteId, filename, config.origin);
        last = link.urlTo;
      }
      return out + state.sliceDoc(last, range.to);
    })
    .join(state.lineBreak);

  event.preventDefault();
  data.setData('text/plain', text);
  if (cut) data.setData(CUT_FLAVOUR, '1');
  return true;
}

/**
 * Inserts pasted text, then brings its foreign files across.
 *
 * The text goes in at once, links still absolute, so the paste feels instant and the
 * copies happen behind it; each link is rewritten in place when its file lands. Links
 * that already name this note need no copy (text cut from here and pasted back), and
 * go in relative straight away.
 *
 * A copy that fails leaves its links absolute. They still open for the owner, and the
 * Attachments panel simply does not list them: the honest state, rather than a
 * `files/…` link to a file that is not here.
 */
async function pasteWithAttachments(
  view: EditorView,
  text: string,
  cut: boolean,
  config: ClipboardConfig,
): Promise<void> {
  const insertion = view.state.update(view.state.replaceSelection(text), {
    scrollIntoView: true,
    userEvent: 'input.paste',
  });
  const inserted: Array<{ from: number; to: number }> = [];
  insertion.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => inserted.push({ from: fromB, to: toB }));
  view.dispatch(insertion);

  // Read back from the document, where the text has its context, before anything moves.
  const links = absoluteLinksWithin(view, inserted);
  relink(
    view,
    links.filter((link) => link.noteId === config.noteId),
    (link) => link.filename,
  );

  const { copyFrom } = config;
  if (!copyFrom) return;

  const bySource = new Map<string, string[]>();
  for (const { noteId, filename } of links) {
    if (noteId === config.noteId) continue;
    const names = bySource.get(noteId) ?? [];
    if (!names.includes(filename)) bySource.set(noteId, [...names, filename]);
  }

  for (const [source, filenames] of bySource) {
    let names: Map<string, string>;
    try {
      names = await copyFrom(source, filenames, cut);
    } catch {
      continue; // left absolute, see above
    }
    // Searched in the current document rather than remembered from the paste: the user
    // has been typing meanwhile, and an undo may have removed the links entirely, in
    // which case there is nothing to do.
    relink(
      view,
      absoluteLinksWithin(view, [{ from: 0, to: view.state.doc.length }]).filter((link) => link.noteId === source),
      (link) => names.get(link.filename) ?? null,
    );
  }
}

/**
 * Rewrites each link's destination to `files/<name>`, by position, in one transaction,
 * for the links `rename` answers a name for. The destination only: a picture inside the
 * label is its own link, with its own change here, and two changes over one span is a
 * transaction CodeMirror refuses.
 */
function relink(view: EditorView, links: AbsoluteLink[], rename: (link: AbsoluteLink) => string | null): void {
  const changes = links.flatMap((link) => {
    const renamed = rename(link);
    if (renamed === null) return [];
    return [{ from: link.urlFrom, to: link.urlTo, insert: relativeAttachmentPath(renamed) }];
  });
  if (changes.length > 0) view.dispatch({ changes });
}
