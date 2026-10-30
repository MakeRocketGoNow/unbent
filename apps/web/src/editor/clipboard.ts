import { EditorSelection, type EditorState, type Extension, type Text } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  ATTACHMENT_PREFIX,
  attachmentUrl,
  mayHoldAbsoluteAttachmentLink,
  parseAbsoluteAttachmentUrl,
  relativeAttachmentPath,
} from '@unbent/shared';
import { attachmentFilenameOf, linksWithin, treeThrough, type DocumentLink, type SyntaxNode } from './links.js';

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
  /**
   * The editor to write into once `copyFrom` answers: the one open then, which may not
   * be the one the text was pasted into, or null for none, when that note is no longer
   * open. `liveViewNow` in `Editor.tsx` says why an extension needs this at all. Absent,
   * the view the text was pasted into.
   */
  liveView?: () => EditorView | null;
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
      if (text && mayHoldAbsoluteAttachmentLink(text)) {
        event.preventDefault();
        void pasteWithAttachments(view, text, data.getData(CUT_FLAVOUR) === '1', config);
        return true;
      }
      // Asked second, so nothing that carries a note's file ever reaches the converter.
      return pasteHtml(event, view, data, config);
    },
  });
}

/**
 * A paste from a web page (or a mail, or a document) as Markdown rather than flat text.
 *
 * The clipboard carries the selection twice: `text/plain`, which CodeMirror inserts, and
 * `text/html`. The plain form has already thrown away what made the page readable: the
 * headings arrive as lines, the links as their words with nowhere to go, a list as lines
 * with no bullets. The HTML still has them, and `htmlToMarkdown` (the converter the ENEX
 * import and the web clipper share) writes them as the Markdown a person would have typed,
 * so the paste stays an ordinary text edit, undone with one ⌘Z.
 *
 * The plain text is still there for whoever wants it: every browser's "Paste and Match
 * Style" (⌘⇧V, Ctrl+Shift+V) sends no `text/html` at all, so it reaches CodeMirror's own
 * paste untouched. That is the way to paste plain, and the reason there is no setting.
 *
 * Declines, leaving the paste to CodeMirror, whenever converting would not help:
 *
 * - The note is read-only. CodeMirror's own handler is the one that respects that, and
 *   these handlers run before it.
 * - The paste is Unbent's own: text cut from a note (`CUT_FLAVOUR`), or HTML naming a
 *   note's file by its absolute address, as a copy from a rendered note does. Those keep
 *   the path they always had, which knows how to bring a file across; converting would
 *   turn the link into one more web address.
 * - It lands in code; see `inCode`.
 * - The HTML has no structure worth keeping; see `STRUCTURE`.
 *
 * Every one of those is decided here, in the event, because claiming the paste has to be:
 * the browser inserts nothing once the event is claimed, and a handler that answers later
 * cannot unclaim it. The conversion itself is in `paste-html.ts`, loaded on first use, so
 * the HTML is read twice: once here by the browser's own parser, which costs the bundle
 * nothing and answers the questions above, and once there into the tree the converter
 * walks. Parsing twice costs a paste milliseconds; parsing once, here, would put the
 * parser in front of every note's first load.
 *
 * A paste that carries files never gets this far: the upload handler (`attach.ts`) is
 * mounted before this one and takes it. A browser's Copy Image puts the picture's bytes
 * beside an `<img>` naming it, and the bytes are the better copy.
 *
 * Nor does HTML past `MAX_CONVERTED_HTML`, read before anything parses it.
 */
function pasteHtml(event: ClipboardEvent, view: EditorView, data: DataTransfer, config: ClipboardConfig): boolean {
  const { state } = view;
  if (state.readOnly || data.getData(CUT_FLAVOUR)) return false;
  const html = data.getData('text/html');
  if (!html || html.length > MAX_CONVERTED_HTML || !worthConverting(html)) return false;
  if (state.selection.ranges.some((range) => inCode(state, range.from))) return false;

  event.preventDefault();
  void insertConverted(view, html, data.getData('text/plain'), config);
  return true;
}

