import { EditorState, EditorSelection, StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConnectivity, setReachableForTests } from '../connectivity.js';
import { editorMarkdown } from './links.js';
import {
  bulletGlyph,
  caretBelowEnd,
  caretRoom,
  collectAttachmentTargets,
  orderedMarker,
  pdfNamesChanged,
  resetExpandedPdfs,
  resetFailedImages,
  richMarkdown,
} from './rich-markdown.js';

/**
 * pdf.js never runs here: jsdom has no canvas rasterizer, and the widget's contract with
 * it is narrow enough to state directly. What these tests are about is which links get a
 * widget at all, and that acquire/release stay balanced.
 */
const renderPage = vi.fn(async () => {});
/** Page count the mocked document reports; raised by the tests that need more than one. */
let pageCount = 1;
const acquirePdf = vi.fn(async (_url: string) => ({ pageCount, renderPage, destroy: () => {} }));
const releasePdf = vi.fn((_url: string) => {});

vi.mock('../pdf/render.js', () => ({
  acquirePdf: (url: string) => acquirePdf(url),
  releasePdf: (url: string) => releasePdf(url),
}));

/**
 * The full-screen viewer is a `<dialog>` jsdom cannot open. What the widgets owe it is a
 * call with the right attachment, which is all that is recorded here.
 */
const openAttachmentViewer = vi.fn();

vi.mock('../attachment-viewer.js', () => ({
  openAttachmentViewer: (target: unknown, siblings: unknown) =>
    openAttachmentViewer(target, siblings),
  downloadUrl: (src: string) => `${src}?download=1`,
}));

/**
 * These mount a real EditorView because the behaviour under test is which ranges get
 * hidden, and that only exists once decorations are applied to a document.
 */
let view: EditorView | undefined;

function mount(doc: string, cursor = doc.length): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  view = new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(cursor),
      extensions: [editorMarkdown(), richMarkdown()],
    }),
    parent,
  });
  focusAt(view, cursor);
  return view;
}

/**
 * Puts the view in the focused, editing state these tests assume.
 *
 * A reveal needs focus (see `reveals` in rich-markdown): a caret alone no longer uncovers
 * syntax, which is the whole point of the fix. `focus()` sets `hasFocus` at once but does
 * not itself rebuild the decorations (that happens on the next update), so a selection is
 * dispatched after it to force the focused build synchronously, the way real editing does.
 */
function focusAt(v: EditorView, cursor: number): void {
  v.focus();
  v.dispatch({ selection: EditorSelection.cursor(cursor) });
}

/** Mounts with attachment resolution on; the shared `mount` deliberately has none. */
/** What the toolbar's copy control was asked to copy, across a test. */
const copyAttachment = vi.fn(async (_filename: string, _kind: 'image' | 'pdf') => {});
/** What the save control was asked to fetch; answers with the stored name. */
const saveRemoteImage = vi.fn(async (_url: string) => 'saved.png');
/** What the bin was asked to delete, across a test. */
const deleteAttachment = vi.fn(async (_filename: string) => {});

function mountWithAttachments(
  doc: string,
  cursor = 0,
  pdfNames: string[] = [],
  // Off for the tests about how a note reads when the editor has no focus: the state a
  // note opened by the sidebar's arrow keys is in, where the caret sits at offset 0 without
  // anyone having put it there. See the unfocused image test.
  focus = true,
  // The editor to write into after a round trip; see `RichMarkdownOptions.liveView`.
  liveView?: () => EditorView | null,
): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const names = new Set(pdfNames);
  view = new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(cursor),
      extensions: [
        editorMarkdown(),
        richMarkdown({
          resolveAttachment: (name) => `/api/notes/n1/files/${name}`,
          isPdfAttachment: (name) => names.has(name),
          copyAttachment,
          saveRemoteImage,
          deleteAttachment,
          liveView,
        }),
      ],
    }),
    parent,
  });
  // See `focusAt`: a reveal needs focus, and most of these tests are about the focused view.
  if (focus) focusAt(view, cursor);
  return view;
}

/**
 * Text of a line as rendered, excluding anything hidden.
 *
 * Walks recursively: hidden marks nest inside styling spans (a `**` sits within the
 * `cm-md-strong` wrapper), so a shallow pass would report them as visible.
 */
function visibleText(v: EditorView, lineNumber: number): string {
  const line = v.dom.querySelectorAll('.cm-line')[lineNumber - 1];
  if (!line) return '';

  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    if (node instanceof HTMLElement) {
      if (node.classList.contains('cm-md-hidden')) return '';
      return [...node.childNodes].map(walk).join('');
    }
    return '';
  };

  return [...line.childNodes].map(walk).join('');
}

/** Class list of a rendered line, for decorations applied per line rather than per range. */
function lineClasses(v: EditorView, lineNumber: number): string {
  const line = v.dom.querySelectorAll('.cm-line')[lineNumber - 1] as HTMLElement | undefined;
  return line?.className ?? '';
}

afterEach(() => {
  view?.destroy();
  view = undefined;
});

describe('syntax hiding', () => {
  /**
   * The mark node excludes the space separating it from content, so hiding only `#` left
   * headings indented by one character against surrounding paragraphs.
   */
  it('hides the space after a heading mark so content aligns with body text', () => {
    const v = mount('# Heading\n\nplain', 12);
    expect(visibleText(v, 1)).toBe('Heading');
  });

  it('hides the space after every heading level', () => {
    const v = mount('### Deep heading\n\nplain', 20);
    expect(visibleText(v, 1)).toBe('Deep heading');
  });

  it('hides the space after a quote mark', () => {
    const v = mount('> quoted\n\nplain', 12);
    expect(visibleText(v, 1)).toBe('quoted');
  });

  /** A list without its bullet is unreadable, so the mark stays, as a bullet. */
  it('renders a list marker as a bullet', () => {
    const v = mount('- item\n\nplain', 10);
    expect(visibleText(v, 1)).toBe('• item');
  });

  it('hides inline emphasis marks without eating following spaces', () => {
    // Cursor on the second line: anywhere on the first would reveal the marks by design.
    const v = mount('a **bold** b\n\nplain', 16);
    expect(visibleText(v, 1)).toBe('a bold b');
  });

  /** Syntax must come back when the cursor enters, or the markdown is uneditable. */
  it('reveals a heading mark when the cursor is on that line', () => {
    const v = mount('# Heading\n\nplain', 3);
    expect(visibleText(v, 1)).toBe('# Heading');
  });

  it('reveals emphasis marks when the cursor is inside them', () => {
    const v = mount('a **bold** b', 5);
    expect(visibleText(v, 1)).toBe('a **bold** b');
  });

  /**
   * Revealed syntax is the editor's punctuation, not the text's: it is classed so the
   * theme can dim it, rather than left to inherit the heading or emphasis it marks.
   */
  it('classes a revealed mark as punctuation', () => {
    const v = mount('# Heading\n\na **bold** b', 3);
    const marks = [...v.dom.querySelectorAll('.cm-md-mark')].map((el) => el.textContent);
    // A heading mark's span takes its separating space with it; see the hanging tests.
    expect(marks).toEqual(['# ']);
  });

  /**
   * The heading mark hangs in the margin so the text does not move on reveal. Its span
   * takes the separating space with it: that space is the gap between hashes and text.
   */
  it('hangs a revealed heading mark together with its space', () => {
    const v = mount('## Heading\n\nplain', 3);
    const hung = v.dom.querySelector('.cm-md-headmark');
    expect(hung?.textContent).toBe('## ');
    expect(hung?.classList.contains('cm-md-mark')).toBe(true);
  });

  it('hangs nothing but heading marks', () => {
    const v = mount('> quote **bold**', 3);
    expect(v.dom.querySelector('.cm-md-headmark')).toBeNull();
    expect(v.dom.querySelectorAll('.cm-md-mark').length).toBe(3);
  });

  it('classes every revealed mark on the line, and none elsewhere', () => {
    const v = mount('# Heading\n\na **bold** _it_ b', 16);
    const marks = [...v.dom.querySelectorAll('.cm-md-mark')].map((el) => el.textContent);
    expect(marks).toEqual(['**', '**', '_', '_']);
    expect(visibleText(v, 1)).toBe('Heading');
  });
});

/**
 * CommonMark joins consecutive lines into a single Paragraph node, so a mark's parent can
 * span lines the cursor is nowhere near. Revealing all of them at once reflows text the
 * user is not editing.
 */
describe('reveal scope', () => {
  const twoLines = '_italic_ one\n**bold** two\n\nplain';

  it('reveals only the line the cursor is on', () => {
    // Cursor inside the italic on line 1.
    const v = mount(twoLines, 3);
    expect(visibleText(v, 1)).toBe('_italic_ one');
    expect(visibleText(v, 2)).toBe('bold two');
  });

  it('reveals the second line without disturbing the first', () => {
    // Cursor inside the bold on line 2.
    const v = mount(twoLines, 17);
    expect(visibleText(v, 1)).toBe('italic one');
    expect(visibleText(v, 2)).toBe('**bold** two');
  });

  it('hides both when the cursor is elsewhere', () => {
    const v = mount(twoLines, twoLines.length);
    expect(visibleText(v, 1)).toBe('italic one');
    expect(visibleText(v, 2)).toBe('bold two');
  });
});

/**
 * Hidden syntax must stay in the layout tree.
 *
 * `display: none` removes an element from layout, and CodeMirror derives cursor positions
 * from rendered geometry: with it, coordsAtPos returned null for every line beginning
 * with a hidden mark, so arrow keys could not land on them. A line hidden at both ends,
 * like `**bold**` alone, had no measurable position anywhere.
 */
