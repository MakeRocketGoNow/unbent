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
  type Exporting,
  type ExportState,
} from './export-archive.js';
import type { HostApp } from './app-bridge.js';

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
 * on is removed rather than left half-written in Downloads.
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
    const destination = appDestination(app, 'unbent-export.zip');
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
    const destination = appDestination(app, 'unbent-export.zip');
    const writer = destination.writable.getWriter();
    await expect(writer.write(new Uint8Array(600_000))).rejects.toThrow(/could not write/);
    writer.releaseLock();
    await destination.abort();
    expect(app.saveAbort).toHaveBeenCalledWith('job-1');
    expect(app.saveEnd).not.toHaveBeenCalled();
  });

  it('refuses to start when the app cannot create the file', () => {
    const { app } = fakeApp();
    app.saveBegin.mockReturnValue('');
    expect(() => appDestination(app, 'unbent-export.zip')).toThrow(/could not create/);
  });

  it('runs a whole export through the app and says where it went', async () => {
    const { app } = fakeApp();
    const exporting = createExporting(
      fake([note({ id: 'ffffffff-0000-4000-8000-000000000009', title: 'Only' })]),
      async (filename) => appDestination(app, filename),
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
    const exporting = createExporting(slow, async (filename) => appDestination(app, filename));
    exporting.start({});
    await until(exporting, (s) => s.status === 'running');
    exporting.stop();
    release();
    await settled(exporting);
    expect(exporting.get().status).not.toBe('done');
    expect(app.saveAbort).toHaveBeenCalledWith('job-1');
  });
});
