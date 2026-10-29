import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import type { EditorView } from '@codemirror/view';
import { undoDepth } from '@codemirror/commands';
import { useRef, useState } from 'react';
import { caretRoom } from '../editor/rich-markdown.js';
import { insertUploads, PendingUploads } from '../editor/attach.js';
import { Editor } from './Editor.js';

/**
 * The editor is uncontrolled, and switching Rich ↔ Source rebuilds the CodeMirror view
 * because the two modes are different extensions. The seed it is handed is the last saved
 * body, so a rebuild that used that seed would throw away whatever had been typed since,
 * and the next keystroke would then save the reverted text. These pin that the live
 * document and the caret survive the rebuild, and that a different note still starts from
 * its seed.
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

  it('keeps the caret where it was when switching between rich and source', () => {
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

    // Put the caret inside the word, not at the document edge the reseed would default to.
    act(() => {
      view!.dispatch({ selection: { anchor: 3 } });
    });

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
    expect(view!.state.selection.main.head).toBe(3);
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

/**
 * Read-only is how a note looks offline, and it comes and goes with the connection. It has
 * to arrive without rebuilding the view (a rebuild would lose the undo history and the
 * caret of someone reading through a tunnel), and it has to hold against the paths that
 * change the document without the keyboard: a dropped file most of all, because the
 * editor's own drop handler runs before CodeMirror's and does not ask.
 */
describe('Editor read-only', () => {
  afterEach(cleanup);

  function mount(readOnly: boolean, onUpload = vi.fn(async () => 'files/x.png')) {
    let view: EditorView | null = null;
    const props = {
      noteId: 'n1',
      initialValue: 'saved body',
      onChange: () => {},
      onUpload,
      onViewReady: (v: EditorView | null) => {
        view = v;
      },
    };
    const result = render(<Editor {...props} readOnly={readOnly} />);
    return {
      view: () => view!,
      setReadOnly: (next: boolean) => result.rerender(<Editor {...props} readOnly={next} />),
      onUpload,
    };
  }

  it('takes no typing and says so in the markup', () => {
    const { view } = mount(true);
    expect(view().state.readOnly).toBe(true);
    expect(view().contentDOM.getAttribute('contenteditable')).toBe('false');
  });

  it('flips in place, keeping the history and the caret', () => {
    const editor = mount(false);
    const before = editor.view();
    act(() => {
      before.dispatch({ changes: { from: 10, insert: ' typed' }, selection: { anchor: 4 } });
    });

    editor.setReadOnly(true);
    expect(editor.view()).toBe(before);
    expect(before.state.readOnly).toBe(true);

    editor.setReadOnly(false);
    expect(editor.view()).toBe(before);
    expect(before.state.readOnly).toBe(false);
    expect(before.state.doc.toString()).toBe('saved body typed');
    expect(before.state.selection.main.head).toBe(4);
    expect(undoDepth(before.state)).toBe(1);
  });

  it('refuses a dropped file', () => {
    const { view, onUpload } = mount(true);
    const file = new File(['x'], 'receipt.png', { type: 'image/png' });
    const drop = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [file] } });
    act(() => {
      view().contentDOM.dispatchEvent(drop);
    });
    expect(drop.defaultPrevented).toBe(true);
    expect(onUpload).not.toHaveBeenCalled();
    expect(view().state.doc.toString()).toBe('saved body');
  });
});

/**
 * The line Down opens below a closing picture is room for the caret, not an edit: saving it
 * would bump the note's date for an arrow key. What is typed on it saves with it.
 */
describe('Editor and the line below a closing picture', () => {
  afterEach(cleanup);

  it('does not hand the opened line to the autosave, but saves it with what is typed there', () => {
    let view: EditorView | null = null;
    const onChange = vi.fn();
    render(
      <Editor
        noteId="n1"
        initialValue="saved body"
        rich
        onChange={onChange}
        onViewReady={(v) => {
          view = v;
        }}
      />,
    );

    const end = view!.state.doc.length;
    act(() => {
      view!.dispatch({
        changes: { from: end, insert: '\n' },
        selection: { anchor: end + 1 },
        annotations: caretRoom.of(true),
      });
    });
    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      view!.dispatch(view!.state.replaceSelection('below'));
    });
    expect(onChange).toHaveBeenLastCalledWith('saved body\nbelow');
  });
});

