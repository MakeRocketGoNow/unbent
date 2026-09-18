import { BlobWriter, TextReader, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js';
import { serialize } from '@unbent/shared';
import { describe, expect, it, vi } from 'vitest';
import { importArchive } from './import-archive.js';
import {
  FAILURE_STREAK_LIMIT,
  ImportStoppedError,
  type ImportClient,
  type ImportSkip,
} from './import-run.js';

/** One exported note's markdown, as the API writes it. */
function noteMarkdown(
  over: {
    id?: string;
    title?: string;
    body?: string;
    tags?: string[];
    notebook?: string;
    fields?: Record<string, string | number | boolean>;
  } = {},
): string {
  return serialize({
    id: over.id ?? '0191c2a0-0000-7000-8000-000000000001',
    title: over.title ?? 'Meeting notes',
    created: new Date('2024-01-15T09:30:00Z'),
    updated: new Date('2024-02-01T10:00:00Z'),
    tags: over.tags ?? ['work'],
    ...(over.notebook ? { notebook: over.notebook } : {}),
    ...(over.fields ? { fields: over.fields } : {}),
    body: over.body ?? '# Agenda\n\nDiscuss things.\n',
  });
}

type ZipContent = Record<string, string | Uint8Array>;

/** Builds a zip in memory from `path → content`. */
async function zipFile(name: string, content: ZipContent): Promise<{ name: string; blob: Blob }> {
  const writer = new ZipWriter(new BlobWriter('application/zip'), { useWebWorkers: false });
  for (const [path, data] of Object.entries(content)) {
    await writer.add(
      path,
      typeof data === 'string' ? new TextReader(data) : new Uint8ArrayReader(data),
    );
  }
  return { name, blob: await writer.close() };
}

function markdownFile(name: string, text: string): { name: string; blob: Blob } {
  return { name, blob: new Blob([text], { type: 'text/markdown' }) };
}

const bytes = (s: string) => new TextEncoder().encode(s);

/**
 * A server that dedupes the way the real one does: by the id the note came with, then by
 * content hash — but a hash hit does not swallow a different note whose id is still free.
 */
function fakeClient(over: Partial<ImportClient> = {}) {
  const notes: Array<{
    id: string;
    title: string;
    body: string;
    tags: string[];
    notebook?: string;
    fields?: Record<string, string | number | boolean>;
  }> = [];
  const files: Array<{ noteId: string; filename: string; mime: string; size: number }> = [];
  const byHash = new Map<string, string>();
  const taken = new Set<string>();

  const client: ImportClient = {
    createNote: vi.fn(async (input) => {
      const byId = input.id ? notes.find((n) => n.id === input.id) : undefined;
      if (byId) return { id: byId.id, created: false };
      const hashed = byHash.get(input.contentHash);
      // Same rule as NotesRepo.importNote: a free id is a different note, even when
      // the text (and so an older title+body hash) matches something already stored.
      if (hashed && (!input.id || taken.has(input.id))) return { id: hashed, created: false };

      const id = input.id && !taken.has(input.id) ? input.id : `note-${notes.length + 1}`;
      taken.add(id);
      if (input.id) taken.add(input.id);
      byHash.set(input.contentHash, id);
      notes.push({
        id,
        title: input.title,
        body: input.body,
        tags: input.tags,
        ...(input.notebook ? { notebook: input.notebook } : {}),
        ...(input.fields ? { fields: input.fields } : {}),
      });
      return { id, created: true };
    }),
    uploadFile: vi.fn(async (noteId, filename, mime, data) => {
      files.push({ noteId, filename, mime, size: data.length });
      return { filename };
    }),
    updateBody: vi.fn(async (noteId, body) => {
      const n = notes.find((x) => x.id === noteId);
      if (n) n.body = body;
    }),
    listFiles: vi.fn(async (noteId) =>
      files.filter((f) => f.noteId === noteId).map((f) => f.filename),
    ),
    ...over,
  };

  return { client, notes, files };
}

describe('the library archive', () => {
  it('imports one note per directory with everything its frontmatter carries', async () => {
    const { client, notes } = fakeClient();
    const zip = await zipFile('unbent-export-2026-09-15.zip', {
      'meeting-notes-0191c2a0/meeting-notes-0191c2a0.md': noteMarkdown({
        notebook: 'Work Notes',
        fields: { Priority: 2, Done: false, Owner: 'Sam' },
      }),
      'second-0191c2b0/second-0191c2b0.md': noteMarkdown({
        id: '0191c2b0-0000-7000-8000-000000000002',
        title: 'Second',
        body: 'plain\n',
        tags: [],
      }),
    });

    const progress = await importArchive(zip, client);

    expect(progress.created).toBe(2);
    expect(progress.failed).toBe(0);
    expect(notes.map((n) => n.title)).toEqual(['Meeting notes', 'Second']);
    expect(client.createNote).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '0191c2a0-0000-7000-8000-000000000001',
        title: 'Meeting notes',
        body: '# Agenda\n\nDiscuss things.\n',
        tags: ['work'],
        notebook: 'Work Notes',
        createdAt: Date.parse('2024-01-15T09:30:00Z'),
        updatedAt: Date.parse('2024-02-01T10:00:00Z'),
        fields: { Priority: 2, Done: false, Owner: 'Sam' },
        sourceEnex: 'unbent-export-2026-09-15.zip',
      }),
    );
    // A note the export left unfiled arrives unfiled — not in some default notebook.
    expect(notes[1]).not.toHaveProperty('notebook');
  });

  it('keeps two notes that share their text, because the export named them apart', async () => {
    const { client, notes } = fakeClient();
    const zip = await zipFile('lib.zip', {
      'a-0191c2a0/a-0191c2a0.md': noteMarkdown({
        id: '0191c2a0-0000-7000-8000-000000000001',
        title: 'Untitled',
        body: '',
        tags: [],
      }),
      'b-0191c2b0/b-0191c2b0.md': noteMarkdown({
        id: '0191c2b0-0000-7000-8000-000000000002',
        title: 'Untitled',
        body: '',
        tags: [],
      }),
    });

    const progress = await importArchive(zip, client);

    expect(progress.created).toBe(2);
    expect(progress.skipped).toBe(0);
    expect(notes.map((n) => n.id)).toEqual([
      '0191c2a0-0000-7000-8000-000000000001',
      '0191c2b0-0000-7000-8000-000000000002',
    ]);
    const hashes = vi.mocked(client.createNote).mock.calls.map((c) => c[0]?.contentHash);
    expect(new Set(hashes).size).toBe(2);

    const again = await importArchive(zip, client);
    expect(again.created).toBe(0);
    expect(again.skipped).toBe(2);
    expect(notes).toHaveLength(2);
  });

  it('uploads what sits in files/ and leaves the body exactly as exported', async () => {
    const { client, notes, files } = fakeClient();
    const body = 'See [agenda](files/agenda.pdf) and ![](<files/board photo.png>)\n';
    const zip = await zipFile('lib.zip', {
      'meeting-notes-0191c2a0/meeting-notes-0191c2a0.md': noteMarkdown({ body }),
      'meeting-notes-0191c2a0/files/agenda.pdf': bytes('%PDF-1.4 fake'),
      'meeting-notes-0191c2a0/files/board photo.png': new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 1, 2,
      ]),
      // Stored but no longer linked: still the note's, still uploaded, still not linked.
      'meeting-notes-0191c2a0/files/stray.txt': bytes('hello'),
    });

    const progress = await importArchive(zip, client);

    expect(progress.filesUploaded).toBe(3);
    expect(files.map((f) => [f.filename, f.mime])).toEqual([
      ['agenda.pdf', 'application/pdf'],
      ['board photo.png', 'image/png'],
      ['stray.txt', 'text/plain'],
    ]);
    expect(notes[0]!.body).toBe(body);
    expect(client.updateBody).not.toHaveBeenCalled();
  });

  it('types an extensionless file by its bytes', async () => {
    const { client, files } = fakeClient();
    const zip = await zipFile('lib.zip', {
      'n-1/n-1.md': noteMarkdown({ body: '[Menu Card](<files/Menu Card>)\n' }),
      'n-1/files/Menu Card': bytes('%PDF-1.7 menu'),
    });

    await importArchive(zip, client);
    expect(files[0]).toMatchObject({ filename: 'Menu Card', mime: 'application/pdf' });
  });

  it('repoints links when the server stores a file under another name', async () => {
    const { client, notes } = fakeClient({
      uploadFile: vi.fn(async () => ({ filename: 'agenda-2.pdf' })),
    });
    const zip = await zipFile('lib.zip', {
      'n-1/n-1.md': noteMarkdown({ body: '[a](files/agenda.pdf)\n' }),
      'n-1/files/agenda.pdf': bytes('%PDF'),
    });

    await importArchive(zip, client);
    expect(notes[0]!.body).toBe('[a](files/agenda-2.pdf)\n');
  });

  it('reads an archive someone unpacked and zipped again', async () => {
    const { client, notes, files } = fakeClient();
    const zip = await zipFile('Archive.zip', {
      // Finder adds the folder, a resource fork tree, and .DS_Store at every level.
      'unbent-export-2026-09-15/.DS_Store': bytes('junk'),
      '__MACOSX/unbent-export-2026-09-15/._.DS_Store': bytes('junk'),
      'unbent-export-2026-09-15/n-1/n-1.md': noteMarkdown({ body: '[a](files/a.txt)\n' }),
      '__MACOSX/unbent-export-2026-09-15/n-1/._n-1.md': bytes('junk'),
      'unbent-export-2026-09-15/n-1/files/a.txt': bytes('hello'),
      'unbent-export-2026-09-15/n-1/files/.hidden': bytes('junk'),
      '__MACOSX/unbent-export-2026-09-15/n-1/files/._a.txt': bytes('junk'),
      // A file the export never wrote — a README someone dropped in.
      'unbent-export-2026-09-15/README.txt': bytes('what is this'),
    });

    const progress = await importArchive(zip, client);

    expect(progress.created).toBe(1);
    expect(progress.failed).toBe(0);
    expect(notes[0]!.title).toBe('Meeting notes');
    expect(files.map((f) => f.filename)).toEqual(['a.txt']);
    // Junk still counts as read, so the bar can reach the end of the file.
    expect(progress.bytesRead).toBeGreaterThan(0);
    expect(progress.bytesRead).toBeLessThanOrEqual(zip.blob.size);
  });

  it('accepts backslash paths from Windows tools', async () => {
    const { client, files } = fakeClient();
    const zip = await zipFile('lib.zip', {
      'n-1\\n-1.md': noteMarkdown({ body: '[a](files/a.txt)\n' }),
      'n-1\\files\\a.txt': bytes('hello'),
    });

    const progress = await importArchive(zip, client);
    expect(progress.created).toBe(1);
    expect(files.map((f) => f.filename)).toEqual(['a.txt']);
  });

  it('files every note under an explicit notebook when asked', async () => {
    const { client } = fakeClient();
    const zip = await zipFile('lib.zip', {
      'n-1/n-1.md': noteMarkdown({ notebook: 'Work Notes' }),
    });

    await importArchive(zip, client, { notebookTag: 'Recipes' });
    expect(client.createNote).toHaveBeenCalledWith(
      expect.objectContaining({ notebook: 'Recipes' }),
    );
  });
});

