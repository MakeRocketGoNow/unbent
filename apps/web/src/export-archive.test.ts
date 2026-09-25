// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { BlobWriter } from '@zip.js/zip.js';
import type { ExportPage, ExportedNote } from '@unbent/shared';
import type { ExportSource } from '@unbent/enex';
import { createExporting, isExportOf, type Exporting, type ExportState } from './export-archive.js';

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
