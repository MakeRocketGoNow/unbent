// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { ImportProgress } from '@unbent/enex';
import { createImportRun } from './import-run.js';
import type { ImportEvent, ImportRequest } from './import-worker.js';

/**
 * The store that holds an import run for as long as the page lives. The importers are
 * tested in `@unbent/enex`; this is what the panel and the snackbar see.
 */

/** A stand-in worker: records what it was sent, and answers when the test says so. */
class FakeWorker {
  sent: ImportRequest[] = [];
  terminated = false;
  onmessage: ((event: MessageEvent<ImportEvent>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  postMessage(request: ImportRequest) {
    this.sent.push(request);
  }
  terminate() {
    this.terminated = true;
  }
  emit(data: ImportEvent) {
    this.onmessage?.({ data } as MessageEvent<ImportEvent>);
  }
}

function harness() {
  const workers: FakeWorker[] = [];
  const run = createImportRun(() => {
    const w = new FakeWorker();
    workers.push(w);
    return w as unknown as Worker;
  });
  return { run, workers, worker: () => workers[workers.length - 1]! };
}

const file = (name: string) => new File(['x'], name);

const progress = (created: number): ImportProgress => ({
  processed: created,
  created,
  skipped: 0,
  failed: 0,
  filesUploaded: 0,
  filesIndexed: 0,
  bytesRead: 1,
  notesTotal: 0,
  currentTitle: '',
});

describe('the import run', () => {
  it('runs a picked file and keeps the result until it is reset', () => {
    const { run, worker } = harness();
    run.pick(file('Notes.enex'));
    run.start({ extractText: true });
    expect(run.get().status).toBe('running');
    expect(worker().sent).toEqual([{ type: 'start', file: run.get().file, extractText: true }]);

    worker().emit({ type: 'skip', skip: { title: 'Kept', noteId: 'n-1', earlierInFile: true } });
    worker().emit({ type: 'done', progress: progress(3) });
    expect(run.get().status).toBe('done');
    expect(run.get().progress?.created).toBe(3);
    expect(run.get().skips.duplicateCount).toBe(1);
    expect(run.get().endedAt).not.toBeNull();

    run.reset();
    expect(run.get().status).toBe('idle');
    expect(run.get().file).toBeNull();
    expect(run.get().skips.duplicateCount).toBe(0);
  });

  /** The panel's buttons are gone mid-run, but a stray caller must not lose the run. */
  it('ignores a pick or a reset while a run is going', () => {
    const { run } = harness();
    run.pick(file('Notes.enex'));
    run.start({ extractText: false });
    run.pick(file('Other.enex'));
    run.reset();
    expect(run.get().status).toBe('running');
    expect(run.get().file?.name).toBe('Notes.enex');
  });

  it('describes a zip, and applies only the answer for the latest pick', () => {
    const { run, worker } = harness();
    run.pick(file('first.zip'));
    run.pick(file('second.zip'));
    expect(worker().sent.map((r) => r.type)).toEqual(['describe', 'describe']);

    // The answer for first.zip arrives while second.zip is the pick.
    worker().emit({ type: 'described', kind: 'unbent' });
    expect(run.get().zip).toBeNull();
    worker().emit({ type: 'described', kind: 'notion', units: [] });
    expect(run.get().zip).toEqual({ kind: 'notion', units: [] });
  });

  it('drops an answer for a zip picked over by another kind of file', () => {
    const { run, worker } = harness();
    run.pick(file('export.zip'));
    run.pick(file('Notes.enex'));
    worker().emit({ type: 'described', kind: 'unbent' });
    expect(run.get().zip).toBeNull();
  });

  it('reports a worker that dies mid-run, and makes a new one for the next', () => {
    const { run, workers, worker } = harness();
    run.pick(file('Notes.enex'));
    run.start({ extractText: true });
    worker().onerror?.({ message: '' } as ErrorEvent);
    expect(run.get().status).toBe('error');
    expect(run.get().error).toMatch(/crashed/);
    expect(workers[0]!.terminated).toBe(true);

    run.reset();
    run.pick(file('Notes.enex'));
    run.start({ extractText: true });
    expect(workers).toHaveLength(2);
  });

  it('keeps the run for the same user and throws it away for another', () => {
    const { run, worker } = harness();
    run.claim('user-a');
    run.pick(file('Notes.enex'));
    run.start({ extractText: true });
    run.claim('user-a');
    expect(run.get().status).toBe('running');

    run.claim('user-b');
    expect(run.get().status).toBe('idle');
    expect(worker().terminated).toBe(true);
  });

  it('counts runs, so a dismissal for one does not hide the next', () => {
    const { run, worker } = harness();
    run.pick(file('Notes.enex'));
    run.start({ extractText: true });
    worker().emit({ type: 'done', progress: progress(1) });
    run.reset();
    run.pick(file('Notes.enex'));
    run.start({ extractText: true });
    expect(run.get().run).toBe(2);
  });
});
