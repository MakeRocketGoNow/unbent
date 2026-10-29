import { describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';
import { attachmentUrl } from '@unbent/shared';
import { attachmentClipboard, CUT_FLAVOUR, type ClipboardConfig } from './clipboard.js';

/**
 * Attachment links across the clipboard: what leaves a note names the note, and what
 * arrives from another note brings its files with it.
 */

const HERE = 'note-here';
const THERE = 'note-there';

function mount(doc: string, config: ClipboardConfig, selection?: { anchor: number; head: number }) {
  return new EditorView({
    state: EditorState.create({ doc, selection, extensions: [markdown({ extensions: [GFM] }), attachmentClipboard(config)] }),
    parent: document.body,
  });
}

/** A DataTransfer stand-in: jsdom's ClipboardEvent carries no clipboardData. */
function clipboard(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    files: [] as File[],
    types: [...store.keys()],
    getData: (type: string) => store.get(type) ?? '',
    setData: (type: string, value: string) => void store.set(type, value),
    store,
  };
}

function fire(view: EditorView, type: 'copy' | 'cut' | 'paste', data: ReturnType<typeof clipboard>) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: data, configurable: true });
  view.contentDOM.dispatchEvent(event);
  return event;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('copy', () => {
  it('names the note in every attachment link of the selection', () => {
    const doc = 'see ![a](files/a.png) and [b](<files/my b.pdf>)';
    const view = mount(doc, { noteId: HERE, origin: 'https://app.example' }, { anchor: 0, head: doc.length });
    const data = clipboard();
    const event = fire(view, 'copy', data);
    expect(event.defaultPrevented).toBe(true);
    expect(data.store.get('text/plain')).toBe(
      `see ![a](${attachmentUrl(HERE, 'a.png', 'https://app.example')}) and [b](${attachmentUrl(HERE, 'my b.pdf', 'https://app.example')})`,
    );
    expect(data.store.has(CUT_FLAVOUR)).toBe(false);
    expect(view.state.doc.toString()).toBe(doc);
    view.destroy();
  });

  it('leaves a selection with no attachment link to the editor', () => {
    const view = mount('plain prose', { noteId: HERE }, { anchor: 0, head: 5 });
    const event = fire(view, 'copy', clipboard());
    expect(event.defaultPrevented).toBe(false);
    view.destroy();
  });

  it('leaves an empty selection to the editor, which copies the line', () => {
    const view = mount('![a](files/a.png)', { noteId: HERE });
    const event = fire(view, 'copy', clipboard());
    expect(event.defaultPrevented).toBe(false);
    view.destroy();
  });
});

describe('copy in context', () => {
  /**
   * A third-level bullet is indented four spaces, which is a code block to a parser
   * handed the selected line alone and a list item to the editor's tree. The links are
   * read where they lie in the document, so the copy carries the file either way.
   */
  it('rewrites a link in a deeply nested bullet', () => {
    const doc = '- a\n  - b\n    - [x](files/a.pdf)';
    const view = mount(doc, { noteId: HERE }, { anchor: doc.indexOf('    -'), head: doc.length });
    const data = clipboard();
    fire(view, 'copy', data);
    expect(data.store.get('text/plain')).toBe(`    - [x](${attachmentUrl(HERE, 'a.pdf')})`);
    view.destroy();
  });

  it('leaves a link cut across the selection edge, and one in a code block, as written', () => {
    const doc = '![a](files/a.png)\n\n    [b](files/b.pdf)';
    const view = mount(doc, { noteId: HERE }, { anchor: 3, head: doc.length });
    const data = clipboard();
    const event = fire(view, 'copy', data);
    expect(event.defaultPrevented).toBe(false);
    view.destroy();
  });

  it('keeps a title and rewrites a picture inside a link with the link', () => {
    const doc = `[![a](<files/a b.png> "pic")](files/c.pdf "doc")`;
    const view = mount(doc, { noteId: HERE }, { anchor: 0, head: doc.length });
    const data = clipboard();
    fire(view, 'copy', data);
    expect(data.store.get('text/plain')).toBe(
      `[![a](${attachmentUrl(HERE, 'a b.png')} "pic")](${attachmentUrl(HERE, 'c.pdf')} "doc")`,
    );
    view.destroy();
  });
});

describe('cut', () => {
  it('marks the text as cut and removes it from the document', () => {
    const doc = 'keep ![a](files/a.png)';
    const view = mount(doc, { noteId: HERE }, { anchor: 5, head: doc.length });
    const data = clipboard();
    const event = fire(view, 'cut', data);
    expect(event.defaultPrevented).toBe(true);
    expect(data.store.get('text/plain')).toBe(`![a](${attachmentUrl(HERE, 'a.png')})`);
    expect(data.store.get(CUT_FLAVOUR)).toBe('1');
    expect(view.state.doc.toString()).toBe('keep ');
    view.destroy();
  });
});

