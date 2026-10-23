import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { importJoplin, joplinIdToNoteId, rewriteJoplinLinks } from './import-joplin.js';
import type { ImportClient } from './import-run.js';
import { JoplinType, joplinTime, parseJoplinItem } from './joplin-item.js';
import { BlobWindow, listTar } from './tar.js';
import { ID, KETTLE_CREATED, KETTLE_UPDATED, PNG, jex, jexFiles, sampleJex, tar } from './test-jex.js';

const PDF = new Uint8Array(readFileSync(new URL('../test/fixtures/scan-good.pdf', import.meta.url)));
const sample = () => ({ name: 'JEX Export.jex', blob: jex(sampleJex(PDF)) });

type Created = Parameters<ImportClient['createNote']>[0] & { storedId: string };

/** A server that keeps a note's id when it is free and recognises one it has seen. */
function fakeClient() {
  const notes: Created[] = [];
  const files: Array<{ noteId: string; filename: string; mime: string; size: number }> = [];
  const texts: Array<{ noteId: string; filename: string; text: string }> = [];
  const client: ImportClient = {
    createNote: vi.fn(async (input) => {
      const seen = notes.find((n) => n.storedId === input.id || n.contentHash === input.contentHash);
      if (seen) return { id: seen.storedId, created: false };
      const storedId = input.id ?? `note-${notes.length + 1}`;
      notes.push({ ...input, storedId });
      return { id: storedId, created: true };
    }),
    uploadFile: vi.fn(async (noteId, filename, mime, bytes) => {
      files.push({ noteId, filename, mime, size: bytes.length });
      return { filename };
    }),
    updateBody: vi.fn(async (noteId, body) => {
      const n = notes.find((x) => x.storedId === noteId);
      if (n) n.body = body;
    }),
    listFiles: vi.fn(async (noteId) => files.filter((f) => f.noteId === noteId).map((f) => f.filename)),
    saveFileText: vi.fn(async (noteId, filename, text) => {
      texts.push({ noteId, filename, text });
    }),
  };
  return { client, notes, files, texts };
}

const byTitle = (notes: Created[], title: string) => notes.find((n) => n.title === title)!;

describe('listTar', () => {
  it('lists the regular files of a ustar archive with where their bytes are', async () => {
    const blob = new Blob([tar([['a.md', new TextEncoder().encode('hello')], ['resources/b.png', new Uint8Array(700)]]) as BlobPart]);
    const window = new BlobWindow(blob);
    const entries = await listTar(window);
    expect(entries.map((e) => [e.name, e.size])).toEqual([['a.md', 5], ['resources/b.png', 700]]);
    expect(await window.text(entries[0]!)).toBe('hello');
  });

  it('honours a pax path and skips directories', async () => {
    const enc = new TextEncoder();
    const long = `${'deep/'.repeat(30)}note.md`;
    // A pax record counts its own length, digits included.
    const rest = ` path=${long}\n`;
    let len = rest.length + 1;
    while (`${len}${rest}`.length !== len) len += 1;
    const archive = tar([
      ['PaxHeader', enc.encode(`${len}${rest}`)],
      ['placeholder.md', enc.encode('x')],
      ['dir/', new Uint8Array(0)],
    ]);
    // Retype the first header as pax and the last as a directory, and re-sum both.
    for (const [at, type] of [[0, 'x'], [512 * 4, '5']] as const) {
      const header = archive.subarray(at, at + 512);
      header[156] = type.charCodeAt(0);
      header.fill(0x20, 148, 156);
      let sum = 0;
      for (const b of header) sum += b;
      header.set(enc.encode(`${sum.toString(8).padStart(6, '0')}\0 `), 148);
    }
    const entries = await listTar(new BlobWindow(new Blob([archive as BlobPart])));
    expect(entries.map((e) => e.name)).toEqual([long]);
  });

  it('refuses an archive cut short inside an entry, rather than reading what is left of it', async () => {
    const archive = tar([['a.md', new TextEncoder().encode('hello')], ['resources/b.pdf', new Uint8Array(3000)]]);
    // Cut halfway through the second entry's bytes, as an interrupted copy would.
    const cut = archive.subarray(0, 512 * 3 + 1000);
    await expect(listTar(new BlobWindow(new Blob([cut as BlobPart])))).rejects.toThrow(/cut short/);
  });

  it('refuses a file that is not a tar archive', async () => {
    const blob = new Blob([new Uint8Array(2048).fill(7) as BlobPart]);
    await expect(listTar(new BlobWindow(blob))).rejects.toThrow(/not a tar archive/);
  });
});

