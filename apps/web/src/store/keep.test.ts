import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConnectivity, setReachableForTests } from '../connectivity.js';
import { createKeeper, filesOf, plan, type KeepSnapshot } from './keep.js';
import { listShelf, writeFile } from './files.js';
import { installMemoryOpfs, type MemoryDirectory } from './test-opfs.js';

const note = (id: string, notebookId: string | null, deletedAt?: number) => ({ id, notebookId, ...(deletedAt === undefined ? {} : { deletedAt }) });
const file = (noteId: string, filename: string, size: number, pending?: true) => ({ noteId, filename, size, ...(pending ? { pending } : {}) });

const library: KeepSnapshot = {
  notes: [note('n1', 'receipts'), note('n2', 'receipts'), note('n3', 'manuals'), note('n4', null), note('n5', 'receipts', 123)],
  attachments: [
    file('n1', 'receipt.pdf', 300),
    file('n1', 'photo.jpg', 100),
    file('n2', 'Report (final) v2.pdf', 200),
    file('n2', 'waiting.jpg', 50, true),
    file('n3', 'manual.pdf', 9000),
    file('n4', 'loose.pdf', 10),
    file('n5', 'trashed.pdf', 10),
  ],
};

describe('filesOf', () => {
  it('is every file of the notebook’s live notes, and no other', () => {
    expect(filesOf(library, new Set(['receipts'])).map((f) => f.filename)).toEqual(['receipt.pdf', 'photo.jpg', 'Report (final) v2.pdf']);
    expect(filesOf(library, new Set())).toEqual([]);
  });
});

describe('plan', () => {
  it('fetches what a kept notebook has and the shelf does not, smallest first', () => {
    const p = plan(library, new Set(['receipts']), []);
    expect(p.fetch.map((f) => f.filename)).toEqual(['photo.jpg', 'Report (final) v2.pdf', 'receipt.pdf']);
    expect(p.remove).toEqual([]);
    expect(p.wanted).toEqual({ files: 3, bytes: 600 });
    expect(p.have).toEqual({ files: 0, bytes: 0 });
  });

  it('fetches nothing already on the shelf, and counts it', () => {
    const p = plan(library, new Set(['receipts']), [{ noteId: 'n1', name: 'receipt.pdf', size: 300 }]);
    expect(p.fetch.map((f) => f.filename)).toEqual(['photo.jpg', 'Report (final) v2.pdf']);
    expect(p.have).toEqual({ files: 1, bytes: 300 });
  });

  it('drops what no kept notebook has any more: a released notebook, a moved or trashed note, a deleted file', () => {
    const shelf = [
      { noteId: 'n1', name: 'receipt.pdf', size: 300 },
      { noteId: 'n3', name: 'manual.pdf', size: 9000 }, // its notebook was released
      { noteId: 'n5', name: 'trashed.pdf', size: 10 }, // its note went to the trash
      { noteId: 'n1', name: 'deleted.pdf', size: 5 }, // the file was deleted
    ];
    const p = plan(library, new Set(['receipts']), shelf);
    expect(p.remove.map((f) => f.name).sort()).toEqual(['deleted.pdf', 'manual.pdf', 'trashed.pdf']);
  });

  it('fetches again a file whose name was reused for other bytes, without removing it first', () => {
    const p = plan(library, new Set(['receipts']), [{ noteId: 'n1', name: 'receipt.pdf', size: 299 }]);
    expect(p.fetch.map((f) => f.filename)).toContain('receipt.pdf');
    expect(p.remove).toEqual([]);
  });
});

