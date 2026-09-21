import { describe, expect, it, vi } from 'vitest';
import { createIndexing } from './index-files.js';
import type { ImportEvent } from './import-worker.js';

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

  it('reads images on the server after the PDFs, when asked, until none are left', async () => {
    const worker = fakeWorker();
    const passes = [
      { read: 2, empty: 1, failed: 0, remaining: 1 },
      { read: 1, empty: 0, failed: 0, remaining: 0 },
    ];
    const readImages = vi.fn(async () => passes.shift()!);
    const indexing = createIndexing(() => worker as unknown as Worker, readImages);

    indexing.start({ auto: false, images: true });
    worker.answer({ type: 'backfill-done', progress: finished });
    await vi.waitFor(() => expect(indexing.get().status).toBe('done'));

    expect(readImages).toHaveBeenCalledTimes(2);
    expect(indexing.get()).toMatchObject({ phase: 'images', images: { read: 3, remaining: 0 }, progress: finished });
  });

  it('never reads images on the unasked pass, and stops when a call moves nothing', async () => {
    const readImages = vi.fn(async () => ({ read: 0, empty: 0, failed: 2, remaining: 2 }));
    const auto = fakeWorker();
    const unasked = createIndexing(() => auto as unknown as Worker, readImages);
    unasked.start({ auto: true, images: true });
    auto.answer({ type: 'backfill-done', progress: finished });
    expect(unasked.get().status).toBe('done');
    expect(readImages).not.toHaveBeenCalled();

    const worker = fakeWorker();
    const asked = createIndexing(() => worker as unknown as Worker, readImages);
    asked.start({ auto: false, images: true });
    worker.answer({ type: 'backfill-done', progress: finished });
    await vi.waitFor(() => expect(asked.get().status).toBe('done'));
    // Two files the server could not read stay pending, and are not paid for twice in one pass.
    expect(readImages).toHaveBeenCalledTimes(1);
    expect(asked.get().images).toEqual({ read: 0, remaining: 2 });
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
