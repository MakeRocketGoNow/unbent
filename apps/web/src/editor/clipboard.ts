import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  ATTACHMENT_PREFIX,
  absoluteAttachmentRefs,
  absolutizeAttachmentLinks,
  findAbsoluteAttachmentLinks,
  relativeAttachmentLink,
  relativizeAttachmentLinks,
} from '@unbent/shared';

/**
 * Attachment links across the clipboard.
 *
 * The editor is raw markdown, so copying a selection copies literally `![x](files/x.png)`
 * — a path that means something only inside this note. Pasted into another note it
 * resolved against that note's files and 404ed, silently, which read as the app losing
 * a picture. The Evernote habit this stands in for is cut in one note, paste in another,
 * and the file goes with the text.
 *
 * Two halves. On copy or cut, every same-note link in the selection is rewritten to its
 * absolute form, `/api/notes/<id>/files/<name>` with the origin in front, so the text
 * says which note's file it means: pasted back into Unbent it can be resolved, and
 * pasted anywhere else it is a real link. On paste, links that name another of the
 * user's notes are copied across on the server and rewritten to `files/…` under the
 * name the file got here. The bytes never pass through the browser — a scan is tens of
 * megabytes, and an R2 copy is one request.
 *
 * Why the clipboard carries text and not the bytes: a page can write only a handful of
 * types to the system clipboard (plain text, HTML, PNG), and a PDF is not one of them in
 * any browser. A self-describing link works for every kind of file and is faster besides.
 *
 * Only the text form is touched. CodeMirror's own copy handler is left in charge of the
 * cases with nothing to rewrite — an empty selection copies the whole line, and the
 * handlers here decline those so that behaviour is not reimplemented.
 */
export interface ClipboardConfig {
  /** The note this editor holds; what a copied link names, and what a paste compares against. */
  noteId: string;
  /** Prepended to copied links so they are URLs outside the app. `location.origin` in a browser. */
  origin?: string;
  /**
   * Copies files from another note into this one. Resolves to the name each file got
   * here, by the name asked for. Absent — a read-only note — foreign links are left
   * absolute, which still open for the owner.
   */
  copyFrom?: (from: string, filenames: string[], move: boolean) => Promise<Map<string, string>>;
}

/**
 * A private clipboard flavour that marks text as cut rather than copied.
 *
 * The distinction is what makes cut-and-paste a move. It travels as a custom
 * `DataTransfer` type, which browsers keep alongside the text within the same browser
 * and drop everywhere else — so a paste from another app can only ever copy, which is
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
      // file — the panel's copy of a picture carries both, and the link is the one to use.
      const text = data.getData('text/plain');
      if (!text || findAbsoluteAttachmentLinks(text).length === 0) return false;
      event.preventDefault();
      void pasteWithAttachments(view, text, data.getData(CUT_FLAVOUR) === '1', config);
      return true;
    },
  });
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

  const text = ranges.map((range) => state.sliceDoc(range.from, range.to)).join(state.lineBreak);
  if (!text.includes(ATTACHMENT_PREFIX)) return false;
  const absolute = absolutizeAttachmentLinks(text, { noteId: config.noteId, origin: config.origin });
  if (absolute === text) return false;

  event.preventDefault();
  data.setData('text/plain', absolute);
  if (cut) data.setData(CUT_FLAVOUR, '1');
  return true;
}

/**
 * Inserts pasted text, then brings its foreign files across.
 *
 * The text goes in at once, links still absolute, so the paste feels instant and the
 * copies happen behind it; each link is rewritten in place when its file lands. Links
 * that already name this note need no copy — text cut from here and pasted back — and
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
  const own = relativizeAttachmentLinks(text, (ref) =>
    ref.noteId === config.noteId ? ref.filename : null,
  );
  view.dispatch(view.state.replaceSelection(own), {
    scrollIntoView: true,
    userEvent: 'input.paste',
  });

  const { copyFrom } = config;
  if (!copyFrom) return;

  const bySource = new Map<string, string[]>();
  for (const { noteId, filename } of absoluteAttachmentRefs(own)) {
    if (noteId === config.noteId) continue;
    bySource.set(noteId, [...(bySource.get(noteId) ?? []), filename]);
  }

  for (const [source, filenames] of bySource) {
    let names: Map<string, string>;
    try {
      names = await copyFrom(source, filenames, cut);
    } catch {
      continue; // left absolute, see above
    }
    relinkCopied(view, source, names);
  }
}

/**
 * Rewrites every link to `source`'s files that now exist here, by position, in one
 * transaction. Searched in the current document rather than remembered from the paste:
 * the user has been typing meanwhile, and an undo may have removed the links entirely,
 * in which case there is nothing to do.
 */
function relinkCopied(view: EditorView, source: string, names: Map<string, string>) {
  const changes = findAbsoluteAttachmentLinks(view.state.doc.toString()).flatMap((link) => {
    const renamed = link.noteId === source ? names.get(link.filename) : undefined;
    if (renamed === undefined) return [];
    return [{ from: link.from, to: link.to, insert: relativeAttachmentLink(link, renamed) }];
  });
  if (changes.length > 0) view.dispatch({ changes });
}