describe('the keeper', () => {
  let root: MemoryDirectory;
  let served: string[];
  const settle = () => vi.waitFor(() => expect(keeper!.status().fetching).toBe(false));
  let keeper: ReturnType<typeof createKeeper> | null = null;
  const start = (over: Partial<Parameters<typeof createKeeper>[0]> = {}) => {
    keeper = createKeeper({ userId: 'u1', snapshot: () => library, settled: () => true, leading: () => true, ...over });
    return keeper;
  };

  beforeEach(() => {
    resetConnectivity();
    root = installMemoryOpfs();
    served = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        served.push(decodeURIComponent(input));
        // Never marked as a view: the cache of opened files is not where these go.
        expect(new Headers(init?.headers).has('X-Unbent-View')).toBe(false);
        const size = [...library.attachments].find((a) => input.endsWith(encodeURIComponent(a.filename)))?.size ?? 0;
        return new Response('x'.repeat(size));
      }),
    );
  });
  afterEach(() => {
    keeper?.stop();
    keeper = null;
    vi.unstubAllGlobals();
  });

  it('fetches a notebook’s files to the shelf once it is kept, and remembers the choice', async () => {
    const k = start();
    await k.keep('receipts');
    await vi.waitFor(() => expect(k.status().have).toEqual({ files: 3, bytes: 600 }));
    await settle();
    expect(root.paths()).toEqual([
      'unbent-files-u1/kept.json',
      'unbent-files-u1/kept/n1/photo.jpg',
      'unbent-files-u1/kept/n1/receipt.pdf',
      'unbent-files-u1/kept/n2/Report (final) v2.pdf',
    ]);
    expect(k.status()).toMatchObject({ wanted: { files: 3, bytes: 600 }, problem: null });
    k.stop();

    // A reload: the choice is on the device, and nothing is fetched twice.
    served = [];
    const again = start();
    await vi.waitFor(() => expect(again.status().kept.has('receipts')).toBe(true));
    await vi.waitFor(() => expect(again.status().have.files).toBe(3));
    expect(served).toEqual([]);
  });

  it('removes a notebook’s files when it is released', async () => {
    const k = start();
    await k.keep('receipts');
    await vi.waitFor(() => expect(k.status().have.files).toBe(3));
    await k.release('receipts');
    await vi.waitFor(async () => expect(await listShelf('u1', 'kept')).toEqual([]));
  });

  it('fetches nothing with no connection, and picks up when it returns', async () => {
    setReachableForTests(false);
    const k = start();
    await k.keep('receipts');
    await vi.waitFor(() => expect(k.status().wanted.files).toBe(3));
    expect(served).toEqual([]);
    setReachableForTests(true);
    await vi.waitFor(() => expect(k.status().have.files).toBe(3), { timeout: 4000 });
  });

  it('takes a download cut off part-way for a lost connection, not a fault, and leaves no partial file', async () => {
    vi.mocked(fetch).mockImplementationOnce(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new TextEncoder().encode('half'));
              controller.error(new TypeError('network error'));
            },
          }),
        ),
    );
    const k = start({ snapshot: () => ({ notes: [note('n1', 'receipts')], attachments: [file('n1', 'photo.jpg', 100)] }) });
    await k.keep('receipts');
    // Nothing is said about it, and once the connectivity check has answered the file is
    // fetched again, whole.
    await vi.waitFor(() => expect(k.status().have).toEqual({ files: 1, bytes: 100 }), { timeout: 4000 });
    expect(k.status().problem).toBeNull();
    expect(served.filter((u) => u.endsWith('photo.jpg'))).toHaveLength(2);
    expect((await listShelf('u1', 'kept'))[0]).toMatchObject({ name: 'photo.jpg', size: 100 });
  });

  it('stops before the device is full and says so', async () => {
    vi.stubGlobal('navigator', { ...navigator, storage: { ...navigator.storage, estimate: async () => ({ usage: 0, quota: 50 * 1024 * 1024 + 150 }) } });
    const k = start();
    await k.keep('receipts');
    await vi.waitFor(() => expect(k.status().problem).toContain('out of room'));
    // The one that fit was kept.
    expect(k.status().have).toEqual({ files: 1, bytes: 100 });
  });

  it('leaves the shelf alone while the library is not whole, and in a tab that does not lead', async () => {
    await writeFile('u1', 'kept', 'n3', 'manual.pdf', new Blob(['x']));
    let settled = false;
    const k = start({ settled: () => settled });
    await k.keep('receipts');
    await new Promise((r) => setTimeout(r, 20));
    expect(served).toEqual([]);
    expect(root.paths()).toContain('unbent-files-u1/kept/n3/manual.pdf');
    k.stop();

    settled = true;
    const follower = start({ leading: () => false });
    await vi.waitFor(() => expect(follower.status().wanted.files).toBe(3));
    expect(served).toEqual([]);
    expect(root.paths()).toContain('unbent-files-u1/kept/n3/manual.pdf');
  });

  it('empties the shelf and the list on releaseAll', async () => {
    const k = start();
    await k.keep('receipts');
    await vi.waitFor(() => expect(k.status().have.files).toBe(3));
    await settle();
    await k.releaseAll();
    expect(await listShelf('u1', 'kept')).toEqual([]);
    expect(k.status().kept.size).toBe(0);
  });
});
