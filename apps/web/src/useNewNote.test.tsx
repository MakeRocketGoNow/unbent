import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { markNewNote, useIsNewNote } from './useNewNote.js';

/**
 * The flag that tells the workspace a note was just created.
 *
 * Rendered as a bare span rather than through the workspace: what is under test is which
 * note the flag answers for and how long it lasts, and mounting the real editor would
 * bring a router, a query client and the note endpoints along to prove the same thing.
 */
function Note({ noteId }: { noteId: string }) {
  return <span data-testid={noteId}>{String(useIsNewNote(noteId))}</span>;
}

afterEach(() => {
  cleanup();
  // The flag lives at module scope, so it outlives a test unless it is put back.
  fireEvent.pointerDown(document.body);
});

describe('useIsNewNote', () => {
  it('answers only for the note that was created', () => {
    markNewNote('a');
    render(
      <>
        <Note noteId="a" />
        <Note noteId="b" />
      </>,
    );

    expect(screen.getByTestId('a').textContent).toBe('true');
    // The other note is open in the same session; a flag that answered for it too would
    // put the caret in the title of a note nobody just made.
    expect(screen.getByTestId('b').textContent).toBe('false');
  });

  it('is false for a note nothing created', () => {
    render(<Note noteId="a" />);
    expect(screen.getByTestId('a').textContent).toBe('false');
  });

  /* Creating a second note hands the claim over rather than leaving both set. */
  it('follows the most recent note', () => {
    markNewNote('a');
    markNewNote('b');
    render(
      <>
        <Note noteId="a" />
        <Note noteId="b" />
      </>,
    );

    expect(screen.getByTestId('a').textContent).toBe('false');
    expect(screen.getByTestId('b').textContent).toBe('true');
  });

  /*
     A pointer press ends the claim, so clicking back into the note later opens it like any
     other note rather than taking the caret back to a title that has had a name for ten
     minutes.
  */
  it('stops claiming the note after a pointer press', () => {
    markNewNote('a');
    render(<Note noteId="a" />);
    expect(screen.getByTestId('a').textContent).toBe('true');

    fireEvent.pointerDown(document.body);
    expect(screen.getByTestId('a').textContent).toBe('false');
  });
});
