import { BlobWriter, TextReader, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js';
import { describe, expect, it, vi } from 'vitest';
import {
  describeNotion,
  detectArchiveKind,
  importNotion,
  notionIdToNoteId,
} from './import-notion.js';
import type { ImportClient } from './import-run.js';

/**
 * A workspace export in miniature, laid out the way Notion lays one out: a wrapping
 * folder, one bundle per top-level item, ids on every page and database file, a row's
 * attachments in a folder named for the row, and the CSV beside the database's stub.
 */
const GAMES = '0a0a0a0a0a0a4a0a8a0a0a0a0a0a0a01';
const CATAN = '0a0a0a0a0a0a4a0a8a0a0a0a0a0a0a02';
const CATAN2 = '0a0a0a0a0a0a4a0a8a0a0a0a0a0a0a06';
const AZUL = '0a0a0a0a0a0a4a0a8a0a0a0a0a0a0a03';
const BLANK = '0a0a0a0a0a0a4a0a8a0a0a0a0a0a0a04';
const STRATEGY = '0a0a0a0a0a0a4a0a8a0a0a0a0a0a0a05';
const GARDEN = '1b1b1b1b1b1b4b1b8b1b1b1b1b1b1b11';
const BEDS = '1b1b1b1b1b1b4b1b8b1b1b1b1b1b1b12';
const PLANTS = '1b1b1b1b1b1b4b1b8b1b1b1b1b1b1b13';
const BASIL = '1b1b1b1b1b1b4b1b8b1b1b1b1b1b1b14';
const TORQUE = '2c2c2c2c2c2c4c2c8c2c2c2c2c2c2c21';
const LIBRARY = '3d3d3d3d3d3d4d3d8d3d3d3d3d3d3d31';

const csv = [
  'Name,Players,Rating,Price,Played On,Mechanics,Tags,Added On,Last Updated',
  'Catan,4,★★★★,$39.99,"August 2, 2026","Trading, Dice","Classic, Family","September 12, 2026 10:19 AM","September 13, 2026 8:00 AM"',
  'Catan,2,★★★,$34.99,"August 9, 2026","Trading, Dice",Family,"September 12, 2026 10:21 AM","September 12, 2026 10:21 AM"',
  'Azul,2,★★★,$29.99,"July 4, 2026","Trading, Dice",Family,"September 12, 2026 10:20 AM","September 12, 2026 10:20 AM"',
].join('\n');

const W = 'Export-3332a9d4-a922-4a0c-b440-d2a08d4da304';
const FILES: Record<string, string | Uint8Array> = {
  [`${W}/Board Games ${GAMES}.md`]: `# 🎲 Board Games\n\n[🎲 Board Games](Board%20Games%20${GAMES}_all.csv)`,
  [`${W}/Board Games ${GAMES}_all.csv`]: `﻿${csv}\n`,
  [`${W}/Board Games/Catan ${CATAN}.md`]: [
    '# Catan',
    '',
    'Players: 4',
    'Rating: ★★★★',
    'Price: $39.99',
    'Played On: August 2, 2026',
    'Mechanics: Trading, Dice',
    'Tags: Classic, Family',
    'Added On: September 12, 2026 10:19 AM',
    'Last Updated: September 13, 2026 8:00 AM',
    '',
    'A classic.',
    '',
    '![box.png](Catan/box.png)',
    '',
    `See [Azul](Azul%20${AZUL}.md) and [notes](Catan/Strategy%20notes%20${STRATEGY}.md).`,
    '',
  ].join('\n'),
  // A second row with the same title: Notion named the folder above after the first, so
  // this page shares that folder's name but does not own it, and links nothing in it.
  [`${W}/Board Games/Catan ${CATAN2}.md`]: '# Catan\n\nPlayers: 2\nRating: ★★★\nPrice: $34.99\nPlayed On: August 9, 2026\nMechanics: Trading, Dice\nTags: Family\nAdded On: September 12, 2026 10:21 AM\nLast Updated: September 12, 2026 10:21 AM\n\nThe travel edition.\n',
  [`${W}/Board Games/Catan/box.png`]: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
  // An orphan: in the folder, kept by the export, but no page links it (too big for Notion).
  [`${W}/Board Games/Catan/rules.pdf`]: new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3]),
  [`${W}/Board Games/Catan/Strategy notes ${STRATEGY}.md`]: '# Strategy notes\n\nBuild roads.\n',
  [`${W}/Board Games/Azul ${AZUL}.md`]: `# Azul\n\nPlayers: 2\nRating: ★★★\nPrice: $29.99\nPlayed On: July 4, 2026\nMechanics: Trading, Dice\nTags: Family, ${'A sentence that sat in the tags column '.repeat(4)}\nAdded On: September 12, 2026 10:20 AM\nLast Updated: September 12, 2026 10:20 AM\n\nTiles.\n`,
  // A row the CSV left out: Notion drops untitled rows from the CSV but not from the folder.
  [`${W}/Board Games/Untitled ${BLANK}.md`]: '# Untitled\n\nAdded On: September 14, 2026 9:00 AM\n',
  [`${W}/Garden ${GARDEN}.md`]: `# Garden\n\n[Beds](Garden/Beds%20${BEDS}.md)\n\n[Plants](Garden/Plants%20${PLANTS}_all.csv)\n`,
  [`${W}/Garden/Beds ${BEDS}.md`]: '# Beds\n\n![plan.png](Beds/plan.png)\n',
  [`${W}/Garden/Beds/plan.png`]: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9]),
  [`${W}/Garden/Plants ${PLANTS}_all.csv`]: 'Name,Sun\nBasil,Full\nMint,Part\nSage,Full\n',
  [`${W}/Garden/Plants/Basil ${BASIL}.md`]: '# Basil\n\nSun: Full\n\n<aside>\n🌿\n\nPinch flowers.\n\n</aside>\n',
  [`${W}/Torque specs ${TORQUE}.md`]: `# Torque specs\n\n| Part | Nm |\n| --- | --- |\n| Stem | 5 |\n\nAlso see [Garden](https://www.notion.so/Garden-${GARDEN}).\n`,
  [`${W}/Library ${LIBRARY}.md`]: `# Library\n\n[Library](Library%20${LIBRARY}.csv)`,
  [`__MACOSX/${W}/._Torque specs ${TORQUE}.md`]: 'junk',
  [`${W}/.DS_Store`]: 'junk',
};