describe('parseJoplinItem', () => {
  it("reads a note the way Joplin's unserialize does", () => {
    const [, bytes] = jexFiles(sampleJex(PDF)).find(([p]) => p === `${ID.soup}.md`)!;
    const item = parseJoplinItem(new TextDecoder().decode(bytes));
    expect(item.type).toBe(JoplinType.note);
    expect(item.title).toBe('Tomato soup');
    expect(item.body).toBe('# Method\n\nSimmer for 20 minutes.\n\nkey: not a property, because a blank line follows\n');
    expect(item.props.parent_id).toBe(ID.kitchen);
    expect(joplinTime(item.props.user_created_time)).toBe(Date.UTC(2024, 10, 11, 12, 0, 0));
  });

  it('unescapes newlines in a property and keeps an escaped backslash-n as written', () => {
    const item = parseJoplinItem('T\n\nid: x\nauthor: line one\\nline two \\\\n\ntype_: 1');
    expect(item.props.author).toBe('line one\nline two \\n');
  });

  it('reads an item with no title or body, such as a tag assignment', () => {
    const item = parseJoplinItem('id: 1\nnote_id: 2\ntag_id: 3\ntype_: 6');
    expect(item).toMatchObject({ type: JoplinType.noteTag, title: '', body: '' });
    expect(item.props.tag_id).toBe('3');
  });

  it('throws on something that is not an item', () => {
    expect(() => parseJoplinItem('just some text')).toThrow();
    expect(() => parseJoplinItem('Title\n\nid: 1')).toThrow(/no type/);
  });
});

describe('rewriteJoplinLinks', () => {
  const resolve = (id: string) =>
    id === 'a'.repeat(32)
      ? { kind: 'file' as const, name: 'Scan (1).pdf' }
      : id === 'b'.repeat(32)
        ? { kind: 'note' as const, href: '/notes/n' }
        : null;

  it('points attachments and notes at what they are here, and makes what it cannot resolve text', () => {
    const body = `![x](:/${'a'.repeat(32)} "title") [y](:/${'b'.repeat(32)}#part) [z](:/${'c'.repeat(32)})`;
    expect(rewriteJoplinLinks(body, resolve)).toBe('![x](<files/Scan (1).pdf>) [y](/notes/n#part) z');
  });

  it('turns a resized picture and an HTML link into markdown', () => {
    const body = `<img src=":/${'a'.repeat(32)}" width="200"> <a href=":/${'b'.repeat(32)}"><b>See</b></a>`;
    expect(rewriteJoplinLinks(body, resolve)).toBe('![Scan (1).pdf](<files/Scan (1).pdf>) [See](/notes/n)');
  });

  it('drops the bang when an image link turns out to be a note', () => {
    expect(rewriteJoplinLinks(`![n](:/${'b'.repeat(32)})`, resolve)).toBe('[n](/notes/n)');
  });
});

