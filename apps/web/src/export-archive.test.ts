// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { BlobWriter } from '@zip.js/zip.js';
import type { ExportPage, ExportedNote } from '@unbent/shared';
import type { ExportSource } from '@unbent/enex';
import {
  appDestination,
  createExporting,
  isExportOf,
  savedAs,
  transient,
  type Exporting,
  type ExportState,
} from './export-archive.js';
import type { HostApp } from './app-bridge.js';
import { ApiError, OfflineError } from './notes-api.js';

/**
 * The store around the archive writer: what a page sees while an export runs. The
 * archive itself is tested where it is written, in `@unbent/enex`.
 */

const note = (n: Partial<ExportedNote> & { id: string; title: string }): ExportedNote => ({
  body: '',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_001_000,
  tags: [],
  notebook: null,
  notebookId: null,
  ...n,
});

function fake(notes: ExportedNote[]): ExportSource {
  return {
    async page(): Promise<ExportPage> {
      return { notes, cursor: null, total: notes.length };
    },
    async file() {
      return new Blob(['x']).stream();
    },
    async notebooks() {
      return [];
    },
    async fields() {
      return [];
    },
  };
}

describe('createExporting', () => {
  it('reports progress, then where the archive went', async () => {
    const source = fake([note({ id: 'ffffffff-0000-4000-8000-000000000008', title: 'Only' })]);
    const seen: string[] = [];
    const exporting = createExporting(source, async () => {
      const writer = new BlobWriter('application/zip');
      return { kind: 'file', writable: writer.writable, finish: async () => null, abort: async () => {} };
    });
    exporting.subscribe((s) => seen.push(`${s.status}:${s.done}/${s.total}`));
    exporting.start({});
    await new Promise<void>((resolve) => {
      const stop = exporting.subscribe((s) => {
        if (s.status === 'done') {
          stop();
          resolve();
        }
      });
    });
    expect(seen[0]).toBe('running:0/null');
    expect(seen.at(-1)).toBe('done:1/1');
    expect(exporting.get()).toMatchObject({ destination: 'file', files: 0 });
    expect(exporting.get().filename).toMatch(/^unbent-export-\d{4}-\d{2}-\d{2}\.zip$/);
  });

  it('records which filter each run was of', async () => {
    const exporting = createExporting(fake([]), memory());
    exporting.start({ notebook: 'Coupons' });
    await settled(exporting);
    expect(exporting.get()).toMatchObject({ status: 'done', run: 1 });
    expect(isExportOf(exporting.get(), { notebook: 'Coupons' })).toBe(true);
    expect(isExportOf(exporting.get(), { notebook: 'Podcast Bookmarks' })).toBe(false);
    // A sort means nothing without a date range, so it does not make a different export.
    expect(isExportOf(exporting.get(), { notebook: 'Coupons', sort: 'title' })).toBe(true);

    exporting.start({});
    await settled(exporting, 2);
    expect(exporting.get().run).toBe(2);
    expect(isExportOf(exporting.get(), {})).toBe(true);
  });

  it('counts a file that is gone as skipped, and still finishes', async () => {
    const id = 'ffffffff-0000-4000-8000-000000000009';
    const attachments = [
      { filename: 'kept.txt', contentType: 'text/plain' },
      { filename: 'gone.pdf', contentType: 'application/pdf' },
    ];
    const source: ExportSource = {
      ...fake([note({ id, title: 'Half there', attachments })]),
      async file(_noteId, filename) {
        return filename === 'gone.pdf' ? null : new Blob(['x']).stream();
      },
    };
    const exporting = createExporting(source, memory());
    exporting.start({});
    await settled(exporting);
    expect(exporting.get()).toMatchObject({ status: 'done', done: 1, files: 1, skipped: 1 });
  });

  it('reports a failure, and throws away what was written', async () => {
    let aborted = false;
    const source: ExportSource = {
      ...fake([]),
      async page() {
        throw new Error('Could not read the notes: 400');
      },
    };
    const exporting = createExporting(source, memory(() => (aborted = true)));
    exporting.start({});
    await settled(exporting);
    expect(exporting.get()).toMatchObject({ status: 'error', error: 'Could not read the notes: 400' });
    expect(aborted).toBe(true);
  });

  it('stops between requests when asked, and says it stopped rather than failed', async () => {
    let aborted = false;
    const source: ExportSource = {
      ...fake([]),
      // A page that does not come back until the export is stopped.
      page: (_filter, _cursor, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')));
        }),
    };
    const exporting = createExporting(source, memory(() => (aborted = true)));
    exporting.start({});
    await until(exporting, (s) => s.status === 'running');
    exporting.stop();
    expect(exporting.get().stopping).toBe(true);
    await settled(exporting);
    expect(exporting.get()).toMatchObject({ status: 'stopped', stopping: false, error: null });
    expect(aborted).toBe(true);
  });

  it('does nothing when the person cancels the save dialog', async () => {
    const exporting = createExporting(fake([]), async () => null);
    exporting.start({ notebook: 'Coupons' });
    await new Promise((r) => setTimeout(r, 10));
    expect(exporting.get().status).toBe('idle');
  });
});