async function zipFile(files: Record<string, string | Uint8Array> = FILES): Promise<{ name: string; blob: Blob }> {
  const writer = new ZipWriter(new BlobWriter('application/zip'), { useWebWorkers: false });
  for (const [path, data] of Object.entries(files)) {
    await writer.add(path, typeof data === 'string' ? new TextReader(data) : new Uint8ArrayReader(data));
  }
  return { name: `${W}.zip`, blob: await writer.close() };
}

type Created = Parameters<ImportClient['createNote']>[0] & { storedId: string };

/** A server that keeps a note's id when it is free and recognises one it has seen. */
function fakeClient() {
  const notes: Created[] = [];
  const files: Array<{ noteId: string; filename: string; mime: string; size: number }> = [];
  const notebooks: Array<Parameters<NonNullable<ImportClient['importNotebook']>>[0]> = [];
  const client: ImportClient = {
    createNote: vi.fn(async (input) => {
      const seen = notes.find((n) => n.storedId === input.id);
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
    importNotebook: vi.fn(async (definition) => {
      notebooks.push(definition);
      return { id: `nb-${notebooks.length}`, skipped: [] };
    }),
  };
  return { client, notes, files, notebooks };
}

const byTitle = (notes: Created[], title: string) => notes.find((n) => n.title === title)!;

describe('describeNotion', () => {
  it('lists each top-level bundle with what it holds, and knows a Notion zip from the app\'s own', async () => {
    const zip = await zipFile();
    expect(await detectArchiveKind(zip.blob)).toBe('notion');

    const { units } = await describeNotion(zip);
    const by = Object.fromEntries(units.map((u) => [u.key, u]));
    expect(by[`Board Games ${GAMES}`]).toEqual({
      key: `Board Games ${GAMES}`, name: '🎲 Board Games', kind: 'database', notes: 5, attachments: 2, fields: 5,
    });
    expect(by[`Garden ${GARDEN}`]).toEqual({
      key: `Garden ${GARDEN}`, name: 'Garden', kind: 'page', notes: 3, attachments: 1, fields: 1,
    });
    expect(by['pages']).toEqual({ key: 'pages', name: 'Pages', kind: 'pages', notes: 1, attachments: 0, fields: 0 });
    expect(by[`Library ${LIBRARY}`]).toMatchObject({ kind: 'database', notes: 0, empty: true });
    expect(units).toHaveLength(4);
  });

  it('reads the same export without its wrapping folder', async () => {
    const bare = Object.fromEntries(
      Object.entries(FILES).filter(([p]) => !p.startsWith('__MACOSX')).map(([p, d]) => [p.slice(W.length + 1), d]),
    );
    const { units } = await describeNotion(await zipFile(bare));
    expect(units.map((u) => u.name).sort()).toEqual(['Garden', 'Library', 'Pages', '🎲 Board Games']);
  });
});

describe('importNotion', () => {
  it('imports a database as a notebook: typed fields, rows as notes with their ids, tags, dates and files', async () => {
    const { client, notes, files, notebooks } = fakeClient();
    const progress = await importNotion(await zipFile(), client, { include: [`Board Games ${GAMES}`] });

    expect(progress).toMatchObject({ created: 5, skipped: 0, failed: 0, notesTotal: 5, filesUploaded: 2 });
    expect(notebooks).toEqual([
      {
        name: '🎲 Board Games',
        fields: [
          { name: 'Players', type: 'number' },
          { name: 'Rating', type: 'number', scale: { max: 5, step: 1 } },
          { name: 'Price', type: 'number', currency: 'USD' },
          { name: 'Played On', type: 'date' },
          { name: 'Mechanics', type: 'multiselect', options: ['Trading', 'Dice'] },
        ],
      },
    ]);

    const catan = notes.find((n) => n.id === notionIdToNoteId(CATAN))!;
    expect(catan).toMatchObject({
      notebook: '🎲 Board Games',
      tags: ['Classic', 'Family'],
      fields: { Players: 4, Rating: 4, Price: 39.99, 'Played On': '2026-08-02', Mechanics: ['Trading', 'Dice'] },
      createdAt: new Date(2026, 8, 12, 10, 19).getTime(),
      updatedAt: new Date(2026, 8, 13, 8, 0).getTime(),
      sourceEnex: `${W}.zip`,
    });
    expect(catan.body).toBe(
      [
        'A classic.',
        '',
        '![box.png](files/box.png)',
        '',
        `See [Azul](/notes/${notionIdToNoteId(AZUL)}) and [notes](/notes/${notionIdToNoteId(STRATEGY)}).`,
      ].join('\n'),
    );

    /*
       Two rows share the title "Catan", so Notion named their attachment folder after the
       first with no id. Both files go to that first Catan and nowhere else: box.png, which
       its body links, and rules.pdf, an orphan the export kept but no page references. The
       orphan lands on the note that owns the folder rather than being lost or duplicated
       onto the second Catan.
    */
    expect(files.filter((f) => f.noteId === catan.storedId).map((f) => [f.filename, f.mime])).toEqual([
      ['box.png', 'image/png'],
      ['rules.pdf', 'application/pdf'],
    ]);
    const catan2 = notes.find((n) => n.id === notionIdToNoteId(CATAN2))!;
    expect(catan2).toMatchObject({ fields: expect.objectContaining({ Price: 34.99 }), body: 'The travel edition.' });
    expect(files.filter((f) => f.noteId === catan2.storedId)).toEqual([]);

    // A row the CSV left out still lands, dated by its own stamp; a row's sub-page is a plain note.
    expect(byTitle(notes, 'Untitled')).toMatchObject({
      id: notionIdToNoteId(BLANK),
      createdAt: new Date(2026, 8, 14, 9, 0).getTime(),
      updatedAt: new Date(2026, 8, 14, 9, 0).getTime(),
    });
    expect(byTitle(notes, 'Untitled').fields).toBeUndefined();
    expect(byTitle(notes, 'Strategy notes')).toMatchObject({ notebook: '🎲 Board Games', body: 'Build roads.' });
    expect(byTitle(notes, 'Strategy notes').fields).toBeUndefined();

    // A part of the Tags column too long to be a tag is dropped, not the note.
    expect(byTitle(notes, 'Azul').tags).toEqual(['Family']);

    // Nothing from the other units.
    expect(notes.map((n) => n.title).sort()).toEqual(['Azul', 'Catan', 'Catan', 'Strategy notes', 'Untitled']);
  });

  it('imports a page tree as a notebook, its nested database\'s columns included, and links pages to each other', async () => {
    const { client, notes, files, notebooks } = fakeClient();
    await importNotion(await zipFile(), client, { include: [`Garden ${GARDEN}`] });

    expect(notebooks).toEqual([{ name: 'Garden', fields: [{ name: 'Sun', type: 'select', options: ['Full', 'Part'] }] }]);
    expect(byTitle(notes, 'Garden').body).toBe(`[Beds](/notes/${notionIdToNoteId(BEDS)})\n\nPlants`);
    expect(byTitle(notes, 'Beds').body).toBe('![plan.png](files/plan.png)');
    expect(files.map((f) => f.filename)).toEqual(['plan.png']);
    expect(byTitle(notes, 'Basil')).toMatchObject({
      notebook: 'Garden',
      fields: { Sun: 'Full' },
      body: '> 🌿 Pinch flowers.',
    });
  });

  it('files loose pages in the named notebook, or none, and keeps a link to a page that was not imported', async () => {
    const first = fakeClient();
    await importNotion(await zipFile(), first.client, { include: ['pages'] });
    expect(first.notebooks).toEqual([]);
    expect(byTitle(first.notes, 'Torque specs')).toMatchObject({
      id: notionIdToNoteId(TORQUE),
      notebook: 'Notion',
      body: `| Part | Nm |\n| --- | --- |\n| Stem | 5 |\n\nAlso see [Garden](https://www.notion.so/Garden-${GARDEN}).`,
    });

    const second = fakeClient();
    await importNotion(await zipFile(), second.client, { include: ['pages', `Garden ${GARDEN}`], pagesNotebook: 'Reference' });
    expect(byTitle(second.notes, 'Torque specs')).toMatchObject({
      notebook: 'Reference',
      body: `| Part | Nm |\n| --- | --- |\n| Stem | 5 |\n\nAlso see [Garden](/notes/${notionIdToNoteId(GARDEN)}).`,
    });

    const third = fakeClient();
    await importNotion(await zipFile(), third.client, { include: ['pages'], pagesNotebook: '' });
    expect(byTitle(third.notes, 'Torque specs').notebook).toBeUndefined();
  });

  it('imports everything but an empty database when nothing is chosen, and skips it all the second time', async () => {
    const { client, notes } = fakeClient();
    const zip = await zipFile();
    const first = await importNotion(zip, client);
    expect(first).toMatchObject({ created: 9, failed: 0, notesTotal: 9 });
    expect(notes.some((n) => n.title === 'Library')).toBe(false);

    const again = await importNotion(zip, client);
    expect(again).toMatchObject({ created: 0, skipped: 9, filesUploaded: 0 });
  });

  it('keeps a Tags column as a field when asked', async () => {
    const { client, notes, notebooks } = fakeClient();
    await importNotion(await zipFile(), client, { include: [`Board Games ${GAMES}`], tagsAsTags: false });
    expect(notebooks[0]?.fields.map((f) => f.name)).toContain('Tags (Notion)');
    expect(byTitle(notes, 'Catan')).toMatchObject({ tags: [], fields: expect.objectContaining({ 'Tags (Notion)': ['Classic', 'Family'] }) });
  });
});
