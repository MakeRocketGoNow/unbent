import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';
import { afterEach, describe, expect, it } from 'vitest';
import { tableTools } from './table-toolbar.js';

/**
 * Mounts a real view, because the behaviour under test is a transaction filter: it only
 * runs when a transaction is dispatched, so there is nothing to call directly.
 */
let view: EditorView | undefined;

function mount(doc: string, at: number): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  view = new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(at),
      extensions: [markdown({ extensions: [GFM] }), tableTools()],
    }),
    parent,
  });
  return view;
}

afterEach(() => {
  view?.destroy();
  view = undefined;
});

describe('reformat on exit', () => {
  const ragged = '| Month | Testing Really Long | Savings |\n| --- | --- | --- |\n| Jan |  | $250 |\n\nAfter.';

  /**
   * Typing a longer header leaves every row below carrying the width the old text needed,
   * which is what makes a table look broken with nothing actually wrong with it.
   */
  it('re-pads the columns when the cursor leaves the table', () => {
    const v = mount(ragged, ragged.indexOf('Jan'));
    v.dispatch({ selection: { anchor: v.state.doc.toString().indexOf('After.') } });

    expect(v.state.doc.toString()).toBe(
      '| Month | Testing Really Long | Savings |\n' +
        '| ----- | ------------------- | ------- |\n' +
        '| Jan   |                     | $250    |\n\nAfter.',
    );
  });

  /**
   * Reformatting on every keystroke would move the text under the cursor as it is typed,
   * and put each of those edits on the undo stack separately.
   */
  it('leaves the table alone while the cursor is still inside it', () => {
    const v = mount(ragged, ragged.indexOf('Month'));
    v.dispatch({ selection: { anchor: v.state.doc.toString().indexOf('$250') } });
    expect(v.state.doc.toString()).toBe(ragged);
  });

  it('does nothing when the table is already aligned', () => {
    const tidy = '| A   | B   |\n| --- | --- |\n| x   | y   |\n\nAfter.';
    const v = mount(tidy, tidy.indexOf('x'));
    v.dispatch({ selection: { anchor: tidy.indexOf('After.') } });
    expect(v.state.doc.toString()).toBe(tidy);
  });

  it('does not disturb a document with no table', () => {
    const prose = 'one\n\ntwo';
    const v = mount(prose, 1);
    v.dispatch({ selection: { anchor: prose.length } });
    expect(v.state.doc.toString()).toBe(prose);
  });

  /** Leaving by deleting the table must not try to reformat what is no longer there. */
  it('survives the table being deleted on the way out', () => {
    const v = mount(ragged, ragged.indexOf('Jan'));
    const end = v.state.doc.toString().indexOf('\n\nAfter.');
    v.dispatch({ changes: { from: 0, to: end }, selection: { anchor: 0 } });
    expect(v.state.doc.toString()).toBe('\n\nAfter.');
  });

  /** Typing in a cell and moving out is the sequence the whole thing exists for. */
  it('re-pads after a cell is edited and left', () => {
    const v = mount('| A | B |\n| --- | --- |\n| x | y |\n\nAfter.', 0);
    const at = v.state.doc.toString().indexOf('x');
    v.dispatch({ changes: { from: at, to: at + 1, insert: 'a much longer value' } });
    v.dispatch({ selection: { anchor: v.state.doc.toString().indexOf('After.') } });

    const lines = v.state.doc.toString().split('\n');
    // Column B keeps the three-character minimum a delimiter cell needs.
    expect(lines[0]).toBe('| A                   | B   |');
    expect(lines[2]).toBe('| a much longer value | y   |');
  });
});
