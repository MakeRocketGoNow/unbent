import { describe, expect, it } from 'vitest';
import { BlobReader, BlobWriter, TextWriter, ZipReader } from '@zip.js/zip.js';
import { parse, parseNotebook, type ExportPage, type ExportedNote, type FieldDef, type NotebookSummary } from '@unbent/shared';
import { writeArchive, type ExportSource } from './export-archive.js';

/**
 * The archive's layout, which the Worker used to own and the browser now writes.
 *
 * The disaster-recovery guarantee has two halves: the server hands back every note with
 * what it needs (apps/api/test/export.test.ts), and this writes those into the zip the
 * importer beside it reads. What is pinned here is the second half — the directory per note, the
 * markdown that parses back, the files beside it, the notebook definitions and which
 * notebooks get one, and a valid archive when there is nothing to put in it.
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

function fake(opts: {
  notes: ExportedNote[];
  pageSize?: number;
  notebooks?: NotebookSummary[];
  fields?: Record<string, FieldDef[]>;
  files?: Record<string, string>;
  /** Files the source answers null for, as a deleted note's or a missing object's would. */
  gone?: string[];
}): ExportSource & { pages: number } {
  const size = opts.pageSize ?? 100;
  const source = {
    pages: 0,
    async page(_filter: unknown, cursor: string | undefined): Promise<ExportPage> {
      source.pages += 1;
      const from = cursor ? Number(cursor) : 0;
      const notes = opts.notes.slice(from, from + size);
      const next = from + size < opts.notes.length ? String(from + size) : null;
      return { notes, cursor: next, total: cursor ? null : opts.notes.length };
    },
    async file(noteId: string, filename: string) {
      if (opts.gone?.includes(`${noteId}/${filename}`)) return null;
      const text = opts.files?.[`${noteId}/${filename}`];
      if (text === undefined) throw new Error(`no such file ${noteId}/${filename}`);
      return new Blob([text]).stream();
    },
    async notebooks() {
      return opts.notebooks ?? [];
    },
    async fields(id: string) {
      return opts.fields?.[id] ?? [];
    },
  };
  return source;
}

/** Writes the archive for a filter into memory and unpacks it into a path -> text map. */
async function archive(source: ExportSource, filter = {}): Promise<Map<string, string>> {
  const writer = new BlobWriter('application/zip');
  await writeArchive(writer.writable, filter, source, new AbortController().signal);
  const reader = new ZipReader(new BlobReader(await writer.getData()));
  const out = new Map<string, string>();
  for (const entry of await reader.getEntries()) {
    if (entry.directory || !entry.getData) continue;
    out.set(entry.filename, await entry.getData(new TextWriter()));
  }
  await reader.close();
  return out;
}

const shopping: NotebookSummary = { id: 'nb-shop', name: 'Shopping', count: 1, fields: 2, purpose: null, emoji: null };
const empty: NotebookSummary = { id: 'nb-empty', name: 'Nothing here', count: 0, fields: 0, purpose: null, emoji: null };
const shoppingFields: FieldDef[] = [
  { id: 'f-url', notebookId: 'nb-shop', name: 'Url', type: 'url', options: [], scale: null, currency: null, position: 0 },
  { id: 'f-status', notebookId: 'nb-shop', name: 'Status', type: 'select', options: ['Want', 'Ordered'], scale: null, currency: null, position: 1 },
];