describe('layout', () => {
  /**
   * Hidden syntax must stay in the layout tree.
   *
   * `display: none` removes an element from layout, and CodeMirror derives cursor
   * positions from rendered geometry: with it, coordsAtPos returned null for every line
   * beginning with a hidden mark and arrow keys could not land on them. A line hidden at
   * both ends, like `**bold**` alone, had no measurable position anywhere.
   *
   * jsdom reports no geometry at all, so this asserts the styling rule rather than the
   * measurement: it is the property that made the lines unreachable.
   */
  it('hides syntax without display:none', () => {
    const v = mount('**bold**\n\nplain', 12);
    const hidden = v.dom.querySelector('.cm-md-hidden');
    expect(hidden).toBeTruthy();

    const rules: string[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        for (const rule of Array.from(sheet.cssRules)) {
          if ('selectorText' in rule && String(rule.selectorText).includes('cm-md-hidden')) {
            rules.push(rule.cssText);
          }
        }
      } catch {
        // Cross-origin sheets are not readable and are irrelevant here.
      }
    }

    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule).not.toContain('display: none');
      expect(rule).toContain('font-size: 0');
    }
  });


  function topLevelText(v: EditorView, lineNumber: number): boolean {
    const line = v.dom.querySelectorAll('.cm-line')[lineNumber - 1];
    return [...(line?.childNodes ?? [])].some(
      (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim().length > 0,
    );
  }

  function lineClass(v: EditorView, lineNumber: number): string {
    const line = v.dom.querySelectorAll('.cm-line')[lineNumber - 1] as HTMLElement | undefined;
    return (line?.className ?? '').replace('cm-line', '').trim();
  }
});
/** The whole reason for this editor: the document is never rewritten. */
describe('document fidelity', () => {
  it.each([
    '[Treatment Plan.pdf](<files/Treatment Plan.pdf>)',
    '[2020_02_29_10_30_00.pdf](files/2020_02_29_10_30_00.pdf)',
    '# Heading\n\n> quote\n\n- [x] task',
  ])('leaves %j byte-identical', (doc) => {
    const v = mount(doc, 0);
    expect(v.state.doc.toString()).toBe(doc);
  });
});

describe('ordered list markers', () => {
  /** The cycle Evernote and word processors use, repeating every three levels. */
  it.each([
    [1, 1, '1.'],
    [3, 1, '3.'],
    [1, 2, 'a.'],
    [2, 2, 'b.'],
    [27, 2, 'aa.'],
    [1, 3, 'i.'],
    [4, 3, 'iv.'],
    [9, 3, 'ix.'],
    [1, 4, '1.'],
    [2, 5, 'b.'],
  ])('renders item %i at depth %i as %s', (ordinal, depth, expected) => {
    expect(orderedMarker(ordinal, depth, '.')).toBe(expected);
  });

  it('keeps the delimiter that was typed', () => {
    expect(orderedMarker(2, 2, ')')).toBe('b)');
  });

  /** `0.` is legal markdown and has no letter or numeral; the digits stand. */
  it('leaves a zero ordinal as digits', () => {
    expect(orderedMarker(0, 2, '.')).toBe('0.');
  });

  it('shows a nested ordered item as a letter', () => {
    const v = mount('1. one\n2. two\n   1. three', 0);
    expect(visibleText(v, 3)).toContain('a.');
  });

  it('numbers the top level as digits', () => {
    const v = mount('1. one\n2. two\n   1. three', 0);
    expect(visibleText(v, 1)).toContain('1.');
  });

  it('uses roman numerals at the third level', () => {
    const v = mount('1. one\n   1. two\n      1. three', 0);
    expect(visibleText(v, 3)).toContain('i.');
  });

  /**
   * An ordered list under a bullet is still a first-level ordered list, so it starts the
   * cycle at digits rather than inheriting the bullet's depth.
   */
  it('restarts the cycle for an ordered list nested under a bullet', () => {
    const v = mount('- one\n  1. two', 0);
    expect(visibleText(v, 2)).toContain('1.');
  });

  /** Same rule as `**`: you cannot edit a marker the editor has replaced. */
  it('reveals the real digits when the cursor is on the marker', () => {
    const doc = '1. one\n2. two\n   3. three';
    const v = mount(doc, doc.lastIndexOf('3.') + 1);
    expect(visibleText(v, 3)).toContain('3.');
  });
});

describe('bullet markers', () => {
  it.each([
    [1, '•'],
    [2, '◦'],
    [3, '▪'],
    [4, '•'],
  ])('renders depth %d as %s', (depth, glyph) => {
    expect(bulletGlyph(depth)).toBe(glyph);
  });

  it.each(['-', '*', '+'])('renders a `%s` item as a bullet', (mark) => {
    const v = mount(`${mark} item\n\nplain`, 10);
    expect(visibleText(v, 1)).toBe('• item');
  });

  it('cycles the glyph by nesting depth', () => {
    const doc = '- one\n  - two\n    - three\n\nplain';
    const v = mount(doc, doc.length);
    expect(visibleText(v, 1)).toBe('• one');
    expect(visibleText(v, 2)).toBe('  ◦ two');
    expect(visibleText(v, 3)).toBe('    ▪ three');
  });

  it('counts only bullet ancestors, so a bullet under a number is top level', () => {
    const doc = '1. one\n   - two\n\nplain';
    const v = mount(doc, doc.length);
    expect(visibleText(v, 2)).toBe('   • two');
  });

  /** You cannot edit a dash the editor has replaced with a bullet. */
  it('reveals the dash when the cursor is on the line', () => {
    const v = mount('- item\n- other', 3);
    expect(visibleText(v, 1)).toBe('- item');
    expect(visibleText(v, 2)).toBe('• other');
  });

  it('never rewrites the document', () => {
    const v = mount('- item\n\nplain', 10);
    expect(v.state.doc.toString()).toBe('- item\n\nplain');
  });

  /** The checkbox is the task's marker; a bullet in front of it would be a second one. */
  it('hides the marker of a task item', () => {
    const v = mount('- [ ] task\n\nplain', 14);
    // The checkbox widget has no text of its own; the space after `[ ]` is the text's.
    expect(visibleText(v, 1)).toBe(' task');
    expect(v.dom.querySelector('.cm-md-task')).not.toBeNull();
  });

  it('reveals the marker of a task item on the caret line', () => {
    const v = mount('- [ ] task\n\nplain', 8);
    expect(visibleText(v, 1)).toBe('-  task');
  });
});

