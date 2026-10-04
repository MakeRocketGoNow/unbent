import { describe, expect, it } from 'vitest';
import { REVISION_MAX_AGE_MS, REVISIONS_KEPT, type RestoredNote } from '@unbent/shared';
import { runInDurableObject } from 'cloudflare:test';
import { feedRows, feedSeq, freshStore } from './helpers.js';

/**
 * Note history (schemas 0003 and 0004; MAK-119, MAK-170): which writes leave a copy of
 * what they replaced, what a copy holds, how long copies last, and that putting one back
 * can itself be undone.
 *
 * Time is moved by re-dating rows rather than by faking the clock: the rules are all
 * "how old is the newest copy", and a copy's age is a column.
 */

type Stub = ReturnType<typeof freshStore>['stub'];

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

async function seeded(label: string, body = 'the first draft') {
  const { stub } = freshStore(label);
  const note = await stub.create({ id: crypto.randomUUID(), title: 'Packing list', body, tags: ['travel'] });
  return { stub, id: note.id };
}

/** Makes every copy of the note `ms` older, as though that long had passed. */
function age(stub: Stub, id: string, ms: number) {
  return runInDurableObject(stub, (_i, state) => {
    state.storage.sql.exec(`UPDATE note_revisions SET created_at = created_at - ?1, through = through - ?1 WHERE note_id = ?2`, ms, id);
  });
}

