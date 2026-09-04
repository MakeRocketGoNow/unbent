import { syntaxTree } from '@codemirror/language';
import {
  type EditorState,
  type Extension,
  type Range,
  RangeSetBuilder,
  StateEffect,
} from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { ATTACHMENT_PREFIX } from '@unbent/shared';
import { acquirePdf, type LoadedPdf, releasePdf } from '../pdf/render.js';

/**
 * Rich markdown rendering inside CodeMirror.
 *
 * Styles markdown as it is written — bold looks bold, headings are larger, images show —
 * while the document stays exactly the text that was typed. That is the point: there is no
 * document model and no serializer, so nothing can rewrite the source behind the user's
 * back. A WYSIWYG editor round-trips through its own tree and rewrites on save, which
 * silently mangles things like `](<files/My File.pdf>)`; here the text never leaves the
 * buffer.
 *
 * Syntax characters (`**`, `#`, backticks) hide unless the cursor is inside the node they
 * belong to, so editing stays direct while reading stays clean.
 */

const BLOCK_STYLES: Record<string, Decoration> = {
  ATXHeading1: Decoration.line({ class: 'cm-md-h1' }),
  ATXHeading2: Decoration.line({ class: 'cm-md-h2' }),
  ATXHeading3: Decoration.line({ class: 'cm-md-h3' }),
  ATXHeading4: Decoration.line({ class: 'cm-md-h4' }),
  ATXHeading5: Decoration.line({ class: 'cm-md-h5' }),
  ATXHeading6: Decoration.line({ class: 'cm-md-h6' }),
  Blockquote: Decoration.line({ class: 'cm-md-quote' }),
};

const INLINE_STYLES: Record<string, Decoration> = {
  StrongEmphasis: Decoration.mark({ class: 'cm-md-strong' }),
  Emphasis: Decoration.mark({ class: 'cm-md-em' }),
  Strikethrough: Decoration.mark({ class: 'cm-md-strike' }),
  InlineCode: Decoration.mark({ class: 'cm-md-code' }),
  URL: Decoration.mark({ class: 'cm-md-url' }),
  LinkMark: Decoration.mark({ class: 'cm-md-punct' }),
};

/** Node types whose punctuation is noise once the surrounding text is styled. */
const MARK_NODES = new Set([
  'HeaderMark',
  'EmphasisMark',
  'CodeMark',
  'StrikethroughMark',
  'QuoteMark',
]);

/**
 * Block marks are separated from their content by a space that the mark node excludes.
 *
 * Hiding only `#` leaves that space visible, indenting every heading by one character —
 * and at heading font sizes the gap is obvious against the paragraphs around it. These
 * node types get the following whitespace hidden along with the mark. Inline marks like
 * `**` are not in this set: the space after them is real content.
 */
const MARKS_WITH_TRAILING_SPACE = new Set(['HeaderMark', 'QuoteMark']);

/**
 * Fenced code gets a line decoration per line rather than one block decoration.
 *
 * A ViewPlugin cannot emit block decorations, and the whole point is a background that
 * spans the run — so each line is marked, with the first and last also flagged so the
 * corners round and the padding sits at the ends rather than on every line.
 */
const CODE_BLOCK_LINE = Decoration.line({ class: 'cm-md-codeblock' });
const CODE_BLOCK_FIRST = Decoration.line({ class: 'cm-md-codeblock cm-md-codeblock-first' });
const CODE_BLOCK_LAST = Decoration.line({ class: 'cm-md-codeblock cm-md-codeblock-last' });
const CODE_BLOCK_ONLY = Decoration.line({
  class: 'cm-md-codeblock cm-md-codeblock-first cm-md-codeblock-last',
});

const hiddenMark = Decoration.mark({ class: 'cm-md-hidden' });
/** The alignment row hides as a collapsed line rather than as zero-width text. */
const hiddenAlignRow = Decoration.mark({ class: 'cm-md-hidden' });
const listBullet = Decoration.mark({ class: 'cm-md-bullet' });
const linkLabel = Decoration.mark({ class: 'cm-md-link' });

/**
 * Table decorations.
 *
 * A real `<table>` is not on offer here: CodeMirror lays out every line independently, so
 * making a cell in one row share a column with the row above needs either a widget
 * replacing the whole block — which takes the text, and the cursor, out of the document —
 * or per-cell width measurement that fights line wrapping and reruns on every keystroke.
 *
 * Tables are set in monospace, which is the whole reason the pipe format exists: when cells
 * are padded to equal width the columns line up on their own. Rich mode sets the rest of the
 * document in a proportional serif, so the table's own `font-family` in the theme below is
 * what keeps that true here. The rendering styles what is already there — header in bold,
 * separators dimmed, the alignment row hidden — and `formatTable` in the commands module
 * does the aligning as a real edit the user can undo.
 */
const tableHeaderCell = Decoration.mark({ class: 'cm-md-th' });
const tablePipe = Decoration.mark({ class: 'cm-md-table-pipe' });
const tableRowLine = Decoration.line({ class: 'cm-md-table-row' });
const tableHeaderLine = Decoration.line({ class: 'cm-md-table-row cm-md-table-head' });
const alignRowLine = Decoration.line({ class: 'cm-md-table-align' });