describe('inline PDF', () => {
  beforeEach(() => {
    acquirePdf.mockClear();
    releasePdf.mockClear();
    renderPage.mockClear();
    pageCount = 1;
    resetExpandedPdfs();
  });

  /**
   * Drains the promise chain behind a widget.
   *
   * Opening awaits `acquirePdf` and then draws each page in turn, so a single macrotask
   * tick lands in the middle of a multi-page expansion. Several passes push past the whole
   * chain, however many pages the mocked document reports.
   */
  const settle = async () => {
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  const moreButton = (v: EditorView) =>
    v.dom.querySelector<HTMLButtonElement>('.cm-md-pdf-more');

  it('renders a PDF attachment link', () => {
    mountWithAttachments('[report](files/report.pdf)');
    expect(acquirePdf).toHaveBeenCalledWith('/api/notes/n1/files/report.pdf');
  });

  /**
   * The angle-bracket form is what `formatAttachmentMarkdown` writes for any filename
   * containing a space, which is most of a real Evernote export.
   */
  it('renders a bracketed destination containing spaces', () => {
    mountWithAttachments('[Treatment Plan.pdf](<files/Treatment Plan.pdf>)');
    expect(acquirePdf).toHaveBeenCalledWith('/api/notes/n1/files/Treatment Plan.pdf');
  });

  it('renders a percent-encoded destination', () => {
    mountWithAttachments('[scan](files/my%20scan.pdf)');
    expect(acquirePdf).toHaveBeenCalledWith('/api/notes/n1/files/my%20scan.pdf');
  });

  /**
   * The Evernote importer writes a parenthesis in a bare destination as `\(`. The parser
   * reads it as the plain character, and so must the address the viewer fetches, or the
   * page under the link never arrives.
   */
  it('unescapes a backslash-escaped destination before resolving it', () => {
    mountWithAttachments('[r](files/Report\\(R\\).pdf)');
    expect(acquirePdf).toHaveBeenCalledWith('/api/notes/n1/files/Report(R).pdf');
  });

  /** A serialiser escapes a bracket in the label too; the tree still sees one link. */
  it('renders a link whose label holds an escaped bracket', () => {
    mountWithAttachments('[Scan \\[1\\].pdf](<files/Scan [1].pdf>)');
    expect(acquirePdf).toHaveBeenCalledWith('/api/notes/n1/files/Scan [1].pdf');
  });

  it('resolves a bracketed destination holding parentheses', () => {
    mountWithAttachments('[r](<files/Report (R).pdf>)');
    expect(acquirePdf).toHaveBeenCalledWith('/api/notes/n1/files/Report (R).pdf');
  });

  /** The link text is the caption, so it must survive alongside the rendered page. */
  it('leaves the markdown link visible', () => {
    const v = mountWithAttachments('[report](files/report.pdf)');
    expect(v.state.doc.toString()).toBe('[report](files/report.pdf)');
    expect(visibleText(v, 1)).toContain('report');
  });

  /**
   * The link keeps text on the line, so the break after the pages is never collapsed by a
   * zero line height the way an image-only line's is; left alone it hangs a blank line
   * under every PDF. See the `.cm-md-pdf + br` theme rule.
   */
  it('hides the trailing break under the pages', () => {
    const v = mountWithAttachments('[report](files/report.pdf)\n\nplain');
    const br = v.dom.querySelector('.cm-md-pdf + br') as HTMLElement | null;
    expect(br).not.toBeNull();
    expect(getComputedStyle(br!).display).toBe('none');
  });

  /**
   * The way to read a scan large. The control arrives with the first page rather than
   * with the widget, so it never sits on a page that has not drawn.
   *
   * The link the page hangs under is the caller's to remove once the file has gone
   * (`deleteStored` says why the widget cannot): the document is left as it was here,
   * and `Workspace.delete-file.test.tsx` has the link coming out.
   */
  it('deletes the file and leaves its link to the caller', async () => {
    deleteAttachment.mockClear();
    const doc = 'intro\n\n[report](files/report.pdf)';
    const v = mountWithAttachments(doc);
    await settle();
    v.dom.querySelector<HTMLButtonElement>('.cm-md-pdf .zoom-remove')?.click();
    [...v.dom.querySelectorAll<HTMLButtonElement>('.cm-md-pdf .attachment-tool-confirm')]
      .find((b) => b.textContent === 'Delete')
      ?.click();
    expect(deleteAttachment).toHaveBeenCalledWith('report.pdf');
    await settle();
    expect(v.state.doc.toString()).toBe(doc);
  });

  it('offers to copy the file once the first page has drawn', async () => {
    copyAttachment.mockClear();
    const v = mountWithAttachments('[report](files/report.pdf)');
    expect(v.dom.querySelector('.cm-md-pdf .zoom-copy')).toBeNull();
    await settle();
    const button = v.dom.querySelector<HTMLButtonElement>('.cm-md-pdf .zoom-copy');
    expect(button).not.toBeNull();
    button?.click();
    expect(copyAttachment).toHaveBeenCalledWith('report.pdf', 'pdf');
  });

  it('offers the full-screen viewer once the first page has drawn', async () => {
    openAttachmentViewer.mockClear();
    const v = mountWithAttachments('[report](files/report.pdf)');
    expect(v.dom.querySelector('.cm-md-pdf .zoom-btn')).toBeNull();
    await settle();
    const button = v.dom.querySelector<HTMLButtonElement>('.cm-md-pdf .zoom-btn');
    expect(button).not.toBeNull();
    expect(button?.getAttribute('aria-label')).toBe('Full screen');
    button?.click();
    expect(openAttachmentViewer.mock.calls.at(-1)?.[0]).toEqual({
      kind: 'pdf',
      src: '/api/notes/n1/files/report.pdf',
      label: '',
    });
  });

  /** A page has no markdown behind it to reveal, so a click on it can open the viewer. */
  it('opens the viewer from a click on the page', async () => {
    openAttachmentViewer.mockClear();
    const v = mountWithAttachments('[report](files/report.pdf)');
    await settle();
    v.dom.querySelector<HTMLCanvasElement>('.cm-md-pdf-canvas')?.click();
    expect(openAttachmentViewer).toHaveBeenCalledTimes(1);
    expect(v.state.doc.toString()).toBe('[report](files/report.pdf)');
  });

  it.each([
    ['an external URL', '[docs](https://example.com/a.pdf)'],
    ['a non-PDF attachment', '[sheet](files/budget.xlsx)'],
    ['an image', '![pic](files/photo.png)'],
  ])('does not render %s', (_label, doc) => {
    mountWithAttachments(doc);
    expect(acquirePdf).not.toHaveBeenCalled();
  });

  /** Without a resolver there is no URL to fetch, so nothing should be attempted. */
  it('renders nothing when no resolver is configured', () => {
    mount('[report](files/report.pdf)', 0);
    expect(acquirePdf).not.toHaveBeenCalled();
  });

  /**
   * An imported file may not admit to being a PDF: Evernote writes `<file-name>` as a
   * display label, so a real export carries PDFs called `Menu Card`. The note's
   * attachment row records the declared type, and rich mode has to reach the same verdict
   * as the preview pane: a note that draws a document in one and a bare link in the other
   * is precisely the bug this covers.
   */
  it('renders a PDF whose name has no extension', () => {
    mountWithAttachments('[Menu Card](<files/Menu Card>)', 0, ['Menu Card']);
    expect(acquirePdf).toHaveBeenCalledWith('/api/notes/n1/files/Menu Card');
  });

  it('matches the decoded name, not the percent-encoded one', () => {
    mountWithAttachments('[Gift](files/Lease%20Summary)', 0, ['Lease Summary']);
    expect(acquirePdf).toHaveBeenCalledWith('/api/notes/n1/files/Lease%20Summary');
  });

  it('leaves an extensionless file the note does not call a PDF alone', () => {
    mountWithAttachments('[notes](files/notes)', 0, ['Menu Card']);
    expect(acquirePdf).not.toHaveBeenCalled();
  });

  it('still renders by extension when nothing is known about the files', () => {
    mountWithAttachments('[report](files/report.pdf)', 0, []);
    expect(acquirePdf).toHaveBeenCalledWith('/api/notes/n1/files/report.pdf');
  });

  /**
   * The list is fetched, so it lands after the view is built. Nothing about that is a
   * document change, a scroll or a selection move, which are the only things that rebuild
   * decorations: without the effect the viewer would wait for the next keystroke.
   */
  it('draws the viewer when the attachment list arrives after mount', () => {
    const names = new Set<string>();
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    view = new EditorView({
      state: EditorState.create({
        doc: '[Menu Card](<files/Menu Card>)',
        selection: EditorSelection.cursor(0),
        extensions: [
          editorMarkdown(),
          richMarkdown({
            resolveAttachment: (name) => `/api/notes/n1/files/${name}`,
            isPdfAttachment: (name) => names.has(name),
          }),
        ],
      }),
      parent,
    });

    expect(acquirePdf).not.toHaveBeenCalled();

    names.add('Menu Card');
    view.dispatch({ effects: pdfNamesChanged.of(null) });

    expect(acquirePdf).toHaveBeenCalledWith('/api/notes/n1/files/Menu Card');
  });

  /**
   * The widget holds a reference-counted document. Leaving it acquired after the editor
   * goes away would keep a parsed PDF alive for the rest of the session.
   */
  it('releases the document when the editor is destroyed', () => {
    const v = mountWithAttachments('[report](files/report.pdf)');
    v.destroy();
    view = undefined;
    expect(releasePdf).toHaveBeenCalledWith('/api/notes/n1/files/report.pdf');
  });

  /**
   * Typing elsewhere rebuilds every decoration. `eq` on the URL is what makes CodeMirror
   * reuse the existing DOM instead of tearing the canvas down and rasterizing again.
   */
  it('does not reacquire when an unrelated edit rebuilds decorations', () => {
    const v = mountWithAttachments('[report](files/report.pdf)\n\ntext');
    expect(acquirePdf).toHaveBeenCalledTimes(1);

    v.dispatch({ changes: { from: v.state.doc.length, insert: '!' } });

    expect(acquirePdf).toHaveBeenCalledTimes(1);
    expect(releasePdf).not.toHaveBeenCalled();
  });

  /** One page is the whole document: offering to show more would be a lie. */
  it('offers no expansion for a single-page PDF', async () => {
    const v = mountWithAttachments('[report](files/report.pdf)');
    await settle();
    expect(moreButton(v)).toBeNull();
  });

  it('counts the pages that are not shown', async () => {
    pageCount = 3;
    const v = mountWithAttachments('[report](files/report.pdf)');
    await settle();
    expect(moreButton(v)?.textContent).toBe('+2 more pages');
  });

  it('says "page" when only one is left over', async () => {
    pageCount = 2;
    const v = mountWithAttachments('[report](files/report.pdf)');
    await settle();
    expect(moreButton(v)?.textContent).toBe('+1 more page');
  });

  /** The point of the change: the count is the control that draws the rest. */
  it('renders every remaining page when the count is clicked', async () => {
    pageCount = 3;
    const v = mountWithAttachments('[report](files/report.pdf)');
    await settle();
    expect(renderPage).toHaveBeenCalledTimes(1);

    moreButton(v)?.click();
    await settle();

    expect(renderPage).toHaveBeenCalledTimes(3);
    expect(v.dom.querySelectorAll('.cm-md-pdf-canvas')).toHaveLength(3);
    expect(moreButton(v)?.textContent).toBe('Showing 3 pages');
  });

  /**
   * Clicking again puts the note back the way it was. The canvases stay so a second
   * expansion never repeats the rasterizing.
   */
  it('collapses again without redrawing', async () => {
    pageCount = 3;
    const v = mountWithAttachments('[report](files/report.pdf)');
    await settle();

    moreButton(v)?.click();
    await settle();
    moreButton(v)?.click();
    await settle();
    expect(moreButton(v)?.textContent).toBe('+2 more pages');

    moreButton(v)?.click();
    await settle();
    expect(renderPage).toHaveBeenCalledTimes(3);
  });

  /**
   * A widget is destroyed when its line scrolls out of the viewport and rebuilt on the way
   * back. An expansion that did not survive that would collapse on its own.
   */
  it('comes back expanded after the widget is rebuilt', async () => {
    pageCount = 3;
    const first = mountWithAttachments('[report](files/report.pdf)');
    await settle();
    moreButton(first)?.click();
    await settle();
    first.destroy();

    const second = mountWithAttachments('[report](files/report.pdf)');
    await settle();
    expect(moreButton(second)?.textContent).toBe('Showing 3 pages');
    expect(second.dom.querySelectorAll('.cm-md-pdf-canvas')).toHaveLength(3);
  });
});

/**
 * Typora's rule, and what separates this from revealing one span at a time: the cursor
 * anywhere on a line shows every mark on it, so the text stops shifting under the caret
 * as it moves across.
 */
describe('inline images', () => {
  beforeEach(() => resetFailedImages());

  const image = (v: EditorView) => v.dom.querySelector<HTMLImageElement>('.cm-md-image img');

  it('draws the attachment', () => {
    const v = mountWithAttachments('![scan](files/scan.jpg)\n\nplain', 0);
    expect(image(v)?.getAttribute('src')).toBe('/api/notes/n1/files/scan.jpg');
    expect(image(v)?.alt).toBe('scan');
  });

  it('draws the alt with its escapes off, as a reader should see it', () => {
    const v = mountWithAttachments('![Scan \\[1\\]](<files/Scan [1].jpg>)\n\nplain', 0);
    expect(image(v)?.alt).toBe('Scan [1]');
  });

  /**
   * The bug this fixes: an image at the very start of an unfocused note showed its raw
   * `![alt](url)` instead of rendering.
   *
   * A note opened by the sidebar's arrow keys mounts its editor without focus, and
   * CodeMirror seeds a caret at offset 0 all the same. When the note begins with an image,
   * that caret sat on it and, treated as an edit-in-progress, the first image alone kept
   * its markdown while every later one rendered. An editor no one is typing in should show
   * the finished note: the picture draws, its alt stands in as the caption, and the `![` /
   * `](url)` around it stay hidden: the same as any image the caret is nowhere near.
   */
  it('renders a leading image in an unfocused editor rather than its markdown', () => {
    const v = mountWithAttachments('![scan](files/scan.jpg)\n\nplain', 0, [], false);
    expect(image(v)?.getAttribute('src')).toBe('/api/notes/n1/files/scan.jpg');
    expect(visibleText(v, 1)).toBe('scan');
  });

  /**
   * The other half of the same rule: focus is what brings the source back to edit. Putting
   * the caret on the image in a focused editor reveals `![alt](url)` in full, so the fix
   * hides nothing the editor still needs to be editable.
   */
  it('reveals a leading image’s markdown once the editor is focused', () => {
    const doc = '![scan](files/scan.jpg)\n\nplain';
    const v = mountWithAttachments(doc, 0);
    expect(visibleText(v, 1)).toBe(doc.split('\n')[0]);
  });

  /** The visible control, and the one the keyboard can reach. */
  it('offers the full-screen viewer from the corner button', () => {
    openAttachmentViewer.mockClear();
    const doc = '![scan](files/scan.jpg)\n\nplain';
    const v = mountWithAttachments(doc, doc.length);
    const button = v.dom.querySelector<HTMLButtonElement>('.cm-md-image .zoom-btn');
    expect(button).not.toBeNull();
    button?.click();
    expect(openAttachmentViewer.mock.calls.at(-1)?.[0]).toEqual({
      kind: 'image',
      src: '/api/notes/n1/files/scan.jpg',
      alt: 'scan',
    });
    // Opening the viewer is not an edit, and must not reveal the source either. The alt
    // stays as its caption; the `![` and `](url)` around it stay hidden.
    expect(v.state.doc.toString()).toBe(doc);
    expect(visibleText(v, 1)).toBe('scan');
  });

  /**
   * The other corner control: the picture to the clipboard, for another note. It names
   * the stored file, not the URL, and says "Copied" for a moment rather than nothing.
   */
  it('copies the stored file from the corner button and says so', async () => {
    copyAttachment.mockClear();
    const doc = '![scan](<files/my scan.jpg>)\n\nplain';
    const v = mountWithAttachments(doc, doc.length);
    const button = v.dom.querySelector<HTMLButtonElement>('.cm-md-image .zoom-copy');
    expect(button?.getAttribute('aria-label')).toBe('Copy');
    button?.click();
    expect(copyAttachment).toHaveBeenCalledWith('my scan.jpg', 'image');
    await new Promise((r) => setTimeout(r, 0));
    expect(button?.getAttribute('aria-label')).toBe('Copied');
    expect(v.state.doc.toString()).toBe(doc);
  });

  /**
   * A remote picture is not a stored file: nothing of the note's to copy, and no download,
   * which a browser would turn into a tab across origins. In their place, the one thing
   * to do with a web image: bring it in.
   */
  it('offers save instead of copy and download for a remote image', () => {
    const doc = '![web](https://example.com/a.png)\n\nplain';
    const v = mountWithAttachments(doc, doc.length);
    const tools = [...v.dom.querySelectorAll('.cm-md-image .attachment-tool')].map((t) =>
      t.getAttribute('aria-label'),
    );
    expect(tools).toEqual(['Full screen', 'Save to note', 'Remove from note']);
  });

  /** No file behind a remote image, so its bin is an ordinary edit: gone at once, ⌘Z undoes. */
  it('removes a remote image from the note without asking', () => {
    deleteAttachment.mockClear();
    const doc = 'before\n\n![web](https://example.com/a.png)\n\nafter';
    const v = mountWithAttachments(doc, doc.length);
    v.dom.querySelector<HTMLButtonElement>('.cm-md-image .zoom-remove')?.click();
    expect(v.state.doc.toString()).toBe('before\n\nafter');
    expect(deleteAttachment).not.toHaveBeenCalled();
  });

  /** Saving rewrites the picture's own markdown to the stored file, keeping its alt. */
  it('saves a web image and points the markdown at the stored file', async () => {
    saveRemoteImage.mockClear();
    const doc = 'intro\n\n![web pic](https://example.com/a.png)\n\nplain';
    const v = mountWithAttachments(doc, 0);
    v.dom.querySelector<HTMLButtonElement>('.cm-md-image .zoom-save')?.click();
    expect(saveRemoteImage).toHaveBeenCalledWith('https://example.com/a.png');
    await new Promise((r) => setTimeout(r, 0));
    expect(v.state.doc.toString()).toBe('intro\n\n![web pic](files/saved.png)\n\nplain');
  });

  it('leaves an escaped alt and a title as written when it saves', async () => {
    saveRemoteImage.mockClear();
    const doc = '![Scan \\[1\\] my\\_pic](https://example.com/a.png "shot")';
    const v = mountWithAttachments(doc, 0);
    v.dom.querySelector<HTMLButtonElement>('.cm-md-image .zoom-save')?.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(v.state.doc.toString()).toBe('![Scan \\[1\\] my\\_pic](files/saved.png "shot")');
  });

  /**
   * The editor is rebuilt on a rich/source switch, and CodeMirror takes a dispatch to a
   * destroyed view silently. The fetch finishes after a switch here, and the stored copy
   * must be written into the editor that is live then, found by its address since that
   * editor has no DOM of the pressed widget's.
   */
  it('writes the stored file into the editor open when the fetch lands, not the one at the press', async () => {
    let finish: (filename: string) => void = () => {};
    saveRemoteImage.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const doc = 'intro\n\n![web pic](https://example.com/a.png)\n\nplain';
    const views = { current: null as EditorView | null };
    const pressed = mountWithAttachments(doc, 0, [], true, () => views.current);
    views.current = pressed;
    pressed.dom.querySelector<HTMLButtonElement>('.cm-md-image .zoom-save')?.click();
    expect(saveRemoteImage).toHaveBeenCalledWith('https://example.com/a.png');

    pressed.destroy();
    const live = mountWithAttachments(doc, 0);
    views.current = live;
    finish('saved.png');
    await new Promise((r) => setTimeout(r, 0));
    expect(live.state.doc.toString()).toBe('intro\n\n![web pic](files/saved.png)\n\nplain');
  });

  /**
   * Image widgets only exist in the viewport. Scrolling the picture off-screen destroys
   * its DOM while the same EditorView is still open, and `posAtDOM` on the detached host
   * does not throw: it answers the start or the end of the document. Finding the picture
   * from that host then rewrites whichever image sits there, which may not be the one
   * that was saved. The stored copy is found by its address instead, as a remount is.
   */
  it('writes the stored file by address when the pressed widget is gone from the same view', async () => {
    let finish: (filename: string) => void = () => {};
    saveRemoteImage.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const doc = '![save](https://example.com/save.png)\n\nplain\n\n![keep](https://example.com/keep.png)';
    const v = mountWithAttachments(doc, doc.indexOf('plain'));
    const widgets = v.dom.querySelectorAll('.cm-md-image');
    expect(widgets).toHaveLength(2);
    const host = widgets[0] as HTMLElement;
    host.querySelector<HTMLButtonElement>('.zoom-save')?.click();
    expect(saveRemoteImage).toHaveBeenCalledWith('https://example.com/save.png');
    // Leave the viewport empty and repaint: the same thing scrolling the picture
    // off-screen does, and the host is then gone from the view.
    vi.spyOn(v, 'visibleRanges', 'get').mockReturnValue([]);
    v.dispatch({ effects: pdfNamesChanged.of(null) });
    finish('saved.png');
    await new Promise((r) => setTimeout(r, 0));
    expect(v.state.doc.toString()).toBe(
      '![save](files/saved.png)\n\nplain\n\n![keep](https://example.com/keep.png)',
    );
  });

  it('keeps the web link when the save fails', async () => {
    saveRemoteImage.mockRejectedValueOnce(new Error('403'));
    const doc = '![web](https://example.com/a.png)\n\nplain';
    const v = mountWithAttachments(doc, doc.length);
    const button = v.dom.querySelector<HTMLButtonElement>('.cm-md-image .zoom-save');
    button?.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(v.state.doc.toString()).toBe(doc);
    expect(button?.getAttribute('aria-label')).toBe('Couldn’t save');
  });

  /** A real link, so the browser saves the file itself; named for the stored file. */
  it('downloads the stored file from the toolbar', () => {
    const doc = '![scan](<files/my scan.jpg>)\n\nplain';
    const v = mountWithAttachments(doc, doc.length);
    const link = v.dom.querySelector<HTMLAnchorElement>('.cm-md-image a.zoom-download');
    expect(link?.getAttribute('href')).toBe('/api/notes/n1/files/my scan.jpg?download=1');
    expect(link?.getAttribute('download')).toBe('my scan.jpg');
  });

  const question = (v: EditorView) =>
    v.dom.querySelector<HTMLElement>('.cm-md-image .attachment-tools-question')?.textContent;
  const answer = (v: EditorView, label: string) =>
    [...v.dom.querySelectorAll<HTMLButtonElement>('.cm-md-image .attachment-tool-confirm')]
      .find((b) => b.textContent === label)
      ?.click();

  /**
   * The bin on a stored picture deletes the file, confirmed in the pill itself. The
   * markdown is the caller's to take out once the file has gone, into whichever editor
   * is open then (`deleteStored` says why this one cannot), so the document is left as
   * it was here; `Workspace.delete-file.test.tsx` has the picture coming out.
   */
  it('asks in place, then deletes the file and leaves the picture to the caller', async () => {
    deleteAttachment.mockClear();
    const doc = 'before\n\n![scan](<files/my scan.jpg>)\n\nafter';
    const v = mountWithAttachments(doc, doc.length);
    v.dom.querySelector<HTMLButtonElement>('.cm-md-image .zoom-remove')?.click();
    expect(question(v)).toBe('Delete file?');
    expect(v.state.doc.toString()).toBe(doc);
    answer(v, 'Delete');
    expect(deleteAttachment).toHaveBeenCalledWith('my scan.jpg');
    await new Promise((r) => setTimeout(r, 0));
    expect(v.state.doc.toString()).toBe(doc);
  });

  it('puts the toolbar back on Cancel and on Escape', () => {
    const doc = '![scan](files/scan.jpg)\n\nplain';
    const v = mountWithAttachments(doc, doc.length);
    const bin = () => v.dom.querySelector<HTMLButtonElement>('.cm-md-image .zoom-remove');
    bin()?.click();
    answer(v, 'Cancel');
    expect(question(v)).toBeUndefined();
    expect(bin()).not.toBeNull();
    bin()?.click();
    v.dom
      .querySelector('.cm-md-image .attachment-tools')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(question(v)).toBeUndefined();
    expect(v.state.doc.toString()).toBe(doc);
  });

  /** A delete the server refused leaves the picture and its link as they were. */
  it('keeps the picture when the delete fails', async () => {
    deleteAttachment.mockRejectedValueOnce(new Error('offline'));
    const doc = '![scan](files/scan.jpg)\n\nplain';
    const v = mountWithAttachments(doc, doc.length);
    v.dom.querySelector<HTMLButtonElement>('.cm-md-image .zoom-remove')?.click();
    answer(v, 'Delete');
    await new Promise((r) => setTimeout(r, 0));
    expect(v.state.doc.toString()).toBe(doc);
    expect(v.dom.querySelector('.cm-md-image .zoom-remove')?.getAttribute('aria-label')).toBe(
      'Couldn’t delete',
    );
  });

  it('removes only a remote picture when text shares its line', () => {
    const doc = 'see ![web](https://example.com/a.png) here';
    const v = mountWithAttachments(doc, 0);
    v.dom.querySelector<HTMLButtonElement>('.cm-md-image .zoom-remove')?.click();
    expect(v.state.doc.toString()).toBe('see  here');
  });

  /**
   * The same rule as a PDF page and as the preview pane: a click on the picture opens it.
   * The markdown it stands in for is reached by arrowing onto the line, as every other
   * hidden syntax is, so opening must not reveal it.
   */
  it('opens the viewer from a click on the picture', () => {
    openAttachmentViewer.mockClear();
    const doc = '![scan](files/scan.jpg)\n\nplain';
    const v = mountWithAttachments(doc, doc.length);
    image(v)?.click();
    expect(openAttachmentViewer).toHaveBeenCalledTimes(1);
    expect(openAttachmentViewer.mock.calls.at(-1)?.[0]).toEqual({
      kind: 'image',
      src: '/api/notes/n1/files/scan.jpg',
      alt: 'scan',
    });
    expect(v.state.doc.toString()).toBe(doc);
    expect(visibleText(v, 1)).toBe('scan');
  });

  /**
   * The alt is kept the way a link keeps its label: a caption, and a place to click before
   * the picture. Only the `![` and `](url)` around it hide; the picture draws after it.
   */
  it('keeps the alt as a caption with the cursor elsewhere', () => {
    const doc = '![scan](files/scan.jpg)\n\nplain';
    const v = mountWithAttachments(doc, doc.length);
    expect(visibleText(v, 1)).toBe('scan');
    // Its own caption style, not the link label's (see `.cm-md-image-alt`).
    expect(v.dom.querySelector('.cm-md-image-alt')?.textContent).toBe('scan');
    expect(v.dom.querySelector('.cm-md-link')).toBeNull();
    expect(image(v)).not.toBeNull();
    // The alt is a caption, not the source: the line still keeps its text height.
    expect(lineClasses(v, 1)).not.toContain('cm-md-image-line');
  });

  /**
   * The bug this fixes: a click at the end of the caption put the caret after the alt,
   * which on the revealed line is the middle of `![alt](url)`, between `alt` and `](`.
   * The hidden syntax has no width, so the click could not have meant that seam; the
   * caret belongs at the end of the whole markdown. See `snapCaptionCaret`.
   *
   * A pointer can only be stubbed here (jsdom lays nothing out), so the test dispatches
   * the selection the click would have produced, tagged as the pointer event it was.
   */
  describe('a caret put on the edge of a caption', () => {
    const doc = '![scan](files/scan.jpg)\n\nplain';
    const altStart = 2;
    const altEnd = altStart + 'scan'.length;
    const imageEnd = '![scan](files/scan.jpg)'.length;

    function placeCaret(v: EditorView, pos: number, userEvent = 'select.pointer'): void {
      v.dispatch({ selection: EditorSelection.cursor(pos), userEvent });
    }

    it('lands at the end of the markdown from the caption\'s right edge', () => {
      const v = mountWithAttachments(doc, doc.length);
      placeCaret(v, altEnd);
      expect(v.state.selection.main.head).toBe(imageEnd);
      // The line reveals around it, with the caret at its end, not inside it.
      expect(visibleText(v, 1)).toBe('![scan](files/scan.jpg)');
    });

    it('lands at the start of the markdown from the caption\'s left edge', () => {
      const v = mountWithAttachments(doc, doc.length);
      placeCaret(v, altStart);
      expect(v.state.selection.main.head).toBe(0);
    });

    it('still edits the alt from a click inside the caption', () => {
      const v = mountWithAttachments(doc, doc.length);
      placeCaret(v, altStart + 2);
      expect(v.state.selection.main.head).toBe(altStart + 2);
    });

    /** The same tap on a phone arrives as a plain selection read back from the DOM. */
    it('snaps a caret placed by touch too', () => {
      const v = mountWithAttachments(doc, doc.length);
      placeCaret(v, altEnd, 'select');
      expect(v.state.selection.main.head).toBe(imageEnd);
    });

    /**
     * The sidebar's arrow keys mount the note unfocused with a phantom caret at 0, which
     * is on this very line; the caption is drawn all the same, so a click still snaps.
     */
    it('snaps when the unfocused caret was already on the line', () => {
      const v = mountWithAttachments(doc, 0, [], false);
      expect(v.dom.querySelector('.cm-md-image-alt')).not.toBeNull();
      placeCaret(v, altEnd);
      expect(v.state.selection.main.head).toBe(imageEnd);
    });

    /** Once revealed there is no caption, and the seam is a real place to put the caret. */
    it('leaves the caret alone once the markdown is revealed', () => {
      const v = mountWithAttachments(doc, imageEnd);
      expect(v.dom.querySelector('.cm-md-image-alt')).toBeNull();
      placeCaret(v, altEnd);
      expect(v.state.selection.main.head).toBe(altEnd);
    });

    it('keeps a dragged range that ends on the edge', () => {
      const v = mountWithAttachments(doc, doc.length);
      v.dispatch({
        selection: EditorSelection.range(doc.length, altEnd),
        userEvent: 'select.pointer',
      });
      expect(v.state.selection.main.head).toBe(altEnd);
      expect(v.state.selection.main.anchor).toBe(doc.length);
    });
  });

  /** The destination is plumbing: dimmed to the brackets' strength, see `imageDestination`. */
  it('dims a revealed destination further than a link\'s', () => {
    const doc = '![scan](files/scan.jpg)';
    const v = mountWithAttachments(doc, doc.length);
    const url = v.dom.querySelector('.cm-md-image-url');
    expect(url?.textContent).toBe('files/scan.jpg');
    expect(url?.classList.contains('cm-md-url')).toBe(true);
    expect(v.dom.querySelector('.cm-md-image-alt')).toBeNull();
  });

  /**
   * With no alt there is nothing to keep and nowhere to caption; the whole `![](url)` is
   * replaced by the picture, and its line collapses to the picture's height.
   */
  it('hides the whole source of an alt-less image with the cursor elsewhere', () => {
    const doc = '![](files/scan.jpg)\n\nplain';
    const v = mountWithAttachments(doc, doc.length);
    expect(visibleText(v, 1)).toBe('');
    expect(image(v)).not.toBeNull();
    expect(lineClasses(v, 1)).toContain('cm-md-image-line');
  });

  it('reveals the source with the cursor on its line', () => {
    const doc = '![scan](files/scan.jpg)\n\nplain';
    const v = mountWithAttachments(doc, 3);
    expect(visibleText(v, 1)).toBe('![scan](files/scan.jpg)');
    expect(image(v)).not.toBeNull();
  });

  it('reveals the source again when the cursor arrives', () => {
    const doc = '![scan](files/scan.jpg)\n\nplain';
    const v = mountWithAttachments(doc, doc.length);
    v.dispatch({ selection: EditorSelection.cursor(2) });
    expect(visibleText(v, 1)).toBe('![scan](files/scan.jpg)');
  });

  it('never rewrites the document', () => {
    const doc = '![scan](files/scan.jpg)\n\nplain';
    const v = mountWithAttachments(doc, doc.length);
    expect(v.state.doc.toString()).toBe(doc);
  });

  /**
   * Hidden text keeps its line box; an alt-less image whose line collapses to nothing has to
   * give that height up too. (An image with an alt keeps the alt caption, and its height:
   * see 'keeps the alt as a caption'.)
   */
  it('collapses a line that holds only an alt-less image', () => {
    const doc = '![](files/scan.jpg)\n\nplain';
    const v = mountWithAttachments(doc, doc.length);
    expect(lineClasses(v, 1)).toContain('cm-md-image-line');
  });

  it('keeps the height of a line that also holds text', () => {
    const doc = 'Receipt: ![scan](files/scan.jpg)\n\nplain';
    const v = mountWithAttachments(doc, doc.length);
    // The leading text plus the image's own alt caption; only the `![`/`](url)` are hidden.
    expect(visibleText(v, 1)).toBe('Receipt: scan');
    expect(lineClasses(v, 1)).not.toContain('cm-md-image-line');
  });

  it('does not collapse the line while the source is revealed', () => {
    const v = mountWithAttachments('![scan](files/scan.jpg)\n\nplain', 3);
    expect(lineClasses(v, 1)).not.toContain('cm-md-image-line');
  });

  /**
   * With the source revealed the line keeps its height for the text, so the collapse that
   * hides the trailing break on an image-only line is off. The break itself is hidden, so a
   * focused image gets no extra line under it (see the `.cm-md-image + br` theme rule).
   */
  it('hides the trailing break under a revealed image', () => {
    const v = mountWithAttachments('![scan](files/scan.jpg)\n\nplain', 3);
    const br = v.dom.querySelector('.cm-md-image + br') as HTMLElement | null;
    expect(br).not.toBeNull();
    expect(getComputedStyle(br!).display).toBe('none');
  });

  /** A remote image loads at its own address, matching what the preview pane renders. */
  it('draws a remote image at its own URL', () => {
    const doc = '![logo](https://example.com/logo.png)\n\nplain';
    const v = mountWithAttachments(doc, doc.length);
    expect(image(v)?.getAttribute('src')).toBe('https://example.com/logo.png');
    expect(image(v)?.alt).toBe('logo');
    expect(visibleText(v, 1)).toBe('logo');
  });

  /** No resolver is needed for a remote image: its address is already absolute. */
  it('draws a remote image without an attachment resolver', () => {
    const doc = '![logo](https://example.com/logo.png)\n\nplain';
    const v = mount(doc, doc.length);
    expect(image(v)?.getAttribute('src')).toBe('https://example.com/logo.png');
  });

  /**
   * The sanitizer strips a `data:` image src in preview; the editor sets `img.src` itself,
   * so it applies the same http(s)-only rule rather than drawing whatever the note wrote.
   */
  it('leaves a data-URL image as source', () => {
    const doc = '![x](data:image/png;base64,AAAA)\n\nplain';
    const v = mountWithAttachments(doc, doc.length);
    expect(visibleText(v, 1)).toBe('![x](data:image/png;base64,AAAA)');
    expect(image(v)).toBeNull();
  });

  /** An attachment still needs a resolver; without one the source stays visible. */
  it('leaves the source visible when no resolver is configured', () => {
    const doc = '![scan](files/scan.jpg)\n\nplain';
    const v = mount(doc, doc.length);
    expect(visibleText(v, 1)).toBe('![scan](files/scan.jpg)');
    expect(image(v)).toBeNull();
  });

  /**
   * A missing attachment used to leave nothing but its source; hiding that too would leave
   * nothing at all. The failure has to bring the text back on its own: no keystroke or
   * selection change is coming to trigger a rebuild.
   */
  it('brings the source back when the image fails to load', () => {
    const doc = '![scan](files/missing.jpg)\n\nplain';
    const v = mountWithAttachments(doc, doc.length);
    // Before the failure only the alt caption shows; the full source is hidden.
    expect(visibleText(v, 1)).toBe('scan');

    image(v)!.dispatchEvent(new Event('error'));

    expect(visibleText(v, 1)).toBe('![scan](files/missing.jpg)');
    expect(lineClasses(v, 1)).not.toContain('cm-md-image-line');
    expect(image(v)).toBeNull();
  });

  /**
   * Offline, nothing is missing: the file is in the account and not on this device. The
   * picture's place says so, the source stays hidden, and nothing is remembered as failed,
   * so the picture is simply asked for again when the connection returns.
   */
  it('says the picture is not available offline rather than bringing the source back', () => {
    const doc = '![scan](files/elsewhere.jpg)\n\nplain';
    const v = mountWithAttachments(doc, doc.length);
    setReachableForTests(false);
    try {
      image(v)!.dispatchEvent(new Event('error'));

      expect(v.dom.querySelector('.file-unavailable')?.textContent).toBe('Not available offline');
      expect(image(v)!.hidden).toBe(true);
      expect(visibleText(v, 1)).not.toContain('![scan]');
      // Nothing in the toolbar could work, and it would draw over the line.
      const tools = v.dom.querySelector<HTMLElement>('.cm-md-image .attachment-tools')!;
      expect(tools.style.display).toBe('none');

      setReachableForTests(true);
      expect(v.dom.querySelector('.file-unavailable')).toBeNull();
      expect(image(v)!.hidden).toBe(false);
      image(v)!.dispatchEvent(new Event('load'));
      expect(tools.style.display).toBe('');
    } finally {
      resetConnectivity();
    }
  });

  /** The failure outlives the widget, which is rebuilt on every scroll. */
  it('remembers the failure across a rebuild', () => {
    const doc = '![scan](files/missing.jpg)\n\nplain';
    const v = mountWithAttachments(doc, doc.length);
    image(v)!.dispatchEvent(new Event('error'));

    v.dispatch({ changes: { from: doc.length, insert: ' more' } });

    expect(visibleText(v, 1)).toBe('![scan](files/missing.jpg)');
    expect(image(v)).toBeNull();
  });
});

/**
 * Down from the end of a note that ends in a picture opens a line under it: the only way
 * to get the caret below an image or a PDF that is the last thing in a note.
 */
describe('a line below a closing picture', () => {
  beforeEach(() => resetFailedImages());

  const down = (v: EditorView) =>
    v.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));

  it('opens a line below an image that ends the note', () => {
    const doc = '![photo.png](files/photo.png)';
    const v = mountWithAttachments(doc, doc.length);
    down(v);
    expect(v.state.doc.toString()).toBe(`${doc}\n`);
    expect(v.state.selection.main.head).toBe(doc.length + 1);
  });

  /** So the editor keeps it from the autosave; see `caretRoom`. */
  it('marks the opened line as room for the caret', () => {
    const doc = '![photo.png](files/photo.png)';
    const v = mountWithAttachments(doc, doc.length);
    const marked: boolean[] = [];
    v.dispatch({
      effects: StateEffect.appendConfig.of(
        EditorView.updateListener.of((u) => {
          for (const tr of u.transactions) if (tr.docChanged) marked.push(tr.annotation(caretRoom) === true);
        }),
      ),
    });
    down(v);
    expect(marked).toEqual([true]);
  });

  it('opens a line below an image with no alt, which the picture replaces', () => {
    const doc = 'intro\n![](files/photo.png)';
    const v = mountWithAttachments(doc, doc.length, [], false);
    v.dispatch({ selection: EditorSelection.cursor(doc.length) });
    down(v);
    expect(v.state.doc.toString()).toBe(`${doc}\n`);
  });

  it('opens a line below a PDF that ends the note', () => {
    const doc = '[scan.pdf](files/scan.pdf)';
    const v = mountWithAttachments(doc, doc.length, ['scan.pdf']);
    down(v);
    expect(v.state.doc.toString()).toBe(`${doc}\n`);
  });

  /** Its end is its bottom; Down there is the editor's own, and changes nothing. */
  it('leaves a note ending in text alone', () => {
    const doc = '![photo.png](files/photo.png)\nand a caption';
    const v = mountWithAttachments(doc, doc.length);
    down(v);
    expect(v.state.doc.toString()).toBe(doc);
  });

  it('leaves the note alone when the caret is not at its end', () => {
    const doc = '![photo.png](files/photo.png)';
    const v = mountWithAttachments(doc, 3);
    down(v);
    expect(v.state.doc.toString()).toBe(doc);
  });

  /** A broken image draws no picture and shows its source, so there is nothing to get below. */
  it('leaves the note alone when the image failed to load', () => {
    const doc = '![photo.png](files/photo.png)';
    const v = mountWithAttachments(doc, doc.length);
    v.dom.querySelector<HTMLImageElement>('.cm-md-image img')?.dispatchEvent(new Event('error'));
    expect(v.dom.querySelector('.cm-md-image img')).toBeNull();
    down(v);
    expect(v.state.doc.toString()).toBe(doc);
  });

  const room = (v: EditorView) => v.contentDOM.classList.contains('cm-md-room-below');
  const press = (v: EditorView, clientY: number) =>
    v.contentDOM.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientY, bubbles: true, cancelable: true }));

  it('leaves room below a picture that ends the note, and only then', () => {
    const doc = '![photo.png](files/photo.png)';
    const v = mountWithAttachments(doc, 0);
    expect(room(v)).toBe(true);
    v.dispatch({ changes: { from: doc.length, insert: '\nand a caption' } });
    expect(room(v)).toBe(false);
  });

  /** A tap under the picture is how a phone, which has no Down key, gets there. */
  it('opens a line for a press below the picture, wherever the caret was', () => {
    const doc = '![photo.png](files/photo.png)';
    const v = mountWithAttachments(doc, 0);
    press(v, 100_000);
    expect(v.state.doc.toString()).toBe(`${doc}\n`);
    expect(v.state.selection.main.head).toBe(doc.length + 1);
    expect(room(v)).toBe(false);
  });

  it('leaves a press on the picture itself alone', () => {
    const doc = '![photo.png](files/photo.png)';
    const v = mountWithAttachments(doc, 0);
    press(v, -100_000);
    expect(v.state.doc.toString()).toBe(doc);
  });

  /** The blank column under a note on a phone, which is outside the editor. */
  it('opens the line for a press on the column below, and only places the caret below text', () => {
    const doc = '![photo.png](files/photo.png)';
    const v = mountWithAttachments(doc, 0);
    caretBelowEnd(v);
    expect(v.state.doc.toString()).toBe(`${doc}\n`);
    expect(v.state.selection.main.head).toBe(doc.length + 1);

    v.dispatch(v.state.replaceSelection('text'));
    v.dispatch({ selection: EditorSelection.cursor(0) });
    caretBelowEnd(v);
    expect(v.state.doc.toString()).toBe(`${doc}\ntext`);
    expect(v.state.selection.main.head).toBe(v.state.doc.length);
  });

  it('puts the caret on the new line, so typing lands below the picture', () => {
    const doc = '![photo.png](files/photo.png)';
    const v = mountWithAttachments(doc, doc.length);
    down(v);
    v.dispatch(v.state.replaceSelection('below'));
    expect(v.state.doc.toString()).toBe(`${doc}\nbelow`);
  });
});