/**
 * A write that lands after a round trip goes into the editor open then. The workspace
 * keys `Editor` on a revision it bumps for a conflict, a restore or a body rewrite, so
 * that is a remount, not a rebuild: the old instance's own ref is cleared and the new
 * view lands in a new instance's. The getter the extensions read has to come from the
 * owner, whose ref is set from `onViewReady` across remounts. This host is wired as
 * `Workspace` is, and the upload is the round trip.
 */
describe('Editor across a remount', () => {
  afterEach(cleanup);

  it('puts an upload into the editor mounted when it lands, through the owner\'s getter', async () => {
    let finish: (path: string) => void = () => {};
    const onUpload = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    let bump: () => void = () => {};
    let current: () => EditorView | null = () => null;

    function Host() {
      const [revision, setRevision] = useState(0);
      const viewRef = useRef<EditorView | null>(null);
      const bodyRef = useRef('saved body');
      bump = () => setRevision((n) => n + 1);
      current = () => viewRef.current;
      return (
        <Editor
          key={`n1-${revision}`}
          noteId="n1"
          initialValue={bodyRef.current}
          onChange={(body) => {
            bodyRef.current = body;
          }}
          onUpload={onUpload}
          onViewReady={(v) => {
            viewRef.current = v;
          }}
          liveView={() => viewRef.current}
        />
      );
    }
    render(<Host />);

    const pressed = current()!;
    const done = insertUploads(pressed, [new File(['x'], 'a.png', { type: 'image/png' })], 0);
    expect(pressed.state.doc.toString()).toMatch(/^!\[uploading a\.png…]\(#upload-[0-9a-f]{8}\)\nsaved body$/);

    act(() => bump());
    const live = current()!;
    expect(live).not.toBe(pressed);
    finish('files/a.png');
    await done;
    expect(live.state.doc.toString()).toBe('![a.png](files/a.png)\nsaved body');
  });

  /*
     The count that keeps the update notice's Reload waiting (`holdPage` in
     `Workspace.tsx`, read by `pageBusy`) is the owner's too: made once beside the getter
     and handed to every instance, so the remount changes nothing about it. It used to be
     the view's, and went to zero at the remount with the upload still running, so a
     Reload pressed then cut the file off half-way to the server.
  */
  it('keeps the owner\'s count of uploads in flight across the remount', async () => {
    let finish: (path: string) => void = () => {};
    const onUpload = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    let bump: () => void = () => {};
    let current: () => EditorView | null = () => null;
    const counts: number[] = [];
    const pending = new PendingUploads((n) => counts.push(n));

    function Host() {
      const [revision, setRevision] = useState(0);
      const viewRef = useRef<EditorView | null>(null);
      const bodyRef = useRef('saved body');
      bump = () => setRevision((n) => n + 1);
      current = () => viewRef.current;
      return (
        <Editor
          key={`n1-${revision}`}
          noteId="n1"
          initialValue={bodyRef.current}
          onChange={(body) => {
            bodyRef.current = body;
          }}
          onUpload={onUpload}
          pendingUploads={pending}
          onViewReady={(v) => {
            viewRef.current = v;
          }}
          liveView={() => viewRef.current}
        />
      );
    }
    render(<Host />);

    const pressed = current()!;
    const done = insertUploads(pressed, [new File(['x'], 'a.png', { type: 'image/png' })], 0);
    expect(pending.size).toBe(1);

    act(() => bump());
    expect(current()).not.toBe(pressed);
    expect(pending.size).toBe(1);
    expect(counts).toEqual([1]);

    finish('files/a.png');
    await done;
    expect(pending.size).toBe(0);
    expect(counts).toEqual([1, 0]);
  });
});