/**
 * A destination that writes into memory. Shaped as a picked file, since a download's
 * hand-over needs a document, which these tests run without.
 */
function memory(onAbort: () => void = () => {}) {
  return async () => {
    const writer = new BlobWriter('application/zip');
    return {
      kind: 'file' as const,
      writable: writer.writable,
      finish: async () => null,
      abort: async () => onAbort(),
    };
  };
}

/** Resolves once the store's state satisfies `test`, checking the state it is in first. */
function until(exporting: Exporting, test: (s: ExportState) => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (test(exporting.get())) return resolve();
    const stop = exporting.subscribe((s) => {
      if (test(s)) {
        stop();
        resolve();
      }
    });
  });
}

/** Resolves once run `run` has ended, however it ended. */
const settled = (exporting: Exporting, run = 1) =>
  until(exporting, (s) => s.run === run && s.status !== 'running');

/**
 * The Android app as the file system: a stand-in that keeps what it is sent, so the
 * test can check the bytes arrive whole and in order, and that a file the export gave up
 * on is removed rather than left half-written in Downloads. Its answers are plain values,
 * returned before the call does, as a `@JavascriptInterface` method's are.
 */
function fakeApp(opts: { failAt?: number } = {}) {
  const pieces: string[] = [];
  const app = {
    postMessage: vi.fn(),
    saveBegin: vi.fn(() => 'job-1'),
    saveChunk: vi.fn((_id: string, b64: string) => {
      if (opts.failAt !== undefined && pieces.length === opts.failAt) return false;
      pieces.push(b64);
      return true;
    }),
    saveEnd: vi.fn(() => true),
    saveAbort: vi.fn(),
  } satisfies HostApp;
  const received = () => Buffer.concat(pieces.map((p) => Buffer.from(p, 'base64')));
  return { app, pieces, received };
}