/**
 * The most clipboard HTML converted. A spreadsheet's copy is a table with inline styles
 * on every cell, and the conversion runs on the page's own thread: measured warm on a
 * desktop in Node, 0.34 s at one megabyte and 2 s at five, for the converter alone, and a
 * phone is several times slower. Past this a frozen page is the worse outcome, and the
 * plain text goes in at once.
 */
const MAX_CONVERTED_HTML = 1_000_000;

/**
 * Converts and inserts, at the selection as it is when the converter answers.
 *
 * That is the selection of the paste in every case but the first paste of a page's life,
 * which waits on the chunk (from the service worker's cache, so milliseconds): any later
 * one waits only a microtask, which no keystroke can come between. A first paste whose
 * chunk cannot be had at all (a page left open across deploys, its build gone from the
 * cache) inserts the plain text, which is what it would have been before this existed:
 * the event is claimed, and nothing at all would be worse.
 *
 * Into the editor open when the converter answers (`liveView`), as every other late write
 * in this file does: flipping between rich and source during that first wait rebuilds the
 * view, and the event being claimed, nothing else would insert the paste. No view at all
 * means the note has closed.
 */
async function insertConverted(view: EditorView, html: string, plain: string, config: ClipboardConfig): Promise<void> {
  let converted: { markdown: string; inline: boolean } | null = null;
  try {
    converted = (await loadConverter()).markdownFromClipboardHtml(html);
  } catch {
    converted = null;
  }
  const target = config.liveView ? config.liveView() : view;
  if (!target) return;
  const { state } = target;
  if (state.readOnly) return;
  const { markdown, inline } = converted ?? { markdown: plain, inline: true };
  if (!markdown) return;
  target.dispatch(
    state.changeByRange((range) => {
      const [lead, tail] = inline ? ['', ''] : apart(state.doc, range.from, range.to);
      const insert = lead + markdown + tail;
      // The cursor ends after the pasted text, as after any paste, and before the break
      // that sets it apart from what followed, so typing on carries on from it.
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.cursor(range.from + lead.length + markdown.length),
      };
    }),
    // One transaction is one undo step, and `input.paste` is what CodeMirror's own paste
    // says, so history never joins it to the typing either side of it.
    { scrollIntoView: true, userEvent: 'input.paste' },
  );
}

let converter: Promise<typeof import('./paste-html.js')> | undefined;

/**
 * The converter's module, imported once. A failed import is forgotten rather than kept,
 * so a paste after the connection comes back tries again. Exported for the tests, which
 * load it up front so that a paste there waits only the microtask a page's later pastes
 * do.
 */
export function loadConverter(): Promise<typeof import('./paste-html.js')> {
  converter ??= import('./paste-html.js').catch((err: unknown) => {
    converter = undefined;
    throw err;
  });
  return converter;
}

/**
 * Elements whose presence makes HTML worth converting, as one selector.
 *
 * Plenty of apps put HTML on the clipboard that carries nothing Markdown can say. A code
 * editor (VS Code) or a terminal writes its text as a `<div>` a line and a `<span>` a
 * colour; converted, each line would become a paragraph and the indentation of every
 * line of code would be lost. HTML with none of these elements is pasted as its plain
 * text, which is what it really is. `a` counts only with an `href`, since an anchor with
 * nowhere to go is text.
 */
const STRUCTURE = [
  'a[href]',
  'img',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'table',
  'blockquote',
  'pre',
  'code',
  'strong',
  'b',
  'em',
  'i',
  'del',
  's',
  'hr',
].join(', ');

/**
 * Whether the HTML has structure (`STRUCTURE`) and names no note's file.
 *
 * Read with the browser's `DOMParser`, whose documents are inert: no script in the
 * pasted HTML runs and no picture in it is fetched. The attachment check reads each
 * address as written, so a copy from a rendered note is recognised whichever origin it
 * was copied on.
 */
function worthConverting(html: string): boolean {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  if (!doc.querySelector(STRUCTURE)) return false;
  for (const element of doc.querySelectorAll('[href], [src]')) {
    for (const name of ['href', 'src']) {
      const address = element.getAttribute(name);
      if (address && parseAbsoluteAttachmentUrl(address)) return false;
    }
  }
  return true;
}