describe('importJoplin', () => {
  it('imports each note into its notebook with its id, tags, dates and files', async () => {
    const { client, notes, files } = fakeClient();
    const failures: Array<{ title: string; reason: string }> = [];
    const progress = await importJoplin(sample(), client, { onFailure: (f) => failures.push(f) });

    // Five live notes, one of them still encrypted; the trashed one is not counted.
    expect(progress).toMatchObject({ notesTotal: 5, created: 4, skipped: 0, filesUploaded: 4 });

    const kettle = byTitle(notes, 'Kettle receipt');
    expect(kettle).toMatchObject({
      id: joplinIdToNoteId(ID.kettle),
      notebook: 'Household / Receipts',
      tags: ['tax', 'warranty'],
      // What Joplin shows the person, not when the item was last synced.
      createdAt: KETTLE_CREATED,
      updatedAt: KETTLE_UPDATED,
      sourceEnex: 'JEX Export.jex',
    });
    expect(kettle.body).toBe(
      [
        'Bought at Acme Appliances. Two-year warranty.',
        '',
        '[Kettle receipt.pdf](<files/Kettle receipt.pdf>)',
        '',
        '![kettle.png](files/kettle.png) and the box: ![kettle.png](files/kettle-2.png)',
        '',
        `![label](files/${ID.pasted}.png)`,
        '',
        'Lost: manual.pdf',
        '',
        `Recipe it boils water for: [Tomato soup](/notes/${joplinIdToNoteId(ID.soup)}#method)`,
      ].join('\n'),
    );
    expect(files.filter((f) => f.noteId === kettle.storedId)).toEqual([
      { noteId: kettle.storedId, filename: 'Kettle receipt.pdf', mime: 'application/pdf', size: PDF.length },
      { noteId: kettle.storedId, filename: 'kettle.png', mime: 'image/png', size: PNG.length },
      { noteId: kettle.storedId, filename: 'kettle-2.png', mime: 'image/png', size: PNG.length },
      // Joplin's catch-all type is replaced by what the bytes are.
      { noteId: kettle.storedId, filename: `${ID.pasted}.png`, mime: 'image/png', size: PNG.length },
    ]);

    expect(byTitle(notes, 'Tomato soup')).toMatchObject({ notebook: 'Kitchen', tags: ['tax'] });

    // An HTML note is converted, and its source becomes a link at the top, as an Evernote clip's does.
    const clip = byTitle(notes, 'Example article');
    expect(clip.body).toBe('<https://example.com/articles/soup>\n\n## Soup basics\n\nStart with **stock**.');
    expect(clip.sourceUrl).toBe('https://example.com/articles/soup');

    // A note whose notebook was not exported with it is left unfiled rather than guessed at.
    expect(byTitle(notes, 'No notebook').notebook).toBeUndefined();

    expect(notes.map((n) => n.title)).not.toContain('Thrown away');
    expect(failures).toEqual([
      { title: 'Kettle receipt', reason: 'Attachment "manual.pdf" is missing from the export.' },
      { title: 'Untitled', reason: expect.stringMatching(/still encrypted/) },
    ]);
  });

  it('reads the text of a PDF so search can find it', async () => {
    const { client, texts } = fakeClient();
    const progress = await importJoplin(sample(), client, { extractText: true });
    expect(progress.filesIndexed).toBe(1);
    expect(texts).toHaveLength(1);
    expect(texts[0]!.filename).toBe('Kettle receipt.pdf');
    expect(texts[0]!.text.length).toBeGreaterThan(20);
  });

  it('skips everything on a second run, and fills in a file a broken run never stored', async () => {
    const { client, notes, files } = fakeClient();
    await importJoplin(sample(), client);
    const kettleId = byTitle(notes, 'Kettle receipt').storedId;
    // As if the first run had died after the note but before its second picture.
    files.splice(files.findIndex((f) => f.filename === 'kettle-2.png'), 1);

    const again = await importJoplin(sample(), client);
    expect(again).toMatchObject({ created: 0, skipped: 4 });
    expect(notes).toHaveLength(4);
    expect(files.filter((f) => f.noteId === kettleId).map((f) => f.filename).sort()).toEqual(
      ['Kettle receipt.pdf', `${ID.pasted}.png`, 'kettle-2.png', 'kettle.png'].sort(),
    );
  });

  it('names attachments the way the upload accepts them', async () => {
    const { client, files } = fakeClient();
    const long = 'A very long title that someone pasted in '.repeat(30);
    const note = { id: ID.soup, title: 'Odd names', parent: ID.kitchen, body: `[a](:/${ID.photo}) [b](:/${ID.photoAgain}) [c](:/${ID.pasted})` };
    const archive = jex({
      folders: [{ id: ID.kitchen, title: 'Kitchen' }],
      notes: [note],
      resources: [
        { id: ID.photo, title: '.env', mime: 'text/plain', ext: '', bytes: new Uint8Array([1]) },
        { id: ID.photoAgain, title: long, mime: 'image/png', ext: 'png', bytes: PNG },
        { id: ID.pasted, title: '...', mime: 'image/png', ext: 'png', bytes: PNG },
      ],
    });
    await importJoplin({ name: 'x.jex', blob: archive }, client);
    const names = files.map((f) => f.filename);
    expect(names[0]).toBe('env');
    expect(names[1]!.length).toBe(768);
    expect(names[1]!.endsWith('.png')).toBe(true);
    expect(names[2]).toBe(`${ID.pasted}.png`);
  });

  it('reports a missing attachment once, however often the note is tried', async () => {
    const { client } = fakeClient();
    const create = client.createNote;
    let calls = 0;
    client.createNote = async (input) => {
      calls += 1;
      // The first try of the receipt meets an overloaded server, the second lands.
      if (input.title === 'Kettle receipt' && calls === 1) throw Object.assign(new Error('busy'), { status: 503 });
      return create(input);
    };
    const failures: Array<{ title: string; reason: string }> = [];
    await importJoplin(sample(), client, { onFailure: (f) => failures.push(f), sleep: async () => {} });
    expect(failures.filter((f) => f.title === 'Kettle receipt')).toHaveLength(1);
  });

  it('reports an item it cannot read and imports the rest', async () => {
    const { client, notes } = fakeClient();
    const failures: Array<{ title: string; reason: string }> = [];
    const files = jexFiles({ folders: [{ id: ID.kitchen, title: 'Kitchen' }], notes: [{ id: ID.soup, title: 'Soup', parent: ID.kitchen, body: 'Hot.' }] });
    files.push([`${'f'.repeat(32)}.md`, new TextEncoder().encode('Damaged\n\nthis line is not a property')]);
    const progress = await importJoplin({ name: 'x.jex', blob: new Blob([tar(files) as BlobPart]) }, client, { onFailure: (f) => failures.push(f) });
    expect(progress.created).toBe(1);
    expect(notes.map((n) => n.title)).toEqual(['Soup']);
    expect(failures).toEqual([{ title: `${'f'.repeat(32)}.md`, reason: expect.stringMatching(/Not a Joplin item/) }]);
  });

  it('stops while the export is still being read, and says it is reading it', async () => {
    const { client, notes } = fakeClient();
    const controller = new AbortController();
    const seen: string[] = [];
    const progress = await importJoplin(sample(), client, {
      signal: controller.signal,
      onProgress: (p) => {
        seen.push(p.currentTitle);
        controller.abort();
      },
    });
    expect(seen).toEqual(['Reading the export…']);
    expect(progress.created).toBe(0);
    expect(notes).toHaveLength(0);
  });

  it('refuses an export with no notes in it', async () => {
    const { client } = fakeClient();
    const empty = { name: 'x.jex', blob: jex({ folders: [{ id: ID.kitchen, title: 'Kitchen' }], notes: [] }) };
    await expect(importJoplin(empty, client)).rejects.toThrow(/no notes/);
  });
});

describe('joplinIdToNoteId', () => {
  it('dashes a v4 id and declines one the server would not take', () => {
    expect(joplinIdToNoteId(ID.kettle)).toBe('b2b2b2b2-b2b2-4b2b-8b2b-2b2b2b2b2b01');
    expect(joplinIdToNoteId('0'.repeat(32))).toBeUndefined();
  });
});