/**
 * Ordered-list markers cycle by depth the way Evernote and word processors do:
 * `1.` → `a.` → `i.` → back to `1.`.
 *
 * Markdown has no syntax for an alphabetic or roman list — `a.` in the source is a
 * paragraph, not a list item — so the cycle is a rendering of the marker, never a rewrite
 * of it. The buffer keeps ordinary `1.`/`2.` numbering, which means the note still nests,
 * exports, and renders as a real ordered list everywhere outside this editor.
 *
 * Only ordered ancestors count, so a numbered list nested under a bullet restarts the
 * cycle at numbers rather than inheriting a depth it does not visually look nested by.
 */
const ORDERED_STYLES = ['decimal', 'alpha', 'roman'] as const;

const ROMAN_DIGITS: ReadonlyArray<readonly [number, string]> = [
  [1000, 'm'],
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i'],
];

function toRoman(n: number): string {
  let rest = n;
  let out = '';
  for (const [value, numeral] of ROMAN_DIGITS) {
    while (rest >= value) {
      out += numeral;
      rest -= value;
    }
  }
  return out;
}

/** Spreadsheet-style lettering, so item 27 is `aa` rather than running out at `z`. */
function toAlpha(n: number): string {
  let rest = n;
  let out = '';
  while (rest > 0) {
    const digit = (rest - 1) % 26;
    out = String.fromCharCode(97 + digit) + out;
    rest = Math.floor((rest - 1) / 26);
  }
  return out;
}

/**
 * The marker to display for the `n`th item at a given ordered-list depth.
 *
 * Zero and negative ordinals have no alphabetic or roman form; markdown allows `0.`, so
 * they fall back to the digits already in the buffer.
 */
export function orderedMarker(ordinal: number, depth: number, delimiter: string): string {
  const style = ORDERED_STYLES[(depth - 1) % ORDERED_STYLES.length];
  if (style === 'decimal' || ordinal < 1) return `${ordinal}${delimiter}`;
  return `${style === 'alpha' ? toAlpha(ordinal) : toRoman(ordinal)}${delimiter}`;
}

/** How many ordered lists enclose this node; 0 when it is not in one. */
function orderedDepth(node: { parent: { name: string; parent: unknown } | null }): number {
  let depth = 0;
  for (let p = node.parent; p; p = p.parent as typeof p) {
    if (p.name === 'OrderedList') depth += 1;
  }
  return depth;
}

/**
 * Displays a converted ordered marker in place of the digits in the buffer.
 *
 * A widget rather than CSS: the marker lives in the text, so there is no list element to
 * hand `list-style-type` to.
 */
class OrderedMarkerWidget extends WidgetType {
  constructor(private readonly label: string) {
    super();
  }

