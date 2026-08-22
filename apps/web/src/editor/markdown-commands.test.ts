import { EditorSelection, EditorState, type StateCommand } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import * as cmd from './markdown-commands.js';

/** Applies a command to `doc` with the given selection and returns the resulting text. */
function run(
  command: StateCommand,
  doc: string,
  from: number,
  to: number = from,
): { doc: string; selection: { from: number; to: number } } {
  let state = EditorState.create({ doc, selection: EditorSelection.single(from, to) });
  command({
    state,
    dispatch: (tr) => {
      state = tr.state;
    },
  });
  const sel = state.selection.main;
  return { doc: state.doc.toString(), selection: { from: sel.from, to: sel.to } };
}

/** Convenience: select the first occurrence of `word`. */
function select(doc: string, word: string): [number, number] {
  const i = doc.indexOf(word);
  return [i, i + word.length];
}

describe('toggleBold', () => {
  it('wraps a selection', () => {
    const doc = 'make this bold';
    const [from, to] = select(doc, 'this');
    expect(run(cmd.toggleBold, doc, from, to).doc).toBe('make **this** bold');
  });

  /** Pressing the shortcut twice should return the text to where it started. */
  it('unwraps an already-bold selection', () => {
    const doc = 'make **this** bold';
    const [from, to] = select(doc, 'this');
    expect(run(cmd.toggleBold, doc, from, to).doc).toBe('make this bold');
  });

  it('inserts a pair and places the cursor between them when nothing is selected', () => {
    const result = run(cmd.toggleBold, 'ab', 1);
    expect(result.doc).toBe('a****b');
    // Typing now lands inside the markers.
    expect(result.selection.from).toBe(3);
  });

  it('leaves the document alone at a document boundary', () => {
    expect(run(cmd.toggleBold, '', 0).doc).toBe('****');
  });
});

describe('toggleItalic', () => {
  it('uses underscores', () => {
    const doc = 'some word here';
    const [from, to] = select(doc, 'word');
    expect(run(cmd.toggleItalic, doc, from, to).doc).toBe('some _word_ here');
  });

  it('unwraps', () => {
    const doc = 'some _word_ here';
    const [from, to] = select(doc, 'word');
    expect(run(cmd.toggleItalic, doc, from, to).doc).toBe('some word here');
  });

  /** Bold is two asterisks and italic one underscore, so they must not collide. */
  it('nests inside bold without disturbing it', () => {
    const doc = 'a **bold word** b';
    const [from, to] = select(doc, 'word');
    expect(run(cmd.toggleItalic, doc, from, to).doc).toBe('a **bold _word_** b');
  });
});

describe('toggleCode and toggleStrikethrough', () => {
  it('wraps in backticks', () => {
    const doc = 'run cmd now';
    const [from, to] = select(doc, 'cmd');
    expect(run(cmd.toggleCode, doc, from, to).doc).toBe('run `cmd` now');
  });

  it('wraps in tildes', () => {
    const doc = 'this gone here';
    const [from, to] = select(doc, 'gone');
    expect(run(cmd.toggleStrikethrough, doc, from, to).doc).toBe('this ~~gone~~ here');
  });
});

describe('line prefixes', () => {
  it('adds a heading', () => {
    expect(run(cmd.toggleH2, 'Title', 0).doc).toBe('## Title');
  });

  it('removes a heading of the same level', () => {
    expect(run(cmd.toggleH2, '## Title', 3).doc).toBe('Title');
  });

  /** Heading levels replace each other rather than stacking into `## # Title`. */
  it('replaces one heading level with another', () => {
    expect(run(cmd.toggleH1, '### Title', 5).doc).toBe('# Title');
    expect(run(cmd.toggleH3, '# Title', 3).doc).toBe('### Title');
  });

  it('applies across every line in a selection', () => {
    const doc = 'one\ntwo\nthree';
    expect(run(cmd.toggleBullet, doc, 0, doc.length).doc).toBe('- one\n- two\n- three');
  });

  it('removes only when every line already has the prefix', () => {
    // Mixed: the unprefixed line gains one rather than the prefixed line losing its own.
    const doc = '- one\ntwo';
    expect(run(cmd.toggleBullet, doc, 0, doc.length).doc).toBe('- one\n- two');
  });

  it('toggles quotes off', () => {
    expect(run(cmd.toggleQuote, '> quoted', 3).doc).toBe('quoted');
  });

  it('adds task list markers', () => {
    expect(run(cmd.toggleTask, 'do the thing', 0).doc).toBe('- [ ] do the thing');
  });
});

describe('insertLink', () => {
  it('uses the selection as the link text and selects the placeholder', () => {
    const doc = 'see docs here';
    const [from, to] = select(doc, 'docs');
    const result = run(cmd.insertLink, doc, from, to);
    expect(result.doc).toBe('see [docs](url) here');
    // The `url` placeholder is selected so typing replaces it.
    expect(result.doc.slice(result.selection.from, result.selection.to)).toBe('url');
  });

  it('inserts an empty link when nothing is selected', () => {
    expect(run(cmd.insertLink, 'x', 1).doc).toBe('x[](url)');
  });
});

/**
 * The reason this editor exists: formatting must never rewrite text it did not touch.
 * A WYSIWYG serializer breaks `](<files/My File.pdf>)` and escapes underscores; these
 * commands are plain edits, so they cannot.
 */
describe('document fidelity', () => {
  const tricky = [
    '[Treatment Plan.pdf](<files/Treatment Plan.pdf>)',
    '[2020_02_29_10_30_00.pdf](files/2020_02_29_10_30_00.pdf)',
    '<http://www.skywaydental.com/>',
    'a_b_c snake_case_name',
  ];

  it.each(tricky)('leaves %j untouched when formatting elsewhere', (line) => {
    const doc = `${line}\n\nplain text`;
    const [from, to] = select(doc, 'plain');
    const result = run(cmd.toggleBold, doc, from, to);
    expect(result.doc).toBe(`${line}\n\n**plain** text`);
    expect(result.doc.startsWith(line)).toBe(true);
  });
});
