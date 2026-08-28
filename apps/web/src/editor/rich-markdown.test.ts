import { EditorState, EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { orderedMarker, richMarkdown } from './rich-markdown.js';

/**
 * pdf.js never runs here: jsdom has no canvas rasterizer, and the widget's contract with
 * it is narrow enough to state directly. What these tests are about is which links get a
 * widget at all, and that acquire/release stay balanced.
 */
const renderPage = vi.fn(async () => {});
const acquirePdf = vi.fn(async (_url: string) => ({ pageCount: 1, renderPage, destroy: () => {} }));
const releasePdf = vi.fn((_url: string) => {});

vi.mock('../pdf/render.js', () => ({
  acquirePdf: (url: string) => acquirePdf(url),
  releasePdf: (url: string) => releasePdf(url),
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

  /** A list without its bullet is unreadable, so the mark stays. */
  it('keeps list markers visible', () => {
    const v = mount('- item\n\nplain', 10);
    expect(visibleText(v, 1)).toContain('-');
    expect(visibleText(v, 1)).toContain('item');
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

describe('inline PDF', () => {
  /** Mounts with attachment resolution on; the shared `mount` deliberately has none. */
  function mountWithAttachments(doc: string, cursor = 0): EditorView {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    view = new EditorView({
      state: EditorState.create({
        doc,
        selection: EditorSelection.cursor(cursor),
        extensions: [
          markdown({ extensions: [GFM] }),
          richMarkdown({ resolveAttachment: (name) => `/api/notes/n1/files/${name}` }),
        ],
      }),
      parent,
    });
    return view;
  }

  beforeEach(() => {
    acquirePdf.mockClear();
    releasePdf.mockClear();
  });

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
});

/**
 * Typora's rule, and what separates this from revealing one span at a time: the cursor
 * anywhere on a line shows every mark on it, so the text stops shifting under the caret
 * as it moves across.
 */
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

  /** Every line of the run carries the background, not just the first. */
  it('marks every line of the block', () => {
    const v = mount(doc, doc.length);
    for (let n = 1; n <= 4; n += 1) {
      expect(lineClasses(v, n)).toContain('cm-md-codeblock');
    }
  });

  it('rounds only the ends', () => {
    const v = mount(doc, doc.length);
    expect(lineClasses(v, 1)).toContain('cm-md-codeblock-first');
    expect(lineClasses(v, 2)).not.toContain('cm-md-codeblock-first');
    expect(lineClasses(v, 2)).not.toContain('cm-md-codeblock-last');
    expect(lineClasses(v, 4)).toContain('cm-md-codeblock-last');
  });

  /**
   * Unlike `**`, a hidden fence cannot be inferred from the rendering: the row would
   * collapse to an empty line and the language would vanish.
   */
  it('keeps the fences visible with the cursor elsewhere', () => {
    const full = `${doc}\n\nplain`;
    const v = mount(full, full.length);
    expect(visibleText(v, 1)).toContain('```');
    expect(visibleText(v, 4)).toContain('```');
  });

  it('keeps the info string visible', () => {
    const full = `${doc}\n\nplain`;
    const v = mount(full, full.length);
    expect(visibleText(v, 1)).toContain('js');
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