  override eq(other: OrderedMarkerWidget): boolean {
    return other.label === this.label;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-md-bullet';
    span.textContent = this.label;
    return span;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/**
 * A real checkbox in place of `[ ]` / `[x]`.
 *
 * Clicking it edits the underlying text rather than tracking separate state, so the
 * document remains the only source of truth.
 */
class TaskWidget extends WidgetType {
  constructor(
    private readonly checked: boolean,
    private readonly pos: number,
  ) {
    super();
  }

  override eq(other: TaskWidget): boolean {
    return other.checked === this.checked && other.pos === this.pos;
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = this.checked;
    box.className = 'cm-md-task';
    box.addEventListener('mousedown', (event) => {
      event.preventDefault();
      // Rewrite just the marker character; everything else is untouched.
      view.dispatch({
        changes: { from: this.pos + 1, to: this.pos + 2, insert: this.checked ? ' ' : 'x' },
      });
    });
    return box;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/**
 * Inline preview for an attachment image.
 *
 * Added after the markdown rather than replacing it, so the source stays visible and
 * editable and a broken or slow image never hides the text that produced it. Declared as
 * an inline widget styled to fill the line: CodeMirror forbids true block decorations from
 * a ViewPlugin, and this needs the plugin's viewport awareness.
 */
class ImageWidget extends WidgetType {
  constructor(
    private readonly url: string,
    private readonly alt: string,
  ) {
    super();
  }

  override eq(other: ImageWidget): boolean {
    return other.url === this.url && other.alt === this.alt;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'cm-md-image';

    const img = document.createElement('img');
    img.src = this.url;
    img.alt = this.alt;
    img.loading = 'lazy';
    // A missing attachment should not leave a broken-image icon mid-document.
    img.onerror = () => wrap.remove();

    wrap.appendChild(img);
    return wrap;
  }

  /** Clicks belong to the editor, not the widget. */
  override ignoreEvent(): boolean {
    return false;
  }
}

/** Width the inline page is rasterized at. Narrower than the preview pane's viewer. */
const EDITOR_PDF_WIDTH = 420;

/**
 * Attachments the reader has expanded to every page, keyed by URL.
 *
 * Deliberately outside the widget. A `PdfWidget` is destroyed whenever its line scrolls
 * out of the viewport and rebuilt on the way back, so state held on the instance or in its
 * DOM would silently collapse an expanded document the moment it left the screen. URL is
 * the same identity `eq` compares and `acquirePdf` caches under, so a widget rebuilt for
 * the same attachment comes back expanded.
 *
 * Not cleared when a note closes: the set holds a handful of short strings, and reopening
 * a note you had expanded and finding it collapsed again is the more annoying outcome.
 */
const expandedPdfs = new Set<string>();

/**
 * Forgets every expansion.
 *
 * Exists for tests. The set is deliberately module-level so an expansion outlives the
 * widget that made it, which also means it outlives one test's editor — without this, a
 * test that expands an attachment decides what the next test sees for the same URL.
 */
export function resetExpandedPdfs(): void {
  expandedPdfs.clear();
}

/**
 * Pages of an attached PDF, drawn under the link that references it.
 *
 * Appended after the markdown rather than replacing it, for the same reason `ImageWidget`
 * is: the link text is frequently the only title a scanned note has, and a replaced link
 * would be the one thing in the document the cursor could not reach. The rendering is
 * quieter than the preview pane's viewer — no chrome, no per-page numbering — because here
 * it sits among text being written rather than in a pane being read.
 *
 * One page is drawn by default; the page-count line below it is a button that draws the
 * rest. Most notes in a real Evernote export are a single scanned document, so the first
 * page is usually the whole thing, and rasterizing every page of every attachment in a
 * note carrying nine of them would cost far more than anyone reads.
 *
 * The document is shared through `acquirePdf`, so scrolling a widget out of the viewport
 * and back does not re-parse the file.
 */
class PdfWidget extends WidgetType {
  constructor(private readonly url: string) {
    super();
  }

  /**
   * Identity is the URL alone.
   *
   * CodeMirror reuses the existing DOM when this returns true, which is what stops a
   * keystroke anywhere in the note from throwing away a rasterized page and drawing it
   * again. Nothing else about the widget affects what is painted — expansion is keyed by
   * the same URL in `expandedPdfs`, so it survives the rebuild rather than needing to be
   * compared here.
   */
  override eq(other: PdfWidget): boolean {
    return other.url === this.url;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'cm-md-pdf';

    const pages = document.createElement('span');
    pages.className = 'cm-md-pdf-pages';
    wrap.appendChild(pages);

    const canvas = document.createElement('canvas');
    canvas.className = 'cm-md-pdf-canvas';
    pages.appendChild(canvas);

    const status = document.createElement('span');
    status.className = 'cm-md-pdf-status';
    status.textContent = 'Rendering…';
    wrap.appendChild(status);

    acquirePdf(this.url)
      .then(async (doc) => {
        // `destroy` ran while the open was in flight: the release is already booked, so
        // stop before drawing into a canvas no longer in the document.
        if (!wrap.isConnected) return;
        await doc.renderPage(1, canvas, EDITOR_PDF_WIDTH);
        if (!wrap.isConnected) return;
        status.remove();
        if (doc.pageCount > 1) this.addMore(wrap, pages, doc);
      })
      .catch(() => {
        // A PDF that will not open should leave the link readable, not an error banner
        // wedged into the middle of the text.
        wrap.remove();
      });

    return wrap;
  }

  /**
   * The line under the first page, and what it does when clicked.
   *
   * A real `<button>` rather than a clickable span: this is the only control in the
   * rendered note, and it has to be reachable by keyboard and announced as something that
   * acts. `contentEditable = false` keeps CodeMirror from treating its text as document
   * content the caret can enter.
   */
  private addMore(wrap: HTMLElement, pages: HTMLElement, doc: LoadedPdf): void {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'cm-md-pdf-more';
    more.contentEditable = 'false';
    wrap.appendChild(more);

    const remaining = doc.pageCount - 1;
    more.textContent = `+${remaining} more page${remaining > 1 ? 's' : ''}`;

    /**
     * Drawing is one-way and one-shot.
     *
     * Once the pages are on screen the button becomes the collapse control, which only
     * hides them — the canvases stay in the DOM so expanding again is free rather than a
     * second rasterizing pass over a document that may run to dozens of pages.
     */
    let drawn = false;

    const collapse = () => {
      expandedPdfs.delete(this.url);
      pages.classList.remove('cm-md-pdf-expanded');
      more.textContent = `+${remaining} more page${remaining > 1 ? 's' : ''}`;
    };

    const expand = async () => {
      expandedPdfs.add(this.url);
      pages.classList.add('cm-md-pdf-expanded');
      more.textContent = `Showing ${doc.pageCount} pages`;
      if (drawn) return;
      drawn = true;

      for (let n = 2; n <= doc.pageCount; n += 1) {
        const canvas = document.createElement('canvas');
        canvas.className = 'cm-md-pdf-canvas';
        pages.appendChild(canvas);
        try {
          await doc.renderPage(n, canvas, EDITOR_PDF_WIDTH);
        } catch {
          // One unrenderable page should not leave a blank canvas wedged between the
          // pages around it.
          canvas.remove();
        }
        // Scrolled out of the viewport mid-draw: the widget is gone and the remaining
        // pages would be drawn into nothing.
        if (!wrap.isConnected) return;
      }
    };

    more.addEventListener('mousedown', (event) => {
      // The editor would otherwise move the caret to the click, which both scrolls the
      // note and steals the focus this button needs to stay keyboard-operable.
      event.preventDefault();
      event.stopPropagation();
    });

    more.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (expandedPdfs.has(this.url)) collapse();
      else void expand();
    });

    // Rebuilt after a scroll for an attachment that was already open: draw straight to
    // the state the reader left it in, with no second click.
    if (expandedPdfs.has(this.url)) void expand();
  }

  /**
   * Balances the `acquirePdf` in `toDOM`.
   *
   * CodeMirror calls this when the widget leaves the document — scrolled out of the
   * viewport, or its line deleted — which is exactly when the shared document should lose
   * a holder.
   */
  override destroy(): void {
    releasePdf(this.url);
  }

  /**
   * Clicks belong to the editor, not the widget.
   *
   * The one exception is the expand button, which stops its own events above; everything
   * else here is a rendered page that should behave like the rest of the note.
   */
  override ignoreEvent(): boolean {
    return false;
  }
}

/** True when any cursor or selection touches this range. */
function selectionTouches(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}

/**
 * Nodes that end the walk up to a block, below the top level.
 *
 * A list is one node covering every item, so stopping at `Document` would reveal the
 * syntax of a whole list because the cursor sits in one of its items. Typora reveals the
 * item being edited and leaves its siblings rendered, and these are the boundaries that
 * produce that: the unit a person thinks of as "the thing I am editing".
 */
const BLOCK_BOUNDARIES = new Set(['ListItem', 'TableRow', 'TableHeader']);

/**
 * The range whose syntax reveals together, for a node the cursor may be in.
 *
 * Typora's rule is the block: the cursor anywhere in a paragraph shows that paragraph's
 * markup at once, while the paragraphs around it stay rendered. Scoping to the emphasis
 * span instead uncovers one `**` at a time as the cursor crosses it, which reads as the
 * editor fighting you rather than as text being edited.
 *
 * Clamped to the cursor's own line, which is where Unbent departs from Typora and has to.
 * The shared pipeline renders with `remark-breaks`, so a single newline is a line break
 * and each line is its own visual unit here — but CommonMark still parses consecutive
 * lines as one Paragraph. Revealing the whole node would reflow lines the user is not
 * editing and can see are separate. For a heading, a list item, or a table row, block and
 * line coincide and the clamp changes nothing; it only bites on the multi-line paragraph,
 * which is exactly the case where the block is not what a reader sees.
 */
function revealScope(
  state: EditorState,
  node: { name: string; from: number; to: number; parent: unknown },
): { from: number; to: number } {
  type Walkable = { name: string; from: number; to: number; parent: Walkable | null };
  let current = node as unknown as Walkable;

  while (current.parent && (current.parent as Walkable).name !== 'Document') {
    if (BLOCK_BOUNDARIES.has(current.name)) break;
    current = current.parent as Walkable;
  }

  // Intersect the block with the line holding the mark, never widening past either.
  const line = state.doc.lineAt(node.from);
  return {
    from: Math.max(current.from, line.from),
    to: Math.min(current.to, line.to),
  };
}

/** Attachment links pointing at a PDF, by extension — mirrors the shared pipeline. */
const PDF_PATH = /\.pdf$/i;

/** Percent-decodes when valid, leaving a literal `%` alone rather than throwing. */
function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Strips the angle brackets CommonMark uses around URLs containing spaces. */
function unwrapUrl(raw: string): string {
  return raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw;
}

export interface RichMarkdownOptions {
  /** Resolves a relative `files/…` path to a URL the browser can load. */
  resolveAttachment?: (filename: string) => string;
  /**
   * Whether a stored file is a PDF, for names the extension does not admit to.
   *
   * The extension is the first signal and needs no help for anything uploaded here. An
   * imported file is the exception: Evernote's `<file-name>` is a display label, so a real
   * export carries PDFs called `Menu Card`, and the only thing that knows better is
   * the content type on the note's attachment row.
   *
   * A live callback rather than a set, because the attachment list is fetched and the
   * view is built before it lands. Asked again on every decoration rebuild, so an answer
   * that changes from false to true takes effect on the next repaint — see
   * `pdfNamesChanged` for making one happen.
   */
  isPdfAttachment?: (filename: string) => boolean;
}

/**
 * Tells the rich renderer its answer to `isPdfAttachment` has changed.
 *
 * The decorations rebuild on edits, scrolls and selection changes, none of which a
 * finished attachment fetch produces — without this the viewer would appear only after
 * the next keystroke. Dispatching this on a transaction is the CodeMirror way to say
 * "repaint", and costs one rebuild.
 */
export const pdfNamesChanged = StateEffect.define<null>();

function buildDecorations(view: EditorView, options: RichMarkdownOptions): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const marks: Array<Range<Decoration>> = [];
  const state = view.state;

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        /**
         * A fenced block is one node spanning many lines, unlike a blockquote whose mark
         * repeats per line, so its background has to be applied line by line.
         *
         * The fences themselves stay visible. Hiding them the way `**` is hidden would
         * leave a styled slab with no indication of where it starts or ends, and unlike
         * emphasis there is no way to infer the syntax from the rendering.
         */
        if (node.name === 'FencedCode') {
          const firstLine = state.doc.lineAt(node.from);
          const lastLine = state.doc.lineAt(node.to);
          const revealed = selectionTouches(state, node.from, node.to);

          /**
           * A fence row with the cursor on it is left as plain text — no slab, no hiding.
           *
           * Typing ``` opens a `FencedCode` node immediately, on the very keystroke, so
           * painting the slab as soon as the node exists wrapped three backticks the user
           * was still typing in a grey bar. Typora leaves that line looking like the text
           * it is and only draws the block once the caret moves off, which reads as the
           * block forming rather than as the editor jumping ahead.
           *
           * Judged per row rather than per block: the cursor sitting on the opening fence
           * should not also strip the slab from code rows further down.
           */
          const cursorLines = new Set<number>();
          for (const range of state.selection.ranges) {
            const from = state.doc.lineAt(range.from).number;
            const to = state.doc.lineAt(range.to).number;
            for (let n = from; n <= to; n += 1) cursorLines.add(n);
          }

          /**
           * Which rows are fences, so they can be hidden rather than shown as backticks.
           *
           * Read from the tree rather than assumed to be the first and last line: a block
           * still being typed has no closing fence yet, and hiding its last line would
           * swallow a line of real code.
           */
          const fenceLines = new Set<number>();
          for (let child = node.node.firstChild; child; child = child.nextSibling) {
            if (child.name === 'CodeMark') fenceLines.add(state.doc.lineAt(child.from).number);
          }
          /** Two fence rows means the block is terminated rather than still being typed. */
          const closed = fenceLines.size > 1;

          /**
           * The language, shown as a corner label instead of literal ```` ```ts ````.
           *
           * Typora renders a fenced block as a slab with the language in the corner, and
           * leaving raw backticks in the text is the thing that made this look unfinished:
           * an opening fence sat on its own line above a gap, with its closing partner
           * often scrolled out of view, so the block read as broken rather than as code.
           */
          const info = node.node.getChild('CodeInfo');
          const language = info ? state.doc.sliceString(info.from, info.to).trim() : '';

          /**
           * The first row that is not a collapsed fence.
           *
           * The language label hangs off this one rather than the opening fence: that row
           * is zero-height with `overflow: hidden` once hidden, which clipped the label
           * away entirely.
           */
          let labelLine = -1;
          for (let n = firstLine.number; n <= lastLine.number; n += 1) {
            if (!fenceLines.has(n)) {
              labelLine = n;
              break;
            }
          }

          for (let n = firstLine.number; n <= lastLine.number; n += 1) {
            const line = state.doc.line(n);
            const isFence = fenceLines.has(n);

            /**
             * The fence still being typed stays plain text: no slab, no collapse.
             *
             * Only while the block is unterminated. Once a closing fence exists the block
             * is formed, and putting the caret back on either fence should reveal its
             * backticks inside the slab like any other reveal — skipping the row there
             * left the closing fence hanging outside a block with an unrounded edge.
             */
            if (isFence && cursorLines.has(n) && !closed) continue;

            /**
             * A hidden fence row still occupies a line, so the rounding and padding go on
             * the first and last *visible* rows — otherwise the slab has a flat edge and a
             * blank strip where the fence used to be.
             */
            const isTop = n === firstLine.number;
            const isBottom = n === lastLine.number;
            const classes = ['cm-md-codeblock'];
            if (isFence && !revealed) classes.push('cm-md-codeblock-fence');
            if (isTop) classes.push('cm-md-codeblock-first');
            if (isBottom) classes.push('cm-md-codeblock-last');
            if (language && n === labelLine && !revealed) classes.push('cm-md-codeblock-labelled');

            marks.push(
              Decoration.line({
                class: classes.join(' '),
                ...(language && n === labelLine && !revealed
                  ? { attributes: { 'data-language': language } }
                  : {}),
              }).range(line.from),
            );

            // Collapse the fence row itself. The line decoration above still paints the
            // slab, so the background stays continuous where the backticks were.
            if (isFence && !revealed && line.to > line.from) {
              marks.push(hiddenMark.range(line.from, line.to));
            }
          }
          return;
        }

        const block = BLOCK_STYLES[node.name];
        if (block) {
          marks.push(block.range(state.doc.lineAt(node.from).from));
          return;
        }

        if (node.name === 'Image') {
          const resolve = options.resolveAttachment;
          if (!resolve) return;

          const text = state.doc.sliceString(node.from, node.to);
          const match = /^!\[([^\]]*)\]\((.+)\)$/.exec(text);
          if (!match) return;

          const url = unwrapUrl(match[2]!.trim());
          if (!url.startsWith(ATTACHMENT_PREFIX)) return;

          // Inline widget: CodeMirror forbids block decorations from a ViewPlugin, and
          // an inline one sits after the link text without needing its own line.
          marks.push(
            Decoration.widget({
              widget: new ImageWidget(resolve(url.slice(ATTACHMENT_PREFIX.length)), match[1] ?? ''),
              side: 1,
            }).range(node.to),
          );
          return;
        }

