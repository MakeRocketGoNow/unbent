import { afterEach, describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';
import { attachments } from './attach.js';
import { fileDropCursor } from './drop-cursor.js';
import { noteDropZone } from './drop-zone.js';

/**
 * The whole note as a drop target, not only the lines its text fills.
 *
 * A new note's text is one line, so the target used to be one line, and a file let go on
 * the empty page under it was opened by the browser in place of the app.
 *
 * jsdom has no layout, so every box measures zero and a pointer at (10, 10) is "below the
 * text" unless a test lays the text out with `layOut`. Which drags the zone claims, which
 * it leaves to the editor, and that a drop goes in as a paragraph of its own need no
 * layout; where above and beside the text land are checked against a box set by hand.
 */

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  document.body.replaceChildren();
});

/** A column holding a title above the editor, the way the note's column does. */
function mount(doc: string, { readOnly = false } = {}) {
  const zone = document.createElement('div');
  const title = document.createElement('input');
  zone.appendChild(title);
  document.body.appendChild(zone);
  const uploaded: string[] = [];
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        // The editor's own parse, tables included: where a file beside the text goes
        // depends on the markdown block the line beside it belongs to.
        markdown({ extensions: [GFM] }),
        fileDropCursor(),
        attachments({
          upload: async (file) => {
            uploaded.push(file.name);
            return `files/${file.name}`;
          },
        }),
        EditorState.readOnly.of(readOnly),
      ],
    }),
    parent: zone,
  });
  const off = noteDropZone(zone, view);
  // Chained, since `besideLine` mounts more than once in a test.
  const previous = cleanup;
  cleanup = () => {
    previous?.();
    off();
    view.destroy();
  };
  return { zone, title, view, uploaded };
}

/** A drag event carrying `types`, from (10, 10); jsdom has neither DragEvent nor DataTransfer. */
function dragEvent(type: string, types = ['Files'], extra: Record<string, unknown> = {}): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const files = types.includes('Files') ? [new File(['x'], 'scan.png', { type: 'image/png' })] : [];
  Object.defineProperty(event, 'dataTransfer', {
    value: { types, files, getData: () => '', dropEffect: 'copy' },
    configurable: true,
  });
  for (const [key, value] of Object.entries({ clientX: 10, clientY: 10, ...extra })) {
    Object.defineProperty(event, key, { value, configurable: true });
  }
  return event as DragEvent;
}

/**
 * Puts the text in a box from (50, 100) to (250, 200), with line `level` level with every
 * height inside it — jsdom measures each line at zero height, so CodeMirror's own answer
 * is always the last line. That is all `landingFor` measures.
 */
function layOut(view: EditorView, level = 1) {
  const box = { left: 50, top: 100, right: 250, bottom: 200, width: 200, height: 100, x: 50, y: 100 };
  view.contentDOM.getBoundingClientRect = () => ({ ...box, toJSON: () => box }) as DOMRect;
  view.lineBlockAtHeight = () => view.lineBlockAt(view.state.doc.line(level).from);
}

/** Where a file over the right margin, then the left, points beside line `level`. */
function besideLine(doc: string, level: number): [number | null, number | null] {
  const { zone, view } = mount(doc);
  layOut(view, level);
  zone.dispatchEvent(dragEvent('dragover', ['Files'], { clientX: 300, clientY: 150 }));
  const right = caretAt(view);
  zone.dispatchEvent(dragEvent('dragover', ['Files'], { clientX: 10, clientY: 150 }));
  return [right, caretAt(view)];
}