/**
 * What the viewer pages through: every attachment the editor would draw, in the order
 * the note has them, whether or not its line is anywhere near the viewport.
 */
describe('attachment set', () => {
  const options = {
    resolveAttachment: (name: string) => `/api/notes/n1/files/${name}`,
    isPdfAttachment: (name: string) => name === 'Menu Card',
  };

  const note = [
    '# Trip',
    '![front](files/front.jpg)',
    'notes',
    '[receipt](<files/Receipt 1.pdf>)',
    '![logo](https://example.com/logo.png)',
    '[menu](<files/Menu Card>)',
    '[sheet](files/budget.xlsx)',
    '![bad](data:image/png;base64,AAAA)',
    '![back](files/back.jpg)',
  ].join('\n\n');

  beforeEach(() => resetFailedImages());

  it('lists images and PDFs in reading order', () => {
    const v = mountWithAttachments(note, 0, ['Menu Card']);
    expect(collectAttachmentTargets(v.state, options)).toEqual([
      { kind: 'image', src: '/api/notes/n1/files/front.jpg', alt: 'front' },
      { kind: 'pdf', src: '/api/notes/n1/files/Receipt 1.pdf', label: 'receipt' },
      { kind: 'image', src: 'https://example.com/logo.png', alt: 'logo' },
      { kind: 'pdf', src: '/api/notes/n1/files/Menu Card', label: 'menu' },
      { kind: 'image', src: '/api/notes/n1/files/back.jpg', alt: 'back' },
    ]);
  });

  it('lists nothing without a resolver but remote images', () => {
    const v = mount(note, 0);
    expect(collectAttachmentTargets(v.state, {})).toEqual([
      { kind: 'image', src: 'https://example.com/logo.png', alt: 'logo' },
    ]);
  });

  it('hands the set to the viewer with the clicked attachment', () => {
    openAttachmentViewer.mockClear();
    const v = mountWithAttachments(note, note.length, ['Menu Card']);
    v.dom.querySelector<HTMLImageElement>('.cm-md-image img')?.click();
    expect(openAttachmentViewer).toHaveBeenCalledTimes(1);
    const [target, siblings] = openAttachmentViewer.mock.calls[0] as [unknown, unknown[]];
    expect(target).toEqual({ kind: 'image', src: '/api/notes/n1/files/front.jpg', alt: 'front' });
    expect(siblings).toHaveLength(5);
  });
});

