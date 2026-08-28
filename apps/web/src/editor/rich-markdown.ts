import { syntaxTree } from '@codemirror/language';
import { type EditorState, type Extension, type Range, RangeSetBuilder } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { ATTACHMENT_PREFIX } from '@unbent/shared';
import { acquirePdf, releasePdf } from '../pdf/render.js';

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

const hiddenMark = Decoration.mark({ class: 'cm-md-hidden' });
const listBullet = Decoration.mark({ class: 'cm-md-bullet' });

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
 * First page of an attached PDF, drawn under the link that references it.
 *
 * Appended after the markdown rather than replacing it, for the same reason `ImageWidget`
 * is: the link text is frequently the only title a scanned note has, and a replaced link
 * would be the one thing in the document the cursor could not reach. The rendering is
 * quieter than the preview pane's viewer — one page, no chrome, no page count — because
 * here it sits among text being written rather than in a pane being read.
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
   * again. Nothing else about the widget affects what is painted.
   */
  override eq(other: PdfWidget): boolean {
    return other.url === this.url;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'cm-md-pdf';

    const canvas = document.createElement('canvas');
    canvas.className = 'cm-md-pdf-canvas';
    wrap.appendChild(canvas);

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
        if (doc.pageCount > 1) {
          const more = document.createElement('span');
          more.className = 'cm-md-pdf-more';
          more.textContent = `+${doc.pageCount - 1} more page${doc.pageCount > 2 ? 's' : ''}`;
          wrap.appendChild(more);
        }
      })
      .catch(() => {
        // A PDF that will not open should leave the link readable, not an error banner
        // wedged into the middle of the text.
        wrap.remove();
      });

    return wrap;
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

  /** Clicks belong to the editor, not the widget. */
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
}

function buildDecorations(view: EditorView, options: RichMarkdownOptions): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const marks: Array<Range<Decoration>> = [];
  const state = view.state;

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
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

        if (node.name === 'Link') {
          const resolve = options.resolveAttachment;
          if (!resolve) return;

          const text = state.doc.sliceString(node.from, node.to);
          // Same shape as the image branch, minus the `!`. A `[…](…)` that does not match
          // is a reference link or footnote, which has no attachment to render.
          const match = /^\[([^\]]*)\]\((.+)\)$/.exec(text);
          if (!match) return;

          const url = unwrapUrl(match[2]!.trim());
          if (!url.startsWith(ATTACHMENT_PREFIX)) return;

          const filename = url.slice(ATTACHMENT_PREFIX.length);
          // Extension on the path, matching how the shared pipeline decides the same
          // thing for the preview pane — the two must agree or a note renders differently
          // in each.
          if (!PDF_PATH.test(decodePath(filename).split('?')[0] ?? '')) return;

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
          // Selection changes matter as much as edits: they reveal and hide syntax.
          if (update.docChanged || update.viewportChanged || update.selectionSet) {
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

      '.cm-md-code': {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
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

      '.cm-md-bullet': { color: 'var(--accent)', fontWeight: '600' },
      '.cm-md-task': { verticalAlign: 'middle', margin: '0 0.35em 0 0', cursor: 'pointer' },
      '.cm-md-url': { opacity: '0.5', fontSize: '0.9em' },
      '.cm-md-punct': { opacity: '0.35' },

      /**
       * The inline PDF page.
       *
       * `display: block` on an inline widget so the page sits under its link rather than
       * beside it, matching how the image widget breaks the line. The canvas gets its
       * pixel size from the renderer, so only the ceiling is set here.
       */
      '.cm-md-pdf': { display: 'block', padding: '0.35rem 0 0.6rem' },
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
      '.cm-md-pdf-more': {
        display: 'block',
        fontSize: '0.85em',
        opacity: '0.6',
        paddingTop: '0.25rem',
      },

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
