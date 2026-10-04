import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { HistoryChanges } from './HistoryChanges.js';

/**
 * The History sheet's Changes view (MAK-167): what Restore would do to the note as it is
 * now. The comparison has its own tests (`note-diff.test.ts`); these are about what is
 * drawn from it.
 */
afterEach(cleanup);

const table = (qty: number) => `| Item | Qty |\n| --- | --- |\n| Acme bolts | ${qty} |`;

describe('HistoryChanges', () => {
  it('says so when the version is the note as it is now', () => {
    render(<HistoryChanges current={{ title: 'Acme', body: 'One' }} version={{ title: 'Acme', body: 'One' }} />);
    expect(screen.getByText('This version is the same as the note now.')).toBeTruthy();
    expect(document.querySelector('ins, del')).toBeNull();
  });

  it('marks the changed number, the note’s as removed and the version’s as added', () => {
    const { container } = render(
      <HistoryChanges current={{ title: 'Acme', body: table(40) }} version={{ title: 'Acme', body: table(45) }} />,
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
      <HistoryChanges current={{ title: 'Acme', body: '' }} version={{ title: 'Acme', body: 'Kept\nAlso kept' }} />,
    );
    const added = container.querySelectorAll('.history-diff-row.is-added');
    expect(added).toHaveLength(2);
    expect(added[0]!.querySelector('.history-diff-mark')!.textContent).toBe('+');
    expect(added[0]!.querySelector('ins')!.textContent).toBe('Kept');
  });

  it('shows a title that differs above the body, and says when only the title does', () => {
    const { container } = render(
      <HistoryChanges current={{ title: 'Acme', body: 'Same' }} version={{ title: 'Acme (final)', body: 'Same' }} />,
    );
    const title = container.querySelector('.history-diff-title')!;
    expect(title.querySelector('del')!.textContent).toBe('Acme');
    expect(title.querySelector('ins')!.textContent).toBe('Acme (final)');
    expect(screen.getByText('The text is the same as the note now.')).toBeTruthy();
  });

  it('names an empty title rather than marking nothing', () => {
    const { container } = render(
      <HistoryChanges current={{ title: '', body: 'Same' }} version={{ title: 'Acme', body: 'Same' }} />,
    );
    expect(container.querySelector('.history-diff-title del')!.textContent).toBe('Untitled');
  });

  it('says a version too different to compare is, and points to Preview', () => {
    const a = Array.from({ length: 2000 }, (_, i) => `Acme line ${i}`).join('\n');
    const b = Array.from({ length: 2000 }, (_, i) => `Another line ${i}, example.com`).join('\n');
    render(<HistoryChanges current={{ title: 'Acme', body: a }} version={{ title: 'Acme', body: b }} />);
    expect(screen.getByText('This version is too different to compare; see Preview.')).toBeTruthy();
  });

  it('folds unchanged lines into a button that opens them in place', () => {
    const body = (last: string) => ['One', 'Two', 'Three', 'Four', 'Five', 'Six', last].join('\n');
    const { container } = render(
      <HistoryChanges current={{ title: 'Acme', body: body('Acme 1') }} version={{ title: 'Acme', body: body('Acme 2') }} />,
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
      <HistoryChanges current={{ title: 'A', body: [...many, 'x 1'].join('\n') }} version={{ title: 'A', body: [...many, 'x 2'].join('\n') }} />,
    );
    expect(screen.getByRole('button', { name: '18 unchanged lines' })).toBeTruthy();
    rerender(
      <HistoryChanges current={{ title: 'A', body: 'x 1' }} version={{ title: 'A', body: 'x 2' }} />,
    );
    expect(screen.queryByRole('button', { name: /unchanged/ })).toBeNull();
  });

  it('does not call a version the same when only its line endings differ, since Restore would write', () => {
    const { container } = render(
      <HistoryChanges current={{ title: 'Acme', body: 'one\ntwo\n' }} version={{ title: 'Acme', body: 'one\r\ntwo' }} />,
    );
    expect(container.textContent).toBe(
      'The text reads the same as the note now; only line endings or blank lines at the end differ.',
    );
  });
});
