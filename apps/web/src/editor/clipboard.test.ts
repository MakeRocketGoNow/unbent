import { beforeAll, describe, expect, it, vi } from 'vitest';
import { history, undo } from '@codemirror/commands';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';
import { attachmentUrl } from '@unbent/shared';
import { attachmentClipboard, CUT_FLAVOUR, loadConverter, type ClipboardConfig } from './clipboard.js';

/**
 * Attachment links across the clipboard: what leaves a note names the note, and what
 * arrives from another note brings its files with it.
 */

const HERE = 'note-here';
const THERE = 'note-there';

function mount(
  doc: string,
  config: ClipboardConfig,
  selection?: { anchor: number; head: number },
  extensions: Extension[] = [],
) {
  return new EditorView({
    state: EditorState.create({
      doc,
      selection,
      extensions: [markdown({ extensions: [GFM] }), attachmentClipboard(config), ...extensions],
    }),
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

describe('an escaped slash in a destination', () => {
  it('is still a same-note link to copy', () => {
    const doc = '[a](files\\/a.pdf)';
    const view = mount(doc, { noteId: HERE }, { anchor: 0, head: doc.length });
    const data = clipboard();
    fire(view, 'copy', data);
    expect(data.store.get('text/plain')).toBe(`[a](${attachmentUrl(HERE, 'a.pdf')})`);
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

  /**
   * The editor is rebuilt on a rich/source switch, with the document carried across,
   * and CodeMirror takes a dispatch to a destroyed view silently. The copy lands after a
   * switch here, and the links must be rewritten in the editor that is live then.
   */
  it('relinks in the editor open when the copy lands, not the one pasted into', async () => {
    let finish: (names: Map<string, string>) => void = () => {};
    const copyFrom = vi.fn(() => new Promise<Map<string, string>>((resolve) => { finish = resolve; }));
    const views = { current: null as EditorView | null };
    const config: ClipboardConfig = { noteId: HERE, copyFrom, liveView: () => views.current };
    const pressed = mount('', config);
    views.current = pressed;
    const text = `[a](${attachmentUrl(THERE, 'a.pdf')})`;
    fire(pressed, 'paste', clipboard({ 'text/plain': text }));
    await settle();
    expect(copyFrom).toHaveBeenCalledWith(THERE, ['a.pdf'], false);
    const carried = pressed.state.doc.toString();

    pressed.destroy();
    const live = mount(carried, config);
    views.current = live;
    finish(new Map([['a.pdf', 'a.pdf']]));
    await settle();
    expect(live.state.doc.toString()).toBe('[a](files/a.pdf)');
    live.destroy();
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

/**
 * A paste from a web page, a mail or a document arrives as the Markdown a person would
 * have typed for it, rather than as the flat text the clipboard also carries.
 */
describe('paste from a page', () => {
  // A paste this handler declines is CodeMirror's, which claims the event too and inserts
  // `text/plain`; so a decline shows as the plain text in the document, not as an
  // unclaimed event.

  // The converter is its own chunk, loaded on first use; loaded here once, a paste waits
  // only a microtask for it, as every paste after a page's first does.
  beforeAll(() => loadConverter());

  async function pasteInto(view: EditorView, data: ReturnType<typeof clipboard>) {
    const event = fire(view, 'paste', data);
    await settle();
    return event;
  }
  const PAGE = [
    '<meta charset="utf-8">',
    '<h2 style="color: #333">Getting started</h2>',
    '<p>Read <a href="https://example.com/guide" class="x">the guide</a> <b>first</b>.</p>',
    '<ul><li>one</li><li>two</li></ul>',
  ].join('');
  const PAGE_MD = '## Getting started\n\nRead [the guide](https://example.com/guide) **first**.\n\n- one\n- two';

  it('inserts the HTML as Markdown and leaves the plain text unused', async () => {
    const view = mount('', { noteId: HERE });
    const event = await pasteInto(view, clipboard({ 'text/html': PAGE, 'text/plain': 'Getting started\nRead the guide first.' }));
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe(PAGE_MD);
    expect(view.state.selection.main.head).toBe(PAGE_MD.length);
    view.destroy();
  });

  /**
   * A code editor writes a `<div>` a line and a `<span>` a colour. Made into paragraphs
   * the code would lose its line structure and its indentation; it is plain text.
   */
  it('pastes the plain text of HTML that is only divs and spans', async () => {
    const view = mount('', { noteId: HERE });
    const html =
      '<div style="color: #d4d4d4"><div><span style="color: #569cd6">if</span> (x) {</div>' +
      '<div>&nbsp;&nbsp;<span>go</span>();</div><div>}</div></div>';
    await pasteInto(view, clipboard({ 'text/html': html, 'text/plain': 'if (x) {\n  go();\n}' }));
    expect(view.state.doc.toString()).toBe('if (x) {\n  go();\n}');
    view.destroy();
  });

  it('pastes the characters into a fenced code block', async () => {
    const doc = '```\nlet a = 1;\n\n```';
    const at = doc.indexOf('\n\n') + 1;
    const view = mount(doc, { noteId: HERE }, { anchor: at, head: at });
    await pasteInto(view, clipboard({ 'text/html': '<pre><code>b = 2</code></pre>', 'text/plain': 'b = 2' }));
    expect(view.state.doc.toString()).toBe('```\nlet a = 1;\nb = 2\n```');
    view.destroy();
  });

  it('pastes the characters into an unclosed fence and inline code, and converts after a closed one', async () => {
    const html = '<b>bold</b>';
    const paste = async (doc: string, at: number) => {
      const view = mount(doc, { noteId: HERE }, { anchor: at, head: at });
      await pasteInto(view, clipboard({ 'text/html': html, 'text/plain': 'bold' }));
      const out = view.state.doc.toString();
      view.destroy();
      return out;
    };
    expect(await paste('```\nx\n', 6)).toBe('```\nx\nbold');
    expect(await paste('a `xy` b', 4)).toBe('a `xboldy` b');
    expect(await paste('a `xy` b', 6)).toBe('a `xy`**bold** b');
    expect(await paste('```\nx\n```', 9)).toBe('```\nx\n```**bold**');
  });

  it('leaves text cut from a note on the plain path', async () => {
    const view = mount('', { noteId: HERE });
    await pasteInto(view, clipboard({ 'text/html': '<b>moved</b>', 'text/plain': 'moved', [CUT_FLAVOUR]: '1' }));
    expect(view.state.doc.toString()).toBe('moved');
    view.destroy();
  });

  it('leaves HTML naming a note file to the plain path', async () => {
    const view = mount('', { noteId: HERE });
    const html = `<p><a href="${attachmentUrl(THERE, 'a.pdf', 'https://app.example')}">a.pdf</a></p>`;
    await pasteInto(view, clipboard({ 'text/html': html, 'text/plain': 'a.pdf' }));
    expect(view.state.doc.toString()).toBe('a.pdf');
    view.destroy();
  });

  it('brings a linked file across rather than converting, when the text links one', async () => {
    const copyFrom = vi.fn(async (_from: string, filenames: string[]) => new Map(filenames.map((n) => [n, n])));
    const view = mount('', { noteId: HERE, copyFrom });
    const text = `[a](${attachmentUrl(THERE, 'a.pdf')})`;
    await pasteInto(view, clipboard({ 'text/html': '<h1>Not this</h1>', 'text/plain': text }));
    await settle();
    expect(copyFrom).toHaveBeenCalledWith(THERE, ['a.pdf'], false);
    expect(view.state.doc.toString()).toBe('[a](files/a.pdf)');
    view.destroy();
  });

  it('replaces the selection', async () => {
    const doc = 'keep this and that';
    const view = mount(doc, { noteId: HERE }, { anchor: 5, head: 9 });
    await pasteInto(view, clipboard({ 'text/html': '<a href="https://example.com/">link</a>', 'text/plain': 'link' }));
    expect(view.state.doc.toString()).toBe('keep [link](https://example.com/) and that');
    expect(view.state.selection.main.head).toBe('keep [link](https://example.com/)'.length);
    view.destroy();
  });

  it('is undone with one undo, apart from the typing before it', async () => {
    const view = mount('', { noteId: HERE }, undefined, [history()]);
    view.dispatch({ changes: { from: 0, insert: 'typed ' }, selection: { anchor: 6 }, userEvent: 'input.type' });
    await pasteInto(view, clipboard({ 'text/html': PAGE, 'text/plain': 'flat' }));
    expect(view.state.doc.toString()).toBe(`typed \n\n${PAGE_MD}`);
    undo(view);
    expect(view.state.doc.toString()).toBe('typed ');
    view.destroy();
  });

  it('pastes one paragraph inline, mid-sentence', async () => {
    const view = mount('before  after', { noteId: HERE }, { anchor: 7, head: 7 });
    await pasteInto(view, clipboard({ 'text/html': '<p>an <em>emphatic</em> word</p>', 'text/plain': 'an emphatic word' }));
    expect(view.state.doc.toString()).toBe('before an _emphatic_ word after');
    view.destroy();
  });

  it('sets blocks pasted mid-line apart on lines of their own', async () => {
    const view = mount('before after', { noteId: HERE }, { anchor: 7, head: 7 });
    await pasteInto(view, clipboard({ 'text/html': '<h3>Title</h3><p>Body</p>', 'text/plain': 'Title\nBody' }));
    expect(view.state.doc.toString()).toBe('before \n\n### Title\n\nBody\n\nafter');
    expect(view.state.selection.main.head).toBe('before \n\n### Title\n\nBody'.length);
    view.destroy();
  });

  it('sets a block apart from the paragraph above and below it, adding only what is missing', async () => {
    const doc = 'above\n\nbelow';
    const view = mount(doc, { noteId: HERE }, { anchor: 6, head: 6 });
    await pasteInto(view, clipboard({ 'text/html': '<ul><li>a</li></ul>', 'text/plain': 'a' }));
    expect(view.state.doc.toString()).toBe('above\n\n- a\n\nbelow');
    view.destroy();
  });

  /**
   * Google Docs wraps a selection in `<b style="font-weight:normal">` and draws its own
   * bold and italic with styled spans. Read as written, the whole paste was one bold run.
   */
  it('reads Google Docs bold and italic from their styles, not from its wrapper', async () => {
    const view = mount('', { noteId: HERE });
    const html =
      '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1">' +
      '<h1 dir="ltr"><span style="font-size:20pt;font-weight:700">Plan</span></h1>' +
      '<p dir="ltr"><span style="font-weight:700">Bold</span><span style="font-weight:400"> and </span>' +
      '<span style="font-style:italic">slanted</span></p></b><br class="Apple-interchange-newline">';
    await pasteInto(view, clipboard({ 'text/html': html, 'text/plain': 'Plan\nBold and slanted' }));
    expect(view.state.doc.toString()).toBe('# Plan\n\n**Bold** and _slanted_');
    view.destroy();
  });

  it('drops the fragment markers, a picture made of bytes, and a link with nowhere to go', async () => {
    const view = mount('', { noteId: HERE });
    const html =
      '<html><body><!--StartFragment--><h2>Head</h2><p>See <a href="/elsewhere">there</a>' +
      '<img src="data:image/png;base64,AAAA" alt="x"><img src="https://example.com/a.png" alt="pic"></p>' +
      '<!--EndFragment--></body></html>';
    await pasteInto(view, clipboard({ 'text/html': html, 'text/plain': 'Head\nSee there' }));
    expect(view.state.doc.toString()).toBe('## Head\n\nSee there![pic](https://example.com/a.png)');
    view.destroy();
  });

  it('inserts the plain text when the conversion comes out empty', async () => {
    const view = mount('', { noteId: HERE });
    const event = await pasteInto(view, clipboard({ 'text/html': '<img src="data:image/png;base64,AAAA">', 'text/plain': 'alt' }));
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe('alt');
    view.destroy();
  });

  it('resolves relative addresses against the source the clipboard names', async () => {
    const view = mount('', { noteId: HERE });
    const html =
      'Version:0.9\r\nStartHTML:0000000105\r\nSourceURL:https://example.com/docs/page\r\n' +
      '<html><body><!--StartFragment--><p><a href="other">other</a> <img src="../pic.png" alt="p"></p><!--EndFragment--></body></html>';
    await pasteInto(view, clipboard({ 'text/html': html, 'text/plain': 'other' }));
    expect(view.state.doc.toString()).toBe('[other](https://example.com/docs/other) ![p](https://example.com/pic.png)');
    view.destroy();
  });

  it('keeps the words of an anchor with no address, and no empty link', async () => {
    const view = mount('', { noteId: HERE });
    await pasteInto(view, clipboard({ 'text/html': '<h2><a id="sec"></a>Section</h2><p>Body</p>', 'text/plain': 'Section\nBody' }));
    expect(view.state.doc.toString()).toBe('## Section\n\nBody');
    view.destroy();
  });

  it('holds video to what a link is held to', async () => {
    const view = mount('', { noteId: HERE });
    const html =
      'Version:0.9\r\nSourceURL:https://example.com/docs/page\r\n<h2>Clip</h2><video src="v.mp4" poster="p.jpg"></video>';
    await pasteInto(view, clipboard({ 'text/html': html, 'text/plain': 'Clip' }));
    expect(view.state.doc.toString()).toBe('## Clip\n\n[![](https://example.com/docs/p.jpg)](https://example.com/docs/v.mp4)');
    view.destroy();

    const unresolved = mount('', { noteId: HERE });
    await pasteInto(unresolved, clipboard({ 'text/html': '<h2>Clip</h2><video src="v.mp4"></video>', 'text/plain': 'Clip' }));
    expect(unresolved.state.doc.toString()).toBe('## Clip');
    unresolved.destroy();
  });

  it('lands in the editor open when the converter answers, not the one pasted into', async () => {
    const views = { current: null as EditorView | null };
    const config: ClipboardConfig = { noteId: HERE, liveView: () => views.current };
    const pressed = mount('', config);
    views.current = pressed;
    fire(pressed, 'paste', clipboard({ 'text/html': PAGE, 'text/plain': 'flat' }));

    pressed.destroy();
    const live = mount('', config);
    views.current = live;
    await settle();
    expect(live.state.doc.toString()).toBe(PAGE_MD);
    live.destroy();
  });

  it('inserts nothing when the note has closed by the time the converter answers', async () => {
    const views = { current: null as EditorView | null };
    const pressed = mount('', { noteId: HERE, liveView: () => views.current });
    views.current = pressed;
    fire(pressed, 'paste', clipboard({ 'text/html': PAGE, 'text/plain': 'flat' }));
    views.current = null;
    await settle();
    expect(pressed.state.doc.toString()).toBe('');
    pressed.destroy();
  });

  it('leaves HTML too large to convert to the browser, which pastes its plain text', async () => {
    const view = mount('', { noteId: HERE });
    const html = `<table>${'<tr><td style="color:red">x</td></tr>'.repeat(30_000)}</table>`;
    const event = await pasteInto(view, clipboard({ 'text/html': html, 'text/plain': 'x' }));
    expect(event.defaultPrevented).toBe(false);
    view.destroy();
  });

  it('keeps the spaces at the edge of a run going in mid-sentence', async () => {
    const view = mount('a b', { noteId: HERE }, { anchor: 2, head: 2 });
    await pasteInto(view, clipboard({ 'text/html': '<b>word</b> ', 'text/plain': 'word ' }));
    expect(view.state.doc.toString()).toBe('a **word** b');
    view.destroy();
  });

  it('declines on a read-only note', async () => {
    const view = mount('', { noteId: HERE }, undefined, [EditorState.readOnly.of(true)]);
    await pasteInto(view, clipboard({ 'text/html': PAGE, 'text/plain': 'flat' }));
    expect(view.state.doc.toString()).toBe('');
    view.destroy();
  });
});