        /**
         * Table rows, headers, and the alignment row.
         *
         * Handled from the `Table` node rather than by matching each child as the iteration
         * reaches it, so the alignment row can be told apart from a cell separator: both are
         * `TableDelimiter`, and only the alignment row spans its whole line.
         */
        if (node.name === 'Table') {
          /**
           * No table-wide reveal flag, unlike the other block constructs.
           *
           * A table's rows carry ordinary text that stays styled whether the cursor is in
           * them or not — there is no syntax to uncover. The one row with syntax, the
           * alignment row, is judged on its own line below.
           */
          for (let row = node.node.firstChild; row; row = row.nextSibling) {
            const line = state.doc.lineAt(row.from);
            const isHeader = row.name === 'TableHeader';

            /**
             * The alignment row stays collapsed even while the rest of the table is
             * revealed, unlike every other mark here.
             *
             * It is the one piece of markdown in a note that must never be edited by hand.
             * It carries no content — its only job is to declare column alignment, which
             * the toolbar sets and `renderTable` rewrites — while being what makes GFM
             * parse the block as a table at all. Editing it cannot improve the table and
             * can only break it: delete a cell from it and the whole thing silently
             * reverts to paragraphs of pipes.
             *
             * Revealing it with the rest of the table therefore invited the one edit that
             * has no good outcome, on a row nobody has a reason to touch.
             */
            if (row.name === 'TableDelimiter' && row.from === line.from && row.to === line.to) {
              /**
               * The exception is the cursor being on the row itself.
               *
               * A collapsed line is still a line the caret can be moved onto, and text it
               * cannot see is text it cannot edit out of. Showing the row it is actually
               * on keeps the document honest — nothing is ever hidden from the point the
               * user is working at — without putting it on screen the rest of the time.
               */
              const onThisRow = selectionTouches(state, line.from, line.to);
              if (!onThisRow) {
                // The line decoration collapses the row; the mark hides its text. Both are
                // needed — hiding the text alone leaves an empty row inside the table.
                marks.push(alignRowLine.range(line.from));
                if (line.to > line.from) marks.push(hiddenAlignRow.range(line.from, line.to));
              }
              continue;
            }

            if (row.name !== 'TableHeader' && row.name !== 'TableRow') continue;
            marks.push((isHeader ? tableHeaderLine : tableRowLine).range(line.from));

            for (let cell = row.firstChild; cell; cell = cell.nextSibling) {
              if (cell.name === 'TableDelimiter') {
                marks.push(tablePipe.range(cell.from, cell.to));
              } else if (cell.name === 'TableCell' && isHeader && cell.to > cell.from) {
                marks.push(tableHeaderCell.range(cell.from, cell.to));
              }
            }
          }
          return;
        }