describe('paste', () => {
  it('relinks a picture inside a link and the link around it in one transaction', async () => {
    const copyFrom = vi.fn(async (_from: string, filenames: string[]) => new Map(filenames.map((n) => [n, n])));
    const view = mount('', { noteId: HERE, copyFrom });
    const text = `[![a](${attachmentUrl(THERE, 'a.png')})](${attachmentUrl(THERE, 'b.pdf')})`;
    fire(view, 'paste', clipboard({ 'text/plain': text }));
    await settle();
    // Two changes over one span is a transaction CodeMirror refuses: each rewrite is its
    // own destination, and the label between them is left as it was.
    expect(view.state.doc.toString()).toBe('[![a](files/a.png)](files/b.pdf)');
    view.destroy();
  });

  it('copies another note files across and links them under the names they got here', async () => {
    const copyFrom = vi.fn(async (_from: string, filenames: string[]) =>
      new Map(filenames.map((name) => [name, name === 'a.png' ? 'a-2.png' : name])),
    );
    const view = mount('start ', { noteId: HERE, copyFrom }, { anchor: 6, head: 6 });
    const text = `![a](${attachmentUrl(THERE, 'a.png', 'https://app.example')}) [b](${attachmentUrl(THERE, 'my b.pdf')})`;
    const event = fire(view, 'paste', clipboard({ 'text/plain': text }));
    expect(event.defaultPrevented).toBe(true);
    // In at once, still absolute, so the paste does not wait on the server.
    expect(view.state.doc.toString()).toBe(`start ${text}`);

    await settle();
    expect(copyFrom).toHaveBeenCalledWith(THERE, ['a.png', 'my b.pdf'], false);
    expect(view.state.doc.toString()).toBe('start ![a](files/a-2.png) [b](<files/my b.pdf>)');
    view.destroy();
  });

  it('finds a link in a pasted nested bullet, once the text has its context', async () => {
    const copyFrom = vi.fn(async (_from: string, filenames: string[]) => new Map(filenames.map((n) => [n, n])));
    const view = mount('', { noteId: HERE, copyFrom });
    fire(view, 'paste', clipboard({ 'text/plain': `- a\n  - b\n    - [x](${attachmentUrl(THERE, 'a.pdf')})` }));
    await settle();
    expect(copyFrom).toHaveBeenCalledWith(THERE, ['a.pdf'], false);
    expect(view.state.doc.toString()).toBe('- a\n  - b\n    - [x](files/a.pdf)');
    view.destroy();
  });

  it('claims text that only looks like it holds a link, and inserts it as it is', async () => {
    const copyFrom = vi.fn();
    const view = mount('', { noteId: HERE, copyFrom });
    const text = `    [a](${attachmentUrl(THERE, 'a.pdf')})`;
    const event = fire(view, 'paste', clipboard({ 'text/plain': text }));
    expect(event.defaultPrevented).toBe(true);
    await settle();
    expect(copyFrom).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe(text);
    view.destroy();
  });

  it('asks for a move when the text was cut', async () => {
    const copyFrom = vi.fn(async (_from: string, filenames: string[]) =>
      new Map(filenames.map((name) => [name, name])),
    );
    const view = mount('', { noteId: HERE, copyFrom });
    fire(view, 'paste', clipboard({ 'text/plain': `[a](${attachmentUrl(THERE, 'a.pdf')})`, [CUT_FLAVOUR]: '1' }));
    await settle();
    expect(copyFrom).toHaveBeenCalledWith(THERE, ['a.pdf'], true);
    expect(view.state.doc.toString()).toBe('[a](files/a.pdf)');
    view.destroy();
  });

  it('relinks this note own files without a copy', async () => {
    const copyFrom = vi.fn();
    const view = mount('', { noteId: HERE, copyFrom });
    fire(view, 'paste', clipboard({ 'text/plain': `![a](${attachmentUrl(HERE, 'a.png', 'https://app.example')})` }));
    await settle();
    expect(copyFrom).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe('![a](files/a.png)');
    view.destroy();
  });

  it('leaves a link absolute when its copy fails', async () => {
    const copyFrom = vi.fn(async () => {
      throw new Error('offline');
    });
    const view = mount('', { noteId: HERE, copyFrom });
    const text = `[a](${attachmentUrl(THERE, 'a.pdf')})`;
    fire(view, 'paste', clipboard({ 'text/plain': text }));
    await settle();
    expect(view.state.doc.toString()).toBe(text);
    view.destroy();
  });

  it('still finds the links after typing ahead of them', async () => {
    const copyFrom = vi.fn(async (_from: string, filenames: string[]) =>
      new Map(filenames.map((name) => [name, name])),
    );
    const view = mount('', { noteId: HERE, copyFrom });
    fire(view, 'paste', clipboard({ 'text/plain': `[a](${attachmentUrl(THERE, 'a.pdf')})` }));
    view.dispatch({ changes: { from: 0, insert: 'typed\n' } });
    await settle();
    expect(view.state.doc.toString()).toBe('typed\n[a](files/a.pdf)');
    view.destroy();
  });

  it('leaves ordinary text to CodeMirror', () => {
    const copyFrom = vi.fn();
    const view = mount('', { noteId: HERE, copyFrom });
    fire(view, 'paste', clipboard({ 'text/plain': 'hello' }));
    expect(view.state.doc.toString()).toBe('hello');
    expect(copyFrom).not.toHaveBeenCalled();
    view.destroy();
  });

  /**
   * The panel's copy of a picture puts a PNG and a link on the clipboard together. The
   * link wins: it reaches the original bytes with one server-side copy, where the PNG
   * would be a re-encoded upload.
   */
  it('prefers the link over a picture that came with it', async () => {
    const copyFrom = vi.fn(async (_from: string, filenames: string[]) =>
      new Map(filenames.map((name) => [name, name])),
    );
    const view = mount('', { noteId: HERE, copyFrom });
    const withFile = clipboard({ 'text/plain': `![a](${attachmentUrl(THERE, 'a.png')})` });
    withFile.files.push(new File(['x'], 'a.png', { type: 'image/png' }));
    const event = fire(view, 'paste', withFile);
    expect(event.defaultPrevented).toBe(true);
    await settle();
    expect(copyFrom).toHaveBeenCalledWith(THERE, ['a.png'], false);
    expect(view.state.doc.toString()).toBe('![a](files/a.png)');
    view.destroy();
  });
});
