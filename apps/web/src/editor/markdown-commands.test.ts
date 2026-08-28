import { EditorSelection, EditorState, type StateCommand } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown as markdownLang } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';
import { syntaxTree } from '@codemirror/language';
import { afterEach, describe, expect, it } from 'vitest';
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

describe('closeCodeFence', () => {
  /** Returns whether the command handled the key, alongside the resulting document. */
  function press(doc: string, at: number) {
    let handled = false;
    let next = EditorState.create({ doc, selection: EditorSelection.single(at) });
    handled = cmd.closeCodeFence({
      state: next,
      dispatch: (tr) => {
        next = tr.state;
      },
    });
    return { handled, doc: next.doc.toString(), cursor: next.selection.main.head };
  }

  it('closes a bare fence', () => {
    const r = press('```', 3);
    expect(r.handled).toBe(true);
    expect(r.doc).toBe('```\n\n```');
  });

  it('closes a fence with a language', () => {
    const r = press('```ts', 5);
    expect(r.doc).toBe('```ts\n\n```');
  });

  /** The cursor must land ready to type, between the two fences. */
  it('leaves the cursor on the blank line', () => {
    const r = press('```ts', 5);
    expect(r.cursor).toBe(6);
  });

  it('carries the indent of a fence inside a list item', () => {
    const doc = '- item\n  ```ts';
    const r = press(doc, doc.length);
    expect(r.doc).toBe('- item\n  ```ts\n  \n  ```');
  });

  /** A closing fence must repeat the opening character and length. */
  it('matches a tilde fence', () => {
    const r = press('~~~ts', 5);
    expect(r.doc).toBe('~~~ts\n\n~~~');
  });

  it('matches a longer fence', () => {
    const r = press('````ts', 6);
    expect(r.doc).toBe('````ts\n\n````');
  });

  /**
   * The syntax tree cannot answer whether a fence is closed: an unterminated one swallows
   * the rest of the document and claims a later block's opening fence as its own closing
   * mark. The check is textual, the way CommonMark decides it.
   */
  it('does not close a fence that already has a closing fence', () => {
    const doc = '```ts\nfoo\n```';
    const r = press(doc, 5);
    expect(r.handled).toBe(false);
    expect(r.doc).toBe(doc);
  });

  it('ignores a closing fence of the other character', () => {
    const doc = '```ts\nfoo\n~~~';
    const r = press(doc, 5);
    expect(r.doc).toBe('```ts\n\n```\nfoo\n~~~');
  });

  /**
   * A shorter run does not close a longer fence, so the block is still open and gets a
   * matching four-backtick close. Confirmed against the shared pipeline, which renders
   * ```` ````ts\nfoo\n```\nbar\n```` ```` as one block containing the shorter run.
   */
  it('ignores a shorter closing run', () => {
    const doc = '````ts\nfoo\n```';
    const r = press(doc, 6);
    expect(r.handled).toBe(true);
    expect(r.doc).toBe('````ts\n\n````\nfoo\n```');
  });

  it('does nothing mid-line', () => {
    const r = press('```ts', 2);
    expect(r.handled).toBe(false);
    expect(r.doc).toBe('```ts');
  });

  it('does nothing on an ordinary line', () => {
    const r = press('just text', 9);
    expect(r.handled).toBe(false);
  });

  it('does nothing on inline code', () => {
    const doc = 'a `snippet` b';
    const r = press(doc, doc.length);
    expect(r.handled).toBe(false);
  });

  /** A selection is a replacement, not a fence being opened. */
  it('does nothing with a selection', () => {
    let state = EditorState.create({ doc: '```ts', selection: EditorSelection.single(0, 5) });
    const handled = cmd.closeCodeFence({
      state,
      dispatch: (tr) => {
        state = tr.state;
      },
    });
    expect(handled).toBe(false);
  });

  /** An info string cannot contain the fence character. */
  it('does nothing when backticks follow the fence', () => {
    const r = press('```a`b', 6);
    expect(r.handled).toBe(false);
  });
});

/**
 * Enter is the one binding that competes with a default command, so it is exercised
 * through the real keymap rather than by calling the command directly: the risk is not
 * that closing a fence fails, it is that ordinary newlines stop working.
 */