        if (node.name === 'Link') {
          const text = state.doc.sliceString(node.from, node.to);
          // A `[…](…)` that does not match is a reference link or footnote: it has no
          // inline destination to hide and no attachment to render.
          const match = /^\[([^\]]*)\]\((.+)\)$/.exec(text);
          if (!match) return;

          const label = match[1] ?? '';

          /**
           * Read as a link: style the label, hide the brackets and destination.
           *
           * Same reveal rule as every other mark, so putting the cursor on the line brings
           * the whole `[text](url)` back to be edited. A label is required — hiding the
           * destination of `[](…)` would leave nothing on screen at all, and the link
           * would be impossible to find again without turning off rich text.
           */
          const scope = revealScope(state, node.node);
          if (label && !selectionTouches(state, scope.from, scope.to)) {
            const labelStart = node.from + 1;
            const labelEnd = labelStart + label.length;
            marks.push(hiddenMark.range(node.from, labelStart));
            marks.push(linkLabel.range(labelStart, labelEnd));
            marks.push(hiddenMark.range(labelEnd, node.to));
          }

          const resolve = options.resolveAttachment;
          if (!resolve) return;

          const url = unwrapUrl(match[2]!.trim());
          if (!url.startsWith(ATTACHMENT_PREFIX)) return;

