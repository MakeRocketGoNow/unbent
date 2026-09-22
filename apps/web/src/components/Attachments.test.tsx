import { useState } from 'react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AttachmentInfo } from '@unbent/shared';
import * as api from '../notes-api.js';
import { keys } from '../queries.js';
import { Attachments } from './Attachments.js';

vi.mock('../notes-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notes-api.js')>()),
  deleteAttachment: vi.fn(),
}));

/**
 * The attachments panel lives on Workspace, which is reused across notes. Deleting a
 * linked file rewrites the draft after the server round trip — the same class of wait
 * Auto-fill and "Save web images" already refuse to land on the next note.
 */
const scan: AttachmentInfo = {
  filename: 'scan.pdf',
  contentType: 'application/pdf',
  size: 12_000,
};

const n1Body = '[scan](files/scan.pdf)\n\nKeep this text.';
const n2Body = 'already written';

function seed(client: QueryClient, noteId: string, files: AttachmentInfo[]) {
  client.setQueryData(keys.attachments(noteId), files);
}

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  seed(client, 'n1', [scan]);
  seed(client, 'n2', [scan]);

  /*
     Mirrors Workspace: one panel, a new `noteId` prop, and a rewrite that always writes
     the draft currently on screen rather than the note the request started on.
  */
  function Harness() {
    const [id, setId] = useState('n1');
    const [body, setBody] = useState(n1Body);
    return (
      <>
        <button
          type="button"
          onClick={() => {
            setId('n2');
            setBody(n2Body);
          }}
        >
          Open n2
        </button>
        <div data-testid="draft-body">{body}</div>
        <Attachments noteId={id} body={body} editorView={null} onBodyRewrite={setBody} />
      </>
    );
  }

  return render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
}

function openPanel() {
  fireEvent.click(screen.getByText(/Attachments \(1\)/));
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
  vi.clearAllMocks();
});

describe('Attachments', () => {
  it('rewrites the open note after a linked file is deleted', async () => {
    vi.mocked(api.deleteAttachment).mockResolvedValue(undefined);
    mount();
    openPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete file' }));

    await waitFor(() => expect(api.deleteAttachment).toHaveBeenCalledWith('n1', 'scan.pdf'));
    expect(screen.getByTestId('draft-body').textContent).toContain('Keep this text.');
    expect(screen.getByTestId('draft-body').textContent).not.toContain('scan.pdf');
  });

  it('does not rewrite the next note when a linked delete finishes after a switch', async () => {
    let finish: () => void = () => {};
    vi.mocked(api.deleteAttachment).mockImplementation(
      () => new Promise((resolve) => { finish = () => resolve(); }),
    );
    mount();
    openPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete file' }));
    await waitFor(() => expect(api.deleteAttachment).toHaveBeenCalledWith('n1', 'scan.pdf'));

    fireEvent.click(screen.getByRole('button', { name: 'Open n2' }));
    expect(screen.getByTestId('draft-body').textContent).toBe(n2Body);

    finish();
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('draft-body').textContent).toBe(n2Body);
    expect(api.deleteAttachment).toHaveBeenCalledTimes(1);
    expect(api.deleteAttachment).toHaveBeenCalledWith('n1', 'scan.pdf');
  });

  it('drops a delete confirm when the open note changes', async () => {
    mount();
    openPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByRole('group', { name: 'Confirm delete attachment' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Open n2' }));
    expect(screen.queryByRole('group', { name: 'Confirm delete attachment' })).toBeNull();
    expect(screen.getByTestId('draft-body').textContent).toBe(n2Body);
  });
});