describe('writeArchive', () => {
  it('writes one directory per note, named for it, with the markdown that parses back', async () => {
    const files = await archive(
      fake({
        notes: [
          note({ id: '0b3a6c1e-0000-4000-8000-000000000001', title: 'Q3: budget & "planning"', body: '# Heading\n\nBody.\n', tags: ['work', 'two words'], notebook: 'Work Notes', notebookId: 'nb-work' }),
          note({ id: '0b3a6c1e-0000-4000-8000-000000000002', title: 'Second note', body: 'two' }),
        ],
      }),
    );
    const names = [...files.keys()].sort();
    expect(names).toEqual(['q3-budget-planning-0b3a6c1e/q3-budget-planning-0b3a6c1e.md', 'second-note-0b3a6c1e/second-note-0b3a6c1e.md']);

    const parsed = parse(files.get(names[0]!)!);
    expect(parsed.id).toBe('0b3a6c1e-0000-4000-8000-000000000001');
    expect(parsed.title).toBe('Q3: budget & "planning"');
    expect(parsed.tags.sort()).toEqual(['two words', 'work']);
    expect(parsed.notebook).toBe('Work Notes');
    expect(parsed.body).toBe('# Heading\n\nBody.\n');
  });

  it('puts every stored file under the note directory, at files/', async () => {
    const files = await archive(
      fake({
        notes: [
          note({
            id: 'aaaaaaaa-0000-4000-8000-000000000003',
            title: 'With files',
            body: '![x](files/pic.png)',
            attachments: [
              { filename: 'pic.png', contentType: 'image/png' },
              { filename: 'unlinked.txt', contentType: 'text/plain' },
            ],
          }),
        ],
        files: {
          'aaaaaaaa-0000-4000-8000-000000000003/pic.png': 'PNGDATA',
          'aaaaaaaa-0000-4000-8000-000000000003/unlinked.txt': 'kept',
        },
      }),
    );
    expect([...files.keys()].sort()).toEqual([
      'with-files-aaaaaaaa/files/pic.png',
      'with-files-aaaaaaaa/files/unlinked.txt',
      'with-files-aaaaaaaa/with-files-aaaaaaaa.md',
    ]);
    expect(files.get('with-files-aaaaaaaa/files/pic.png')).toBe('PNGDATA');
    // The link stays relative, so the unpacked folder works without this app.
    expect(parse(files.get('with-files-aaaaaaaa/with-files-aaaaaaaa.md')!).body).toBe('![x](files/pic.png)');
  });

  it('skips a file that is gone and counts it, rather than failing the archive', async () => {
    const id = 'aaaaaaaa-0000-4000-8000-000000000004';
    const writer = new BlobWriter('application/zip');
    const progress = await writeArchive(
      writer.writable,
      {},
      fake({
        notes: [
          note({
            id,
            title: 'Half there',
            attachments: [
              { filename: 'kept.txt', contentType: 'text/plain' },
              { filename: 'gone.pdf', contentType: 'application/pdf' },
            ],
          }),
        ],
        files: { [`${id}/kept.txt`]: 'kept' },
        gone: [`${id}/gone.pdf`],
      }),
      new AbortController().signal,
    );
    expect(progress).toEqual({ done: 1, total: 1, files: 1, skipped: 1 });
    const reader = new ZipReader(new BlobReader(await writer.getData()));
    const names = (await reader.getEntries()).map((e) => e.filename).sort();
    await reader.close();
    expect(names).toEqual(['half-there-aaaaaaaa/files/kept.txt', 'half-there-aaaaaaaa/half-there-aaaaaaaa.md']);
  });

  it('walks every page', async () => {
    const notes = Array.from({ length: 7 }, (_, i) =>
      note({ id: `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`, title: `Note ${i}` }),
    );
    const source = fake({ notes, pageSize: 3 });
    const files = await archive(source);
    expect(files.size).toBe(7);
    expect(source.pages).toBe(3);
  });

  it('writes a valid archive that says so when there is nothing to export', async () => {
    const files = await archive(fake({ notes: [] }));
    expect([...files.keys()]).toEqual(['README.txt']);
    expect(files.get('README.txt')).toBe('No notes to export.\n');
  });

  /**
   * What a note's frontmatter cannot say — that a field is a URL, which options a select
   * offers, that a field with no values exists — rides in `notebooks/<slug>.yaml`, one per
   * notebook the archive is about.
   */
  it('writes every notebook for an unfiltered export, empty ones included', async () => {
    const files = await archive(
      fake({
        notes: [note({ id: 'bbbbbbbb-0000-4000-8000-000000000004', title: 'Bike', notebook: 'Shopping', notebookId: 'nb-shop' })],
        notebooks: [shopping, empty],
        fields: { 'nb-shop': shoppingFields },
      }),
    );
    expect([...files.keys()].filter((k) => k.startsWith('notebooks/')).sort()).toEqual([
      'notebooks/nothing-here.yaml',
      'notebooks/shopping.yaml',
    ]);
    expect(parseNotebook(files.get('notebooks/shopping.yaml')!)).toEqual({
      name: 'Shopping',
      fields: [
        { name: 'Url', type: 'url' },
        { name: 'Status', type: 'select', options: ['Want', 'Ordered'] },
      ],
    });
    expect(parseNotebook(files.get('notebooks/nothing-here.yaml')!)).toEqual({ name: 'Nothing here', fields: [] });
  });

  it('writes only the notebooks a slice is about, and the one it named even when empty', async () => {
    const source = fake({
      notes: [note({ id: 'cccccccc-0000-4000-8000-000000000005', title: 'Tagged', tags: ['gift'] })],
      notebooks: [shopping, empty],
      fields: { 'nb-shop': shoppingFields },
    });
    // A slice by tag carries the notebooks its notes are in; an unfiled note names none.
    expect([...(await archive(source, { tags: ['gift'] })).keys()].filter((k) => k.startsWith('notebooks/'))).toEqual([]);
    // A notebook slice carries that notebook, and only it, even when nothing matched.
    const emptySlice = await archive(fake({ notes: [], notebooks: [shopping, empty] }), { notebook: 'Nothing here' });
    expect([...emptySlice.keys()].sort()).toEqual(['README.txt', 'notebooks/nothing-here.yaml']);
  });

  it('stops between files when asked, leaving nothing behind', async () => {
    const controller = new AbortController();
    const source = fake({
      notes: [note({ id: 'dddddddd-0000-4000-8000-000000000006', title: 'A' }), note({ id: 'eeeeeeee-0000-4000-8000-000000000007', title: 'B' })],
    });
    const writer = new BlobWriter('application/zip');
    const run = writeArchive(writer.writable, {}, source, controller.signal, (p) => {
      if (p.done === 1) controller.abort();
    });
    await expect(run).rejects.toThrow();
  });
});
