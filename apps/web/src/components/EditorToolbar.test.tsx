import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { EditorToolbar, type NoteView } from './EditorToolbar.js';
import { attachments, type AttachConfig } from '../editor/attach.js';

/**
 * The view switcher, which is the part of this toolbar with a state machine in it.
 *
 * The formatting buttons are thin wrappers over commands that `markdown-commands.test.ts`
 * already covers command-by-command; what is worth pinning here is the behaviour that
 * replaced two booleans with one value — that exactly one view reads as selected, that
 * the split modifier appears only where it applies, and that formatting goes inert in a
 * view with no selection to format.
 *
 * `view` is null throughout: a real EditorView needs a layout jsdom will not give it, and
 * every assertion here is about the switcher, which never touches it.
 */
function setup(
  current: NoteView,
  opts: { split?: { on: boolean; onToggle: () => void }; onChange?: (v: NoteView) => void } = {},
) {
  render(
    <EditorToolbar
      view={null}
      noteView={{ current, onChange: opts.onChange ?? (() => {}), split: opts.split }}
    />,
  );
}

afterEach(cleanup);

describe('EditorToolbar view switcher', () => {
  it('marks exactly one view selected', () => {
    setup('source');
    const checked = screen
      .getAllByRole('radio')
      .filter((b) => b.getAttribute('aria-checked') === 'true');
    expect(checked.map((b) => b.textContent)).toEqual(['Source']);
  });

  it('reports the view the user picked', () => {
    const onChange = vi.fn();
    setup('rich', { onChange });
    // mousedown, not click: the buttons act on mousedown so the editor keeps its selection.
    fireEvent.mouseDown(screen.getByRole('radio', { name: 'Preview' }));
    expect(onChange).toHaveBeenCalledWith('preview');
  });

  /*
     The split control is a modifier on the source view. Showing it anywhere else would
     invite the question of what it does there, which is the confusion the three-view
     model exists to end.
  */
  it('offers the split only in the source view', () => {
    const split = { on: false, onToggle: () => {} };
    setup('source', { split });
    expect(screen.queryByLabelText('Preview beside source')).not.toBeNull();

    cleanup();
    setup('rich', { split });
    expect(screen.queryByLabelText('Preview beside source')).toBeNull();

    cleanup();
    setup('preview', { split });
    expect(screen.queryByLabelText('Preview beside source')).toBeNull();
  });

  /* Undefined split means a width with no room for a second pane, not a split that is off. */
  it('hides the split where it cannot apply', () => {
    setup('source');
    expect(screen.queryByLabelText('Preview beside source')).toBeNull();
  });

  it('disables formatting in the preview, where there is nothing to format', () => {
    setup('preview');
    expect((screen.getByLabelText('Bold (⌘B)') as HTMLButtonElement).disabled).toBe(true);

    cleanup();
    // Still disabled in an editing view here only because `view` is null; the point is
    // that preview disables it independently of whether the editor has mounted.
    setup('rich');
    expect((screen.getByLabelText('Bold (⌘B)') as HTMLButtonElement).disabled).toBe(true);
  });
});

/**
 * The Attach button, which is the one control in the bar that opens something rather
 * than acting on the selection.
 *
 * A real view here, unlike above: whether the button is enabled depends on what the
 * view was configured with, and whether a chosen file lands depends on the view's
 * document. jsdom gives CodeMirror enough of a DOM for both.
 */
describe('EditorToolbar attach', () => {
  function mount(config: AttachConfig | null) {
    return new EditorView({
      state: EditorState.create({ doc: 'body', extensions: config ? [attachments(config)] : [] }),
      parent: document.body,
    });
  }

  const attach = () => screen.getByLabelText('Attach file') as HTMLButtonElement;

  it('is disabled until there is an editor', () => {
    setup('rich');
    expect(attach().disabled).toBe(true);
  });

  // Among the inserts: Link, then Attach, then Table. Its family, not a slot of its own.
  it('sits right after Link', () => {
    setup('rich');
    const labels = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    expect(labels.indexOf('Attach file')).toBe(labels.indexOf('Link (⌘K)') + 1);
    expect(labels[labels.indexOf('Attach file') + 1]).toBe('Table');
  });

  it('is disabled in the preview, where the cursor it inserts at is not on screen', () => {
    const view = mount({ upload: async () => 'files/x' });
    render(<EditorToolbar view={view} noteView={{ current: 'preview', onChange: () => {} }} />);
    expect(attach().disabled).toBe(true);
    view.destroy();
  });

  it('is disabled on a note that cannot take files', () => {
    const view = mount(null);
    render(<EditorToolbar view={view} noteView={{ current: 'rich', onChange: () => {} }} />);
    expect(attach().disabled).toBe(true);
    view.destroy();
  });

  it('opens the file picker on click, and puts the chosen file at the cursor', async () => {
    const view = mount({ upload: () => new Promise(() => {}) });
    view.dispatch({ selection: { anchor: 4 } });
    render(<EditorToolbar view={view} noteView={{ current: 'rich', onChange: () => {} }} />);
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});

    expect(attach().disabled).toBe(false);
    fireEvent.click(attach());
    expect(click).toHaveBeenCalledTimes(1);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } });
    expect(view.state.doc.toString()).toMatch(/^body!\[uploading a\.png…]/);

    click.mockRestore();
    view.destroy();
  });
});
