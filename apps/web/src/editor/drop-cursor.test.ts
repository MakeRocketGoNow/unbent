import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { fileDropCursor } from './drop-cursor.js';

/**
 * The insertion point shown while a file is dragged over the editor.
 *
 * The browser draws its own caret for dragged *text* and nothing at all for dragged
 * files, so before this there was no aim: you dropped a screenshot and found out
 * afterwards where it had gone.
 *
 * jsdom has no layout, so `posAtCoords` cannot be exercised: what is testable is the
 * part that is not geometry: that a marker appears only for a drag carrying files, and
 * that it is cleared again by every path that ends a drag. A marker left behind is worse
 * than none, because it points at a position nothing is going to use.
 */
function mount(doc: string, { readOnly = false } = {}) {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [fileDropCursor(), EditorState.readOnly.of(readOnly)],
    }),
    parent: document.body,
  });
  return view;
}

/**
 * A DragEvent carrying whatever `types` claims; jsdom has no DataTransfer of its own.
 *
 * `getData` and `files` are stubbed because CodeMirror's own drop handler runs after this
 * extension's and reaches for both: without them the drop test throws out of a handler
 * that has nothing to do with what is under test.
 */
function dragEvent(type: string, types: string[]): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: { types, files: [], getData: () => '' },
    configurable: true,
  });
  Object.defineProperty(event, 'clientX', { value: 10, configurable: true });
  Object.defineProperty(event, 'clientY', { value: 10, configurable: true });
  return event;
}

/** The marker is a widget decoration, so its presence is visible in the DOM. */
const hasCaret = () => document.querySelectorAll('.cm-dropCursor-caret').length > 0;

describe('file drop cursor', () => {
  it('claims a file drag so the browser does not navigate to the file', () => {
    const view = mount('hello world');
    const event = dragEvent('dragover', ['Files']);
    view.contentDOM.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    view.destroy();
  });

  /**
   * A text drag already has the browser's own caret. Drawing a second one beside it
   * would be worse than drawing none, so this one stays out of the way.
   */
  it('ignores a drag that carries no files', () => {
    const view = mount('hello world');
    const event = dragEvent('dragover', ['text/plain']);
    view.contentDOM.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(hasCaret()).toBe(false);
    view.destroy();
  });

  /**
   * A note in the trash takes the file and keeps it, so a point drawn there was an aim at
   * nothing. Still claimed, or the browser would open the file in the app's place.
   */
  it('refuses a file over a note that takes no changes, without drawing a point', () => {
    const view = mount('hello world', { readOnly: true });
    const event = dragEvent('dragover', ['Files']);
    view.contentDOM.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect((event as DragEvent).dataTransfer?.dropEffect).toBe('none');
    expect(hasCaret()).toBe(false);
    view.destroy();
  });

  it('clears the marker when the drag ends without a drop', () => {
    const view = mount('hello world');
    view.contentDOM.dispatchEvent(dragEvent('dragover', ['Files']));
    view.contentDOM.dispatchEvent(dragEvent('dragend', ['Files']));
    expect(hasCaret()).toBe(false);
    view.destroy();
  });

  it('clears the marker on drop, so it does not outlive the drag', () => {
    const view = mount('hello world');
    view.contentDOM.dispatchEvent(dragEvent('dragover', ['Files']));
    view.contentDOM.dispatchEvent(dragEvent('drop', ['Files']));
    expect(hasCaret()).toBe(false);
    view.destroy();
  });
});
