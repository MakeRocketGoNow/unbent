import { describe, expect, it, vi } from 'vitest';
import { createIndexing } from './index-files.js';
import type { ImportEvent } from './import-worker.js';
import type { ReadPass } from './notes-api.js';

/** A worker that records what it is sent and lets a test answer as the real one would. */
function fakeWorker() {
  const posted: unknown[] = [];
  const worker = {
    posted,
    postMessage: (message: unknown) => posted.push(message),
    terminate: vi.fn(),
    onmessage: null as ((event: MessageEvent<ImportEvent>) => void) | null,
    onerror: null as ((event: ErrorEvent) => void) | null,
    answer(data: ImportEvent) {
      this.onmessage?.({ data } as MessageEvent<ImportEvent>);
    },
  };
  return worker;
}

const finished = { done: 3, indexed: 2, unusable: 1, failed: 0, total: 3 };

describe('indexing', () => {
  it('hands a PDF to the worker with its bytes, and leaves other files alone', () => {
    const worker = fakeWorker();
    const indexing = createIndexing(() => worker as unknown as Worker);
    const pdf = new File(['%PDF-'], 'scan.pdf', { type: 'application/pdf' });

    indexing.indexFile('n1', 'scan.pdf', pdf);
    indexing.indexFile('n1', 'photo.png', new File([''], 'photo.png', { type: 'image/png' }));

    expect(worker.posted).toEqual([{ type: 'index-file', noteId: 'n1', filename: 'scan.pdf', file: pdf }]);
  });

  it('runs one pass at a time, and the unasked pass only once', () => {
    const worker = fakeWorker();
    const indexing = createIndexing(() => worker as unknown as Worker);

    indexing.start({ auto: true });
    indexing.start({ auto: true });
    expect(worker.posted).toEqual([{ type: 'backfill', auto: true }]);
    expect(indexing.get().status).toBe('running');

    worker.answer({ type: 'backfill-done', progress: finished });
    expect(indexing.get()).toMatchObject({ status: 'done', progress: finished });

    // Opening the app again in the same page load does not start over; pressing the button does.
    indexing.start({ auto: true });
    expect(worker.posted).toHaveLength(1);
    indexing.start({ auto: false });
    expect(worker.posted).toHaveLength(2);
  });

  it('reports a pass that stopped short of a backlog', () => {
    const worker = fakeWorker();
    const indexing = createIndexing(() => worker as unknown as Worker);
    const seen: string[] = [];
    indexing.subscribe((state) => seen.push(state.status));

    indexing.start({ auto: true });
    worker.answer({ type: 'backfill-deferred', remaining: 4084 });

    expect(indexing.get()).toMatchObject({ status: 'deferred', remaining: 4084 });
    expect(seen).toEqual(['running', 'deferred']);
  });

  it('reads images on the server as a pass of its own, a few per request, until none are left', async () => {
    const worker = fakeWorker();
    const passes = [
      { read: 2, empty: 1, failed: 0, remaining: 1 },
      { read: 1, empty: 0, failed: 0, remaining: 0 },
    ];
    const readPending = vi.fn(async () => passes.shift()!);
    const indexing = createIndexing(() => worker as unknown as Worker, readPending);

    indexing.readImages();
    // The count of what is left is the server's to give; nothing is claimed before it answers.
    expect(indexing.get()).toMatchObject({ status: 'running', phase: 'images', images: null, progress: null });
    await vi.waitFor(() => expect(indexing.get().status).toBe('done'));

    expect(readPending).toHaveBeenCalledTimes(2);
    expect(indexing.get()).toMatchObject({ phase: 'images', images: { read: 3, remaining: 0 } });
    // The PDFs were never involved: no worker was made, and nothing was posted to one.
    expect(worker.posted).toEqual([]);
  });

  it('asks the server to count only once, and ends when the server runs out of files', async () => {
    const worker = fakeWorker();
    const passes = [
      { read: 3, empty: 0, failed: 0, remaining: 5 },
      { read: 2, empty: 1, failed: 0 },
      { read: 1, empty: 0, failed: 0 },
    ];
    const readPending = vi.fn(async () => passes.shift()!);
    const indexing = createIndexing(() => worker as unknown as Worker, readPending);

    indexing.readImages();
    await vi.waitFor(() => expect(indexing.get().status).toBe('done'));

    expect(readPending.mock.calls.map((c) => (c as unknown[])[1])).toEqual([true, false, false]);
    // 5 left after the first call and 3 taken by the second, which kept count says 2 are
    // left. The third was handed only 1: an upload or another tab drifted the count. It was
    // handed fewer files than it asked for, so it saw the last of them, and read them all.
    // "0 left" is the truth, not the drifted 1 that would sit beside "Done".
    expect(indexing.get().images).toEqual({ read: 6, remaining: 0 });
  });

  it('leaves what the last call could not read when the server runs out', async () => {
    const worker = fakeWorker();
    const passes = [
      { read: 3, empty: 0, failed: 0, remaining: 9 },
      { read: 1, empty: 0, failed: 1 },
    ];
    const readPending = vi.fn(async () => passes.shift()!);
    const indexing = createIndexing(() => worker as unknown as Worker, readPending);

    indexing.readImages();
    await vi.waitFor(() => expect(indexing.get().status).toBe('done'));

    // The kept count says 5 are left; the server handed out 2, so there were only 2, and
    // the one it could not read is what waits for next time.
    expect(readPending).toHaveBeenCalledTimes(2);
    expect(indexing.get().images).toEqual({ read: 4, remaining: 1 });
  });

  it('never reads images as part of a PDF pass, and stops when a call moves nothing', async () => {
    const readPending = vi.fn(async () => ({ read: 0, empty: 0, failed: 2, remaining: 2 }));
    const worker = fakeWorker();
    const indexing = createIndexing(() => worker as unknown as Worker, readPending);

    // Neither the unasked pass nor the button's reaches the paid one.
    indexing.start({ auto: true });
    worker.answer({ type: 'backfill-done', progress: finished });
    indexing.start({ auto: false });
    worker.answer({ type: 'backfill-done', progress: finished });
    expect(indexing.get().status).toBe('done');
    expect(readPending).not.toHaveBeenCalled();

    indexing.readImages();
    await vi.waitFor(() => expect(indexing.get().status).toBe('done'));
    // Two files the server could not read stay pending, and are not paid for twice in one pass.
    expect(readPending).toHaveBeenCalledTimes(1);
    expect(indexing.get().images).toEqual({ read: 0, remaining: 2 });
  });

  it('runs one pass at a time, whichever kind is running', async () => {
    const worker = fakeWorker();
    const readPending = vi.fn(async () => ({ read: 1, empty: 0, failed: 0, remaining: 0 }));
    const indexing = createIndexing(() => worker as unknown as Worker, readPending);

    indexing.start({ auto: false });
    indexing.readImages();
    expect(readPending).not.toHaveBeenCalled();
    worker.answer({ type: 'backfill-done', progress: finished });

    indexing.readImages();
    indexing.start({ auto: false });
    expect(worker.posted).toHaveLength(1);
    await vi.waitFor(() => expect(indexing.get().status).toBe('done'));
    expect(readPending).toHaveBeenCalledTimes(1);
  });

  it('stops the PDF pass between files, keeping what it got through', () => {
    const worker = fakeWorker();
    const indexing = createIndexing(() => worker as unknown as Worker);

    // Nothing to stop yet: no abort goes to a worker that was never made.
    indexing.stop();
    expect(worker.posted).toEqual([]);

    indexing.start({ auto: false });
    indexing.stop();
    expect(worker.posted).toEqual([{ type: 'backfill', auto: false }, { type: 'abort' }]);
    expect(indexing.get()).toMatchObject({ status: 'running', stopping: true });

    // The worker ends an aborted pass the way it ends a finished one, with what it had done.
    const partial = { done: 4, indexed: 3, unusable: 1, failed: 0, total: 40 };
    worker.answer({ type: 'backfill-done', progress: partial });
    expect(indexing.get()).toMatchObject({ status: 'stopped', stopping: false, progress: partial });
  });

  it('reads an abort that cut a fetch short as stopped, not failed', () => {
    const worker = fakeWorker();
    const indexing = createIndexing(() => worker as unknown as Worker);
    indexing.start({ auto: false });
    indexing.stop();
    worker.answer({ type: 'error', message: 'The operation was aborted.' });
    expect(indexing.get()).toMatchObject({ status: 'stopped', error: null });

    // A real failure on a pass nobody stopped is still one.
    indexing.start({ auto: false });
    worker.answer({ type: 'error', message: 'Out of memory' });
    expect(indexing.get()).toMatchObject({ status: 'error', error: 'Out of memory' });
  });

  it('stops the image pass between requests, letting the one in flight land', async () => {
    const worker = fakeWorker();
    let land!: (pass: ReadPass) => void;
    const readPending = vi.fn(
      () =>
        new Promise<ReadPass>((resolve) => {
          land = resolve;
        }),
    );
    const indexing = createIndexing(() => worker as unknown as Worker, readPending);

    indexing.readImages();
    expect(readPending).toHaveBeenCalledTimes(1);

    indexing.stop();
    expect(indexing.get()).toMatchObject({ status: 'running', phase: 'images', stopping: true });

    // Paid for already, so counted — and then no second request.
    land({ read: 3, empty: 0, failed: 0, remaining: 9 });
    await vi.waitFor(() => expect(indexing.get().status).toBe('stopped'));
    expect(readPending).toHaveBeenCalledTimes(1);
    expect(indexing.get()).toMatchObject({ stopping: false, images: { read: 3, remaining: 9 } });
  });

  it('drops a worker that crashed so the next start gets a fresh one', () => {
    const workers = [fakeWorker(), fakeWorker()];
    let spawned = 0;
    const indexing = createIndexing(() => workers[spawned++] as unknown as Worker);

    indexing.start({ auto: false });
    workers[0]!.onerror?.({ message: '' } as ErrorEvent);
    expect(indexing.get().status).toBe('error');
    expect(indexing.get().error).toMatch(/try again/);
    expect(workers[0]!.terminate).toHaveBeenCalled();

    indexing.start({ auto: false });
    expect(spawned).toBe(2);
    expect(workers[1]!.posted).toEqual([{ type: 'backfill', auto: false }]);
  });
});
