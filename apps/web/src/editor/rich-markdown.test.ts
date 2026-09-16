import { EditorState, EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bulletGlyph,
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
  openAttachmentViewer: (target: unknown) => openAttachmentViewer(target),
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
      extensions: [markdown({ extensions: [GFM] }), richMarkdown()],
    }),
    parent,
  });
  return view;
}

/** Mounts with attachment resolution on; the shared `mount` deliberately has none. */
function mountWithAttachments(doc: string, cursor = 0, pdfNames: string[] = []): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const names = new Set(pdfNames);
  view = new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(cursor),
      extensions: [
        markdown({ extensions: [GFM] }),
        richMarkdown({
          resolveAttachment: (name) => `/api/notes/n1/files/${name}`,
          isPdfAttachment: (name) => names.has(name),
        }),
      ],
    }),
    parent,
  });
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

  /** A list without its bullet is unreadable, so the mark stays — as a bullet. */
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
 * from rendered geometry — with it, coordsAtPos returned null for every line beginning
 * with a hidden mark, so arrow keys could not land on them. A line hidden at both ends,
 * like `**bold**` alone, had no measurable position anywhere.
 */
describe('layout', () => {
  /**
   * Hidden syntax must stay in the layout tree.
   *
   * `display: none` removes an element from layout, and CodeMirror derives cursor
   * positions from rendered geometry — with it, coordsAtPos returned null for every line
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

  /** The link text is the caption, so it must survive alongside the rendered page. */
  it('leaves the markdown link visible', () => {
    const v = mountWithAttachments('[report](files/report.pdf)');
    expect(v.state.doc.toString()).toBe('[report](files/report.pdf)');
    expect(visibleText(v, 1)).toContain('report');
  });

  /**
   * The way to read a scan large. The control arrives with the first page rather than
   * with the widget, so it never sits on a page that has not drawn.
   */
  it('offers the full-screen viewer once the first page has drawn', async () => {
    openAttachmentViewer.mockClear();
    const v = mountWithAttachments('[report](files/report.pdf)');
    expect(v.dom.querySelector('.cm-md-pdf .zoom-btn')).toBeNull();
    await settle();
    const button = v.dom.querySelector<HTMLButtonElement>('.cm-md-pdf .zoom-btn');
    expect(button).not.toBeNull();
    expect(button?.getAttribute('aria-label')).toBe('Full screen');
    button?.click();
    expect(openAttachmentViewer).toHaveBeenCalledWith({
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
   * as the preview pane — a note that draws a document in one and a bare link in the other
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
   * decorations — without the effect the viewer would wait for the next keystroke.
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
          markdown({ extensions: [GFM] }),
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

  /**
   * The corner control is the whole affordance here: a click on the picture itself is
   * how the mouse reaches the markdown it stands in for, so it stays the editor's.
   */
  it('offers the full-screen viewer on the picture', () => {
    openAttachmentViewer.mockClear();
    const doc = '![scan](files/scan.jpg)\n\nplain';
    const v = mountWithAttachments(doc, doc.length);
    const button = v.dom.querySelector<HTMLButtonElement>('.cm-md-image .zoom-btn');
    expect(button).not.toBeNull();
    button?.click();
    expect(openAttachmentViewer).toHaveBeenCalledWith({
      kind: 'image',
      src: '/api/notes/n1/files/scan.jpg',
      alt: 'scan',
    });
    // Opening the viewer is not an edit, and must not reveal the source either.
    expect(v.state.doc.toString()).toBe(doc);
    expect(visibleText(v, 1)).toBe('');
  });

  /** The picture is the label: unlike a link there is nothing in the source worth keeping. */
  it('hides the whole source with the cursor elsewhere', () => {
    const doc = '![scan](files/scan.jpg)\n\nplain';
    const v = mountWithAttachments(doc, doc.length);
    expect(visibleText(v, 1)).toBe('');
    expect(image(v)).not.toBeNull();
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

  /** Hidden text keeps its line box; the line has to give that height up too. */
  it('collapses a line that holds only the image', () => {
    const doc = '![scan](files/scan.jpg)\n\nplain';
    const v = mountWithAttachments(doc, doc.length);
    expect(lineClasses(v, 1)).toContain('cm-md-image-line');
  });

  it('keeps the height of a line that also holds text', () => {
    const doc = 'Receipt: ![scan](files/scan.jpg)\n\nplain';
    const v = mountWithAttachments(doc, doc.length);
    expect(visibleText(v, 1)).toBe('Receipt: ');
    expect(lineClasses(v, 1)).not.toContain('cm-md-image-line');
  });

  it('does not collapse the line while the source is revealed', () => {
    const v = mountWithAttachments('![scan](files/scan.jpg)\n\nplain', 3);
    expect(lineClasses(v, 1)).not.toContain('cm-md-image-line');
  });

  /** A remote image loads at its own address, matching what the preview pane renders. */
  it('draws a remote image at its own URL', () => {
    const doc = '![logo](https://example.com/logo.png)\n\nplain';
    const v = mountWithAttachments(doc, doc.length);
    expect(image(v)?.getAttribute('src')).toBe('https://example.com/logo.png');
    expect(image(v)?.alt).toBe('logo');
    expect(visibleText(v, 1)).toBe('');
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
   * nothing at all. The failure has to bring the text back on its own — no keystroke or
   * selection change is coming to trigger a rebuild.
   */
  it('brings the source back when the image fails to load', () => {
    const doc = '![scan](files/missing.jpg)\n\nplain';
    const v = mountWithAttachments(doc, doc.length);
    expect(visibleText(v, 1)).toBe('');

    image(v)!.dispatchEvent(new Event('error'));

    expect(visibleText(v, 1)).toBe('![scan](files/missing.jpg)');
    expect(lineClasses(v, 1)).not.toContain('cm-md-image-line');
    expect(image(v)).toBeNull();
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

  /** Between the two, touching neither span — the old per-node scope hid both here. */
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
   * are still shown here because the cursor is inside the block — the ordinary reveal
   * rule — but the slab is now drawn, which is the change from a bare line of text.
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
   * inside the slab rather than dropping the row out of the block — which left the
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