          const filename = url.slice(ATTACHMENT_PREFIX.length);
          // Extension on the path, then the stored content type — matching how the shared
          // pipeline decides the same thing for the preview pane. The two must agree or a
          // note renders differently in each, which is exactly what happened when only the
          // preview learned to trust the content type.
          const decoded = decodePath(filename).split('?')[0] ?? '';
          if (!PDF_PATH.test(decoded) && !options.isPdfAttachment?.(decoded)) return;

          marks.push(
            Decoration.widget({ widget: new PdfWidget(resolve(filename)), side: 1 }).range(node.to),
          );
          return;
        }

        if (node.name === 'ListMark') {
          const raw = state.doc.sliceString(node.from, node.to);
          const ordered = /^(\d+)([.)])$/.exec(raw);
          const depth = ordered ? orderedDepth(node.node) : 0;

          /**
           * Show the depth's marker style, but only while the cursor is elsewhere.
           *
           * On the active line the real digits come back, for the same reason `**` does:
           * you cannot edit a marker you cannot see, and typing `2.` over a displayed `b.`
           * would otherwise look like the editor was fighting you.
           */
          const scope = revealScope(state, node.node);
          if (ordered && depth > 1 && !selectionTouches(state, scope.from, scope.to)) {
            const label = orderedMarker(Number(ordered[1]), depth, ordered[2] ?? '.');
            marks.push(
              Decoration.replace({ widget: new OrderedMarkerWidget(label) }).range(
                node.from,
                node.to,
              ),
            );
            return;
          }

          marks.push(listBullet.range(node.from, node.to));
          return;
        }

        if (node.name === 'TaskMarker') {
          const checked = state.doc.sliceString(node.from, node.to).includes('x');
          marks.push(
            Decoration.replace({ widget: new TaskWidget(checked, node.from) }).range(
              node.from,
              node.to,
            ),
          );
          return;
        }

        const inline = INLINE_STYLES[node.name];
        if (inline && node.to > node.from) {
          marks.push(inline.range(node.from, node.to));
          return;
        }

        /**
         * Hide syntax punctuation, but only while the cursor is elsewhere.
         *
         * Hiding it unconditionally would make the markdown uneditable — you could not see
         * what you were deleting. Revealing on cursor entry is what keeps this a text
         * editor rather than a WYSIWYG imitation.
         *
         * The unit is the block, not the mark: entering a paragraph shows all of its
         * markup at once, the way Typora does, rather than uncovering each `**` as the
         * cursor reaches it.
         */
        if (MARK_NODES.has(node.name)) {
          /**
           * Fence rows are handled by the `FencedCode` branch, which hides the whole line
           * rather than just the backticks — see there for why.
           */
          if (node.name === 'CodeMark' && node.node.parent?.name === 'FencedCode') return;

          const scope = revealScope(state, node.node);

          if (!selectionTouches(state, scope.from, scope.to)) {
            let end = node.to;
            if (MARKS_WITH_TRAILING_SPACE.has(node.name)) {
              // Consume the separating whitespace so the content aligns with body text.
              while (end < state.doc.length && /[ \t]/.test(state.doc.sliceString(end, end + 1))) {
                end += 1;
              }
            }
            marks.push(hiddenMark.range(node.from, end));
          }
        }
      },
    });
  }

  // RangeSetBuilder requires sorted input; line, mark, and widget decorations interleave.
  marks.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
  for (const m of marks) builder.add(m.from, m.to, m.value);
  return builder.finish();
}