describe('block-level reveal', () => {
  const two = 'a **bold** and _italic_ here';

  it('reveals both marks with the cursor in the first', () => {
    const v = mount(two, 5);
    expect(visibleText(v, 1)).toBe(two);
  });

  it('reveals both marks with the cursor in the second', () => {
    const v = mount(two, two.indexOf('italic') + 1);
    expect(visibleText(v, 1)).toBe(two);
  });

  /** Between the two, touching neither span: the old per-node scope hid both here. */
  it('reveals both marks with the cursor between them', () => {
    const v = mount(two, two.indexOf('and') + 1);
    expect(visibleText(v, 1)).toBe(two);
  });

  it('hides both when the cursor is on another line', () => {
    const doc = `${two}\n\nplain`;
    const v = mount(doc, doc.length);
    expect(visibleText(v, 1)).toBe('a bold and italic here');
  });

  /**
   * A list is one node covering every item, so an unclamped walk to the top would reveal
   * the whole list from a cursor in any single item.
   */
  it('reveals only the item the cursor is in', () => {
    const doc = '- **one**\n- **two**';
    const v = mount(doc, 4);
    expect(visibleText(v, 1)).toContain('**one**');
    expect(visibleText(v, 2)).not.toContain('**');
  });

  /**
   * `remark-breaks` makes a single newline a line break, so consecutive lines are one
   * Paragraph to CommonMark but separate lines on screen. Revealing the whole node would
   * reflow a line the user is not editing.
   */
  it('does not reveal a sibling line of the same paragraph', () => {
    const doc = '**one** line\n_two_ line';
    const v = mount(doc, 3);
    expect(visibleText(v, 1)).toBe('**one** line');
    expect(visibleText(v, 2)).toBe('two line');
  });
});

