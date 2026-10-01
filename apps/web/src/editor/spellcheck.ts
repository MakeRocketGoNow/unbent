import { RangeSetBuilder, type Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { ATTACHMENT_PREFIX } from '@unbent/shared';

/**
 * The editor takes prose, so the browser and the phone keyboard should treat it as prose.
 *
 * CodeMirror ships as a code editor and sets `spellcheck="false"`, `autocorrect="off"` and
 * `autocapitalize="off"` on its content element — right for source code, and the first
 * thing anyone notices typing a note on a phone: no capital at the start of a sentence,
 * no corrections, and on a desktop no underline under a misspelling. The Android app is
 * this page in a WebView, so it inherited all three.
 *
 * Both modes, not only rich: source mode is still someone writing a note, just with the
 * markup showing.
 *
 * What is not prose is excluded below, by range. Only the underline can be: the keyboard
 * reads `autocorrect` and `autocapitalize` from the editable host when it gains focus, and
 * nothing a span inside it says reaches the keyboard. So a phone may still offer a
 * correction inside a code block; it will not draw a red line under one.
 */
export function proseSpellcheck(): Extension {
  return [
    EditorView.contentAttributes.of({
      spellcheck: 'true',
      autocorrect: 'on',
      autocapitalize: 'sentences',
    }),
    noSpellcheckPlugin,
  ];
}

const noSpellcheck = Decoration.mark({ attributes: { spellcheck: 'false' } });

/**
 * Syntax whose text is not words, and would be underlined from end to end if it were
 * checked: code, addresses, and markup. Each is excluded whole, children included.
 */
const NOT_PROSE = new Set([
  'FencedCode',
  'CodeBlock',
  'InlineCode',
  // A bare URL, a link's destination, an `<autolink>`.
  'URL',
  'Autolink',
  'HTMLBlock',
  'HTMLTag',
  'CommentBlock',
  'Comment',
]);

/**
 * Whether a link or image points at one of the note's own files.
 *
 * Their label is the file's name — an upload writes `file.name` there and the import
 * writes the name the attachment came with — so `IMG_2041.jpg` and `Report_v2_final.pdf`
 * would carry a red line in nearly every imported note. Matching by destination rather
 * than by whether the label looks like a filename means a caption someone wrote over a
 * stored image is not checked either. That is the trade: the archive is thousands of
 * notes whose labels are filenames, and a hand-written caption is the exception.
 */
function linksStoredFile(view: EditorView, url: { from: number; to: number } | null): boolean {
  if (!url) return false;
  const raw = view.state.doc.sliceString(url.from, url.to);
  // A destination with a space in it is written in angle brackets, which the node keeps.
  return raw.replace(/^</, '').startsWith(ATTACHMENT_PREFIX);
}

function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter(node) {
        const link = node.name === 'Link' || node.name === 'Image';
        const excluded =
          NOT_PROSE.has(node.name) || (link && linksStoredFile(view, node.node.getChild('URL')));
        if (!excluded) return;
        // Visible ranges can split a long code block; ranges arrive in document order and
        // never overlap, so the builder's ordering rule holds without a sort.
        const start = Math.max(node.from, from);
        const end = Math.min(node.to, to);
        if (end > start) builder.add(start, end, noSpellcheck);
        return false;
      },
    });
  }
  return builder.finish();
}

/**
 * A plugin rather than attributes on the rich renderer's own decorations, because source
 * mode needs the same exclusions and has no renderer.
 */
const noSpellcheckPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = build(view);
    }

    update(update: ViewUpdate) {
      // The parse landing after the first twenty milliseconds is a change of tree with no
      // change of document; see the same check in the rich renderer.
      const parsed = syntaxTree(update.startState) !== syntaxTree(update.state);
      if (update.docChanged || update.viewportChanged || parsed) {
        this.decorations = build(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
