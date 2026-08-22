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

const hiddenMark = Decoration.mark({ class: 'cm-md-hidden' });
const listBullet = Decoration.mark({ class: 'cm-md-bullet' });

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

/** True when any cursor or selection touches this range. */
function selectionTouches(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from);
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

        if (node.name === 'ListMark') {
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
         */
        if (MARK_NODES.has(node.name)) {
          const scope = node.node.parent ?? node;
          if (!selectionTouches(state, scope.from, scope.to)) {
            marks.push(hiddenMark.range(node.from, node.to));
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
      '.cm-md-hidden': { display: 'none' },

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