describe('fenced code blocks', () => {
  const doc = '```js\nconst x = 1;\nconst y = 2;\n```';
  /** The block plus somewhere outside it to park the cursor. */
  const away = `${doc}\n\nplain`;

  /** Every line of the run carries the background, not just the first. */
  it('marks every line of the block', () => {
    const v = mount(away, away.length);
    for (let n = 1; n <= 4; n += 1) {
      expect(lineClasses(v, n)).toContain('cm-md-codeblock');
    }
  });

  it('rounds only the ends', () => {
    const v = mount(away, away.length);
    expect(lineClasses(v, 1)).toContain('cm-md-codeblock-first');
    expect(lineClasses(v, 2)).not.toContain('cm-md-codeblock-first');
    expect(lineClasses(v, 2)).not.toContain('cm-md-codeblock-last');
    expect(lineClasses(v, 4)).toContain('cm-md-codeblock-last');
  });

  /**
   * Raw backticks left in the slab read as an artifact rather than as syntax: the opening
   * fence sits on its own line above a gap, and its closing partner is often scrolled out
   * of view, so the block looks broken. Typora shows the language in the corner instead.
   */
  it('hides both fence rows with the cursor elsewhere', () => {
    const full = `${doc}\n\nplain`;
    const v = mount(full, full.length);
    expect(visibleText(v, 1)).not.toContain('```');
    expect(visibleText(v, 4)).not.toContain('```');
  });

  it('hides the info string along with its fence', () => {
    const full = `${doc}\n\nplain`;
    const v = mount(full, full.length);
    expect(visibleText(v, 1)).not.toContain('js');
  });

  /** The language still has to be visible somewhere, or the block loses information. */
  it('shows the language as a corner label', () => {
    const full = `${doc}\n\nplain`;
    const v = mount(full, full.length);
    const labelled = v.dom.querySelector('.cm-md-codeblock-labelled');
    expect(labelled?.getAttribute('data-language')).toBe('js');
  });

  /**
   * The label hangs off a row that is actually on screen. Putting it on the opening fence
   * clipped it away: that row is collapsed to zero height with `overflow: hidden`, so the
   * language rendered and was then invisible.
   */
  it('puts the label on a row that is not collapsed', () => {
    const full = `${doc}\n\nplain`;
    const v = mount(full, full.length);
    const labelled = v.dom.querySelector('.cm-md-codeblock-labelled');
    expect(labelled?.classList.contains('cm-md-codeblock-fence')).toBe(false);
  });

  /** Same rule as every other mark: the cursor inside brings the real syntax back. */
  it('reveals the fences with the cursor inside the block', () => {
    const v = mount(doc, doc.indexOf('const x') + 2);
    expect(visibleText(v, 1)).toContain('```');
    expect(visibleText(v, 1)).toContain('js');
    expect(visibleText(v, 4)).toContain('```');
  });

  /**
   * A block being typed has no closing fence yet. Hiding its last line on the assumption
   * that one exists would swallow a line of real code.
   */
  it('does not hide the last line of an unterminated block', () => {
    const open = '```js\nconst x = 1;';
    const v = mount(open, 0);
    expect(visibleText(v, 2)).toContain('const x = 1;');
  });

  /**
   * Typing ``` opens a `FencedCode` node on that keystroke, so painting the slab as soon
   * as the node exists wrapped backticks the user was mid-way through typing.
   */
  it('leaves a just-typed fence as plain text', () => {
    const v = mount('```', 3);
    expect(lineClasses(v, 1)).not.toContain('cm-md-codeblock');
    expect(visibleText(v, 1)).toBe('```');
  });

  it('leaves a fence being given a language as plain text', () => {
    const v = mount('```ts', 5);
    expect(lineClasses(v, 1)).not.toContain('cm-md-codeblock');
    expect(visibleText(v, 1)).toBe('```ts');
  });

  /**
   * Moving off the fence is what forms the block, the way Typora does it. The backticks
   * are still shown here because the cursor is inside the block (the ordinary reveal
   * rule), but the slab is now drawn, which is the change from a bare line of text.
   */
  it('draws the slab once the cursor leaves the fence row', () => {
    const doc2 = '```ts\nfoo';
    const v = mount(doc2, doc2.length);
    expect(lineClasses(v, 1)).toContain('cm-md-codeblock');
    expect(lineClasses(v, 2)).toContain('cm-md-codeblock');
  });

  /**
   * Per row, not per block: while a block is still being written, a cursor on its opening
   * fence must not strip the slab from the code already typed below it.
   */
  it('keeps the slab on code rows while typing an unterminated fence', () => {
    const v = mount('```ts\nconst x = 1;', 2);
    expect(lineClasses(v, 1)).not.toContain('cm-md-codeblock');
    expect(lineClasses(v, 2)).toContain('cm-md-codeblock');
  });

  /**
   * Once the block is closed it is formed, so the caret on a fence reveals its backticks
   * inside the slab rather than dropping the row out of the block, which left the
   * closing fence hanging below an unrounded edge.
   */
  it('keeps a closed block whole with the cursor on its closing fence', () => {
    const v = mount(doc, doc.length);
    expect(lineClasses(v, 4)).toContain('cm-md-codeblock');
    expect(lineClasses(v, 4)).toContain('cm-md-codeblock-last');
    expect(visibleText(v, 4)).toContain('```');
  });

  it('hides a fence with no language', () => {
    const plain = '```\ncode here\n```\n\nafter';
    const v = mount(plain, plain.length);
    expect(visibleText(v, 1)).not.toContain('```');
    expect(visibleText(v, 2)).toContain('code here');
  });

  /** Inline code is the other `CodeMark` user, and its backticks must still hide. */
  it('still hides inline code backticks', () => {
    const v = mount('a `snippet` b\n\nplain', 20);
    expect(visibleText(v, 1)).toBe('a snippet b');
  });

  it('does not mark an ordinary paragraph', () => {
    const v = mount('just text\n\nplain', 0);
    expect(lineClasses(v, 1)).not.toContain('cm-md-codeblock');
  });
});

