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

  it('drops a worker that crashed so the next start gets a fresh one', () => {
    const workers = [fakeWorker(), fakeWorker()];
    let spawned = 0;
    const indexing = createIndexing(() => workers[spawned++] as unknown as Worker);

    indexing.start({ auto: false });
    workers[0]!.onerror?.({ message: '' } as ErrorEvent);
    expect(indexing.get().status).toBe('error');
    expect(indexing.get().error).toMatch(/Try again/);
    expect(workers[0]!.terminate).toHaveBeenCalled();

    indexing.start({ auto: false });
    expect(spawned).toBe(2);
    expect(workers[1]!.posted).toEqual([{ type: 'backfill', auto: false }]);
  });
});
