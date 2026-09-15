import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import type { EditorView } from '@codemirror/view';
import { Editor } from './Editor.js';

/**
 * The editor is uncontrolled, and switching Rich ↔ Source rebuilds the CodeMirror view
 * because the two modes are different extensions. The seed it is handed is the last saved
 * body, so a rebuild that used that seed would throw away whatever had been typed since —
 * and the next keystroke would then save the reverted text. These pin that the live
 * document survives the rebuild, and that a different note still starts from its seed.
 */
describe('Editor across Rich / Source', () => {
  afterEach(cleanup);

  it('keeps what was typed when switching between rich and source', () => {
    let view: EditorView | null = null;
    const { rerender } = render(
      <Editor
        noteId="n1"
        initialValue="saved body"
        rich
        onChange={() => {}}
        onViewReady={(v) => {
          view = v;
        }}
      />,
    );

    expect(view).not.toBeNull();
    act(() => {
      view!.dispatch({
        changes: { from: view!.state.doc.length, insert: ' typed' },
      });
    });
    expect(view!.state.doc.toString()).toBe('saved body typed');

    rerender(
      <Editor
        noteId="n1"
        initialValue="saved body"
        rich={false}
        onChange={() => {}}
        onViewReady={(v) => {
          view = v;
        }}
      />,
    );

    expect(view).not.toBeNull();
    expect(view!.state.doc.toString()).toBe('saved body typed');
  });

  it('seeds from the saved body when the note changes, not the previous note\'s typing', () => {
    let view: EditorView | null = null;
    const { rerender } = render(
      <Editor
        noteId="n1"
        initialValue="first note"
        rich
        onChange={() => {}}
        onViewReady={(v) => {
          view = v;
        }}
      />,
    );

    act(() => {
      view!.dispatch({
        changes: { from: view!.state.doc.length, insert: ' typed' },
      });
    });
    // The typing landed on n1's view, so the reseed below is dropping *this* text, not a
    // no-op on an already-saved body.
    expect(view!.state.doc.toString()).toBe('first note typed');

    rerender(
      <Editor
        noteId="n2"
        initialValue="second note"
        rich
        onChange={() => {}}
        onViewReady={(v) => {
          view = v;
        }}
      />,
    );

    expect(view).not.toBeNull();
    expect(view!.state.doc.toString()).toBe('second note');
  });
});
