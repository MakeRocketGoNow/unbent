import { EditorSelection, EditorState, type StateCommand } from '@codemirror/state';
import { markdown as markdownLang } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';
import { syntaxTree } from '@codemirror/language';
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

/**
 * List indentation.
 *
 * The indent width must match the parent's marker rather than a fixed size: two spaces
 * nests under `- `, but an item under `1. ` needs three. A wrong width does not error —
 * the line stays a sibling, so the key appears to do nothing.
 */
describe('indentList', () => {
  it('indents a bullet under the item above it', () => {
    const doc = '- one\n- two';
    expect(run(cmd.indentList, doc, doc.indexOf('- two')).doc).toBe('- one\n  - two');
  });

  it('indents three spaces under an ordered item', () => {
    const doc = '1. one\n1. two';
    expect(run(cmd.indentList, doc, doc.indexOf('1. two')).doc).toBe('1. one\n   1. two');
  });

  it('indents relative to a parent that is itself indented', () => {
    const doc = '- one\n  - two\n  - three';
    expect(run(cmd.indentList, doc, doc.lastIndexOf('  - three')).doc).toBe(
      '- one\n  - two\n    - three',
    );
  });

  it('indents task list items', () => {
    const doc = '- [ ] one\n- [ ] two';
    expect(run(cmd.indentList, doc, doc.indexOf('- [ ] two')).doc).toBe(
      '- [ ] one\n  - [ ] two',
    );
  });

  /** The first item has no parent; indenting it would orphan the list. */
  it('refuses to indent the first item of a list', () => {
    const doc = '- only';
    expect(run(cmd.indentList, doc, 2).doc).toBe('- only');
  });

  it('does nothing outside a list', () => {
    const doc = 'plain paragraph';
    expect(run(cmd.indentList, doc, 4).doc).toBe('plain paragraph');
  });

  /**
   * The reason indenting shows `a.` rather than `c.`: a nested list is a new list.
   *
   * Without this the moved item keeps the count it had as a sibling, which is both wrong
   * markdown and the wrong letter once depth decides how the marker is displayed.
   */
  it('restarts numbering at 1 when an ordered item is indented', () => {
    const doc = '1. one\n2. two\n3. three';
    expect(run(cmd.indentList, doc, doc.indexOf('3. three')).doc).toBe(
      '1. one\n2. two\n   1. three',
    );
  });

  it('continues the nested numbering for a following sibling', () => {
    const doc = '1. one\n2. two\n   1. three\n4. four';
    expect(run(cmd.indentList, doc, doc.indexOf('4. four')).doc).toBe(
      '1. one\n2. two\n   1. three\n   2. four',
    );
  });

  it('leaves bullet markers alone', () => {
    const doc = '- one\n- two';
    expect(run(cmd.indentList, doc, doc.indexOf('- two')).doc).toBe('- one\n  - two');
  });

  it('indents every selected item', () => {
    const doc = '- one\n- two\n- three';
    const result = run(cmd.indentList, doc, doc.indexOf('- two'), doc.length);
    expect(result.doc).toBe('- one\n  - two\n  - three');
  });
});

describe('outdentList', () => {
  it('outdents a nested bullet', () => {
    const doc = '- one\n  - two';
    expect(run(cmd.outdentList, doc, doc.indexOf('  - two') + 2).doc).toBe('- one\n- two');
  });

  /** Rejoining the outer list means taking the next number in it, not keeping the child's. */
  it('outdents three spaces under an ordered parent and continues its numbering', () => {
    const doc = '1. one\n   1. two';
    expect(run(cmd.outdentList, doc, doc.indexOf('   1. two') + 3).doc).toBe('1. one\n2. two');
  });

  it('does nothing to a top-level item', () => {
    const doc = '- one\n- two';
    expect(run(cmd.outdentList, doc, doc.indexOf('- two')).doc).toBe('- one\n- two');
  });

  /**
   * Outdent must restore the nesting indent produces, at any nesting width.
   *
   * Structure, not bytes: ordered items are renumbered on the way down and back up, so a
   * list written with lazy `1. 1.` numbering returns as `1. 2.`. That is the same list.
   */
  it.each([
    ['- one\n- two', '- one\n- two'],
    ['1. one\n1. two', '1. one\n2. two'],
    ['- [ ] one\n- [ ] two', '- [ ] one\n- [ ] two'],
  ])('round-trips %j', (doc, restored) => {
    const pos = doc.lastIndexOf('\n') + 1;
    const indented = run(cmd.indentList, doc, pos + 2).doc;
    expect(indented).not.toBe(doc);
    // Cursor moves with the inserted indent.
    const shift = indented.length - doc.length;
    expect(run(cmd.outdentList, indented, pos + 2 + shift).doc).toBe(restored);
  });
});

/**
 * The indent must actually nest in the parser, not merely add spaces.
 *
 * A wrong width leaves the item a sibling with stray indentation, which looks correct in
 * the editor but renders and exports as a flat list.
 */
describe('indent produces real nesting', () => {
  function nestingDepth(doc: string): number {
    const state = EditorState.create({
      doc,
      extensions: [markdownLang({ extensions: [GFM] })],
    });
    let depth = 0;
    syntaxTree(state).iterate({
      enter(n) {
        if (n.name === 'BulletList' || n.name === 'OrderedList') depth += 1;
      },
    });
    return depth;
  }

  it.each([
    ['bullet', '- one\n- two'],
    ['ordered', '1. one\n1. two'],
    ['task', '- [ ] one\n- [ ] two'],
  ])('%s list nests after indenting', (_label, doc) => {
    expect(nestingDepth(doc)).toBe(1);
    const indented = run(cmd.indentList, doc, doc.lastIndexOf('\n') + 3).doc;
    expect(nestingDepth(indented)).toBe(2);
  });
});