describe('Enter through the real keymap', () => {
  let view: EditorView | undefined;

  afterEach(() => {
    view?.destroy();
    view = undefined;
  });

  function pressEnter(doc: string, at: number, shiftKey = false): string {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    view = new EditorView({
      state: EditorState.create({
        doc,
        selection: EditorSelection.cursor(at),
        extensions: [
          history(),
          keymap.of([...cmd.markdownKeymap, ...defaultKeymap, ...historyKeymap]),
          markdownLang({ extensions: [GFM] }),
        ],
      }),
      parent,
    });
    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        shiftKey,
        bubbles: true,
        cancelable: true,
      }),
    );
    return view.state.doc.toString();
  }

  it('closes an open fence', () => {
    expect(pressEnter('```ts', 5)).toBe('```ts\n\n```');
  });

  it('still inserts an ordinary newline in prose', () => {
    expect(pressEnter('hello', 5)).toBe('hello\n');
  });

  it('still splits a line mid-word', () => {
    expect(pressEnter('hello', 2)).toBe('he\nllo');
  });

  it('does not double-close inside an existing block', () => {
    expect(pressEnter('```ts\nfoo\n```', 5)).toBe('```ts\n\nfoo\n```');
  });

  /**
   * CodeMirror expresses Shift-Enter as a property of the Enter binding rather than a
   * separate key, so binding only `run` leaves Shift-Enter falling through to the default
   * keymap — which split the fence line instead of closing it. Shift means nothing here,
   * so the two must not diverge.
   */
  it('closes an open fence on Shift-Enter', () => {
    expect(pressEnter('```ts', 5, true)).toBe('```ts\n\n```');
  });

  it('still inserts an ordinary newline on Shift-Enter in prose', () => {
    expect(pressEnter('hello', 5, true)).toBe('hello\n');
  });

  it('does not double-close inside an existing block on Shift-Enter', () => {
    expect(pressEnter('```ts\nfoo\n```', 5, true)).toBe('```ts\n\nfoo\n```');
  });

  /**
   * Pressing Enter at the end of a closing fence is the obvious way to carry on writing
   * below a block. A closing fence is textually identical to an opening one, so without
   * asking the tree which it is, this added a second fence — which then opened a block
   * that swallowed everything typed after it.
   */
  it('does not add a fence when Enter is pressed on a closing fence', () => {
    const doc = '```js\nfoo\n```';
    expect(pressEnter(doc, doc.length)).toBe('```js\nfoo\n```\n');
  });

  it('does not add a fence on Shift-Enter on a closing fence', () => {
    const doc = '```js\nfoo\n```';
    expect(pressEnter(doc, doc.length, true)).toBe('```js\nfoo\n```\n');
  });

  /** The same line inside a list item, where the fence is indented. */
  it('does not add a fence on an indented closing fence', () => {
    const doc = '- item\n  ```ts\n  foo\n  ```';
    expect(pressEnter(doc, doc.length)).toBe('- item\n  ```ts\n  foo\n  ```\n  ');
  });
});

describe('formatTable', () => {
  function fmt(doc: string, at: number) {
    let state = EditorState.create({ doc, selection: EditorSelection.single(at) });
    const handled = cmd.formatTable({
      state,
      dispatch: (tr) => {
        state = tr.state;
      },
    });
    return { handled, out: state.doc.toString() };
  }

  it('pads cells so columns line up', () => {
    const r = fmt('|Month|Savings|\n|-|-|\n|January|$250|', 3);
    expect(r.out).toBe(
      '| Month   | Savings |\n| ------- | ------- |\n| January | $250    |',
    );
  });

  /** Monospace plus equal-width cells is what makes the columns readable. */
  it('gives every row the same width', () => {
    const r = fmt('|A|B|\n|-|-|\n|xx|y|\n|z|wwww|', 2);
    const widths = r.out.split('\n').map((l) => l.length);
    expect(new Set(widths).size).toBe(1);
  });

  it('keeps alignment markers and pushes right-aligned text right', () => {
    const r = fmt('| A | B |\n| :-- | --: |\n| x | 1 |\n| longer | 22 |', 3);
    expect(r.out).toBe('| A      |   B |\n| :----- | --: |\n| x      |   1 |\n| longer |  22 |');
  });

  it('centres a centred column', () => {
    const r = fmt('| A |\n| :-: |\n| xxxx |\n| y |', 3);
    expect(r.out).toBe('|  A   |\n| :--: |\n| xxxx |\n|  y   |');
  });

  /** A short row must gain cells, never have its data dropped. */
  it('pads a row that is missing cells', () => {
    const r = fmt('| A | B | C |\n| - | - | - |\n| x |', 3);
    expect(r.out).toBe('| A   | B   | C   |\n| --- | --- | --- |\n| x   |     |     |');
  });

  /** An escaped pipe is content, not a separator. */
  it('does not split on an escaped pipe', () => {
    const r = fmt('| A | B |\n| - | - |\n| a \\| b | c |', 3);
    expect(r.out).toContain('a \\| b');
    expect(r.out.split('\n')[2]).toBe('| a \\| b | c   |');
  });

  it('preserves the indent of a table inside a list item', () => {
    const r = fmt('- item\n  |A|B|\n  |-|-|\n  |x|y|', 10);
    expect(r.out).toBe('- item\n  | A   | B   |\n  | --- | --- |\n  | x   | y   |');
  });

  /** Running it twice must not keep growing the padding. */
  it('is idempotent', () => {
    const once = fmt('|Month|Savings|\n|-|-|\n|January|$250|', 3).out;
    const twice = fmt(once, 3);
    expect(twice.handled).toBe(false);
    expect(twice.out).toBe(once);
  });

  it('does nothing without a delimiter row', () => {
    const r = fmt('| just | pipes |\n| more | text |', 3);
    expect(r.handled).toBe(false);
  });

  it('does nothing in ordinary prose', () => {
    expect(fmt('no table here', 3).handled).toBe(false);
  });
});