describe('link rendering', () => {
  it('shows only the label with the cursor elsewhere', () => {
    const doc = '[Anthropic](https://anthropic.com)\n\nplain';
    const v = mount(doc, doc.length);
    expect(visibleText(v, 1)).toBe('Anthropic');
  });

  it('reveals the whole link with the cursor on its line', () => {
    const doc = '[Anthropic](https://anthropic.com)';
    const v = mount(doc, 3);
    expect(visibleText(v, 1)).toBe(doc);
  });

  /** Hiding the destination of an empty label would leave nothing on screen to find. */
  it('leaves a link with no label alone', () => {
    const doc = '[](https://anthropic.com)\n\nplain';
    const v = mount(doc, doc.length);
    expect(visibleText(v, 1)).toContain('https://anthropic.com');
  });

  it('never rewrites the document', () => {
    const doc = '[Anthropic](https://anthropic.com)\n\nplain';
    const v = mount(doc, doc.length);
    expect(v.state.doc.toString()).toBe(doc);
  });

  /** The label is styled, so a reader can tell it is a link and not plain text. */
  it('styles the label', () => {
    const doc = '[Anthropic](https://anthropic.com)\n\nplain';
    const v = mount(doc, doc.length);
    expect(v.dom.querySelector('.cm-md-link')?.textContent).toBe('Anthropic');
  });
});

