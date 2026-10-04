import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { HistoryChanges } from './HistoryChanges.js';

/**
 * The History sheet's Changes view (MAK-167): what Restore would do to the note as it is
 * now. The comparison has its own tests (`note-diff.test.ts`); these are about what is
 * drawn from it.
 */
afterEach(cleanup);

/** A note with no notebook, tags or fields: these tests are about its text. */
const bare = { notebook: null, tags: [], fields: [] };

const table = (qty: number) => `| Item | Qty |\n| --- | --- |\n| Acme bolts | ${qty} |`;

describe('HistoryChanges', () => {
  it('says so when the version is the note as it is now', () => {
    render(<HistoryChanges current={{ ...bare, title: 'Acme', body: 'One' }} version={{ title: 'Acme', body: 'One' }} />);
    expect(screen.getByText('This version is the same as the note now.')).toBeTruthy();
    expect(document.querySelector('ins, del')).toBeNull();
  });

  it('marks the changed number, the note’s as removed and the version’s as added', () => {
    const { container } = render(
      <HistoryChanges current={{ ...bare, title: 'Acme', body: table(40) }} version={{ title: 'Acme', body: table(45) }} />,
    );
    const rows = container.querySelector('.history-diff-rows')!;
    // Each mark says which it is, so the old number and the new are not heard as one.
    expect(rows.querySelector('del')!.textContent).toBe('removed 40');
    expect(rows.querySelector('ins')!.textContent).toBe('added 45');
    const changed = rows.querySelector('.is-changed')!;
    expect(changed.textContent).toContain('| Acme bolts |');
    // The direction is said in words, in the same marks.
    expect(screen.getByText(/Restoring this version would add what is/)).toBeTruthy();
  });

  it('gives whole lines a − or + as well as a tint, so colour is not the only signal', () => {
    const { container } = render(
      <HistoryChanges current={{ ...bare, title: 'Acme', body: '' }} version={{ title: 'Acme', body: 'Kept\nAlso kept' }} />,
    );
    const added = container.querySelectorAll('.history-diff-row.is-added');
    expect(added).toHaveLength(2);
    expect(added[0]!.querySelector('.history-diff-mark')!.textContent).toBe('+');
    expect(added[0]!.querySelector('ins')!.textContent).toBe('Kept');
  });

  it('shows a title that differs above the body, and says when only the title does', () => {
    const { container } = render(
      <HistoryChanges current={{ ...bare, title: 'Acme', body: 'Same' }} version={{ title: 'Acme (final)', body: 'Same' }} />,
    );
    const title = container.querySelector('.history-diff-title')!;
    expect(title.querySelector('del')!.textContent).toBe('Acme');
    expect(title.querySelector('ins')!.textContent).toBe('Acme (final)');
    expect(screen.getByText('The text is the same as the note now.')).toBeTruthy();
  });

  it('names an empty title rather than marking nothing', () => {
    const { container } = render(
      <HistoryChanges current={{ ...bare, title: '', body: 'Same' }} version={{ title: 'Acme', body: 'Same' }} />,
    );
    expect(container.querySelector('.history-diff-title del')!.textContent).toBe('Untitled');
  });

  it('says a version too different to compare is, and points to Preview', () => {
    const a = Array.from({ length: 2000 }, (_, i) => `Acme line ${i}`).join('\n');
    const b = Array.from({ length: 2000 }, (_, i) => `Another line ${i}, example.com`).join('\n');
    render(<HistoryChanges current={{ ...bare, title: 'Acme', body: a }} version={{ title: 'Acme', body: b }} />);
    expect(screen.getByText('This version is too different to compare; see Preview.')).toBeTruthy();
  });

  it('folds unchanged lines into a button that opens them in place', () => {
    const body = (last: string) => ['One', 'Two', 'Three', 'Four', 'Five', 'Six', last].join('\n');
    const { container } = render(
      <HistoryChanges current={{ ...bare, title: 'Acme', body: body('Acme 1') }} version={{ title: 'Acme', body: body('Acme 2') }} />,
    );
    const fold = screen.getByRole('button', { name: '4 unchanged lines' });
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('One')).toBeNull();

    fireEvent.click(fold);
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    // Under the button, in order, before the context it led to.
    const text = [...container.querySelectorAll('.history-diff-row.is-same')].map((r) => r.textContent);
    expect(text).toEqual(['One', 'Two', 'Three', 'Four', 'Five', 'Six']);

    fireEvent.click(fold);
    expect(screen.queryByText('One')).toBeNull();
  });

  it('counts the lines a fold hides, and folds nothing when there is nothing to hide', () => {
    const many = Array.from({ length: 20 }, (_, i) => `Line ${i}`);
    const { rerender } = render(
      <HistoryChanges current={{ ...bare, title: 'A', body: [...many, 'x 1'].join('\n') }} version={{ title: 'A', body: [...many, 'x 2'].join('\n') }} />,
    );
    expect(screen.getByRole('button', { name: '18 unchanged lines' })).toBeTruthy();
    rerender(
      <HistoryChanges current={{ ...bare, title: 'A', body: 'x 1' }} version={{ title: 'A', body: 'x 2' }} />,
    );
    expect(screen.queryByRole('button', { name: /unchanged/ })).toBeNull();
  });

  it('does not call a version the same when only its line endings differ, since Restore would write', () => {
    const { container } = render(
      <HistoryChanges current={{ ...bare, title: 'Acme', body: 'one\ntwo\n' }} version={{ title: 'Acme', body: 'one\r\ntwo', props: bare }} />,
    );
    expect(container.textContent).toBe(
      'The text reads the same as the note now; only line endings or blank lines at the end differ.',
    );
  });

  /*
     Fields, tags and the notebook (MAK-170): above the body with the title, one line each,
     only what differs.
  */
  const status = (value: string) => ({ fieldId: 'f-status', name: 'Status', type: 'select' as const, value, notebookId: 'nb', notebook: 'Watch list' });
  const filed = { notebook: { id: 'nb', name: 'Watch list' }, tags: ['drama'], fields: [status('Done')] };
  const held = { notebook: { id: 'nb', name: 'Watch list' }, tags: [{ id: 't', name: 'drama' }], fields: [status('Queued')] };

  it('lists a field that differs like the title line, and nothing for what is the same', () => {
    const { container } = render(
      <HistoryChanges current={{ ...filed, title: 'A film', body: '' }} version={{ title: 'A film', body: '', props: held }} />,
    );
    const lines = container.querySelectorAll('.history-prop');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.querySelector('dt')!.textContent).toBe('Status');
    expect(lines[0]!.querySelector('del')!.textContent).toBe('Done');
    expect(lines[0]!.querySelector('ins')!.textContent).toBe('Queued');
    expect(screen.getByText(/Restoring this version would add what is/)).toBeTruthy();
    expect(screen.getByText('The text is the same as the note now.')).toBeTruthy();
  });

  it('calls a version the same only when its fields, tags and notebook are too', () => {
    render(<HistoryChanges current={{ ...filed, fields: [status('Queued')], title: 'A', body: '' }} version={{ title: 'A', body: '', props: held }} />);
    expect(screen.getByText('This version is the same as the note now.')).toBeTruthy();
  });

  it('marks a tag going on and one coming off, and says Inbox for no notebook', () => {
    const { container } = render(
      <HistoryChanges
        current={{ notebook: null, tags: ['seen'], fields: [status('Queued')], title: 'A', body: '' }}
        version={{ title: 'A', body: '', props: held }}
      />,
    );
    const [notebook, tags] = [...container.querySelectorAll('.history-prop')];
    expect(notebook!.querySelector('del')!.textContent).toBe('Inbox');
    expect(notebook!.querySelector('ins')!.textContent).toBe('Watch list');
    expect(tags!.querySelector('del')!.textContent).toBe('removed seen');
    expect(tags!.querySelector('ins')!.textContent).toBe('added drama');
  });

  it('says why something would not be put back, with no mark on it', () => {
    const { container } = render(
      <HistoryChanges
        current={{ ...filed, title: 'A', body: '' }}
        version={{ title: 'A', body: '', props: held, unfit: [{ what: 'field', id: 'f-status', name: 'Status', why: 'option' }] }}
      />,
    );
    expect(screen.getByText('This field no longer offers “Queued”, so it stays as it is.')).toBeTruthy();
    expect(container.querySelector('ins, del')).toBeNull();
    // And no legend over a page with no marks to explain.
    expect(screen.queryByText(/Restoring this version would add what is/)).toBeNull();
  });

  it('says a version from before fields were kept leaves them as they are', () => {
    render(<HistoryChanges current={{ ...filed, title: 'A', body: 'x 1' }} version={{ title: 'A', body: 'x 2' }} />);
    expect(screen.getByText(/kept before fields, tags and the notebook were part of one/)).toBeTruthy();
  });
});