describe('a single note', () => {
  it('imports the flat zip a note with attachments downloads as', async () => {
    const { client, notes, files } = fakeClient();
    const zip = await zipFile('meeting-notes-0191c2a0.zip', {
      'meeting-notes-0191c2a0.md': noteMarkdown({ body: '[a](files/a.txt)\n' }),
      'files/a.txt': bytes('hello'),
    });

    const progress = await importArchive(zip, client);

    expect(progress.created).toBe(1);
    expect(notes[0]!.title).toBe('Meeting notes');
    expect(files).toHaveLength(1);
  });

  it('imports the bare markdown a note without attachments downloads as', async () => {
    const { client, notes } = fakeClient();
    const md = markdownFile('meeting-notes-0191c2a0.md', noteMarkdown({ title: 'Bare' }));

    const progress = await importArchive(md, client);

    expect(progress.created).toBe(1);
    expect(progress.bytesRead).toBe(md.blob.size);
    expect(notes[0]!.title).toBe('Bare');
  });
});

describe('importing again', () => {
  it('skips notes already present and does not re-upload their files', async () => {
    const { client, notes, files } = fakeClient();
    const content = {
      'n-1/n-1.md': noteMarkdown({ body: '[a](files/a.txt)\n' }),
      'n-1/files/a.txt': bytes('hello'),
    };

    const first = await importArchive(await zipFile('lib.zip', content), client);
    expect(first.created).toBe(1);

    const second = await importArchive(await zipFile('lib.zip', content), client);
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(1);
    expect(notes).toHaveLength(1);
    expect(files).toHaveLength(1);
  });

  it('reports each note it skips under its title, as already here', async () => {
    const { client, notes } = fakeClient();
    const content = { 'n-1/n-1.md': noteMarkdown({ title: 'Quarterly plan' }) };
    await importArchive(await zipFile('lib.zip', content), client);

    const skips: ImportSkip[] = [];
    await importArchive(await zipFile('lib.zip', content), client, {
      onSkip: (s) => skips.push(s),
    });

    expect(skips).toEqual([
      { title: 'Quarterly plan', noteId: notes[0]!.id, earlierInFile: false },
    ]);
  });

  it('is matched by id even when the note has since been edited', async () => {
    const { client, notes } = fakeClient();
    await importArchive(await zipFile('lib.zip', { 'n-1/n-1.md': noteMarkdown() }), client);
    notes[0]!.body = 'edited since the export';

    const again = await importArchive(
      await zipFile('lib.zip', { 'n-1/n-1.md': noteMarkdown() }),
      client,
    );

    expect(again.skipped).toBe(1);
    expect(notes[0]!.body).toBe('edited since the export');
  });

  it('fills in files a prior run never finished uploading', async () => {
    const uploaded: string[] = [];
    const { client } = fakeClient({
      createNote: vi.fn(async () => ({ id: 'note-1', created: false })),
      listFiles: async () => ['a.txt'],
      uploadFile: vi.fn(async (_noteId, filename) => {
        uploaded.push(filename);
        return { filename };
      }),
    });
    const zip = await zipFile('lib.zip', {
      'n-1/n-1.md': noteMarkdown(),
      'n-1/files/a.txt': bytes('hello'),
      'n-1/files/b.txt': bytes('hello'),
    });

    const progress = await importArchive(zip, client);

    expect(progress.skipped).toBe(1);
    expect(uploaded).toEqual(['b.txt']);
  });
});

