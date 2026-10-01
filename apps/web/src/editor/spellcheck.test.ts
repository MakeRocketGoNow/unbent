import { describe, it, expect, afterEach } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { ensureSyntaxTree } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';
import { proseSpellcheck } from './spellcheck.js';

/**
 * Spellcheck and the phone keyboard's corrections, which CodeMirror turns off by default.
 *
 * jsdom draws no underlines, so what is pinned is what the browser is told: the content
 * element asks for spellcheck, autocorrect and sentence capitals, and the ranges that are
 * not prose carry `spellcheck="false"` of their own.
 */
let view: EditorView | null = null;

function mount(doc: string): EditorView {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ extensions: [GFM] }), proseSpellcheck()],
  });
  // The whole parse up front, as a phone's idle callback would eventually deliver it.
  ensureSyntaxTree(state, state.doc.length, 5000);
  view = new EditorView({ state, parent: document.body });
  return view;
}

/** The text of every span the browser is told not to check, in document order. */
function unchecked(v: EditorView): string[] {
  return [...v.contentDOM.querySelectorAll('[spellcheck="false"]')].map((e) => e.textContent ?? '');
}

afterEach(() => {
  view?.destroy();
  view = null;
});

describe('proseSpellcheck', () => {
  it('asks the browser and the keyboard to treat the note as prose', () => {
    const v = mount('hello');
    expect(v.contentDOM.getAttribute('spellcheck')).toBe('true');
    expect(v.contentDOM.getAttribute('autocorrect')).toBe('on');
    expect(v.contentDOM.getAttribute('autocapitalize')).toBe('sentences');
  });

  it('checks ordinary text, emphasis and a link label', () => {
    const v = mount('Some *emphasised* words and [a label](https://example.com).');
    expect(unchecked(v)).toEqual(['https://example.com']);
  });

  it('leaves code alone, inline and fenced', () => {
    const v = mount('Run `pnpm devv` first.\n\n```ts\nconst teh = 1;\n```\n\nAfter.');
    expect(unchecked(v)).toEqual(['`pnpm devv`', '```ts', 'const teh = 1;', '```']);
  });

  it('leaves bare URLs and autolinks alone', () => {
    const v = mount('See https://example.com/qwzx and <https://example.org/zzq>.');
    expect(unchecked(v)).toEqual(['https://example.com/qwzx', '<https://example.org/zzq>']);
  });

  it("leaves a stored file's name alone, whether it is a link or an image", () => {
    const v = mount(
      '[Report_v2_final.pdf](files/Report_v2_final.pdf)\n\n![IMG_2041.jpg](<files/IMG 2041.jpg>)',
    );
    expect(unchecked(v)).toEqual([
      '[Report_v2_final.pdf](files/Report_v2_final.pdf)',
      '![IMG_2041.jpg](<files/IMG 2041.jpg>)',
    ]);
  });

  it('leaves HTML and comments alone', () => {
    const v = mount('A line<br>break.\n\n<!-- upload failed: nope -->');
    expect(unchecked(v)).toEqual(['<br>', '<!-- upload failed: nope -->']);
  });

  it('follows an edit that turns text into code', () => {
    const v = mount('plain wurd');
    expect(unchecked(v)).toEqual([]);
    v.dispatch({ changes: [{ from: 6, insert: '`' }, { from: 10, insert: '`' }] });
    expect(unchecked(v)).toEqual(['`wurd`']);
  });
});