describe('tableNextCell', () => {
  function tab(doc: string, at: number) {
    let state = EditorState.create({ doc, selection: EditorSelection.single(at) });
    const handled = cmd.tableNextCell({
      state,
      dispatch: (tr) => {
        state = tr.state;
      },
    });
    return { handled, out: state.doc.toString(), cursor: state.selection.main.head };
  }

  /**
   * Asserted on the character landed on rather than an offset: formatting rewrites the
   * table, so a position taken before it means nothing after.
   */
  it('moves to the next cell', () => {
    const doc = '| A | B |\n| - | - |\n| x | y |';
    const r = tab(doc, doc.indexOf('x'));
    expect(r.out[r.cursor]).toBe('y');
  });

  it('formats the table on the way', () => {
    const r = tab('|A|B|\n|-|-|\n|xx|y|', 2);
    expect(r.out).toBe('| A   | B   |\n| --- | --- |\n| xx  | y   |');
  });

  /** Tab off the last cell extends the table, the way a spreadsheet does. */
  it('moves into the row below from the last cell', () => {
    const doc = '| A | B |\n| - | - |\n| x | y |\n| z | w |';
    const r = tab(doc, doc.indexOf('y'));
    expect(r.out[r.cursor]).toBe('z');
  });

  it('does nothing in prose so Tab still indents lists', () => {
    expect(tab('- item', 6).handled).toBe(false);
  });

  /** A lone pipe in a sentence is not a table. */
  it('does nothing on a stray pipe', () => {
    expect(tab('a | b', 3).handled).toBe(false);
  });

  /**
   * Driven through the real keymap, because calling the command directly hid a bug the
   * editor showed immediately: the reformat and the cursor move have to arrive as one
   * transaction, and dispatching a selection built from the formatted state against the
   * editor's own state dropped the edits, so Tab appeared to do nothing.
   */
  describe('through the real keymap', () => {
    let view: EditorView | undefined;

    afterEach(() => {
      view?.destroy();
      view = undefined;
    });

    function pressTab(doc: string, at: number): { doc: string; cursorChar: string } {
      const parent = document.createElement('div');
      document.body.appendChild(parent);
      view = new EditorView({
        state: EditorState.create({
          doc,
          selection: EditorSelection.cursor(at),
          extensions: [
            history(),
            keymap.of([...cmd.markdownKeymap, ...defaultKeymap, ...historyKeymap]),
            markdownLang({ extensions: [GFM] }),
          ],
        }),
        parent,
      });
      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true, cancelable: true }),
      );
      const out = view.state.doc.toString();
      return { doc: out, cursorChar: out[view.state.selection.main.head] ?? '' };
    }

    it('formats the table and advances', () => {
      const doc = '|Month|Savings|\n|-|-|\n|January|$250|';
      const r = pressTab(doc, doc.indexOf('January'));
      expect(r.doc).toBe('| Month   | Savings |\n| ------- | ------- |\n| January | $250    |');
      expect(r.cursorChar).toBe('$');
    });

    it('still indents a list', () => {
      const doc = '- one\n- two';
      expect(pressTab(doc, doc.length).doc).toBe('- one\n  - two');
    });
  });
});