export function richMarkdown(options: RichMarkdownOptions = {}): Extension {
  return [
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;

        constructor(view: EditorView) {
          this.decorations = buildDecorations(view, options);
        }

        update(update: ViewUpdate) {
          // Selection changes matter as much as edits: they reveal and hide syntax. The
          // effect covers the one input that changes without a transaction of its own —
          // the attachment list arriving after the view was built.
          const relisted = update.transactions.some((tr) =>
            tr.effects.some((e) => e.is(pdfNamesChanged)),
          );
          if (update.docChanged || update.viewportChanged || update.selectionSet || relisted) {
            this.decorations = buildDecorations(update.view, options);
          }
        }
      },
      { decorations: (v) => v.decorations },
    ),

    EditorView.theme({
      /**
       * Hide syntax without removing it from layout.
       *
       * `display: none` takes the element out of the layout tree, and CodeMirror measures
       * cursor positions from rendered geometry — `coordsAtPos` returned null for every
       * line starting with a hidden mark, so arrow keys could not land on them. A line
       * hidden at both ends (`**bold**` alone) had no measurable position at all.
       *
       * Zero-width font keeps the element in the layout tree with no visible size, so the
       * text is invisible but every position stays measurable.
       */
      '.cm-md-hidden': {
        fontSize: '0',
        // Inherited line-height would still reserve vertical space at font-size 0.
        lineHeight: '0',
      },

      '.cm-md-h1': { fontSize: '1.6em', fontWeight: '600', lineHeight: '1.35' },
      '.cm-md-h2': { fontSize: '1.35em', fontWeight: '600', lineHeight: '1.35' },
      '.cm-md-h3': { fontSize: '1.15em', fontWeight: '600' },
      '.cm-md-h4': { fontSize: '1.05em', fontWeight: '600' },
      '.cm-md-h5': { fontWeight: '600' },
      '.cm-md-h6': { fontWeight: '600', opacity: '0.8' },

      '.cm-md-strong': { fontWeight: '700' },
      '.cm-md-em': { fontStyle: 'italic' },
      '.cm-md-strike': { textDecoration: 'line-through', opacity: '0.7' },

      /**
       * The fenced-code background, drawn per line so the run reads as one slab.
       *
       * `margin` rather than `padding` on the sides would break the background's
       * continuity between lines, so the inset is horizontal padding and the rounding is
       * applied only at the two ends.
       */
      '.cm-md-codeblock': {
        background: 'color-mix(in srgb, currentColor 6%, transparent)',
        fontFamily: 'var(--font-mono)',
        fontSize: '0.9em',
        padding: '0 0.7rem',
      },
      '.cm-md-codeblock-first': { paddingTop: '0.5rem', borderRadius: '0.35rem 0.35rem 0 0' },
      '.cm-md-codeblock-last': { paddingBottom: '0.5rem', borderRadius: '0 0 0.35rem 0.35rem' },

      /**
       * A collapsed fence row.
       *
       * The line still exists — the cursor has to be able to land on it, which is why the
       * text is hidden at zero size rather than removed — but it must not leave a blank
       * strip inside the slab. Zero height with the background still painted keeps the
       * block looking continuous.
       */
      '.cm-md-codeblock-fence': {
        height: '0',
        overflow: 'hidden',
        paddingTop: '0',
        paddingBottom: '0',
      },

      /**
       * The language, drawn in the corner of the slab rather than as text in the document.
       *
       * `::after` on the first row so it needs no widget and cannot be selected or
       * deleted: it is a rendering of `CodeInfo`, never a second copy of it.
       */
      '.cm-md-codeblock-labelled': { position: 'relative' },
      '.cm-md-codeblock-labelled::after': {
        content: 'attr(data-language)',
        position: 'absolute',
        top: '0.15rem',
        right: '0.5rem',
        fontSize: '0.7rem',
        letterSpacing: '0.03em',
        textTransform: 'uppercase',
        opacity: '0.45',
        pointerEvents: 'none',
      },

      '.cm-md-code': {
        fontFamily: 'var(--font-mono)',
        fontSize: '0.9em',
        padding: '0.1em 0.3em',
        borderRadius: '0.25rem',
        background: 'color-mix(in srgb, currentColor 10%, transparent)',
      },

      '.cm-md-quote': {
        paddingLeft: '0.9rem',
        borderLeft: '3px solid color-mix(in srgb, currentColor 25%, transparent)',
        opacity: '0.85',
      },

      /**
       * Tables.
       *
       * The columns line up because `formatTable` pads the cells with literal spaces and
       * this rule puts them back in a monospace face — nothing here does layout, so both
       * halves are load-bearing. Rich mode sets the rest of the document in a proportional
       * serif, where equal character counts are no longer equal widths; the table would
       * come apart without its own font. See the note by the decorations.
       */
      '.cm-md-table-row': {
        fontFamily: 'var(--font-mono)',
        fontSize: '0.9em',
        background: 'color-mix(in srgb, currentColor 4%, transparent)',
      },
      '.cm-md-table-head': {
        background: 'color-mix(in srgb, currentColor 8%, transparent)',
      },
      '.cm-md-th': { fontWeight: '700' },
      // Dimmed rather than hidden: the pipes are what make the columns readable as columns.
      '.cm-md-table-pipe': { opacity: '0.25' },

      /** Collapsed like a code fence: the row exists for the cursor, but shows nothing. */
      '.cm-md-table-align': {
        height: '0',
        overflow: 'hidden',
        paddingTop: '0',
        paddingBottom: '0',
      },

      '.cm-md-bullet': { color: 'var(--accent)', fontWeight: '600' },
      '.cm-md-task': { verticalAlign: 'middle', margin: '0 0.35em 0 0', cursor: 'pointer' },
      '.cm-md-url': { opacity: '0.5', fontSize: '0.9em' },
      /**
       * Underlined rather than only coloured: colour alone is not an accessible way to
       * mark a link, and the accent is already the list-bullet colour.
       */
      '.cm-md-link': {
        color: 'var(--accent)',
        textDecoration: 'underline',
        textUnderlineOffset: '0.15em',
        cursor: 'pointer',
      },
      '.cm-md-punct': { opacity: '0.35' },

      /**
       * The inline PDF page.
       *
       * `display: block` on an inline widget so the page sits under its link rather than
       * beside it, matching how the image widget breaks the line. The canvas gets its
       * pixel size from the renderer, so only the ceiling is set here.
       */
      '.cm-md-pdf': { display: 'block', padding: '0.35rem 0 0.6rem' },
      /**
       * The page stack.
       *
       * Pages after the first are hidden with CSS rather than removed, so collapsing and
       * expanding again costs nothing after the one rasterizing pass.
       */
      '.cm-md-pdf-pages': { display: 'block' },
      '.cm-md-pdf-pages > .cm-md-pdf-canvas ~ .cm-md-pdf-canvas': { display: 'none' },
      '.cm-md-pdf-expanded > .cm-md-pdf-canvas ~ .cm-md-pdf-canvas': {
        display: 'block',
        marginTop: '0.4rem',
      },
      '.cm-md-pdf-canvas': {
        display: 'block',
        maxWidth: 'min(100%, 26rem)',
        borderRadius: '0.35rem',
        border: '1px solid color-mix(in srgb, currentColor 15%, transparent)',
        // A scan is nearly always on white; on a dark theme an unbacked canvas shows the
        // editor through the page margins.
        background: '#fff',
      },
      '.cm-md-pdf-status': { fontSize: '0.85em', opacity: '0.6' },
      /**
       * The expand control, styled as the quiet caption it replaced.
       *
       * A button carries a platform look that would be far louder than anything else in a
       * rendered note, so the browser's own chrome is stripped back off — but it stays a
       * button for the keyboard and the screen reader.
       */
      '.cm-md-pdf-more': {
        display: 'block',
        font: 'inherit',
        fontSize: '0.85em',
        opacity: '0.6',
        padding: '0.25rem 0 0',
        margin: '0',
        border: 'none',
        background: 'none',
        color: 'inherit',
        textAlign: 'left',
        textDecoration: 'underline',
        textUnderlineOffset: '0.15em',
        cursor: 'pointer',
      },
      '.cm-md-pdf-more:hover': { opacity: '0.85' },

      '.cm-md-image': { display: 'block', padding: '0.35rem 0 0.6rem' },
      '.cm-md-image img': {
        maxWidth: 'min(100%, 26rem)',
        maxHeight: '18rem',
        borderRadius: '0.35rem',
        border: '1px solid color-mix(in srgb, currentColor 15%, transparent)',
      },
    }),
  ];
}
