import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import {
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
} from '@tanstack/react-router';
import type { NoteSummary } from '@unbent/shared';
import { NoteCard, coverOf } from './NoteCard.js';
import type { RowSelection } from './NoteListItem.js';
import { resetConnectivity, setReachableForTests } from '../connectivity.js';

const note: NoteSummary = {
  id: 'n1',
  title: 'Acme Hardware',
  createdAt: 0,
  updatedAt: 0,
  tags: ['receipt'],
  notebook: 'Receipts',
};

function mount(overrides: Partial<NoteSummary> = {}, props: { selection?: RowSelection; hint?: string } = {}) {
  const rootRoute = createRootRoute({
    component: () => (
      <ul>
        <NoteCard note={{ ...note, ...overrides }} {...props} />
      </ul>
    ),
  });
  const noteRoute = createRoute({ getParentRoute: () => rootRoute, path: '/notes/$noteId' });
  const router = createRouter({
    routeTree: rootRoute.addChildren([noteRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(<RouterProvider router={router as any} />);
}

afterEach(() => {
  cleanup();
  resetConnectivity();
});

describe('coverOf', () => {
  /* A scan filed as a PDF and then photographed: the photo is the one that can be
     recognised, so it is the cover even though the PDF came first. */
  it('takes the first image over an earlier file of another kind', () => {
    expect(
      coverOf({
        attachments: [
          { filename: 'Scan 1.pdf', contentType: 'application/pdf' },
          { filename: 'front.jpg', contentType: 'image/jpeg' },
          { filename: 'back.png', contentType: 'image/png' },
        ],
      }),
    ).toEqual({ kind: 'image', filename: 'front.jpg' });
  });

  it('reads a declared type with parameters and capitals as an image', () => {
    expect(coverOf({ attachments: [{ filename: 'a.jpg', contentType: 'Image/JPEG; charset=binary' }] })).toEqual({
      kind: 'image',
      filename: 'a.jpg',
    });
  });

  it('falls back to the first file when none is an image', () => {
    expect(
      coverOf({
        attachments: [
          { filename: 'Invoice.pdf', contentType: 'application/pdf' },
          { filename: 'memo.m4a', contentType: 'audio/mp4' },
        ],
      }),
    ).toEqual({ kind: 'file', contentType: 'application/pdf' });
  });

  it('has no cover for a note with no files', () => {
    expect(coverOf({})).toEqual({ kind: 'none' });
    expect(coverOf({ attachments: [] })).toEqual({ kind: 'none' });
  });
});

describe('NoteCard', () => {
  it('is a link to the note, with the image as its cover', async () => {
    mount({
      attachments: [
        { filename: 'Scan 1.pdf', contentType: 'application/pdf' },
        { filename: 'front photo.jpg', contentType: 'image/jpeg' },
      ],
    });
    const link = (await screen.findByText('Acme Hardware')).closest('a')!;
    expect(link.getAttribute('href')).toBe('/notes/n1');
    const img = link.querySelector('img')!;
    // Marked as a cover, so the worker does not keep it as a file someone opened.
    expect(img.getAttribute('src')).toBe('/api/notes/n1/files/front%20photo.jpg?cover=1');
    expect(img.getAttribute('loading')).toBe('lazy');
    // The title names the card; the picture is not read out first.
    expect(img.getAttribute('alt')).toBe('');
  });

  it('draws the file kind glyph where a non-image file would be the cover', async () => {
    mount({ attachments: [{ filename: 'Invoice.pdf', contentType: 'application/pdf' }] });
    await screen.findByText('Acme Hardware');
    const cover = document.querySelector('.note-card-cover')!;
    expect(cover.classList.contains('file')).toBe(true);
    expect(cover.querySelector('img')).toBeNull();
    expect(cover.querySelector('svg')).not.toBeNull();
  });

  /* An image the browser cannot draw (HEIC outside Safari, bytes not on the device
     offline) falls back to its glyph rather than the broken-image box. */
  it('falls back to the glyph when the image does not draw', async () => {
    mount({ attachments: [{ filename: 'IMG_0001.heic', contentType: 'image/heic' }] });
    await screen.findByText('Acme Hardware');
    fireEvent.error(document.querySelector('.note-card-cover img')!);
    const cover = document.querySelector('.note-card-cover')!;
    expect(cover.classList.contains('file')).toBe(true);
    expect(cover.querySelector('img')).toBeNull();
    expect(cover.querySelector('svg')).not.toBeNull();
  });

  /* Offline is a reason to try again, not a verdict on the file. */
  it('tries a cover that failed offline again once the app is back online', async () => {
    setReachableForTests(false);
    mount({ attachments: [{ filename: 'front.jpg', contentType: 'image/jpeg' }] });
    await screen.findByText('Acme Hardware');
    fireEvent.error(document.querySelector('.note-card-cover img')!);
    expect(document.querySelector('.note-card-cover img')).toBeNull();
    act(() => setReachableForTests(true));
    expect(document.querySelector('.note-card-cover img')).not.toBeNull();
  });

  it('does not try again a cover that failed while online', async () => {
    mount({ attachments: [{ filename: 'IMG_0001.heic', contentType: 'image/heic' }] });
    await screen.findByText('Acme Hardware');
    fireEvent.error(document.querySelector('.note-card-cover img')!);
    act(() => {
      setReachableForTests(false);
      setReachableForTests(true);
    });
    expect(document.querySelector('.note-card-cover img')).toBeNull();
  });

  it('shows the words of a note with no files where its cover would be', async () => {
    mount({ excerpt: 'Remember to ask about the warranty.' });
    const words = await screen.findByText('Remember to ask about the warranty.');
    expect(words.className).toBe('note-card-excerpt');
    expect(words.closest('.note-card-cover')?.classList.contains('none')).toBe(true);
    // Hidden with the cover, but the link is described by them, after its name.
    expect(words.closest('a')?.getAttribute('aria-describedby')).toBe(words.id);
  });

  it('draws an empty cover for a note with neither files nor words', async () => {
    mount();
    await screen.findByText('Acme Hardware');
    const cover = document.querySelector('.note-card-cover')!;
    expect(cover.classList.contains('none')).toBe(true);
    expect(cover.childElementCount).toBe(0);
  });

  it('draws the fields line, cut to one line by its class, and no excerpt under the title', async () => {
    mount({
      excerpt: 'Paid at the counter.',
      attachments: [{ filename: 'a.jpg', contentType: 'image/jpeg' }],
      fields: [
        { fieldId: 'a', name: 'Vendor', type: 'text', value: 'Acme', notebookId: 'nb', notebook: 'Receipts' },
        { fieldId: 'b', name: 'Paid', type: 'checkbox', value: true, notebookId: 'nb', notebook: 'Receipts' },
      ],
    });
    const line = await screen.findByText('Vendor: Acme · Paid: Yes');
    expect(line.className).toBe('note-fields-line');
    expect(line.getAttribute('title')).toBe('Vendor: Acme · Paid: Yes');
    expect(screen.queryByText('Paid at the counter.')).toBeNull();
  });

  it('draws no fields line outside a notebook', async () => {
    mount();
    await screen.findByText('Acme Hardware');
    expect(document.querySelector('.note-fields-line')).toBeNull();
  });

  it('says why a search matched in place of the date', async () => {
    mount({}, { hint: 'in Invoice.pdf' });
    expect((await screen.findByText('in Invoice.pdf')).className).toBe('note-meta');
  });

  /* The row's rules, through the row's handlers: a modifier click picks rather than opens. */
  it('picks on a modifier click and shows the checkbox while selecting', async () => {
    const onPick = vi.fn();
    mount({}, { selection: { selected: true, active: true, onPick } });
    const link = (await screen.findByText('Acme Hardware')).closest('a')!;
    expect(link.getAttribute('aria-selected')).toBe('true');
    fireEvent.click(link, { metaKey: true });
    expect(onPick).toHaveBeenCalledWith({ range: false });
    fireEvent.click(link, { shiftKey: true });
    expect(onPick).toHaveBeenLastCalledWith({ range: true });
    const box = screen.getByRole('checkbox', { name: 'Select Acme Hardware' }) as HTMLInputElement;
    expect(box.checked).toBe(true);
  });

  it('toggles on Space when focused', async () => {
    const onPick = vi.fn();
    mount({}, { selection: { selected: false, active: false, onPick } });
    const link = (await screen.findByText('Acme Hardware')).closest('a')!;
    fireEvent.keyDown(link, { key: ' ' });
    expect(onPick).toHaveBeenCalledWith({ range: false });
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});
