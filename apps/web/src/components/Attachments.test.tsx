import { useState } from 'react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AttachmentInfo } from '@unbent/shared';
import * as api from '../notes-api.js';
import { keys } from '../queries.js';
import { Attachments } from './Attachments.js';

vi.mock('../store/actions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/actions.js')>()),
  // The file the test marks as waiting is taken back here; every other delete is the
  // server's. (The rule itself is tested in store/actions.test.ts.)
  deleteOrCancelAttachment: vi.fn(async (noteId: string, filename: string) => {
    if (filename !== 'photo.jpg') await (await import('../notes-api.js')).deleteAttachment(noteId, filename);
  }),
}));
import { deleteOrCancelAttachment } from '../store/actions.js';

vi.mock('../notes-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notes-api.js')>()),
  deleteAttachment: vi.fn(),
  copyAttachments: vi.fn(),
  listNotes: vi.fn(),
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
/*
   A second body for n2 that carries the same file link the move strips. A rewrite that
   wrongly lands on n2 loses that link and is caught; a link-free n2 body would swallow the
   bug, since removing a link n2 never had leaves the body untouched either way.
*/
const n2WithScan = '[scan](files/scan.pdf)\n\nn2 keeps this.';

function seed(client: QueryClient, noteId: string, files: AttachmentInfo[]) {
  client.setQueryData(keys.attachments(noteId), files);
}

function mount(secondBody: string = n2Body) {
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
            setBody(secondBody);
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

  it('does not rewrite the next note when a linked move finishes after a switch', async () => {
    // The picker lists the note to move to; only id/title/updatedAt are read from a row.
    vi.mocked(api.listNotes).mockResolvedValue({
      items: [{ id: 'n2', title: 'Second', updatedAt: 0 }] as never,
      cursor: null,
      total: 1,
    });
    vi.mocked(api.copyAttachments).mockResolvedValue({ files: [], missing: [] });
    let finishDelete: () => void = () => {};
    vi.mocked(api.deleteAttachment).mockImplementation(
      () => new Promise((resolve) => { finishDelete = () => resolve(); }),
    );
    // n2 opens onto a body that also links scan.pdf, so a stray rewrite here would show.
    mount(n2WithScan);
    openPanel();

    fireEvent.click(screen.getByRole('button', { name: /More actions for scan\.pdf/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Move to note…' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Second/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Second/ }));

    // The copy resolves, then the delete hangs — the move's rewrite is still ahead of it.
    await waitFor(() =>
      expect(api.copyAttachments).toHaveBeenCalledWith('n2', {
        from: 'n1',
        filenames: ['scan.pdf'],
        link: true,
      }),
    );
    await waitFor(() => expect(api.deleteAttachment).toHaveBeenCalledWith('n1', 'scan.pdf'));

    fireEvent.click(screen.getByRole('button', { name: 'Open n2' }));
    expect(screen.getByTestId('draft-body').textContent).toBe(n2WithScan);

    finishDelete();
    await act(async () => {
      await Promise.resolve();
    });
    // n2's body — including its own scan.pdf link — is left exactly as it was.
    expect(screen.getByTestId('draft-body').textContent).toBe(n2WithScan);
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

/*
 * A locked note — offline, or a copy read from the offline cache — takes no changes, and
 * that includes this panel. Insert link most of all: it writes into the editor directly,
 * where read-only does not reach, and the draft would be saved over a newer copy later.
 * The controls fade in place; Copy and the download link keep working.
 */
describe('Attachments on a locked note', () => {
  it('fades every control that changes the note, and keeps the ones that read', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    seed(client, 'n1', [scan]);
    const onBodyRewrite = vi.fn();
    render(
      <QueryClientProvider client={client}>
        <Attachments noteId="n1" body="no link here" editorView={null} onBodyRewrite={onBodyRewrite} readOnly />
      </QueryClientProvider>,
    );
    openPanel();
    const button = (name: string) => screen.getByRole<HTMLButtonElement>('button', { name });
    expect(button('Insert link').disabled).toBe(true);
    expect(button('Delete').disabled).toBe(true);
    expect(button('More actions for scan.pdf').disabled).toBe(true);
    expect(button('Insert link').title).toBe('Not available offline');
    expect(button('Copy').disabled).toBe(false);
    expect(screen.getByRole('link', { name: 'scan.pdf' })).toBeTruthy();

    fireEvent.click(button('Insert link'));
    expect(onBodyRewrite).not.toHaveBeenCalled();
  });

  it('lists a file still waiting to upload as waiting, and holds back what would ask the server about it', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(keys.attachments('n1'), [scan, { filename: 'photo.jpg', contentType: 'image/jpeg', size: 2_000, pending: true }]);
    render(
      <QueryClientProvider client={client}>
        <Attachments noteId="n1" body={'[scan](files/scan.pdf)\n\n![photo](files/photo.jpg)'} editorView={null} onBodyRewrite={() => {}} />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByText(/Attachments \(2\)/));
    expect(screen.getByText('Waiting to upload')).toBeTruthy();
    // The uploaded file downloads; the waiting one is a name, since only the server answers a download.
    expect(screen.getByText('scan.pdf').closest('a')).not.toBeNull();
    expect(screen.getByText('photo.jpg').closest('a')).toBeNull();
    const [, waitingRow] = screen.getAllByRole('listitem');
    const button = (name: string) => [...waitingRow!.querySelectorAll('button')].find((b) => b.textContent === name) as HTMLButtonElement;
    expect(button('Copy').disabled).toBe(true);
    expect(button('Copy').title).toBe('Waiting to upload');

    // Delete is live: for a file that has not uploaded it takes the file back, on this
    // device, and asks the server nothing.
    expect(button('Delete').disabled).toBe(false);
    fireEvent.click(button('Delete'));
    expect(screen.getByText(/before it uploads\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove file' }));
    await waitFor(() => expect(deleteOrCancelAttachment).toHaveBeenCalledWith('n1', 'photo.jpg'));
    expect(api.deleteAttachment).not.toHaveBeenCalled();
  });
});
