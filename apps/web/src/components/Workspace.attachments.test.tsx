import { useState } from 'react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
} from '@tanstack/react-router';
import type { AttachmentInfo, Note } from '@unbent/shared';
import { keys } from '../queries.js';
import { Workspace } from './Workspace.js';

/**
 * The attachments panel opens closed (MAK-149).
 *
 * It opens by itself only for a note with files its body no longer links. The draft is
 * seeded in an effect, so the first render of a note used to hand the panel the previous
 * note's body (or the empty initial draft) and for that one render every file looked
 * unlinked. The panel latches open on unlinked files, so every note with files opened
 * expanded.
 */
const pdf: AttachmentInfo = { filename: 'report.pdf', contentType: 'application/pdf', size: 1000 };
const png: AttachmentInfo = { filename: 'photo.png', contentType: 'image/png', size: 2000 };

const linked: Note = {
  id: 'n1',
  title: 'Two files',
  body: '[report.pdf](files/report.pdf)\n\n![photo.png](files/photo.png)',
  tags: [],
  notebook: null,
  createdAt: 0,
  updatedAt: 100,
  fields: [],
};

const plain: Note = { ...linked, id: 'n0', title: 'No files', body: 'just text' };

let openNote: (id: string) => void = () => {};

function Host({ first }: { first: string }) {
  const [id, setId] = useState(first);
  openNote = setId;
  return <Workspace noteId={id} />;
}

function mount(first: string, withFiles: Note = linked) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(keys.note(linked.id), withFiles);
  client.setQueryData(keys.attachments(linked.id), [pdf, png]);
  client.setQueryData(keys.note(plain.id), plain);
  client.setQueryData(keys.attachments(plain.id), []);
  client.setQueryData(keys.tags(), []);
  client.setQueryData(keys.config(), { providers: [], autofill: false });
  client.setQueryData(keys.notebooks(), { notebooks: [], unfiled: 2 });

  const rootRoute = createRootRoute({ component: () => <Host first={first} /> });
  const notesRoute = createRoute({ getParentRoute: () => rootRoute, path: '/notes' });
  const router = createRouter({
    routeTree: rootRoute.addChildren([notesRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  return render(
    <QueryClientProvider client={client}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
}

async function panel(container: HTMLElement) {
  await screen.findByText('Attachments (2)');
  // Let the seeding effects settle: the bug was a latch set during them.
  await act(async () => {});
  return container.querySelector<HTMLDetailsElement>('details.attachments')!;
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the attachments panel', () => {
  it('starts closed on a note whose files are all linked', async () => {
    const { container } = mount(linked.id);
    expect((await panel(container)).open).toBe(false);
  });

  it('starts closed when another note was open before it', async () => {
    const { container } = mount(plain.id);
    await screen.findByDisplayValue('No files');
    act(() => openNote(linked.id));
    expect((await panel(container)).open).toBe(false);
  });

  it('still opens for a note with a file its body does not link', async () => {
    const { container } = mount(linked.id, { ...linked, body: '[report.pdf](files/report.pdf)' });
    expect((await panel(container)).open).toBe(true);
    expect(screen.getByText(/1 not linked in note/)).toBeTruthy();
  });
});