function countRevisions(stub: Stub) {
  return runInDurableObject(stub, (_i, state) => state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM note_revisions`).one().n);
}

describe('history: typing', () => {
  it('keeps what the first save of a sitting replaced, and nothing for the saves after it', async () => {
    const { stub, id } = await seeded('typing');
    await stub.update(id, { body: 'the first draft, and' });
    await stub.update(id, { body: 'the first draft, and more' });
    await stub.update(id, { title: 'Packing list for June', body: 'the first draft, and more still' });

    const revisions = (await stub.listRevisions(id))!;
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ title: 'Packing list', size: 'the first draft'.length });
    expect(revisions[0]!.cause).toBeUndefined();
    expect(await stub.getRevision(id, revisions[0]!.id)).toMatchObject({ title: 'Packing list', body: 'the first draft' });
  });

  it('keeps another once the newest is older than the window', async () => {
    const { stub, id } = await seeded('window');
    await stub.update(id, { body: 'monday' });
    await age(stub, id, 29 * MINUTE);
    await stub.update(id, { body: 'still monday' });
    expect(await stub.listRevisions(id)).toHaveLength(1);

    await age(stub, id, 2 * MINUTE);
    await stub.update(id, { body: 'tuesday' });
    const revisions = (await stub.listRevisions(id))!;
    expect(revisions).toHaveLength(2);
    // Newest first: what the second sitting replaced, then what the first did.
    expect((await stub.getRevision(id, revisions[0]!.id))!.body).toBe('still monday');
    expect((await stub.getRevision(id, revisions[1]!.id))!.body).toBe('the first draft');
  });

  it('keeps nothing for a write that changes nothing, or that only adds a file\'s link', async () => {
    const { stub, id } = await seeded('no-op');
    await stub.update(id, { body: 'the first draft' }); // what is stored: a no-op
    await stub.update(id, { tags: ['travel'] });
    await stub.appendToBody(id, '![](files/photo.jpg)');
    await stub.updateMany([id], { addTags: ['travel'] });
    expect(await stub.listRevisions(id)).toEqual([]);
  });

  it('keeps nothing for the first save of a note made empty, as the app makes them', async () => {
    const { stub } = freshStore('new-note');
    const { id } = await stub.create({ id: crypto.randomUUID(), title: '', body: '', tags: [] });
    await stub.update(id, { title: 'Groceries', body: 'eggs' });
    await stub.update(id, { body: 'eggs, milk', by: 'assistant' });
    // The assistant's copy is of the text the person typed; the empty start is never one.
    const revisions = (await stub.listRevisions(id))!;
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ title: 'Groceries', cause: 'assistant' });
  });

  it('keeps nothing for a save refused as stale', async () => {
    const { stub, id } = await seeded('stale');
    const refused = await stub.update(id, { body: 'written against an old copy', ifUpdatedAt: 1 });
    expect(refused).toHaveProperty('stale');
    expect(await stub.listRevisions(id)).toEqual([]);
  });
});

/** A notebook with a field of each kind the restore rules turn on, and a note filed in it. */
async function filed(label: string) {
  const { stub } = freshStore(label);
  const nb = (await stub.createNotebook('Watch list'))!;
  const status = (await stub.createField(nb.id, { name: 'Status', type: 'select', options: ['Queued', 'Watching', 'Done'] })) as { id: string };
  const year = (await stub.createField(nb.id, { name: 'Year', type: 'number', options: [] })) as { id: string };
  const note = await stub.create({
    id: crypto.randomUUID(),
    title: 'A film',
    body: '',
    tags: ['drama'],
    notebook: 'Watch list',
    fields: { [status.id]: 'Queued', [year.id]: 1999 },
  });
  return { stub, id: note.id, nb, status, year };
}

/** A tag's id by its name, whether or not a live note still carries it. */
function tagId(stub: Stub, name: string) {
  return runInDurableObject(stub, (_i, state) => state.storage.sql.exec<{ id: string }>(`SELECT id FROM tags WHERE name = ?1`, name).one().id);
}

const valuesOf = (note: { fields?: Array<{ name: string; value: unknown }> }) =>
  Object.fromEntries((note.fields ?? []).map((v) => [v.name, v.value]));

describe('history: fields, tags and the notebook', () => {
  it('keeps a version for a save that changes only a field, holding the note as it stood', async () => {
    const { stub, id, nb, status } = await filed('fields-only');
    await stub.update(id, { fields: { [status.id]: 'Watching' } });

    const revisions = (await stub.listRevisions(id))!;
    expect(revisions).toHaveLength(1);
    // No text in this note at all: the row has to say what the copy was kept for.
    expect(revisions[0]).toMatchObject({ title: 'A film', size: 0, changed: ['fields'] });
    const copy = (await stub.getRevision(id, revisions[0]!.id))!;
    expect(copy.props).toMatchObject({
      notebook: { id: nb.id, name: 'Watch list' },
      tags: [{ name: 'drama' }],
    });
    expect(valuesOf(copy.props!)).toEqual({ Status: 'Queued', Year: 1999 });
    expect(copy).not.toHaveProperty('unfit');
  });

  it('keeps one version for a run of field, tag and notebook edits, and says each part that changed', async () => {
    const { stub, id, status, year } = await filed('run');
    await stub.update(id, { fields: { [status.id]: 'Watching' } });
    await stub.update(id, { fields: { [year.id]: 2001 } });
    await stub.update(id, { tags: ['drama', 'rewatch'] });
    await stub.update(id, { body: 'Better than I remembered.' });

    const revisions = (await stub.listRevisions(id))!;
    expect(revisions).toHaveLength(1);
    // In the order a row says them, not the order they happened in.
    expect(revisions[0]!.changed).toEqual(['text', 'fields', 'tags']);

    await age(stub, id, 31 * MINUTE);
    await stub.update(id, { notebook: null });
    const later = (await stub.listRevisions(id))!;
    expect(later).toHaveLength(2);
    expect(later[0]).toMatchObject({ changed: ['notebook'] });
    expect(valuesOf((await stub.getRevision(id, later[0]!.id))!.props!)).toEqual({ Status: 'Watching', Year: 2001 });
  });

  it('keeps nothing for the first fields of a note that held nothing, filed or not', async () => {
    const { stub } = freshStore('empty-filed');
    const nb = (await stub.createNotebook('Log'))!;
    const kind = (await stub.createField(nb.id, { name: 'Kind', type: 'text', options: [] })) as { id: string };
    const { id } = await stub.create({ id: crypto.randomUUID(), title: '', body: '', tags: [], notebook: 'Log' });
    await stub.update(id, { fields: { [kind.id]: 'Walk' } });
    expect(await stub.listRevisions(id)).toEqual([]);
  });

  it('keeps a version of each note a bulk change writes, and none of a note it leaves alone', async () => {
    const { stub, id, status } = await filed('bulk');
    const other = await stub.create({ id: crypto.randomUUID(), title: 'Another', body: 'x', tags: ['drama'], notebook: 'Watch list' });
    const untouched = await stub.create({ id: crypto.randomUUID(), title: 'Seen', body: 'x', tags: [], notebook: 'Watch list', fields: { [status.id]: 'Done' } });

    await stub.updateMany([id, other.id, untouched.id], { fields: { [status.id]: 'Done' } });
    expect((await stub.listRevisions(id))!).toEqual([expect.objectContaining({ changed: ['fields'] })]);
    expect(await stub.listRevisions(other.id)).toHaveLength(1);
    expect(await stub.listRevisions(untouched.id)).toEqual([]);

    // The person's own selection is a sitting like any other: nothing more inside the window.
    await stub.updateMany([id], { addTags: ['seen'] });
    expect((await stub.listRevisions(id))!).toEqual([expect.objectContaining({ changed: ['fields', 'tags'] })]);
    // An assistant's batch is not: what it replaces is kept, as its text edits are.
    await stub.updateMany([id], { notebook: null, by: 'assistant' });
    const revisions = (await stub.listRevisions(id))!;
    expect(revisions).toHaveLength(2);
    expect(revisions[0]).toMatchObject({ cause: 'assistant', changed: ['notebook'] });
    expect((await stub.getRevision(id, revisions[0]!.id))!.props).toMatchObject({ notebook: { name: 'Watch list' }, tags: [{ name: 'drama' }, { name: 'seen' }] });
  });
});

describe('history: putting fields, tags and the notebook back', () => {
  it('restores them with the text, and its undo puts the later ones back', async () => {
    const { stub, id, status, year } = await filed('restore-props');
    await stub.update(id, { fields: { [status.id]: 'Done', [year.id]: null }, tags: ['seen'], notebook: null, by: 'assistant' });
    const [copy] = (await stub.listRevisions(id))!;
    const before = await feedSeq(stub);

    const restored = (await stub.restoreRevision(id, copy!.id)) as RestoredNote;
    expect(restored.note).toMatchObject({ notebook: 'Watch list', tags: ['drama'] });
    expect(valuesOf(restored.note)).toEqual({ Status: 'Queued', Year: 1999 });
    expect(restored).not.toHaveProperty('skipped');
    expect(await feedRows(stub, before)).toEqual([{ entity: 'note', id }]);

    const [kept] = (await stub.listRevisions(id))!;
    expect(kept).toMatchObject({ id: restored.kept, cause: 'restore', changed: ['fields', 'tags', 'notebook'] });
    const undone = (await stub.restoreRevision(id, restored.kept!, restored.note.updatedAt)) as RestoredNote;
    expect(undone.note).toMatchObject({ notebook: null, tags: ['seen'] });
    expect(valuesOf(undone.note)).toEqual({ Status: 'Done' });
  });

  it('changes nothing when the copy is the note already, fields and all', async () => {
    const { stub, id, status } = await filed('same-props');
    await stub.update(id, { fields: { [status.id]: 'Watching' } });
    const [copy] = (await stub.listRevisions(id))!;
    await stub.update(id, { fields: { [status.id]: 'Queued' } });
    const now = (await stub.get(id))!;
    expect(await stub.restoreRevision(id, copy!.id)).toEqual({ note: now, kept: null });
  });

  it('goes by id: a renamed notebook, tag and field are still the ones the copy means', async () => {
    const { stub, id, nb, status } = await filed('renamed');
    await stub.update(id, { fields: { [status.id]: 'Done' }, tags: [], notebook: null, by: 'assistant' });
    const [copy] = (await stub.listRevisions(id))!;
    await stub.updateNotebook(nb.id, { name: 'Films' });
    await stub.renameTag(await tagId(stub, 'drama'), 'Drama');
    await stub.updateField(nb.id, status.id, { name: 'State' });

    expect((await stub.getRevision(id, copy!.id))!).not.toHaveProperty('unfit');
    const restored = (await stub.restoreRevision(id, copy!.id)) as RestoredNote;
    expect(restored.note).toMatchObject({ notebook: 'Films', tags: ['Drama'] });
    expect(valuesOf(restored.note)).toEqual({ State: 'Queued', Year: 1999 });
    expect(await stub.listNotebooks()).toHaveLength(1);
  });

  it('skips what no longer fits, says so before and after, and restores the rest', async () => {
    const { stub, id, nb, status, year } = await filed('unfit');
    await stub.update(id, { title: 'A film, seen', fields: { [status.id]: 'Done', [year.id]: 2001 }, tags: ['seen'], by: 'assistant' });
    const [copy] = (await stub.listRevisions(id))!;
    // Since then: the choice the copy holds is gone, the other field is deleted, and so is its tag.
    await stub.updateField(nb.id, status.id, { options: ['Watching', 'Done'] });
    await stub.deleteField(nb.id, year.id);
    await stub.deleteTag(await tagId(stub, 'drama'));

    const skipped = [
      { what: 'tag', id: expect.any(String), name: 'drama', why: 'deleted' },
      { what: 'field', id: status.id, name: 'Status', why: 'option' },
      { what: 'field', id: year.id, name: 'Year', why: 'deleted' },
    ];
    expect((await stub.getRevision(id, copy!.id))!.unfit).toEqual(skipped);
    const restored = (await stub.restoreRevision(id, copy!.id)) as RestoredNote;
    expect(restored.skipped).toEqual(skipped);
    // The title came back; the tag the copy lacked came off; the values that could not
    // be put back are as the note had them, not cleared.
    expect(restored.note).toMatchObject({ title: 'A film', tags: [] });
    expect(valuesOf(restored.note)).toMatchObject({ Status: 'Done' });
    // Not made again under its old name.
    expect(await runInDurableObject(stub, (_i, state) => state.storage.sql.exec(`SELECT id FROM tags WHERE name = 'drama'`).toArray())).toEqual([]);
  });

  it('leaves the note where it is, with that notebook\'s values, when the copy\'s notebook is gone', async () => {
    const { stub, id, nb } = await filed('notebook-gone');
    const shelf = (await stub.createNotebook('Shelf'))!;
    const place = (await stub.createField(shelf.id, { name: 'Place', type: 'text', options: [] })) as { id: string };
    await stub.update(id, { notebook: 'Shelf', by: 'assistant' });
    await stub.update(id, { body: 'On the top shelf.', fields: { [place.id]: 'Hall' } });
    const copy = (await stub.listRevisions(id))!.at(-1)!;
    await stub.deleteNotebook(nb.id);

    const restored = (await stub.restoreRevision(id, copy.id)) as RestoredNote;
    expect(restored.skipped).toContainEqual({ what: 'notebook', id: nb.id, name: 'Watch list', why: 'deleted' });
    expect(restored.note).toMatchObject({ notebook: 'Shelf', body: '' });
    // Not made again under its old name, and Shelf's own value is not emptied.
    expect((await stub.listNotebooks()).map((n) => n.name)).toEqual(['Shelf']);
    expect(valuesOf(restored.note)).toMatchObject({ Place: 'Hall' });
  });

  it('never clears a value held under a deleted field, which no undo could bring back', async () => {
    const { stub, id, nb } = await filed('tombstone');
    const rating = (await stub.createField(nb.id, { name: 'Rating', type: 'number', options: [] })) as { id: string };
    await stub.update(id, { title: 'A film, renamed', by: 'assistant' });
    const [copy] = (await stub.listRevisions(id))!;
    // Gained after the copy; then its notebook goes, and the value lives on under a tombstone.
    await stub.update(id, { fields: { [rating.id]: 4 } });
    await stub.deleteNotebook(nb.id);
    expect(valuesOf((await stub.get(id))!)).toMatchObject({ Rating: 4 });

    const stays = { what: 'field', id: rating.id, name: 'Rating', why: 'deleted' };
    expect((await stub.getRevision(id, copy!.id))!.unfit).toContainEqual(stays);
    const restored = (await stub.restoreRevision(id, copy!.id)) as RestoredNote;
    expect(restored.note.title).toBe('A film');
    expect(restored.skipped).toContainEqual(stays);
    expect(valuesOf(restored.note)).toMatchObject({ Rating: 4 });
  });

  it('clears a value the note has gained since, when the note goes back to the copy\'s notebook', async () => {
    const { stub, id } = await filed('gained');
    const shelf = (await stub.createNotebook('Shelf'))!;
    const place = (await stub.createField(shelf.id, { name: 'Place', type: 'text', options: [] })) as { id: string };
    await stub.update(id, { notebook: 'Shelf', fields: { [place.id]: 'Hall' }, by: 'assistant' });
    const [copy] = (await stub.listRevisions(id))!;

    const restored = (await stub.restoreRevision(id, copy!.id)) as RestoredNote;
    expect(restored.note.notebook).toBe('Watch list');
    expect(valuesOf(restored.note)).toEqual({ Status: 'Queued', Year: 1999 });
  });
});

describe('history: an assistant', () => {
  it('keeps what its write replaced even inside the window', async () => {
    const { stub, id } = await seeded('assistant');
    // A sitting: one copy, of the text before it.
    await stub.update(id, { body: 'typed a minute ago' });
    await stub.update(id, { body: 'typed just now, and long' });
    // And then an edit over MCP that guts it.
    await stub.update(id, { body: '', by: 'assistant' });

    const revisions = (await stub.listRevisions(id))!;
    expect(revisions).toHaveLength(2);
    expect(revisions[0]).toMatchObject({ cause: 'assistant', size: 'typed just now, and long'.length });
    expect((await stub.getRevision(id, revisions[0]!.id))!.body).toBe('typed just now, and long');
  });

  it('keeps one copy for a run of its edits: the text before the run', async () => {
    const { stub, id } = await seeded('run');
    for (const body of ['one', 'two', 'three', 'four']) await stub.update(id, { body, by: 'assistant' });
    const revisions = (await stub.listRevisions(id))!;
    expect(revisions).toHaveLength(1);
    expect((await stub.getRevision(id, revisions[0]!.id))!.body).toBe('the first draft');
  });

  it('keeps another when someone has typed between two of its edits', async () => {
    const { stub, id } = await seeded('between');
    await stub.update(id, { body: 'tidied', by: 'assistant' });
    await stub.update(id, { body: 'tidied, then added to by hand' });
    await stub.update(id, { body: 'gutted', by: 'assistant' });
    const revisions = (await stub.listRevisions(id))!;
    expect(revisions).toHaveLength(2);
    expect((await stub.getRevision(id, revisions[0]!.id))!.body).toBe('tidied, then added to by hand');
  });

  it('keeps another when its run outlasts the window', async () => {
    const { stub, id } = await seeded('long-run');
    await stub.update(id, { body: 'one', by: 'assistant' });
    await age(stub, id, 31 * MINUTE);
    await runInDurableObject(stub, (_i, state) => {
      // The note rests as long as its copy has: `through` still names its date.
      state.storage.sql.exec(`UPDATE notes SET updated_at = updated_at - ?1 WHERE id = ?2`, 31 * MINUTE, id);
    });
    await stub.update(id, { body: 'two', by: 'assistant' });
    expect(await stub.listRevisions(id)).toHaveLength(2);
  });
});

describe('history: retention', () => {
  it('keeps the newest copies of a note, up to the cap', async () => {
    const { stub, id } = await seeded('cap');
    for (let i = 1; i <= REVISIONS_KEPT + 3; i++) {
      await stub.update(id, { body: `version ${i}` });
      await age(stub, id, 31 * MINUTE);
    }
    const revisions = (await stub.listRevisions(id))!;
    expect(revisions).toHaveLength(REVISIONS_KEPT);
    expect(await countRevisions(stub)).toBe(REVISIONS_KEPT);
    // The oldest three went: the first draft, version 1 and version 2.
    expect((await stub.getRevision(id, revisions.at(-1)!.id))!.body).toBe('version 3');
    expect((await stub.getRevision(id, revisions[0]!.id))!.body).toBe(`version ${REVISIONS_KEPT + 2}`);
  });

  it('shows nothing older than the age limit, and removes it at the next copy kept', async () => {
    const { stub, id } = await seeded('age');
    await stub.update(id, { body: 'spring' });
    const [old] = (await stub.listRevisions(id))!;
    await age(stub, id, REVISION_MAX_AGE_MS + DAY);
    // Still on disk, since nothing has written to the note, but not shown or served.
    expect(await countRevisions(stub)).toBe(1);
    expect(await stub.listRevisions(id)).toEqual([]);
    expect(await stub.getRevision(id, old!.id)).toBeNull();
    expect(await stub.restoreRevision(id, old!.id)).toBeNull();

    await stub.update(id, { body: 'summer' });
    expect(await countRevisions(stub)).toBe(1);
    expect((await stub.listRevisions(id))!).toHaveLength(1);
  });

  it('prunes one note without touching another', async () => {
    const { stub, id } = await seeded('neighbours');
    const other = await stub.create({ id: crypto.randomUUID(), title: 'Other', body: 'kept', tags: [] });
    await stub.update(other.id, { body: 'kept, changed' });
    for (let i = 1; i <= REVISIONS_KEPT + 2; i++) {
      await stub.update(id, { body: `version ${i}` });
      await age(stub, id, 31 * MINUTE);
    }
    expect(await stub.listRevisions(other.id)).toHaveLength(1);
  });

  it('goes with the note when the note is purged, and stays while it is in the trash', async () => {
    const { stub, id } = await seeded('purge');
    await stub.update(id, { body: 'changed' });
    await stub.remove(id);
    expect(await countRevisions(stub)).toBe(1);
    // A trashed note has no history to show until it is restored.
    expect(await stub.listRevisions(id)).toBeNull();
    await stub.restore(id);
    expect(await stub.listRevisions(id)).toHaveLength(1);

    await stub.remove(id);
    await stub.purgeOne(id);
    expect(await countRevisions(stub)).toBe(0);
  });

  it('travels in the operator dump, so a store rebuilt from one can still undo an edit', async () => {
    const { stub, id } = await seeded('dump', 'before');
    await stub.update(id, { body: 'after' });
    const page = await stub.dumpPage('note_revisions');
    expect(page.rows).toBe(1);
    expect(new TextDecoder().decode(page.bytes)).toContain(`INSERT INTO note_revisions`);
  });

  it('goes with everything else when the account is wiped', async () => {
    const { stub, id } = await seeded('wipe');
    await stub.update(id, { body: 'changed' });
    await stub.wipe();
    // The schema is rebuilt on the next call, empty.
    expect(await stub.listRevisions(id)).toBeNull();
    expect(await countRevisions(stub)).toBe(0);
  });
});

describe('history: clearing it', () => {
  it('deletes every copy of the note, shown or not, and leaves the note and its neighbours alone', async () => {
    const { stub, id } = await seeded('clear', 'the account number is 12345');
    const other = await stub.create({ id: crypto.randomUUID(), title: 'Other', body: 'kept', tags: [] });
    await stub.update(other.id, { body: 'kept, changed' });
    await stub.update(id, { body: 'the account number is in the safe' });
    // A copy past the age limit: hidden from the list, still on disk until now.
    await age(stub, id, REVISION_MAX_AGE_MS + DAY);
    await stub.update(id, { body: 'the account number is in the safe.' , by: 'assistant' });
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec(
        `INSERT INTO note_revisions (note_id, title, body, size, created_at, through) VALUES (?1, 'old', 'the account number is 12345', 27, 1, 1)`,
        id,
      );
    });
    expect(await stub.listRevisions(id)).toHaveLength(1);
    expect(await countRevisions(stub)).toBe(3);
    const note = await stub.get(id);
    const before = await feedSeq(stub);

    expect(await stub.clearRevisions(id)).toBe(2);
    expect(await stub.listRevisions(id)).toEqual([]);
    expect(await stub.get(id)).toEqual(note);
    expect(await feedSeq(stub)).toBe(before);
    expect(await stub.listRevisions(other.id)).toHaveLength(1);
    // And the next change of text starts a new history rather than being suppressed.
    await stub.update(id, { body: 'changed again' });
    expect(await stub.listRevisions(id)).toHaveLength(1);
  });

  it('answers null for a note that is not live, and clears nothing', async () => {
    const { stub, id } = await seeded('clear-trashed');
    await stub.update(id, { body: 'changed' });
    await stub.remove(id);
    expect(await stub.clearRevisions(id)).toBeNull();
    expect(await stub.clearRevisions('no-such-note')).toBeNull();
    expect(await countRevisions(stub)).toBe(1);
  });
});

describe('history: putting a copy back', () => {
  it('restores the title and body, keeps what it replaced, and records the note in the feed', async () => {
    const { stub, id } = await seeded('restore', 'a long and careful note');
    await stub.update(id, { title: 'Gutted', body: '', by: 'assistant' });
    const [copy] = (await stub.listRevisions(id))!;
    const before = await feedSeq(stub);
    const gutted = (await stub.get(id))!;

    const { note: restored, kept } = (await stub.restoreRevision(id, copy!.id)) as RestoredNote;
    expect(restored).toMatchObject({ title: 'Packing list', body: 'a long and careful note', tags: ['travel'] });
    expect(restored.updatedAt).toBeGreaterThan(gutted.updatedAt);
    expect(await feedRows(stub, before)).toEqual([{ entity: 'note', id }]);

    // The restore is undone the way it was done: the gutted text is the newest copy,
    // although the copy before it is seconds old.
    const revisions = (await stub.listRevisions(id))!;
    expect(revisions).toHaveLength(2);
    expect(revisions[0]).toMatchObject({ title: 'Gutted', size: 0, cause: 'restore' });
    // And the answer named it: the copy an Undo puts back.
    expect(kept).toBe(revisions[0]!.id);
    const undone = (await stub.restoreRevision(id, kept!)) as RestoredNote;
    expect(undone.note).toMatchObject({ title: 'Gutted', body: '' });
    expect(await stub.listRevisions(id)).toHaveLength(3);
  });

  it('refuses, and keeps nothing, when the note has been saved since the date the caller names', async () => {
    const { stub, id } = await seeded('precondition', 'whole');
    await stub.update(id, { body: '', by: 'assistant' });
    const [copy] = (await stub.listRevisions(id))!;
    const { note: restored } = (await stub.restoreRevision(id, copy!.id)) as RestoredNote;
    // Typed after the restore: inside the window, so no copy of its own.
    await stub.update(id, { body: 'whole, and a line typed since' });
    const [kept] = (await stub.listRevisions(id))!;
    expect(kept).toMatchObject({ cause: 'restore', createdAt: restored.updatedAt });

    // The Undo of that restore, which names the date the restore left.
    const refused = await stub.restoreRevision(id, kept!.id, restored.updatedAt);
    expect(refused).toMatchObject({ stale: { body: 'whole, and a line typed since' } });
    expect((await stub.get(id))!.body).toBe('whole, and a line typed since');
    expect(await stub.listRevisions(id)).toHaveLength(2);
  });

  it('goes ahead when the note still carries that date', async () => {
    const { stub, id } = await seeded('precondition-ok', 'whole');
    await stub.update(id, { body: '', by: 'assistant' });
    const [copy] = (await stub.listRevisions(id))!;
    const { note: restored } = (await stub.restoreRevision(id, copy!.id)) as RestoredNote;
    const [kept] = (await stub.listRevisions(id))!;
    expect(await stub.restoreRevision(id, kept!.id, restored.updatedAt)).toMatchObject({ note: { body: '' } });
  });

  it('changes nothing when the copy is what the note already says', async () => {
    const { stub, id } = await seeded('same');
    await stub.update(id, { body: 'changed' });
    const [copy] = (await stub.listRevisions(id))!;
    await stub.update(id, { body: 'the first draft' });
    const now = (await stub.get(id))!;
    const before = await feedSeq(stub);

    // Nothing written, nothing kept, and the answer says so.
    expect(await stub.restoreRevision(id, copy!.id)).toEqual({ note: now, kept: null });
    expect(await feedSeq(stub)).toBe(before);
    expect(await stub.listRevisions(id)).toHaveLength(1);
  });

  it('refuses a copy that belongs to another note, and a note in the trash', async () => {
    const { stub, id } = await seeded('foreign');
    await stub.update(id, { body: 'changed' });
    const [copy] = (await stub.listRevisions(id))!;
    const other = await stub.create({ id: crypto.randomUUID(), title: 'Other', body: 'untouched', tags: [] });

    expect(await stub.getRevision(other.id, copy!.id)).toBeNull();
    expect(await stub.restoreRevision(other.id, copy!.id)).toBeNull();
    expect((await stub.get(other.id))!.body).toBe('untouched');

    await stub.remove(id);
    expect(await stub.getRevision(id, copy!.id)).toBeNull();
    expect(await stub.restoreRevision(id, copy!.id)).toBeNull();
  });
});