describe('appDestination', () => {
  it('streams the archive to the app in pieces that reassemble to the same bytes', async () => {
    const { app, pieces, received } = fakeApp();
    const bytes = new Uint8Array(1_300_000).map((_, i) => i % 251);
    const destination = await appDestination(app, 'unbent-export.zip');
    const writer = destination.writable.getWriter();
    // Unevenly, the way the zip writer does, to cross piece boundaries mid-chunk.
    for (let i = 0; i < bytes.length; i += 7_001) await writer.write(bytes.slice(i, i + 7_001));
    await writer.close();
    expect(app.saveBegin).toHaveBeenCalledWith('unbent-export.zip', 'application/zip');
    expect(pieces.length).toBe(3);
    expect(Buffer.compare(received(), Buffer.from(bytes))).toBe(0);
    expect(app.saveEnd).toHaveBeenCalledWith('job-1');
    await destination.abort();
    expect(app.saveAbort).not.toHaveBeenCalled();
  });

  it('fails the write when the app cannot store a piece, and removes the file', async () => {
    const { app } = fakeApp({ failAt: 0 });
    const destination = await appDestination(app, 'unbent-export.zip');
    const writer = destination.writable.getWriter();
    await expect(writer.write(new Uint8Array(600_000))).rejects.toThrow(/could not write/);
    writer.releaseLock();
    await destination.abort();
    expect(app.saveAbort).toHaveBeenCalledWith('job-1');
    expect(app.saveEnd).not.toHaveBeenCalled();
  });

  /*
   * An iOS host: WKWebView has no synchronous call from a page, so every answer is a
   * promise that settles when the native write has. The stand-in answers a turn of the
   * event loop later and counts the calls it has not answered yet.
   */
  function promisingApp(opts: { failAt?: number } = {}) {
    const pieces: string[] = [];
    let unanswered = 0;
    let most = 0;
    const later = <T,>(answer: () => T) =>
      new Promise<T>((resolve) => {
        unanswered += 1;
        most = Math.max(most, unanswered);
        setTimeout(() => {
          unanswered -= 1;
          resolve(answer());
        }, 1);
      });
    const app = {
      postMessage: vi.fn(),
      saveBegin: vi.fn(() => later(() => 'job-1')),
      saveChunk: vi.fn((_id: string, b64: string) =>
        later(() => {
          if (opts.failAt !== undefined && pieces.length === opts.failAt) return false;
          pieces.push(b64);
          return true;
        }),
      ),
      saveEnd: vi.fn(() => later(() => true)),
      saveAbort: vi.fn(),
    } satisfies HostApp;
    const received = () => Buffer.concat(pieces.map((p) => Buffer.from(p, 'base64')));
    return { app, pieces, received, most: () => most };
  }

  it('waits for a host that answers each piece later, one piece at a time', async () => {
    const { app, pieces, received, most } = promisingApp();
    const bytes = new Uint8Array(1_300_000).map((_, i) => i % 251);
    const destination = await appDestination(app, 'unbent-export.zip');
    const writer = destination.writable.getWriter();
    // Not awaited one by one: a writer that runs ahead is the case the wait is for. The
    // stream queues what it is handed and gives the sink one chunk at a time.
    const writes: Promise<void>[] = [];
    for (let i = 0; i < bytes.length; i += 7_001) writes.push(writer.write(bytes.slice(i, i + 7_001)));
    await Promise.all(writes);
    await writer.close();
    expect(pieces.length).toBe(3);
    expect(Buffer.compare(received(), Buffer.from(bytes))).toBe(0);
    // Never a second piece sent while the first was still being written.
    expect(most()).toBe(1);
    expect(app.saveEnd).toHaveBeenCalledWith('job-1');
  });

  it('holds a write open until the host has answered for its piece', async () => {
    let answer: (ok: boolean) => void = () => {};
    const app = {
      postMessage: vi.fn(),
      saveBegin: vi.fn(async () => 'job-1'),
      saveChunk: vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve))),
      saveEnd: vi.fn(async () => true),
      saveAbort: vi.fn(),
    } satisfies HostApp;
    const destination = await appDestination(app, 'unbent-export.zip');
    const writer = destination.writable.getWriter();
    let written = false;
    const write = writer.write(new Uint8Array(600_000)).then(() => (written = true));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(app.saveChunk).toHaveBeenCalledTimes(1);
    expect(written).toBe(false);
    answer(true);
    await write;
    expect(written).toBe(true);
  });

  it('fails the write when a host that answers later says the piece was not stored', async () => {
    const { app } = promisingApp({ failAt: 0 });
    const destination = await appDestination(app, 'unbent-export.zip');
    const writer = destination.writable.getWriter();
    await expect(writer.write(new Uint8Array(600_000))).rejects.toThrow(/could not write/);
    writer.releaseLock();
    await destination.abort();
    expect(app.saveAbort).toHaveBeenCalledWith('job-1');
    expect(app.saveEnd).not.toHaveBeenCalled();
  });

  /*
   * A WKWebView reply reports a native error by rejecting, where Android's bridge answers
   * false. Either way the export says what the page says, not what the host threw.
   */
  it('says the same of a host that rejects as of one that answers false', async () => {
    const native = () => Promise.reject(new Error('NSCocoaErrorDomain 640'));
    const { app } = promisingApp();
    app.saveChunk.mockImplementationOnce(native);
    const destination = await appDestination(app, 'unbent-export.zip');
    const writer = destination.writable.getWriter();
    await expect(writer.write(new Uint8Array(600_000))).rejects.toThrow(/^The app could not write the archive/);
    writer.releaseLock();

    const ending = promisingApp();
    ending.app.saveEnd.mockImplementationOnce(native);
    const closing = (await appDestination(ending.app, 'unbent-export.zip')).writable.getWriter();
    await expect(closing.close()).rejects.toThrow(/^The app could not finish/);

    const beginning = promisingApp();
    beginning.app.saveBegin.mockImplementationOnce(native);
    await expect(appDestination(beginning.app, 'unbent-export.zip')).rejects.toThrow(/^The app could not create/);
  });

  it('runs a whole export through a host that answers later', async () => {
    const { app, most } = promisingApp();
    const exporting = createExporting(
      fake([note({ id: 'ffffffff-0000-4000-8000-00000000000b', title: 'Only' })]),
      (filename) => appDestination(app, filename),
    );
    exporting.start({});
    await settled(exporting);
    expect(exporting.get()).toMatchObject({ status: 'done', destination: 'app' });
    expect(app.saveEnd).toHaveBeenCalled();
    expect(most()).toBe(1);
  });

  it('refuses to start when the app cannot create the file', async () => {
    const { app } = fakeApp();
    app.saveBegin.mockReturnValue('');
    await expect(appDestination(app, 'unbent-export.zip')).rejects.toThrow(/could not create/);
  });

  it('runs a whole export through the app and says where it went', async () => {
    const { app } = fakeApp();
    const exporting = createExporting(
      fake([note({ id: 'ffffffff-0000-4000-8000-000000000009', title: 'Only' })]),
      (filename) => appDestination(app, filename),
    );
    exporting.start({});
    await settled(exporting);
    expect(exporting.get()).toMatchObject({ status: 'done', destination: 'app' });
    expect(app.saveEnd).toHaveBeenCalled();
    expect(savedAs(exporting.get())).toMatch(/^Saved unbent-export-.*\.zip to Downloads$/);
  });

  it('removes the file when the export is stopped', async () => {
    const { app } = fakeApp();
    let release: () => void = () => {};
    const slow: ExportSource = {
      ...fake([note({ id: 'ffffffff-0000-4000-8000-00000000000a', title: 'Only' })]),
      page: () => new Promise((resolve) => {
        release = () => resolve({ notes: [], cursor: null, total: 0 });
      }),
    };
    const exporting = createExporting(slow, (filename) => appDestination(app, filename));
    exporting.start({});
    await until(exporting, (s) => s.status === 'running');
    exporting.stop();
    release();
    await settled(exporting);
    expect(exporting.get().status).not.toBe('done');
    expect(app.saveAbort).toHaveBeenCalledWith('job-1');
  });
});

/*
 * What the export retries. A dropped connection reaches it two ways: fetch's own TypeError
 * from a file read, and the `OfflineError` the API client makes of one for a page read.
 * The second is an `ApiError` with status 0, and was taken for a refusal — one blip on a
 * page ended an hour-long export.
 */
describe('transient', () => {
  it('retries a dropped connection, however it arrives', () => {
    expect(transient(new TypeError('Failed to fetch'))).toBe(true);
    expect(transient(new OfflineError())).toBe(true);
  });

  it('retries the server’s 5xx and nothing else it says', () => {
    expect(transient(new ApiError(503, 'busy'))).toBe(true);
    expect(transient(new ApiError(404, 'gone'))).toBe(false);
    expect(transient(new ApiError(401, 'signed out'))).toBe(false);
  });
});