/** Where the drop point is drawn, or null when it is not. */
function caretAt(view: EditorView): number | null {
  const caret = view.dom.querySelector('.cm-dropCursor-caret');
  return caret ? view.posAtDOM(caret) : null;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('noteDropZone', () => {
  it('claims a file over the page under the text, and points at the end', () => {
    const { zone, view } = mount('one\ntwo');
    const event = dragEvent('dragover');
    zone.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(caretAt(view)).toBe(7);
  });

  it('points at the top for a file above the text', () => {
    const { title, view } = mount('one\ntwo');
    layOut(view);
    title.dispatchEvent(dragEvent('dragover', ['Files'], { clientX: 120, clientY: 50 }));
    expect(caretAt(view)).toBe(0);
  });

  /** The side decides: before the paragraph from the left margin, after it from the right. */
  it('points before or after the paragraph beside a file in a margin', () => {
    expect(besideLine('one\n\ntwo', 1)).toEqual([3, 0]);
    expect(besideLine('one\n\ntwo', 3)).toEqual([8, 5]);
  });

  /*
     A row of a fence, a table, a list or a quote is a line of its own in rich mode, but a
     file set apart beside it would go inside the fence as text, or cut the rest in two.
  */
  it('points before or after the whole block a line in a margin belongs to', () => {
    const fence = '```\ncode one\ncode two\n```\n\nafter';
    expect(besideLine(fence, 3)).toEqual([fence.indexOf('\n\n'), 0]);
    const table = '| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n\nafter';
    expect(besideLine(table, 3)).toEqual([table.indexOf('\n\n'), 0]);
    expect(besideLine('- one\n- two\n- three', 2)).toEqual([19, 0]);
    expect(besideLine('> one\n> two', 2)).toEqual([11, 0]);
    expect(besideLine('one\ntwo', 2)).toEqual([7, 0]);
  });

  it('points at a blank line between blocks as it is', () => {
    expect(besideLine('one\n\ntwo', 2)).toEqual([4, 4]);
  });

  it('leaves a drag the editor claimed to the editor', () => {
    const { view } = mount('one\ntwo');
    // Without layout the editor's own lookup answers the start of the note; the zone,
    // had it taken the drag as well, would have moved the point to the end.
    const event = dragEvent('dragover');
    view.contentDOM.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(caretAt(view)).toBe(0);
  });

  it('ignores a drag that carries no files', () => {
    const { zone, view } = mount('one');
    const event = dragEvent('dragover', ['text/plain']);
    zone.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(caretAt(view)).toBeNull();
  });

  it('refuses a file over a note that takes no changes', () => {
    const { zone, view } = mount('one', { readOnly: true });
    const event = dragEvent('dragover');
    zone.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(event.dataTransfer?.dropEffect).toBe('none');
    expect(caretAt(view)).toBeNull();
  });

  it('keeps the point while the drag crosses the note, and clears it when it leaves', () => {
    const { zone, title, view } = mount('one');
    zone.dispatchEvent(dragEvent('dragover'));
    title.dispatchEvent(dragEvent('dragleave', ['Files'], { relatedTarget: view.contentDOM }));
    expect(caretAt(view)).toBe(3);
    zone.dispatchEvent(dragEvent('dragleave', ['Files'], { relatedTarget: document.body }));
    expect(caretAt(view)).toBeNull();
  });

  it('puts a file dropped under the text after it, as a paragraph of its own', async () => {
    const { zone, view, uploaded } = mount('> a quote');
    zone.dispatchEvent(dragEvent('dragover'));
    const event = dragEvent('drop');
    zone.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(caretAt(view)).toBeNull();
    await settle();
    expect(uploaded).toEqual(['scan.png']);
    expect(view.state.doc.toString()).toBe('> a quote\n\n![scan.png](files/scan.png)\n');
  });

  it('puts a file dropped beside a fence after the fence, not inside it', async () => {
    const { zone, view } = mount('```\ncode one\ncode two\n```\n\nafter');
    layOut(view, 3);
    zone.dispatchEvent(dragEvent('drop', ['Files'], { clientX: 300, clientY: 150 }));
    await settle();
    expect(view.state.doc.toString()).toBe(
      '```\ncode one\ncode two\n```\n\n![scan.png](files/scan.png)\n\nafter',
    );
  });

  it('puts a file dropped above the text at the top', async () => {
    const { title, view } = mount('one');
    layOut(view);
    title.dispatchEvent(dragEvent('drop', ['Files'], { clientX: 120, clientY: 50 }));
    await settle();
    expect(view.state.doc.toString()).toBe('![scan.png](files/scan.png)\n\none');
  });

  it('takes nothing into a note that takes no changes', async () => {
    const { zone, view, uploaded } = mount('one', { readOnly: true });
    const event = dragEvent('drop');
    zone.dispatchEvent(event);
    // Still claimed, or the browser would open the file in the app's place.
    expect(event.defaultPrevented).toBe(true);
    await settle();
    expect(uploaded).toEqual([]);
    expect(view.state.doc.toString()).toBe('one');
  });

  it('stops listening when it is taken off', () => {
    const { zone } = mount('one');
    cleanup?.();
    cleanup = null;
    const event = dragEvent('dragover');
    zone.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
