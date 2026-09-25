// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { BlobWriter } from '@zip.js/zip.js';
import type { ExportPage, ExportedNote } from '@unbent/shared';
import type { ExportSource } from '@unbent/enex';
import { createExporting } from './export-archive.js';

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

  it('does nothing when the person cancels the save dialog', async () => {
    const exporting = createExporting(fake([]), async () => null);
    exporting.start({ notebook: 'Coupons' });
    await new Promise((r) => setTimeout(r, 10));
    expect(exporting.get().status).toBe('idle');
  });
});
