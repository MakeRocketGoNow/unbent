import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  FAILURE_STREAK_LIMIT,
  ImportStoppedError,
  importEnex,
  type ImportClient,
} from './import.js';

/** Builds an in-memory ENEX file with the given notes. */
function enexFile(name: string, notes: string[]): {
  name: string;
  stream: () => ReadableStream<Uint8Array>;
} {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export4.dtd">
<en-export export-date="20260817T195256Z">${notes.join('')}</en-export>`;
  return {
    name,
    stream: () =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(xml));
          controller.close();
        },
      }),
  };
}

function note(opts: {
  title: string;
  content: string;
  tags?: string[];
  created?: string;
  sourceUrl?: string;
  resources?: Array<{ base64: string; mime: string; filename: string }>;
}): string {
  const tags = (opts.tags ?? []).map((t) => `<tag>${t}</tag>`).join('');
  const attrs = opts.sourceUrl
    ? `<note-attributes><source-url>${opts.sourceUrl}</source-url></note-attributes>`
    : '';
  const resources = (opts.resources ?? [])
    .map(
      (r) =>
        `<resource><data encoding="base64">${r.base64}</data><mime>${r.mime}</mime>` +
        `<resource-attributes><file-name>${r.filename}</file-name></resource-attributes></resource>`,
    )
    .join('');
  return `<note><title>${opts.title}</title>
    <created>${opts.created ?? '20240115T093000Z'}</created>
    <updated>${opts.created ?? '20240115T093000Z'}</updated>
    ${tags}${attrs}
    <content><![CDATA[<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">
<en-note>${opts.content}</en-note>]]></content>${resources}</note>`;
}

/** base64 of "hello" and its md5, precomputed. */
const HELLO_B64 = 'aGVsbG8=';
const HELLO_MD5 = '5d41402abc4b2a76b9719d911017c592';

function fakeClient(over: Partial<ImportClient> = {}) {
  const notes: Array<{ id: string; title: string; body: string; tags: string[] }> = [];
  const files: Array<{ noteId: string; filename: string; size: number }> = [];
  const seenHashes = new Map<string, string>();

  const client: ImportClient = {
    createNote: vi.fn(async (input) => {
      const existing = seenHashes.get(input.contentHash);
      if (existing) return { id: existing, created: false };
      const id = `note-${notes.length + 1}`;
      seenHashes.set(input.contentHash, id);
      notes.push({ id, title: input.title, body: input.body, tags: input.tags });
      return { id, created: true };
    }),
    uploadFile: vi.fn(async (noteId, filename, _mime, bytes) => {
      files.push({ noteId, filename, size: bytes.length });
      return { filename };
    }),
    updateBody: vi.fn(async (noteId, body) => {
      const n = notes.find((x) => x.id === noteId);
      if (n) n.body = body;
    }),
    ...over,
  };

  return { client, notes, files };
}

describe('importEnex', () => {
  it('imports notes with titles, bodies, and timestamps', async () => {
    const { client, notes } = fakeClient();
    const file = enexFile('Quotes.enex', [
      note({ title: 'First', content: '<div>hello world</div>' }),
      note({ title: 'Second', content: '<h1>Heading</h1>' }),
    ]);

    const progress = await importEnex(file, client);

    expect(progress.created).toBe(2);
    expect(progress.failed).toBe(0);
    expect(notes.map((n) => n.title)).toEqual(['First', 'Second']);
    expect(notes[0]!.body).toContain('hello world');
    expect(notes[1]!.body).toContain('# Heading');
  });

  it('stores the notebook name separately from evernote tags', async () => {
    const { client, notes } = fakeClient();
    const file = enexFile('Appliance Manuals.enex', [
      note({ title: 'Visit', content: '<div>x</div>', tags: ['Doctor Visit', 'Medical'] }),
    ]);

    await importEnex(file, client);
    expect(notes[0]!.tags.sort()).toEqual(['Doctor Visit', 'Medical']);
    expect(client.createNote).toHaveBeenCalledWith(
      expect.objectContaining({ notebook: 'Appliance Manuals' }),
    );
  });

  it('accepts an explicit notebook tag over the filename', async () => {
    const { client } = fakeClient();
    const file = enexFile('weird-export-name.enex', [note({ title: 'x', content: '<div>x</div>' })]);

    await importEnex(file, client, { notebookTag: 'Recipes' });
    expect(client.createNote).toHaveBeenCalledWith(
      expect.objectContaining({ notebook: 'Recipes', tags: [] }),
    );
  });

  it('preserves evernote timestamps', async () => {
    let captured: { createdAt: number; updatedAt: number } | undefined;
    const { client } = fakeClient({
      createNote: async (input) => {
        captured = input;
        return { id: 'n1', created: true };
      },
    });
    const file = enexFile('N.enex', [
      note({ title: 'Old', content: '<div>x</div>', created: '20170105T161432Z' }),
    ]);

    await importEnex(file, client);
    expect(new Date(captured!.createdAt).toISOString()).toBe('2017-01-05T16:14:32.000Z');
  });

  it('prepends a source url for bookmark notes', async () => {
    const { client, notes } = fakeClient();
    const file = enexFile('Raindrop.io.enex', [
      note({
        title: 'Bookmark',
        content: '<div>description text</div>',
        sourceUrl: 'https://example.com/article',
      }),
    ]);

    await importEnex(file, client);
    expect(notes[0]!.body).toContain('<https://example.com/article>');
  });

  it('does not duplicate a source url the clipper already included', async () => {
    const { client, notes } = fakeClient();
    const file = enexFile('R.enex', [
      note({
        title: 'B',
        content: '<div><a href="https://example.com/a">https://example.com/a</a></div>',
        sourceUrl: 'https://example.com/a',
      }),
    ]);

    await importEnex(file, client);
    expect(notes[0]!.body.match(/example\.com\/a/g)?.length).toBe(1);
  });
});

describe('attachments', () => {
  it('uploads resources and links them relatively', async () => {
    const { client, notes, files } = fakeClient();
    const file = enexFile('N.enex', [
      note({
        title: 'With file',
        content: `<en-media hash="${HELLO_MD5}" type="text/plain"/>`,
        resources: [{ base64: HELLO_B64, mime: 'text/plain', filename: 'hello.txt' }],
      }),
    ]);

    await importEnex(file, client);

    expect(files).toHaveLength(1);
    expect(files[0]!.size).toBe(5);
    expect(notes[0]!.body).toContain('files/hello.txt');
  });

  /** Evernote keeps attachments that were never embedded; dropping them loses files. */
  it('appends attachments the note body never referenced', async () => {
    const { client, notes, files } = fakeClient();
    const file = enexFile('N.enex', [
      note({
        title: 'Orphan file',
        content: '<div>no media element here</div>',
        resources: [{ base64: HELLO_B64, mime: 'text/plain', filename: 'stray.txt' }],
      }),
    ]);

    await importEnex(file, client);

    expect(files).toHaveLength(1);
    expect(notes[0]!.body).toContain('## Attachments');
    expect(notes[0]!.body).toContain('files/stray.txt');
  });

  it('rewrites links when the server renames a colliding file', async () => {
    const { client, notes } = fakeClient({
      uploadFile: vi.fn(async () => ({ filename: 'hello-2.txt' })),
    });
    const file = enexFile('N.enex', [
      note({
        title: 'Renamed',
        content: `<en-media hash="${HELLO_MD5}" type="text/plain"/>`,
        resources: [{ base64: HELLO_B64, mime: 'text/plain', filename: 'hello.txt' }],
      }),
    ]);

    await importEnex(file, client);
    expect(notes[0]!.body).toContain('files/hello-2.txt');
    expect(notes[0]!.body).not.toContain('files/hello.txt');
  });
});

/** Resumability is the point: a 3GB import will be interrupted. */
describe('resume', () => {
  it('skips notes already imported and does not re-upload their files', async () => {
    const { client, notes, files } = fakeClient();
    const file = () =>
      enexFile('N.enex', [
        note({
          title: 'Same',
          content: `<en-media hash="${HELLO_MD5}" type="text/plain"/>`,
          resources: [{ base64: HELLO_B64, mime: 'text/plain', filename: 'hello.txt' }],
        }),
      ]);

    const first = await importEnex(file(), client);
    expect(first.created).toBe(1);
    expect(files).toHaveLength(1);

    const second = await importEnex(file(), client);
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(1);
    // The expensive half of a resumed run must not repeat.
    expect(files).toHaveLength(1);
    expect(notes).toHaveLength(1);
  });

  it('uploads attachments a prior run missed when the note already exists', async () => {
    const files: string[] = [];
    const { client } = fakeClient({
      createNote: vi.fn(async () => ({ id: 'note-1', created: false })),
      // First resource landed; second did not (worker died mid-note).
      listFiles: async () => ['a.txt'],
      uploadFile: vi.fn(async (_noteId, filename) => {
        files.push(filename);
        return { filename };
      }),
    });

    const progress = await importEnex(
      enexFile('N.enex', [
        note({
          title: 'Partial',
          content: '<div></div>',
          resources: [
            { base64: HELLO_B64, mime: 'text/plain', filename: 'a.txt' },
            { base64: HELLO_B64, mime: 'text/plain', filename: 'b.txt' },
          ],
        }),
      ]),
      client,
    );

    expect(progress.skipped).toBe(1);
    expect(progress.created).toBe(0);
    expect(files).toEqual(['b.txt']);
  });
});

describe('failures', () => {
  it('records a failure and continues with the next note', async () => {
    let call = 0;
    const { client, notes } = fakeClient({
      createNote: vi.fn(async (input) => {
        call += 1;
        if (call === 1) throw new Error('server exploded');
        notes.push({ id: 'n', title: input.title, body: input.body, tags: input.tags });
        return { id: 'n', created: true };
      }),
    });
    const failures: string[] = [];

    const file = enexFile('N.enex', [
      note({ title: 'Doomed', content: '<div>x</div>' }),
      note({ title: 'Fine', content: '<div>y</div>' }),
    ]);

    const progress = await importEnex(file, client, {
      onFailure: (f) => failures.push(f.title),
    });

    expect(progress.failed).toBe(1);
    expect(progress.created).toBe(1);
    expect(failures).toEqual(['Doomed']);
  });

  it('reports progress as it goes', async () => {
    const { client } = fakeClient();
    const seen: number[] = [];
    const file = enexFile('N.enex', [
      note({ title: 'a', content: '<div>1</div>' }),
      note({ title: 'b', content: '<div>2</div>' }),
      note({ title: 'c', content: '<div>3</div>' }),
    ]);

    await importEnex(file, client, { onProgress: (p) => seen.push(p.processed) });
    expect(seen).toEqual([1, 2, 3]);
  });

  it('stops when aborted', async () => {
    const controller = new AbortController();
    const { client } = fakeClient({
      createNote: vi.fn(async () => {
        controller.abort();
        return { id: 'n', created: true };
      }),
    });

    const file = enexFile('N.enex', [
      note({ title: 'a', content: '<div>1</div>' }),
      note({ title: 'b', content: '<div>2</div>' }),
      note({ title: 'c', content: '<div>3</div>' }),
    ]);

    const progress = await importEnex(file, client, { signal: controller.signal });
    // The first note lands, the rest are skipped quietly — cancelling is not failing.
    expect(progress.created).toBe(1);
    expect(progress.failed).toBe(0);
    expect(progress.processed).toBe(1);
  });
});

/**
 * Text extraction during import.
 *
 * Most notes in a real export are a scanned PDF with an empty body, so without this they
 * arrive as title-only stubs that search cannot reach.
 */
describe('attachment text extraction', () => {
  const pdfBase64 = readFileSync(
    new URL('../test/fixtures/scan-good.b64.txt', import.meta.url),
    'utf8',
  ).trim();

  function pdfNote(title: string): string {
    // The md5 does not need to match: an unreferenced resource is still uploaded.
    return note({
      title,
      content: '<div></div>',
      resources: [{ base64: pdfBase64, mime: 'application/pdf', filename: 'scan.pdf' }],
    });
  }

  it('extracts and saves text when enabled', async () => {
    const saved: Array<{ filename: string; text: string }> = [];
    const { client } = fakeClient({
      saveFileText: async (_noteId, filename, text) => {
        saved.push({ filename, text });
      },
    });

    const progress = await importEnex(enexFile('Scans.enex', [pdfNote('Scan')]), client, {
      extractText: true,
    });

    expect(progress.filesIndexed).toBe(1);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.filename).toBe('scan.pdf');
    // Content from the scan's OCR layer, which is the whole point.
    expect(saved[0]!.text).toContain('Northfield');
  }, 60_000);

  it('does not extract when disabled', async () => {
    const saved: string[] = [];
    const { client } = fakeClient({
      saveFileText: async (_n, f) => {
        saved.push(f);
      },
    });

    const progress = await importEnex(enexFile('Scans.enex', [pdfNote('Scan')]), client);

    expect(progress.filesIndexed).toBe(0);
    expect(saved).toEqual([]);
  }, 60_000);

  it('still uploads the file when its text is unusable', async () => {
    const saved: string[] = [];
    const { client, files } = fakeClient({
      saveFileText: async (_n, f) => {
        saved.push(f);
      },
    });

    // A text file is not extractable, so no text is saved but the upload still happens.
    const file = enexFile('Mixed.enex', [
      note({
        title: 'Plain',
        content: '<div>x</div>',
        resources: [{ base64: 'aGVsbG8=', mime: 'text/plain', filename: 'note.txt' }],
      }),
    ]);

    const progress = await importEnex(file, client, { extractText: true });

    expect(files).toHaveLength(1);
    expect(progress.filesIndexed).toBe(0);
    expect(saved).toEqual([]);
  }, 60_000);
});

/**
 * The server going away partway through a run.
 *
 * This is the shape a deleted preview Worker produced: every request from one moment on
 * answered with the same status, by something that was not the API. The notes are fine —
 * the run has simply stopped being able to import anything — so it should end and say so
 * rather than spend the rest of the file proving the point once per note.
 */
describe('a server that stops responding', () => {
  const statusError = (status: number) =>
    Object.assign(new Error(`${status} — the request did not reach the API`), { status });

  const manyNotes = (count: number) =>
    Array.from({ length: count }, (_, i) => note({ title: `N${i}`, content: '<div></div>' }));

  it('stops the run once the failures are consecutive and alike', async () => {
    const healthy = 2;
    const createNote = vi.fn(async (input: { title: string; contentHash: string }) => {
      if (notes.length >= healthy) throw statusError(404);
      notes.push(input.title);
      return { id: `note-${notes.length}`, created: true };
    });
    const notes: string[] = [];
    const { client } = fakeClient({ createNote });

    const failures: string[] = [];
    const run = importEnex(enexFile('N.enex', manyNotes(60)), client, {
      onFailure: (f) => failures.push(f.title),
    });

    await expect(run).rejects.toBeInstanceOf(ImportStoppedError);
    await expect(run).rejects.toMatchObject({ status: 404, streak: FAILURE_STREAK_LIMIT });

    // The whole point: it gave up rather than working through the other 53 notes.
    expect(failures).toHaveLength(FAILURE_STREAK_LIMIT);
    expect(createNote).toHaveBeenCalledTimes(healthy + FAILURE_STREAK_LIMIT);
  });

  it('says how much landed before it gave up', async () => {
    const { client } = fakeClient({
      createNote: vi.fn(async (input) => {
        if (input.title === 'N0') return { id: 'note-1', created: true };
        throw statusError(503);
      }),
    });

    await expect(
      importEnex(enexFile('N.enex', manyNotes(20)), client),
    ).rejects.toThrow(/503.*1 notes were imported before that.*Import the same file again/s);
  });

  it('keeps going when a success breaks the streak', async () => {
    let call = 0;
    const { client } = fakeClient({
      createNote: vi.fn(async () => {
        // Fails in runs of four, which on its own never reaches the limit.
        if (++call % 5 !== 0) throw statusError(404);
        return { id: `note-${call}`, created: true };
      }),
    });

    const progress = await importEnex(enexFile('N.enex', manyNotes(20)), client);
    expect(progress.processed).toBe(20);
    expect(progress.created).toBe(4);
    expect(progress.failed).toBe(16);
  });

  it('keeps going when the statuses differ', async () => {
    const statuses = [500, 502, 503, 504, 500, 502, 503, 504];
    let call = 0;
    const { client } = fakeClient({
      createNote: vi.fn(async () => {
        throw statusError(statuses[call++ % statuses.length]!);
      }),
    });

    const progress = await importEnex(enexFile('N.enex', manyNotes(8)), client);
    expect(progress.processed).toBe(8);
    expect(progress.failed).toBe(8);
  });

  it('never trips on failures that are about the notes themselves', async () => {
    const { client } = fakeClient({
      // No status: the kind of failure a malformed note produces, which the next note
      // says nothing about. Every one of these must still be attempted.
      createNote: vi.fn(async () => {
        throw new Error('Converted note body is too large to store.');
      }),
    });

    const progress = await importEnex(enexFile('N.enex', manyNotes(12)), client);
    expect(progress.processed).toBe(12);
    expect(progress.failed).toBe(12);
  });
});