describe('failures', () => {
  it('reports markdown without frontmatter by its path and carries on', async () => {
    const failures: Array<{ title: string; reason: string }> = [];
    const { client, notes } = fakeClient();
    const zip = await zipFile('vault.zip', {
      'Daily/2026-09-15.md': '# Just a note\n\nNo frontmatter here.\n',
      'n-1/n-1.md': noteMarkdown({ title: 'Real' }),
    });

    const progress = await importArchive(zip, client, { onFailure: (f) => failures.push(f) });

    expect(progress.failed).toBe(1);
    expect(progress.created).toBe(1);
    expect(failures).toEqual([
      { title: 'Daily/2026-09-15.md', reason: expect.stringContaining('Not an exported note') },
    ]);
    expect(notes.map((n) => n.title)).toEqual(['Real']);
  });

  it('names a note by its title once that is known', async () => {
    const failures: Array<{ title: string; reason: string }> = [];
    const { client } = fakeClient({
      createNote: vi.fn(async () => {
        throw new Error('nope');
      }),
    });
    const zip = await zipFile('lib.zip', { 'n-1/n-1.md': noteMarkdown({ title: 'Known' }) });

    await importArchive(zip, client, { onFailure: (f) => failures.push(f) });
    expect(failures).toEqual([{ title: 'Known', reason: 'nope' }]);
  });

  it('stops when aborted, without logging the rest as failures', async () => {
    const controller = new AbortController();
    const failures: unknown[] = [];
    const { client } = fakeClient({
      createNote: vi.fn(async (input) => {
        if (input.title === 'Two') controller.abort();
        return { id: input.title, created: true };
      }),
    });
    const zip = await zipFile('lib.zip', {
      'a/a.md': noteMarkdown({ id: '1', title: 'One' }),
      'b/b.md': noteMarkdown({ id: '2', title: 'Two' }),
      'c/c.md': noteMarkdown({ id: '3', title: 'Three' }),
    });

    const progress = await importArchive(zip, client, {
      signal: controller.signal,
      onFailure: (f) => failures.push(f),
    });

    expect(progress.created).toBe(2);
    expect(failures).toEqual([]);
    expect(client.createNote).toHaveBeenCalledTimes(2);
  });

  it('gives up once the server has stopped answering', async () => {
    const { client } = fakeClient({
      createNote: vi.fn(async () => {
        throw Object.assign(new Error('Bad Gateway'), { status: 502 });
      }),
    });
    const content: Record<string, string> = {};
    for (let i = 0; i < FAILURE_STREAK_LIMIT + 3; i += 1) {
      content[`n-${i}/n-${i}.md`] = noteMarkdown({ id: `id-${i}`, title: `Note ${i}` });
    }

    const run = importArchive(await zipFile('lib.zip', content), client);

    await expect(run).rejects.toBeInstanceOf(ImportStoppedError);
    await expect(run).rejects.toMatchObject({ status: 502, streak: FAILURE_STREAK_LIMIT });
    expect(client.createNote).toHaveBeenCalledTimes(FAILURE_STREAK_LIMIT);
  });
});