describe('following links', () => {
  /**
   * What a click asked the browser to follow. The editor opens a link through a detached
   * anchor, and jsdom does not navigate, so the anchor's own click is what is recorded.
   */
  let followed: Array<{ href: string; target: string; rel: string }>;

  beforeEach(() => {
    followed = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      followed.push({ href: this.getAttribute('href') ?? '', target: this.target, rel: this.rel });
    });
    openAttachmentViewer.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete window.__unbent;
  });

  /** A press and release on the label, as a mouse or a tap delivers them. */
  function clickLabel(v: EditorView): { pressClaimed: boolean } {
    const label = v.dom.querySelector('.cm-md-link');
    expect(label).not.toBeNull();
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
    label!.dispatchEvent(press);
    label!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    return { pressClaimed: press.defaultPrevented };
  }

  it('opens a web link in a new tab from a click on its label', () => {
    const doc = '[Example](https://example.com/page)\n\nplain';
    const v = mount(doc, doc.length);
    clickLabel(v);
    expect(followed).toEqual([
      { href: 'https://example.com/page', target: '_blank', rel: 'noopener noreferrer' },
    ]);
  });

  /**
   * The Android WebView has no tabs: a `_blank` to this site used to load into the app
   * itself and destroy the page. Same-origin links go through `__unbent.open` instead,
   * the way a notification already does; off-site ones still take the new-tab path so
   * the shell can send them to a Custom Tab.
   */
  it('opens a same-origin link in place when the Android app is hosting', () => {
    const opened: string[] = [];
    window.__unbent = {
      open: (path) => {
        opened.push(path);
        return true;
      },
    };
    const href = `${window.location.origin}/notes/abc?view=table`;
    const doc = `[Other](${href})\n\nplain`;
    const v = mount(doc, doc.length);
    clickLabel(v);
    expect(opened).toEqual(['/notes/abc?view=table']);
    expect(followed).toEqual([]);
  });

  /** `open` refuses a path the Worker answers, such as an attachment's address. */
  it('falls back to a new tab when the Android app will not open a link in place', () => {
    window.__unbent = { open: () => false };
    const href = `${window.location.origin}/api/attachments/abc`;
    const doc = `[File](${href})\n\nplain`;
    const v = mount(doc, doc.length);
    clickLabel(v);
    expect(followed).toEqual([{ href, target: '_blank', rel: 'noopener noreferrer' }]);
  });

  it('still opens an off-site link in a new tab when the Android app is hosting', () => {
    window.__unbent = { open: () => true };
    const doc = '[Example](https://example.com/page)\n\nplain';
    const v = mount(doc, doc.length);
    clickLabel(v);
    expect(followed).toEqual([
      { href: 'https://example.com/page', target: '_blank', rel: 'noopener noreferrer' },
    ]);
  });

  /** Otherwise the tap would reveal `[text](url)` under the finger as the tab opened. */
  it('keeps the caret where it was', () => {
    const doc = '[Example](https://example.com)\n\nplain';
    const v = mount(doc, doc.length);
    const { pressClaimed } = clickLabel(v);
    expect(pressClaimed).toBe(true);
    expect(v.state.selection.main.head).toBe(doc.length);
    expect(visibleText(v, 1)).toBe('Example');
  });

  it('opens from an editor nobody has focused yet', () => {
    const doc = '[Example](https://example.com)';
    const v = mountWithAttachments(doc, 0, [], false);
    clickLabel(v);
    expect(followed.map((f) => f.href)).toEqual(['https://example.com']);
  });

  it('ignores a title after the destination', () => {
    const doc = '[Example](https://example.com "The example")\n\nplain';
    const v = mount(doc, doc.length);
    clickLabel(v);
    expect(followed.map((f) => f.href)).toEqual(['https://example.com']);
  });

  it('shows the destination on hover', () => {
    const doc = '[Example](<https://example.com/a b>)\n\nplain';
    const v = mount(doc, doc.length);
    expect(v.dom.querySelector('.cm-md-link')?.getAttribute('title')).toBe(
      'https://example.com/a b',
    );
  });

  /** Chrome leaves an empty tab behind for a `_blank` mail link. */
  it('hands a mail link over without a new tab', () => {
    const doc = '[Write](mailto:someone@example.com)\n\nplain';
    const v = mount(doc, doc.length);
    clickLabel(v);
    expect(followed).toEqual([{ href: 'mailto:someone@example.com', target: '', rel: '' }]);
  });

  /** The sanitizer drops these in the preview; a click here is only a click on text. */
  it('leaves a script link as text to edit', () => {
    const doc = '[Run](javascript:alert(1))\n\nplain';
    const v = mount(doc, doc.length);
    clickLabel(v);
    expect(followed).toEqual([]);
  });

  /**
   * A path from the root of the site (the sample note's links to its settings pages)
   * goes to the router in place, the way a link in the sidebar would, and claims the press
   * like any link the editor opens.
   */
  let opened: string[] = [];
  beforeEach(() => {
    opened = [];
  });
  function mountWithOpenPath(doc: string, openPath: (path: string) => boolean): EditorView {
    // `openPath` says whether the app has a page; the editor is handed the opener for it.
    const pathOpener = (path: string) => (openPath(path) ? () => opened.push(path) : undefined);
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    view = new EditorView({
      state: EditorState.create({
        doc,
        selection: EditorSelection.cursor(doc.length),
        extensions: [editorMarkdown(), richMarkdown({ pathOpener })],
      }),
      parent,
    });
    focusAt(view, doc.length);
    return view;
  }

  it('opens a path on this site in place', () => {
    const doc = '[Import](/settings/import)\n\nplain';
    const v = mountWithOpenPath(doc, () => true);
    const { pressClaimed } = clickLabel(v);
    expect(opened).toEqual(['/settings/import']);
    expect(followed).toEqual([]);
    expect(pressClaimed).toBe(true);
  });

  /**
   * A path with no page (a link carried over from another tool's export, or a stored
   * file's address) is text, as before: a new tab would only show the not-found page.
   */
  it('leaves a path the app has no page for as text', () => {
    for (const doc of ['[Note](/Folder/Note.md)\n\nplain', '[File](/api/notes/n1/files/a.txt)\n\nplain']) {
      const v = mountWithOpenPath(doc, () => false);
      clickLabel(v);
      expect(opened, doc).toEqual([]);
      expect(followed, doc).toEqual([]);
      v.destroy();
    }
  });

  it('never takes an address on another site for a path', () => {
    const doc = '[Elsewhere](//example.com/x)\n\nplain';
    const v = mountWithOpenPath(doc, () => true);
    clickLabel(v);
    expect(opened).toEqual([]);
    expect(followed).toEqual([]);
  });

  /** With nothing to open it with, a path is text, as it was before paths were followed. */
  it('leaves a path as text when there is no way to open it', () => {
    const doc = '[Import](/settings/import)\n\nplain';
    const v = mount(doc, doc.length);
    clickLabel(v);
    expect(followed).toEqual([]);
  });

  it('opens a stored PDF in the viewer', () => {
    const doc = '[Report (final) v2.pdf](<files/Report (final) v2.pdf>)\n\nplain';
    const v = mountWithAttachments(doc, doc.length);
    clickLabel(v);
    expect(followed).toEqual([]);
    expect(openAttachmentViewer).toHaveBeenCalledWith(
      { kind: 'pdf', src: '/api/notes/n1/files/Report (final) v2.pdf', label: '' },
      expect.any(Array),
    );
  });

  /**
   * Attachments are served sandboxed, so a navigation would download anyway, and in the
   * Android app a same-origin tab replaces the app.
   */
  it('downloads any other stored file', () => {
    const doc = '[Budget.xlsx](files/Budget.xlsx)\n\nplain';
    const v = mountWithAttachments(doc, doc.length);
    clickLabel(v);
    expect(followed).toEqual([
      { href: '/api/notes/n1/files/Budget.xlsx?download=1', target: '', rel: '' },
    ]);
  });

  /** Revealed, the label is text being edited: a plain click places the caret. */
  it('does not open a revealed link on a plain click', () => {
    const doc = '[Example](https://example.com)';
    const v = mount(doc, 3);
    expect(v.dom.querySelector('.cm-md-link')).toBeNull();
    expect(followed).toEqual([]);
  });

  /** The case that looked disabled: a pasted link whose text is its own address. */
  it('draws a URL used as a label as the link, not a dimmed destination', () => {
    const doc = '[https://example.com](https://example.com)\n\nplain';
    const v = mount(doc, doc.length);
    const label = v.dom.querySelector('.cm-md-link')!;
    expect(label.textContent).toBe('https://example.com');
    expect(label.closest('.cm-md-url')).toBeNull();
    expect(label.querySelector('.cm-md-url')).toBeNull();
  });

  it('dims only the destination once the link is revealed', () => {
    const doc = '[https://example.com](https://example.com/long)';
    const v = mount(doc, 3);
    const dimmed = [...v.dom.querySelectorAll('.cm-md-url')].map((e) => e.textContent);
    expect(dimmed).toEqual(['https://example.com/long']);
  });

  it('draws a bare URL as a link and opens it from a click', () => {
    const doc = 'read https://example.org/page today\n\nplain';
    const v = mount(doc, doc.length);
    const link = v.dom.querySelector('.cm-md-link');
    expect(link?.textContent).toBe('https://example.org/page');
    expect(v.dom.querySelector('.cm-md-url')).toBeNull();
    clickLabel(v);
    expect(followed.map((f) => f.href)).toEqual(['https://example.org/page']);
  });

  /** On the line being edited a bare URL is its own text, so a click places the caret. */
  it('leaves a bare URL as text on the line being edited', () => {
    const doc = 'read https://example.org/page today';
    const v = mount(doc, 2);
    expect(v.dom.querySelector('.cm-md-link')).toBeNull();
  });

  it('opens www. and email addresses the way the preview links them', () => {
    const doc = 'see www.example.com or someone@example.com\n\nplain';
    const v = mount(doc, doc.length);
    const titles = [...v.dom.querySelectorAll('.cm-md-link')].map((e) => e.getAttribute('title'));
    expect(titles).toEqual(['http://www.example.com', 'mailto:someone@example.com']);
  });

  it('hides an autolink\'s angle brackets and opens it', () => {
    const doc = '<https://example.com/x>\n\nplain';
    const v = mount(doc, doc.length);
    expect(visibleText(v, 1)).toBe('https://example.com/x');
    clickLabel(v);
    expect(followed.map((f) => f.href)).toEqual(['https://example.com/x']);
  });

  /**
   * CommonMark applies no backslash escapes inside an autolink, and the preview encodes
   * the backslash in its href; the URL parser would otherwise read it as a slash.
   */
  it('follows an autolink with a backslash where the preview does', () => {
    const doc = '<https://example.com/a\\_b>\n\nplain';
    const v = mount(doc, doc.length);
    clickLabel(v);
    expect(followed.map((f) => f.href)).toEqual(['https://example.com/a%5C_b']);
  });

  /** A backslash before a letter is no escape, so it stays, and is encoded the same way. */
  it('follows an inline link with a literal backslash where the preview does', () => {
    const doc = '[a](https://example.com/a\\b)\n\nplain';
    const v = mount(doc, doc.length);
    clickLabel(v);
    expect(followed.map((f) => f.href)).toEqual(['https://example.com/a%5Cb']);
  });

  it('keeps a middle-click from opening it', () => {
    const doc = '[Example](https://example.com)\n\nplain';
    const v = mount(doc, doc.length);
    const label = v.dom.querySelector('.cm-md-link')!;
    label.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 1 }));
    label.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 1 }));
    expect(followed).toEqual([]);
  });
});

describe('tables', () => {
  const doc = '| Month | Savings |\n| --- | ---: |\n| Jan | $250 |';
  const away = `${doc}\n\nplain`;

  it('marks header and body rows', () => {
    const v = mount(away, away.length);
    expect(lineClasses(v, 1)).toContain('cm-md-table-head');
    expect(lineClasses(v, 3)).toContain('cm-md-table-row');
    expect(lineClasses(v, 3)).not.toContain('cm-md-table-head');
  });

  /** The alignment row declares alignment; the padding already shows it. */
  it('collapses the alignment row', () => {
    const v = mount(away, away.length);
    expect(lineClasses(v, 2)).toContain('cm-md-table-align');
    expect(visibleText(v, 2)).toBe('');
  });

  /**
   * The one row that stays hidden while the rest of the table is revealed. It carries no
   * content, the toolbar owns its alignment, and editing it can only break the table.
   */
  it('keeps the alignment row collapsed with the cursor elsewhere in the table', () => {
    const v = mount(doc, doc.indexOf('Jan'));
    expect(lineClasses(v, 2)).toContain('cm-md-table-align');
    expect(visibleText(v, 2)).toBe('');
  });

  /**
   * Text the caret can reach but cannot see is text that can be deleted blind, so the row
   * the cursor is actually on is always shown.
   */
  it('reveals the alignment row when the cursor is on it', () => {
    const v = mount(doc, doc.indexOf('| ---') + 3);
    expect(lineClasses(v, 2)).not.toContain('cm-md-table-align');
    expect(visibleText(v, 2)).toContain('---');
  });

  it('bolds the header cells', () => {
    const v = mount(away, away.length);
    const cells = [...v.dom.querySelectorAll('.cm-md-th')].map((el) => el.textContent);
    expect(cells).toEqual(['Month', 'Savings']);
  });

  /** Dimmed rather than hidden: the pipes are what make the columns read as columns. */
  it('keeps the separators visible', () => {
    const v = mount(away, away.length);
    expect(visibleText(v, 1)).toContain('|');
    expect(v.dom.querySelector('.cm-md-table-pipe')).not.toBeNull();
  });

  it('never rewrites the document', () => {
    const v = mount(away, away.length);
    expect(v.state.doc.toString()).toBe(away);
  });

  /** A table still being typed is a paragraph until it parses; nothing should be styled. */
  it('does not style an incomplete table', () => {
    const partial = '| Month | Savings |\n| --- |';
    const v = mount(partial, 0);
    expect(lineClasses(v, 1)).not.toContain('cm-md-table');
  });
});
