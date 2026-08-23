import { EditorState, EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';
import { afterEach, describe, expect, it } from 'vitest';
import { richMarkdown } from './rich-markdown.js';

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