describe('how far along the run is', () => {
  /** A library of text notes, the shape the export writes: `{dir}/{dir}.md`. */
  function library(n: number): ZipContent {
    const content: ZipContent = {};
    for (let i = 0; i < n; i += 1) {
      const dir = `note-directory-${i}`;
      content[`${dir}/${dir}.md`] = noteMarkdown({
        id: `0191c2a0-0000-7000-8000-00000000000${i}`,
        title: `Note ${i}`,
      });
    }
    return content;
  }

  it('counts the notes it will import, so the bar tracks notes rather than bytes', async () => {
    const { client } = fakeClient();
    // The shape that broke the bar: most notes are text, a couple carry an image that is
    // almost the whole file. The count must not be swayed by where the bytes are.
    const zip = await zipFile('lib.zip', {
      ...library(20),
      'big-1/big-1.md': noteMarkdown({ id: 'b1', title: 'With an image', body: '[i](files/image.png)\n' }),
      'big-1/files/image.png': new Uint8Array(600_000).fill(7),
      'big-2/big-2.md': noteMarkdown({ id: 'b2', title: 'With a bigger image', body: '[i](files/image.png)\n' }),
      'big-2/files/image.png': new Uint8Array(1_600_000).fill(9),
    });

    const progress = await importArchive(zip, client);

    expect(progress.notesTotal).toBe(22);
    expect(progress.processed).toBe(22);
    expect(progress.created).toBe(22);
  });

  it('counts only note directories, not the junk a re-zipped archive carries', async () => {
    const { client } = fakeClient();
    const zip = await zipFile('Archive.zip', {
      'export/n-1/n-1.md': noteMarkdown({ id: '1', title: 'One' }),
      'export/n-2/n-2.md': noteMarkdown({ id: '2', title: 'Two' }),
      'export/.DS_Store': bytes('junk'),
      '__MACOSX/export/._n-1.md': bytes('junk'),
      'export/README.txt': bytes('what is this'),
      'export/orphan/files/stray.txt': bytes('belongs to nothing'),
    });

    const progress = await importArchive(zip, client);

    expect(progress.notesTotal).toBe(2);
    expect(progress.processed).toBe(2);
  });

  it('is one note for a bare markdown file', async () => {
    const { client } = fakeClient();
    const md = markdownFile('meeting-notes-0191c2a0.md', noteMarkdown());

    const progress = await importArchive(md, client);

    expect(progress.notesTotal).toBe(1);
    expect(progress.processed).toBe(1);
  });

  it('still reaches its note total when the notes are already present', async () => {
    const { client } = fakeClient();
    const content = library(5);

    await importArchive(await zipFile('lib.zip', content), client);
    const again = await importArchive(await zipFile('lib.zip', content), client);

    expect(again.skipped).toBe(5);
    expect(again.processed).toBe(again.notesTotal);
  });
});