describe('table structure', () => {
  const T = '| Month | Savings |\n| --- | --- |\n| Jan | $250 |\n| Feb | $80 |';

  function run(command: StateCommand, doc: string, at: number) {
    let state = EditorState.create({ doc, selection: EditorSelection.single(at) });
    const handled = command({
      state,
      dispatch: (tr) => {
        state = tr.state;
      },
    });
    const out = state.doc.toString();
    return { handled, out, cursorChar: out[state.selection.main.head] ?? '' };
  }

  it('adds a column after the cursor', () => {
    const r = run(cmd.addColumnAfter, T, T.indexOf('Month'));
    expect(r.out).toBe(
      '| Month |     | Savings |\n| ----- | --- | ------- |\n' +
        '| Jan   |     | $250    |\n| Feb   |     | $80     |',
    );
  });

  it('adds a column before the cursor', () => {
    const r = run(cmd.addColumnBefore, T, T.indexOf('Savings'));
    expect(r.out.split('\n')[0]).toBe('| Month |     | Savings |');
  });

  it('adds a row below the cursor', () => {
    const r = run(cmd.addRowAfter, T, T.indexOf('Jan'));
    expect(r.out.split('\n')[3]).toBe('|       |         |');
  });

  it('deletes the cursor column', () => {
    const r = run(cmd.deleteColumn, T, T.indexOf('Savings'));
    expect(r.out).toBe('| Month |\n| ----- |\n| Jan   |\n| Feb   |');
  });

  it('deletes the cursor row', () => {
    const r = run(cmd.deleteRow, T, T.indexOf('Jan'));
    expect(r.out).toBe('| Month | Savings |\n| ----- | ------- |\n| Feb   | $80     |');
  });

  /** A table with no columns renders as bare pipes, so the last one stays. */
  it('refuses to delete the only column', () => {
    const one = '| A |\n| - |\n| x |';
    expect(run(cmd.deleteColumn, one, one.indexOf('A')).handled).toBe(false);
  });

  /**
   * Deleting the header would silently promote the first body row into one, which is a
   * data change disguised as a structural edit.
   */
  it('refuses to delete the header row', () => {
    expect(run(cmd.deleteRow, T, T.indexOf('Month')).handled).toBe(false);
  });

  it('refuses to delete the last body row', () => {
    const one = '| A |\n| - |\n| x |';
    expect(run(cmd.deleteRow, one, one.indexOf('x')).handled).toBe(false);
  });

  /** Alignment has to re-pad the values, not just rewrite the delimiter. */
  it('aligns a column right and repads it', () => {
    const r = run(cmd.alignColumn('right'), T, T.indexOf('Savings'));
    expect(r.out).toBe(
      '| Month | Savings |\n| ----- | ------: |\n| Jan   |    $250 |\n| Feb   |     $80 |',
    );
  });

  it('centres a column', () => {
    const r = run(cmd.alignColumn('center'), T, T.indexOf('Savings'));
    expect(r.out.split('\n')[1]).toBe('| ----- | :-----: |');
  });

  it('deletes the whole table', () => {
    const r = run(cmd.deleteTable, `${T}\n\nafter`, T.indexOf('Jan'));
    expect(r.out).toBe('\nafter');
  });

  /** Structural edits must keep the cursor in its cell, not at a stale offset. */
  it('keeps the cursor in the cell it was in', () => {
    const r = run(cmd.addRowAfter, T, T.indexOf('$250'));
    expect(r.handled).toBe(true);
    // The new row is empty, so the cursor lands at its first cell.
    expect(r.out.split('\n')[3]).toBe('|       |         |');
  });

  it('does nothing outside a table', () => {
    expect(run(cmd.addColumnAfter, 'just prose', 3).handled).toBe(false);
    expect(run(cmd.deleteTable, 'just prose', 3).handled).toBe(false);
  });

  describe('buildTable', () => {
    it('builds a header plus the requested body rows', () => {
      expect(cmd.buildTable(2, 3)).toBe(
        '|     |     |     |\n| --- | --- | --- |\n|     |     |     |\n|     |     |     |',
      );
    });

    it('carries an indent', () => {
      expect(cmd.buildTable(1, 1, '  ').split('\n')[0]).toBe('  |     |');
    });
  });

  describe('insertTableCommand', () => {
    it('inserts a starter table on a blank line', () => {
      const r = run(cmd.insertTableCommand, '', 0);
      expect(r.out.split('\n').length).toBe(5);
      expect(r.out.split('\n')[1]).toBe('| --- | --- | --- |');
    });

    /** A table written mid-sentence parses as a paragraph, so it must open a line. */
    it('opens a new line when the cursor is in text', () => {
      const r = run(cmd.insertTableCommand, 'some prose', 10);
      expect(r.out.startsWith('some prose\n|')).toBe(true);
    });

    it('leaves the cursor in the first header cell', () => {
      const r = run(cmd.insertTableCommand, '', 0);
      // The cell is blank, so the character there is the padding before the next pipe.
      expect(r.out.slice(0, 2)).toBe('| ');
      expect(r.cursorChar).toBe(' ');
    });
  });
});