/**
 * The line breaks a block paste needs between `from` and `to` to stand apart from what is
 * around it. The rule `apart` in `attach.ts` has for a dropped file, for the same reason:
 * Markdown reads a line written straight under a paragraph, a quote or a list item as
 * more of it, so a heading pasted after a word is not a heading, and a paragraph pasted
 * under a list joins its last item. Only what is missing goes in, so no blank line is
 * doubled.
 *
 * Unlike a dropped file, nothing goes after a paste that ends the note: a paste leaves
 * the cursor where the text ends, with no empty line after it that nobody typed.
 */
function apart(doc: Text, from: number, to: number): [string, string] {
  const first = doc.lineAt(from);
  const last = doc.lineAt(to);
  const blank = (n: number) => doc.line(n).text.trim() === '';
  const lead = from > first.from ? '\n\n' : first.number === 1 || blank(first.number - 1) ? '' : '\n';
  const tail = to < last.to ? '\n\n' : last.number === doc.lines || blank(last.number + 1) ? '' : '\n';
  return [lead, tail];
}

/** Code, where a paste is the characters and never a conversion. */
const CODE_NODES = new Set(['FencedCode', 'CodeBlock', 'InlineCode']);

/**
 * Whether `pos` is inside code: a fenced or indented block, or an inline span.
 *
 * Inside code the person wants the characters they copied, and Markdown there is not
 * Markdown: a snippet copied from a documentation page carries `<pre>` and `<code>`, and
 * converted it would arrive fenced inside the fence. Read from the editor's own tree, as
 * everything here is (`links.ts` says why), and the tree is parsed through the cursor so
 * a paste far down a long note cannot be read against a tree that stops short of it.
 *
 * The edges are the subtle part. Just inside the opening backtick or fence is inside.
 * Exactly at a node's end is inside only where typing there would still be code: at the
 * end of an indented block's last line, or anywhere in a fence that is never closed (it
 * runs to the end of the note). After a closing fence or a closing backtick it is not.
 */
function inCode(state: EditorState, pos: number): boolean {
  const tree = treeThrough(state, pos);
  for (let node: SyntaxNode | null = tree.resolveInner(pos, -1); node; node = node.parent) {
    if (!CODE_NODES.has(node.name) || node.from >= pos) continue;
    if (pos < node.to) return true;
    if (node.name === 'CodeBlock') return true;
    // A closed fence has a second `CodeMark`, its closing one; an inline span is only
    // ever a node once it is closed.
    if (node.name === 'FencedCode') return node.getChildren('CodeMark').length < 2;
    return false;
  }
  return false;
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
  // `files` in its destination (the slash after it may be escaped, `files\/a.pdf`,
  // which the tree reads as the plain one).
  if (!ranges.some((range) => state.sliceDoc(range.from, range.to).includes(ATTACHMENT_PREFIX.slice(0, -1)))) return false;

  const links = linksWithin(state, ranges).filter((link) => attachmentFilenameOf(link) !== null);
  if (links.length === 0) return false;

  const text = ranges
    .map((range) => {
      let out = '';
      let last = range.from;
      for (const link of links) {
        if (link.from < range.from || link.to > range.to) continue; // another range's
        out += state.sliceDoc(last, link.urlFrom) + attachmentUrl(config.noteId, attachmentFilenameOf(link)!, config.origin);
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
    // Searched in the current document of the editor open now (`liveView`) rather than
    // remembered from the paste: the user has been typing meanwhile, the editor may have
    // been rebuilt with the document carried across, and an undo may have removed the
    // links entirely, in which case there is nothing to do. No editor open for the note
    // (null) is nothing to do as well: the pasted-into view is gone then.
    const live = config.liveView ? config.liveView() : view;
    if (!live) continue;
    relink(
      live,
      absoluteLinksWithin(live, [{ from: 0, to: live.state.doc.length }]).filter((link) => link.noteId === source),
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
