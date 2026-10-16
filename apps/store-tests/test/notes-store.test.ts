import { describe, expect, it } from 'vitest';
import { runInDurableObject } from 'cloudflare:test';
import { REVISIONS_KEPT, UNFILED, encodeCursor } from '@unbent/shared';
import { beginDump } from '@unbent/api/lib/dump';
import { DUMP_TABLES } from '@unbent/api/store/tables';
import { feedRows, feedSeq, freshStore } from './helpers.js';

/**
 * `NotesStore` through the object's RPC surface, against the real schema.
 *
 * Two things these exist to catch that no fake would. A bind-count mismatch: every `?N`
 * in the port was renumbered when `user_id` left, and the runtime throws on any statement
 * whose placeholders and values disagree, so calling each method once is the cheapest
 * net. And the schema's behaviour under the queries — the count triggers, the FTS
 * triggers, the cascades — which the port relies on and a fake cannot perform.
 *
 * Every test takes a fresh object; see helpers.ts.
 */

const note = (over: Partial<Parameters<ReturnType<typeof freshStore>['stub']['create']>[0]> = {}) => ({
  id: crypto.randomUUID(),
  title: 'Alpha invoice',
  body: 'running quickly through the woods',
  tags: [] as string[],
  ...over,
});

describe('notes: create, read, update', () => {
  it('creates a note with tags, a notebook and a field value, and reads it back', async () => {
    const { stub } = freshStore('crud');
    const nb = await stub.createNotebook('Receipts');
    expect(nb).toMatchObject({ name: 'Receipts' });
    const amount = await stub.createField(nb!.id, { name: 'Amount', type: 'number', options: [] });
    expect(amount).toMatchObject({ name: 'Amount', type: 'number', position: 0 });
    const amountId = (amount as { id: string }).id;

    const created = await stub.create(note({ tags: ['home', 'acme'], notebook: 'Receipts', fields: { [amountId]: 12 } }));
    expect(created.tags).toEqual(['acme', 'home']);
    expect(created.notebook).toBe('Receipts');
    expect(created.fields).toEqual([expect.objectContaining({ fieldId: amountId, name: 'Amount', value: 12 })]);

    const read = await stub.get(created.id);
    expect(read).toEqual(created);

    // The triggers kept every count: the account's, the notebook's, the tags'.
    expect(await stub.count()).toBe(1);
    expect(await stub.count({ notebook: 'receipts' })).toBe(1);
    expect(await stub.count({ tags: ['home'] })).toBe(1);
    expect(await stub.countUnfiledNotes()).toBe(0);
    expect(await stub.listTags()).toEqual([
      { id: expect.any(String), name: 'acme', count: 1 },
      { id: expect.any(String), name: 'home', count: 1 },
    ]);
    expect(await stub.listNotebooks()).toEqual([
      { id: nb!.id, name: 'Receipts', purpose: null, emoji: null, count: 1, fields: 1 },
    ]);
  });

  it('reads a trashed note only when asked, marked with when it was trashed', async () => {
    const { stub } = freshStore('trashed-read');
    const created = await stub.create(note({ tags: ['kept'] }));
    await stub.remove(created.id);
    expect(await stub.get(created.id)).toBeNull();
    expect(await stub.get(created.id, { includeTrashed: true })).toMatchObject({
      id: created.id,
      tags: ['kept'],
      deletedAt: expect.any(Number),
    });
    // Reading it is all the flag allows: a write still finds nothing there.
    expect(await stub.update(created.id, { title: 'Edited in the bin' })).toBeNull();
    await stub.restore(created.id);
    expect(await stub.get(created.id, { includeTrashed: true })).not.toHaveProperty('deletedAt');
    expect(await stub.get('ghost', { includeTrashed: true })).toBeNull();
  });

  it('drops keys that match what is stored, so a no-op patch keeps the date', async () => {
    const { stub } = freshStore('noop');
    const created = await stub.create(note({ tags: ['b', 'a'] }));
    const same = await stub.update(created.id, { title: created.title, tags: ['a', 'b', ' b '] });
    expect(same).toMatchObject({ updatedAt: created.updatedAt });

    await new Promise((r) => setTimeout(r, 2));
    const changed = await stub.update(created.id, { title: 'Beta', notebook: 'Taxes', tags: ['c'] });
    expect(changed).toMatchObject({ title: 'Beta', notebook: 'Taxes', tags: ['c'] });
    expect((changed as { updatedAt: number }).updatedAt).toBeGreaterThan(created.updatedAt);
    // The old tags lost their live note; the new notebook was created on the way.
    expect(await stub.listTags()).toEqual([{ id: expect.any(String), name: 'c', count: 1 }]);
    expect((await stub.listNotebooks()).map((n) => [n.name, n.count])).toEqual([['Taxes', 1]]);
    expect(await stub.update('nope', { title: 'x' })).toBeNull();
  });

  it('refuses a patch made against an older copy, and hands back the note as it stands', async () => {
    const { stub } = freshStore('stale');
    const created = await stub.create(note({ body: 'first draft' }));
    await new Promise((r) => setTimeout(r, 2));

    // Another device saves; this one still holds `created`.
    const elsewhere = await stub.update(created.id, { body: 'edited on the phone', ifUpdatedAt: created.updatedAt });
    expect(elsewhere).toMatchObject({ body: 'edited on the phone' });
    const saved = elsewhere as { updatedAt: number };
    expect(saved.updatedAt).toBeGreaterThan(created.updatedAt);

    const refused = await stub.update(created.id, { body: 'typed on the desktop', ifUpdatedAt: created.updatedAt });
    expect(refused).toEqual({ stale: expect.objectContaining({ body: 'edited on the phone', updatedAt: saved.updatedAt }) });
    expect((await stub.get(created.id))?.body).toBe('edited on the phone');

    // Refused even when it would change nothing: an answer of "saved" would tell the
    // writer its copy is current, and the rest of that copy is not.
    const same = await stub.update(created.id, { body: 'edited on the phone', ifUpdatedAt: created.updatedAt });
    expect(same).toEqual({ stale: expect.objectContaining({ updatedAt: saved.updatedAt }) });

    // Against the copy as it now stands, the same edit goes through; without the
    // precondition it always does.
    expect(await stub.update(created.id, { body: 'typed on the desktop', ifUpdatedAt: saved.updatedAt })).toMatchObject({
      body: 'typed on the desktop',
    });
    expect(await stub.update(created.id, { body: 'whatever is there' })).toMatchObject({ body: 'whatever is there' });
    expect(await stub.update('nope', { title: 'x', ifUpdatedAt: 1 })).toBeNull();
  });

  it('moves the date forward on every write, however close together they land', async () => {
    // Back to back, with no pause: the clock may read the same millisecond for all of
    // them, and a write that kept the last one's date would pass a precondition made
    // against the copy before it.
    const { stub } = freshStore('stamp');
    const created = await stub.create(note({ body: 'one' }));
    const dates = [created.updatedAt];
    for (const body of ['two', 'three', 'four']) {
      dates.push(((await stub.update(created.id, { body })) as { updatedAt: number }).updatedAt);
    }
    await stub.appendToBody(created.id, 'five');
    dates.push((await stub.get(created.id))!.updatedAt);
    await stub.updateMany([created.id], { addTags: ['six'] });
    dates.push((await stub.get(created.id))!.updatedAt);

    for (let i = 1; i < dates.length; i++) expect(dates[i]).toBeGreaterThan(dates[i - 1]!);
  });

  it('refuses a value its field cannot hold, before writing anything, with the field named', async () => {
    const { stub } = freshStore('invalid');
    const nb = (await stub.createNotebook('Coupons'))!;
    const expires = (await stub.createField(nb.id, { name: 'Expires', type: 'date', options: [] })) as { id: string };
    const created = await stub.create(note({ notebook: 'Coupons' }));

    let caught: (Error & { fieldName?: string }) | null = null;
    try {
      await stub.update(created.id, { title: 'Changed', fields: { [expires.id]: 'not a date' } });
    } catch (e) {
      caught = e as Error;
    }
    // The class does not survive RPC but the name and the own property do, which is what
    // the facade rebuilds a real `InvalidFieldValue` from.
    expect(caught?.name).toBe('InvalidFieldValue');
    expect(caught?.fieldName).toBe('Expires');
    expect((await stub.get(created.id))?.title).toBe('Alpha invoice');
    await expect(stub.update(created.id, { fields: { 'no-such-field': 1 } })).rejects.toMatchObject({
      name: 'InvalidFieldValue',
      fieldName: 'no-such-field',
    });
  });

  it('duplicates a note with its filing and values, appends to and replaces a body', async () => {
    const { stub } = freshStore('dup');
    const nb = (await stub.createNotebook('Recipes'))!;
    const serves = (await stub.createField(nb.id, { name: 'Serves', type: 'number', options: [] })) as { id: string };
    const src = await stub.create(note({ tags: ['dinner'], notebook: 'Recipes', fields: { [serves.id]: 4 } }));
    const copy = await stub.duplicate(src.id, crypto.randomUUID());
    expect(copy).toMatchObject({ title: src.title, body: src.body, tags: ['dinner'], notebook: 'Recipes' });
    expect(copy!.id).not.toBe(src.id);
    expect(copy!.fields?.[0]).toMatchObject({ fieldId: serves.id, value: 4 });
    expect(await stub.count({ tags: ['dinner'] })).toBe(2);
    expect(await stub.duplicate('missing', crypto.randomUUID())).toBeNull();

    expect(await stub.appendToBody(src.id, '![scan](files/scan.pdf)')).toBe(true);
    expect((await stub.get(src.id))?.body).toBe(`${src.body}\n\n![scan](files/scan.pdf)`);
    expect(await stub.appendToBody('missing', 'x')).toBe(false);
    await stub.setBody(src.id, 'replaced');
    expect((await stub.get(src.id))?.body).toBe('replaced');
  });
});

describe('notes: listing and counting', () => {
  async function seed(stub: ReturnType<typeof freshStore>['stub']) {
    const nb = (await stub.createNotebook('Receipts'))!;
    const amount = (await stub.createField(nb.id, { name: 'Amount', type: 'number', options: [] })) as { id: string };
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const created = await stub.create(
        note({
          title: `Note ${String(i).padStart(2, '0')}`,
          body: `body ${i}`,
          tags: i % 3 === 0 ? ['third'] : [],
          notebook: i % 2 === 0 ? 'Receipts' : null,
          ...(i % 4 === 0 ? { fields: { [amount.id]: i } } : {}),
        }),
      );
      ids.push(created.id);
      // Distinct `updated_at` values, so the default sort has an order to page through.
      await runInDurableObject(stub, (_i, state) => {
        state.storage.sql.exec(`UPDATE notes SET created_at = ?1, updated_at = ?1 WHERE id = ?2`, 1_000 + i, created.id);
      });
    }
    return { nb, amount, ids };
  }

  it('pages by keyset under every sort, in both directions', async () => {
    const { stub } = freshStore('paging');
    await seed(stub);

    const walk = async (opts: Omit<Parameters<typeof stub.list>[0], 'limit' | 'cursor'>) => {
      const titles: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const items = await stub.list({ ...opts, limit: 5, cursor });
        titles.push(...items.map((n) => n.title));
        // The facade's `nextCursor` is what the route uses; reproduce its rule here.
        if (items.length < 5) break;
        const last = items[items.length - 1]!;
        cursor = await runInDurableObject(stub, () => {
          const key = opts.sort === 'title' ? last.title : opts.sort === 'created' ? last.createdAt : last.updatedAt;
          return `${key}\u001F${last.id}`;
        });
      }
      return titles;
    };

    const all = Array.from({ length: 12 }, (_, i) => `Note ${String(i).padStart(2, '0')}`);
    expect(await walk({ sort: 'updated' })).toEqual([...all].reverse());
    expect(await walk({ sort: 'updated', order: 'asc' })).toEqual(all);
    expect(await walk({ sort: 'title', order: 'asc' })).toEqual(all);
    expect(await walk({ sort: 'created' })).toEqual([...all].reverse());
    // An excerpt travels; the body does not.
    const [first] = await stub.list({ limit: 1 });
    expect(first).toMatchObject({ excerpt: 'body 11' });
    expect(first).not.toHaveProperty('body');
  });

  it('filters by notebook, unfiled, tag, field and date range, and the counts agree', async () => {
    const { stub } = freshStore('filters');
    const { amount } = await seed(stub);

    expect((await stub.list({ limit: 50, notebook: 'receipts' })).length).toBe(6);
    expect(await stub.count({ notebook: 'receipts' })).toBe(6);
    expect((await stub.list({ limit: 50, notebook: UNFILED })).length).toBe(6);
    expect(await stub.count({ notebook: UNFILED })).toBe(6);
    expect((await stub.list({ limit: 50, tags: ['third'] })).length).toBe(4);
    expect(await stub.count({ tags: ['third'] })).toBe(4);
    // Two filters at once are counted from the rows, not read from a stored count.
    expect(await stub.count({ tags: ['third'], notebook: 'Receipts' })).toBe(2);
    expect(await stub.count({ tags: ['third'], notebook: UNFILED })).toBe(2);
    expect((await stub.list({ limit: 50, tags: ['third'], notebook: UNFILED })).length).toBe(2);
    expect(await stub.count({ fields: [{ fieldId: amount.id, op: 'set' }] })).toBe(3);
    expect(await stub.count({ fields: [{ fieldId: amount.id, op: 'gte', value: '8' }] })).toBe(1);
    expect(await stub.count({ fields: [{ fieldId: amount.id, op: 'eq', value: '4' }] })).toBe(1);
    expect(await stub.count({ fields: [{ fieldId: amount.id, op: 'empty' }] })).toBe(9);
    // `created_at` is 1000..1011 (ms epoch), all inside 1970-01-01.
    expect(await stub.count({ from: '1970-01-01', to: '1970-01-01', sort: 'created' })).toBe(12);
    expect(await stub.count({ from: '1970-01-02', sort: 'created' })).toBe(0);
    expect(await stub.count({ exact: true })).toBe(12);
  });

  it('leaves the body, field values and files out of a compact page, and nothing else', async () => {
    const { stub } = freshStore('compact');
    const nb = (await stub.createNotebook('Coupons'))!;
    const store = (await stub.createField(nb.id, { name: 'Store', type: 'text', options: [] })) as { id: string };
    const made = await stub.create(
      note({ title: 'Acme 10% off', body: 'Ten percent off at example.com', notebook: 'Coupons', tags: ['Deals'], fields: { [store.id]: 'Acme' } }),
    );

    const [full] = await stub.list({ limit: 50 });
    expect(full).toMatchObject({ excerpt: 'Ten percent off at example.com', fields: [expect.objectContaining({ name: 'Store' })] });

    const [compact] = await stub.list({ limit: 50, compact: true });
    expect(compact).toMatchObject({ id: made.id, title: 'Acme 10% off', notebook: 'Coupons', tags: ['Deals'], excerpt: '' });
    expect(compact).not.toHaveProperty('fields');
    // Paging is by the sort key, which a compact row still carries.
    expect(compact!.createdAt).toBe(full!.createdAt);

    // Asked for, the values named come back, no others, and still not the body (MAK-216).
    const code = (await stub.createField(nb.id, { name: 'Code', type: 'text', options: [] })) as { id: string };
    await stub.update(made.id, { fields: { [code.id]: 'TEN' } });
    const [withFields] = await stub.list({ limit: 50, compact: true, compactFields: [store.id] });
    expect(withFields).toMatchObject({ excerpt: '' });
    expect(withFields!.fields).toEqual([expect.objectContaining({ fieldId: store.id, value: 'Acme' })]);
  });

  it('creates many notes in one call, all or none (MAK-214)', async () => {
    const { stub } = freshStore('create-many');
    const nb = (await stub.createNotebook('Acme Screenings'))!;
    const year = (await stub.createField(nb.id, { name: 'Year', type: 'number', options: [] })) as { id: string };

    const made = await stub.createMany([
      note({ title: 'Coyote Returns', notebook: 'Acme Screenings', fields: { [year.id]: 1999 } }),
      note({ title: 'Acme: The Series', notebook: 'Acme Screenings', tags: ['tv'] }),
    ]);
    expect(made.map((m) => [m.title, m.skipped])).toEqual([['Coyote Returns', false], ['Acme: The Series', false]]);
    expect((await stub.get(made[0]!.id))?.fields?.[0]?.value).toBe(1999);
    expect((await stub.get(made[1]!.id))?.tags).toEqual(['tv']);

    // A value that does not fit takes the whole batch with it, the good note before it too.
    await expect(
      stub.createMany([
        note({ title: 'Fine', notebook: 'Acme Screenings' }),
        note({ title: 'Bad', notebook: 'Acme Screenings', fields: { [year.id]: 'soon' } }),
      ]),
    ).rejects.toThrow();
    expect(await stub.count({ notebook: 'Acme Screenings' })).toBe(2);
  });

  it('skips a title its notebook already holds, and one given twice, when asked', async () => {
    const { stub } = freshStore('create-many-skip');
    const held = await stub.create(note({ title: 'Coyote Returns', notebook: 'Acme Screenings' }));
    await stub.create(note({ title: 'Elsewhere', notebook: 'Podcast Bookmarks' }));
    const loose = await stub.create(note({ title: 'Loose' }));

    const made = await stub.createMany(
      [
        note({ title: 'coyote returns', notebook: 'acme screenings' }),
        // The same title in another notebook is not a duplicate.
        note({ title: 'Elsewhere', notebook: 'Acme Screenings' }),
        note({ title: 'New one', notebook: 'Acme Screenings' }),
        note({ title: 'NEW ONE', notebook: 'Acme Screenings' }),
        note({ title: 'Loose' }),
        // Untitled notes are never one another's duplicates.
        note({ title: '', notebook: 'Acme Screenings' }),
        note({ title: '', notebook: 'Acme Screenings' }),
      ],
      { skipExisting: true },
    );
    expect(made.map((m) => m.skipped)).toEqual([true, false, false, true, true, false, false]);
    expect(made[0]).toEqual({ id: held.id, title: 'Coyote Returns', skipped: true });
    expect(made[3]).toEqual({ id: made[2]!.id, title: 'New one', skipped: true });
    expect(made[3]!.id).toBe(made[2]!.id);
    expect(made[4]!.id).toBe(loose.id);
    expect(await stub.count({ notebook: 'Acme Screenings' })).toBe(5);

    // Without the flag, a title is only a title.
    const again = await stub.createMany([note({ title: 'Coyote Returns', notebook: 'Acme Screenings' })]);
    expect(again[0]!.skipped).toBe(false);
  });

  it('finds a notebook by name whatever its case, with its own fields and no other notebook\'s', async () => {
    const { stub } = freshStore('notebook-by-name');
    const coupons = (await stub.createNotebook('Coupons'))!;
    const other = (await stub.createNotebook('Podcast Bookmarks'))!;
    await stub.createField(coupons.id, { name: 'Expires', type: 'date', options: [] });
    await stub.createField(other.id, { name: 'Episode', type: 'text', options: [] });

    const found = await stub.notebookByName('  coupons ');
    expect(found).toMatchObject({ id: coupons.id, name: 'Coupons' });
    expect(found!.fields.map((f) => f.name)).toEqual(['Expires']);
    expect(await stub.notebookByName('Receipts')).toBeNull();
  });

  it('says where a set of notes is filed, and gives the fields only when that is one notebook', async () => {
    const { stub } = freshStore('field-targets');
    const nb = (await stub.createNotebook('Coupons'))!;
    await stub.createField(nb.id, { name: 'Expires', type: 'date', options: [] });
    const a = await stub.create(note({ title: 'Acme 10% off', notebook: 'Coupons' }));
    const b = await stub.create(note({ title: 'Acme free shipping', notebook: 'Coupons' }));
    const loose = await stub.create(note({ title: 'Report (final) v2' }));
    const gone = await stub.create(note({ title: 'Trashed', notebook: 'Coupons' }));
    await stub.remove(gone.id);

    const one = await stub.fieldTargets([a.id, b.id, gone.id, 'no-such-note']);
    // A trashed note and an unknown id are equally not there to be written to.
    expect(one.matched.sort()).toEqual([a.id, b.id].sort());
    expect(one.notebooks).toEqual([{ id: nb.id, name: 'Coupons', notes: 2, example: expect.any(String) }]);
    expect(one.fields.map((f) => f.name)).toEqual(['Expires']);

    // Mixed with an unfiled note there is no one notebook to resolve a name against.
    const mixed = await stub.fieldTargets([a.id, loose.id]);
    expect(mixed.notebooks).toHaveLength(2);
    expect(mixed.notebooks.find((n) => n.id === null)).toEqual({ id: null, name: null, notes: 1, example: loose.id });
    expect(mixed.fields).toEqual([]);

    expect(await stub.fieldTargets([loose.id])).toMatchObject({ matched: [loose.id], fields: [] });
    expect(await stub.fieldTargets(['no-such-note'])).toEqual({ matched: [], notebooks: [], fields: [] });
  });

  it('lists and counts the notes with no tag, live only, alone or within a notebook', async () => {
    const { stub } = freshStore('untagged');
    const bare = await stub.create(note({ title: 'Bare', notebook: 'Coupons' }));
    const bareElsewhere = await stub.create(note({ title: 'Bare elsewhere' }));
    await stub.create(note({ title: 'Tagged', notebook: 'Coupons', tags: ['Acme'] }));
    const trashed = await stub.create(note({ title: 'Trashed bare', notebook: 'Coupons' }));
    await stub.remove(trashed.id);
    // A note that had a tag and lost it is untagged again, though the tag's row stays.
    const stripped = await stub.create(note({ title: 'Stripped', notebook: 'Coupons', tags: ['Acme'] }));
    await stub.update(stripped.id, { tags: [] });

    const ids = async (opts: Parameters<typeof stub.list>[0]) => (await stub.list(opts)).map((n) => n.id).sort();
    expect(await ids({ limit: 50, untagged: true })).toEqual([bare.id, bareElsewhere.id, stripped.id].sort());
    expect(await ids({ limit: 50, untagged: true, notebook: 'Coupons' })).toEqual([bare.id, stripped.id].sort());
    expect(await ids({ limit: 50, untagged: true, notebook: UNFILED })).toEqual([bareElsewhere.id]);
    // The count is not the stored one, which knows nothing of tags; and it agrees with the list.
    expect(await stub.count({ untagged: true })).toBe(3);
    expect(await stub.count({ untagged: true, notebook: 'Coupons' })).toBe(2);
    // Together with a tag the two contradict, and nothing matches.
    expect(await stub.list({ limit: 50, untagged: true, tags: ['Acme'] })).toEqual([]);
    expect(await stub.count({ untagged: true, tags: ['Acme'] })).toBe(0);
    // Off, it narrows nothing.
    expect(await stub.count({ untagged: false })).toBe(4);
    // And it pages: a cursor over the narrowed list skips and repeats nothing.
    const first = await stub.list({ limit: 2, untagged: true, sort: 'created', order: 'asc' });
    const last = first[first.length - 1]!;
    const next = await stub.list({ limit: 2, untagged: true, sort: 'created', order: 'asc', cursor: `${last.createdAt}\u001F${last.id}` });
    expect([...first, ...next].map((n) => n.id).sort()).toEqual([bare.id, bareElsewhere.id, stripped.id].sort());
  });

  it('sorts by a field: valued notes first in value order, then the rest by id, paged across the seam', async () => {
    const { stub } = freshStore('fieldsort');
    const { amount, ids } = await seed(stub);
    const sortField = (await stub.fieldById(amount.id))!;
    const page1 = await stub.list({ limit: 2, sortField, order: 'asc' });
    expect(page1.map((n) => n.title)).toEqual(['Note 00', 'Note 04']);
    const last1 = page1[1]!;
    const page2 = await stub.list({ limit: 2, sortField, order: 'asc', cursor: `4\u001F${last1.id}` });
    expect(page2[0]!.title).toBe('Note 08');
    // Past the last valued row, the valueless run starts, ordered by id.
    const valuelessIds = ids.filter((_, i) => i % 4 !== 0).sort();
    expect(page2[1]!.id).toBe(valuelessIds[0]);
    const page3 = await stub.list({ limit: 2, sortField, order: 'asc', cursor: `\u001F${page2[1]!.id}` });
    expect(page3.map((n) => n.id)).toEqual(valuelessIds.slice(1, 3));
  });

  it('lists the trash newest-deleted first and counts it from the stored totals', async () => {
    const { stub } = freshStore('trash');
    const { ids } = await seed(stub);
    expect(await stub.remove(ids[0]!)).toBe(true);
    expect(await stub.remove(ids[0]!)).toBe(false);
    expect(await stub.remove(ids[1]!)).toBe(true);
    const trash = await stub.list({ limit: 10, trashed: true });
    expect(trash.map((n) => n.id)).toEqual([ids[1], ids[0]]);
    expect(trash[0]!.deletedAt).toBeGreaterThan(0);
    expect(await stub.count({ trashed: true })).toBe(2);
    expect(await stub.count()).toBe(10);
    expect(await stub.count({ tags: ['third'] })).toBe(3);
    expect(await stub.get(ids[0]!)).toBeNull();
    expect(await stub.restore(ids[0]!)).toBe(true);
    expect(await stub.restore(ids[0]!)).toBe(false);
    expect(await stub.count({ tags: ['third'] })).toBe(4);
  });

  it('recounts to zero corrections after all of that, and fixes a count that drifted', async () => {
    const { stub } = freshStore('recount');
    await seed(stub);
    expect(await stub.recountNotes()).toBe(0);
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec(`UPDATE tags SET note_count = 99`);
      state.storage.sql.exec(`UPDATE note_counts SET live = 0`);
    });
    expect(await stub.recountNotes()).toBe(2);
    expect(await stub.recountNotes()).toBe(0);
  });
});

describe('notes: search', () => {
  it('finds notes through every tier, names the source, and reindexes on update and delete', async () => {
    const { stub } = freshStore('search');
    const nb = (await stub.createNotebook('Receipts'))!;
    const vendor = (await stub.createField(nb.id, { name: 'Vendor', type: 'text', options: [] })) as { id: string };
    const inBody = await stub.create(note({ title: 'Lunch', body: 'coffee with the accountant', notebook: 'Receipts' }));
    const inTag = await stub.create(note({ title: 'Car', body: 'nothing', tags: ['Acme Roadster 9000'] }));
    const inField = await stub.create(note({ title: 'Bill', body: 'nothing', notebook: 'Receipts', fields: { [vendor.id]: 'Acme Coffee Roasters' } }));
    const inFile = await stub.create(note({ title: 'Scan', body: 'nothing' }));
    await stub.recordAttachment({ id: 'a1', noteId: inFile.id, filename: 'scan.pdf', contentType: 'application/pdf', size: 1, r2Key: 'k1' });
    await stub.recordText({ attachmentId: 'a1', noteId: inFile.id, filename: 'scan.pdf', text: 'coffee beans, 2 kg' });

    const coffee = await stub.search('coffee', 20);
    expect(coffee.map((r) => [r.id, r.matchedField ?? r.matchedFile ?? r.matchedTag ?? 'body'])).toEqual([
      [inBody.id, 'body'],
      [inField.id, 'Vendor'],
      [inFile.id, 'scan.pdf'],
    ]);
    expect(coffee[0]!.snippet).toContain('<<coffee>>');
    expect(await stub.search('roadster', 20)).toEqual([expect.objectContaining({ id: inTag.id, matchedTag: 'Acme Roadster 9000' })]);
    // Porter stemming: "running" finds "run".
    await stub.update(inTag.id, { body: 'running late' });
    expect((await stub.search('run', 20)).map((r) => r.id)).toEqual([inTag.id]);
    await stub.remove(inBody.id);
    expect((await stub.search('coffee', 20)).map((r) => r.id)).toEqual([inField.id, inFile.id]);
    await stub.purgeOne(inBody.id);
    expect((await stub.search('accountant', 20)).length).toBe(0);
    expect(await stub.search('   ', 20)).toEqual([]);
  });

  it('answers the same page scope-driven and FTS-driven for a filtered search', async () => {
    const { stub } = freshStore('scoped');
    const nb = (await stub.createNotebook('Small'))!;
    void nb;
    const a = await stub.create(note({ title: 'In scope', body: 'shared word', notebook: 'Small', tags: ['t'] }));
    await stub.create(note({ title: 'Out of scope', body: 'shared word', notebook: 'Other' }));
    const b = await stub.create(note({ title: 'Also', body: 'shared word twice shared', notebook: 'Small' }));

    const filters = { notebook: 'small' };
    const scopeDriven = await stub.search('shared', 10, filters);
    const ftsDriven = await stub.search('shared', 10, filters, 0);
    expect(scopeDriven.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    expect(ftsDriven.map((r) => r.id)).toEqual(scopeDriven.map((r) => r.id));

    // A tag filter takes the `+n.deleted_at` shape in both queries.
    expect((await stub.search('shared', 10, { tags: ['t'] })).map((r) => r.id)).toEqual([a.id]);
    expect((await stub.search('shared', 10, { tags: ['t'] }, 0)).map((r) => r.id)).toEqual([a.id]);
    expect(await stub.search('shared', 10, { notebook: UNFILED })).toEqual([]);
    expect(await stub.search('shared', 10, { notebook: 'no such notebook' })).toEqual([]);
  });

  it("carries each match's list row, in the search's order, for a table", async () => {
    const { stub } = freshStore('search-rows');
    const nb = (await stub.createNotebook('Receipts'))!;
    const vendor = (await stub.createField(nb.id, { name: 'Vendor', type: 'text', options: [] })) as { id: string };
    const inTitle = await stub.create(note({ title: 'Coffee', body: 'nothing', notebook: 'Receipts', tags: ['cafe'] }));
    const inField = await stub.create(note({ title: 'Bill', body: 'nothing', notebook: 'Receipts', fields: { [vendor.id]: 'Acme Coffee' } }));
    await stub.create(note({ title: 'Elsewhere', body: 'coffee', notebook: 'Other' }));

    const plain = await stub.search('coffee', 10, { notebook: 'Receipts' });
    const rows = await stub.searchRows('coffee', 10, { notebook: 'Receipts' });
    // The same matches, ranked the same, each with what the list would draw for it.
    expect(rows.map(({ note: _, ...r }) => r)).toEqual(plain);
    expect(rows.map((r) => r.id)).toEqual([inTitle.id, inField.id]);
    expect(rows[0]!.note).toEqual((await stub.list({ limit: 10, notebook: 'Receipts' })).find((n) => n.id === inTitle.id));
    expect(rows[1]!.note.fields).toEqual([expect.objectContaining({ fieldId: vendor.id, value: 'Acme Coffee' })]);
    expect(rows[0]!.note.tags).toEqual(['cafe']);
  });
});

describe('notes: bulk actions and purging', () => {
  it('moves and retags a selection, touching only what changes', async () => {
    const { stub } = freshStore('bulk');
    const a = await stub.create(note({ tags: ['keep'], notebook: 'Here' }));
    const b = await stub.create(note({ tags: ['keep', 'drop'] }));
    const c = await stub.create(note({}));
    await stub.remove(c.id);
    const { matched, changed } = await stub.updateMany([a.id, b.id, c.id, 'ghost'], {
      notebook: 'Here',
      addTags: ['keep', 'new'],
      removeTags: ['drop'],
    });
    expect(matched.sort()).toEqual([a.id, b.id].sort());
    expect(changed.sort()).toEqual([a.id, b.id].sort());
    expect((await stub.get(a.id))!.tags).toEqual(['keep', 'new']);
    expect((await stub.get(b.id))).toMatchObject({ notebook: 'Here', tags: ['keep', 'new'] });
    // Nothing differs now, so nothing is written and nothing re-dated.
    const before = (await stub.get(a.id))!.updatedAt;
    expect(await stub.updateMany([a.id], { notebook: 'Here', addTags: ['keep'] })).toEqual({ matched: [a.id], changed: [] });
    expect((await stub.get(a.id))!.updatedAt).toBe(before);
  });

  it('sets a field value across a selection, merging, leaving held values dated and refusing the wrong notebook', async () => {
    const { stub } = freshStore('bulk-fields');
    const store = (await stub.createField((await stub.createNotebook('Coupons'))!.id, { name: 'Store', type: 'text', options: [] })) as { id: string };
    const kind = (await stub.createField((await stub.listNotebooks())[0]!.id, { name: 'Kind', type: 'select', options: ['food', 'fuel'] })) as { id: string };
    const a = await stub.create(note({ notebook: 'Coupons', fields: { [store.id]: 'Acme', [kind.id]: 'food' } }));
    const b = await stub.create(note({ notebook: 'Coupons' }));
    const c = await stub.create(note({ notebook: 'Coupons', fields: { [store.id]: 'Acme' } }));
    const elsewhere = await stub.create(note({ notebook: 'Taxes' }));
    const unfiled = await stub.create(note({}));
    const heldDate = (await stub.get(c.id))!.updatedAt;

    // Only the named field changes; a note already holding the value is matched, not changed.
    const done = await stub.updateMany([a.id, b.id, c.id, 'ghost'], { fields: { [store.id]: 'Acme' } });
    expect(done.matched.sort()).toEqual([a.id, b.id, c.id].sort());
    expect(done.changed).toEqual([b.id]);
    expect((await stub.get(c.id))!.updatedAt).toBe(heldDate);
    expect((await stub.get(a.id))!.fields!.map((v) => [v.name, v.value]).sort()).toEqual([['Kind', 'food'], ['Store', 'Acme']]);
    expect((await stub.get(b.id))!.fields!.map((v) => [v.name, v.value])).toEqual([['Store', 'Acme']]);

    // Null clears, but only where there is something to clear.
    const cleared = await stub.updateMany([a.id, b.id, c.id], { fields: { [kind.id]: null } });
    expect(cleared.changed).toEqual([a.id]);
    expect((await stub.get(a.id))!.fields!.map((v) => v.name)).toEqual(['Store']);

    // A value the field cannot hold refuses the call, and nothing before it lands.
    await expect(stub.updateMany([a.id, b.id], { addTags: ['half'], fields: { [kind.id]: 'water' } })).rejects.toMatchObject({
      name: 'InvalidFieldValue',
      fieldName: 'Kind',
    });
    expect((await stub.get(a.id))!.tags).toEqual([]);

    // Notes from another notebook, or none, refuse the whole call and say which note.
    for (const stray of [elsewhere, unfiled]) {
      await expect(stub.updateMany([a.id, stray.id], { fields: { [store.id]: 'Beta' } })).rejects.toMatchObject({
        name: 'InvalidFieldValue',
        fieldName: 'Store',
        message: expect.stringContaining(stray.id),
      });
    }
    expect((await stub.get(a.id))!.fields!.find((v) => v.name === 'Store')!.value).toBe('Acme');

    // The destination counts: the same patch is fine alongside a move into the notebook.
    const moved = await stub.updateMany([elsewhere.id], { notebook: 'Coupons', fields: { [store.id]: 'Beta' } });
    expect(moved.changed).toEqual([elsewhere.id]);
    await expect(stub.updateMany([a.id], { fields: { 'no-such-field': 'x' } })).rejects.toMatchObject({ name: 'InvalidFieldValue' });
  });

  it('trashes, restores and purges many, skipping ids on the wrong side of the trash', async () => {
    const { stub } = freshStore('many');
    const a = await stub.create(note({ tags: ['only-here'] }));
    const b = await stub.create(note({}));
    await stub.recordAttachment({ id: 'a1', noteId: a.id, filename: 'f.pdf', contentType: 'application/pdf', size: 1, r2Key: 'users/u/a/f.pdf' });
    expect((await stub.removeMany([a.id, b.id, a.id, 'ghost'])).sort()).toEqual([a.id, b.id].sort());
    expect(await stub.removeMany([a.id])).toEqual([]);
    expect(await stub.restoreMany([b.id, 'ghost'])).toEqual([b.id]);
    // b is live again, so the purge leaves it and returns only a's keys.
    expect(await stub.purgeMany([a.id, b.id])).toEqual({ deleted: 1, keys: ['users/u/a/f.pdf'] });
    expect(await stub.get(b.id)).not.toBeNull();
    // The tag a alone carried was swept with it.
    expect(await stub.listTags()).toEqual([]);
    expect((await stub.stats()).counts.tags).toBe(0);
  });

  it('purges a scope page by page, sweeping on the last, with cascades taking the children', async () => {
    const before = Date.now();
    const { stub } = freshStore('purge');
    const nb = (await stub.createNotebook('Bin'))!;
    const f = (await stub.createField(nb.id, { name: 'F', type: 'text', options: [] })) as { id: string };
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const n = await stub.create(note({ tags: [`t${i}`], notebook: 'Bin', fields: { [f.id]: `v${i}` } }));
      ids.push(n.id);
      await stub.recordAttachment({ id: `att${i}`, noteId: n.id, filename: 'f.pdf', contentType: 'application/pdf', size: 1, r2Key: `k${i}` });
      await stub.recordText({ attachmentId: `att${i}`, noteId: n.id, filename: 'f.pdf', text: 'acme' });
    }
    await stub.removeMany(ids.slice(0, 3));

    const first = await stub.purge('trashed', 2);
    expect(first.notes).toBe(2);
    expect(first.keys.length).toBe(2);
    expect(first.remaining).toBeGreaterThanOrEqual(1);
    const second = await stub.purge('trashed', 2);
    expect(second).toMatchObject({ notes: 1, remaining: 0 });
    expect(await stub.purge('trashed', 2)).toEqual({ notes: 0, keys: [], remaining: 0 });

    const stats = await stub.stats();
    expect(stats.counts).toMatchObject({ notes: 2, attachments: 2, attachment_text: 2, note_tags: 2, note_fields: 2, tags: 2 });
    // The newest write's time, read from the feed; what the operator page shows as "Last change".
    expect(stats.lastWriteAt).toBeGreaterThanOrEqual(before);
    expect(await stub.count()).toBe(2);
    expect(await stub.count({ trashed: true })).toBe(0);

    const wipe = await stub.purge('all', 10);
    expect(wipe).toMatchObject({ notes: 2, remaining: 0 });
    expect((await stub.stats()).counts).toMatchObject({ notes: 0, attachments: 0, attachment_text: 0, note_tags: 0, note_fields: 0, tags: 0 });
    expect(await stub.search('acme', 10)).toEqual([]);
    expect(await stub.recountNotes()).toBe(0);
  });
});

describe('notes: import', () => {
  it('imports once by id, once by hash, and re-files an unfiled match', async () => {
    const { stub } = freshStore('import');
    const base = { title: 'T', body: 'B', tags: ['x'], createdAt: 5, updatedAt: 6, contentHash: 'h1' };
    const first = await stub.importNote({ ...base, id: 'keep-me', notebook: 'Imported' });
    expect(first).toEqual({ id: 'keep-me', created: true, skippedFields: [] });
    expect(await stub.importNote({ ...base, id: 'keep-me', notebook: 'Imported' })).toMatchObject({ id: 'keep-me', created: false });
    // Same text, free id: a different note.
    expect((await stub.importNote({ ...base, id: 'other', notebook: 'Imported' })).created).toBe(true);
    // No id, known hash: the note already here.
    expect(await stub.importNote({ ...base })).toMatchObject({ created: false });
    // A trashed note keeps its id, so the same note imported again — its text since
    // edited, so no live note shares the hash — lands under a fresh id.
    await stub.remove('keep-me');
    const again = await stub.importNote({ ...base, id: 'keep-me', body: 'edited', contentHash: 'h2' });
    expect(again.created).toBe(true);
    expect(again.id).not.toBe('keep-me');
    // A taken id whose hash matches a live note is a remint from an earlier run of that
    // note, and skipping it is what makes a resumed import resume.
    expect(await stub.importNote({ ...base, id: 'keep-me' })).toMatchObject({ id: 'other', created: false });

    const nb = (await stub.listNotebooks())[0]!;
    await stub.deleteNotebook(nb.id);
    expect((await stub.get('other'))!.notebook).toBeNull();
    await stub.importNote({ ...base, id: 'other', notebook: 'Imported' });
    expect((await stub.get('other'))!.notebook).toBe('Imported');
    expect((await stub.get('other'))!.createdAt).toBe(5);
  });

  it('applies a notebook definition and values by name, creating fields and widening options', async () => {
    const { stub } = freshStore('importnb');
    const result = await stub.importNotebook({
      name: 'Coupons',
      emoji: '🎟️',
      purpose: 'Deals',
      fields: [
        { name: 'Store', type: 'select', options: ['Acme'] },
        { name: 'Value', type: 'number', currency: 'USD' },
      ],
    } as Parameters<typeof stub.importNotebook>[0]);
    if (result === 'conflict') throw new Error('expected a new notebook');
    expect(result.skipped).toEqual([]);
    const nb = (await stub.listNotebooks())[0]!;
    expect(nb).toMatchObject({ name: 'Coupons', emoji: '🎟️', purpose: 'Deals', fields: 2 });

    const imported = await stub.importNote({
      title: 'Ten off',
      body: '',
      tags: [],
      notebook: 'Coupons',
      createdAt: 1,
      updatedAt: 1,
      contentHash: 'c1',
      fields: { Store: 'Globex', Value: 10, Tags: ['a'], '': 'x', Expires: '2030-01-01' },
    });
    // `Tags` is reserved; the blank name is nothing; Globex was added to the select.
    expect(imported.skippedFields).toEqual(['Tags', '']);
    const fields = (await stub.listFields(nb.id))!;
    expect(fields.map((f) => [f.name, f.type])).toEqual([['Store', 'select'], ['Value', 'number'], ['Expires', 'date']]);
    expect(fields[0]!.options).toEqual(['Acme', 'Globex']);
    expect((await stub.get(imported.id))!.fields!.map((v) => [v.name, v.value])).toEqual([
      ['Store', 'Globex'],
      ['Value', 10],
      ['Expires', '2030-01-01'],
    ]);

    const second = await stub.importNotebook({
      name: 'coupons',
      emoji: '🧾',
      fields: [{ name: 'value', type: 'text' }],
    } as Parameters<typeof stub.importNotebook>[0]);
    if (second === 'conflict') throw new Error('expected a merge');
    expect(second.skipped).toEqual([
      { kind: 'emoji', name: '🧾', reason: 'Already 🎟️ here; left as it is' },
      { name: 'value', reason: 'Already here as number, not text; left as it is' },
    ]);
  });

  it('creates a notebook from a definition only when told to, and never merges then', async () => {
    const { stub } = freshStore('importnb-create');
    const made = await stub.importNotebook(
      { name: 'Coupons', emoji: '🎟️', fields: [{ name: 'Code', type: 'text' }, { name: 'Used', type: 'checkbox' }] },
      { create: true },
    );
    if (made === 'conflict') throw new Error('expected a new notebook');
    expect(made.skipped).toEqual([]);
    const nb = (await stub.listNotebooks())[0]!;
    expect(nb).toMatchObject({ id: made.id, name: 'Coupons', emoji: '🎟️', fields: 2 });

    // The same name in other letters is taken: refused, and the notebook is as it was.
    expect(
      await stub.importNotebook({ name: 'coupons', emoji: '🧾', fields: [{ name: 'Store', type: 'text' }] }, { create: true }),
    ).toBe('conflict');
    expect(await stub.listNotebooks()).toEqual([expect.objectContaining({ name: 'Coupons', emoji: '🎟️', fields: 2 })]);
    expect((await stub.listFields(nb.id))!.map((f) => f.name)).toEqual(['Code', 'Used']);
  });
});

describe('tags and notebooks', () => {
  it('renames and merges tags, and deletes one off trashed notes too', async () => {
    const { stub } = freshStore('tags');
    const a = await stub.create(note({ tags: ['Receipts'] }));
    const b = await stub.create(note({ tags: ['Receipt', 'Receipts'] }));
    const tags = await stub.listTags();
    const receipts = tags.find((t) => t.name === 'Receipts')!;
    const receipt = tags.find((t) => t.name === 'Receipt')!;
    expect(await stub.renameTag(receipts.id, ' ', {})).toBe('missing');
    expect(await stub.renameTag(receipts.id, 'Receipt')).toBe('conflict');
    expect(await stub.renameTag(receipts.id, 'Receipt', { merge: true })).toEqual({ id: receipt.id, name: 'Receipt', merged: true });
    expect((await stub.get(a.id))!.tags).toEqual(['Receipt']);
    expect((await stub.get(b.id))!.tags).toEqual(['Receipt']);
    expect(await stub.listTags()).toEqual([{ id: receipt.id, name: 'Receipt', count: 2 }]);
    expect(await stub.renameTag(receipt.id, 'Bills')).toEqual({ id: receipt.id, name: 'Bills', merged: false });
    expect((await stub.search('bills', 5)).map((r) => r.id).sort()).toEqual([a.id, b.id].sort());

    await stub.remove(b.id);
    expect(await stub.deleteTag(receipt.id)).toBe(true);
    expect(await stub.deleteTag(receipt.id)).toBe(false);
    await stub.restore(b.id);
    expect((await stub.get(b.id))!.tags).toEqual([]);
    expect(await stub.listTags()).toEqual([]);
  });

  it('finds a tag by name in any case, keeping the spelling stored first (MAK-127)', async () => {
    const { stub } = freshStore('tags-nocase');
    const a = await stub.create(note({ title: 'Lunch', tags: ['Receipts'] }));
    // A write naming another case attaches the tag there is, and a list naming one name
    // twice in two cases is one tag.
    const b = await stub.create(note({ title: 'Lunch again', tags: ['receipts', 'RECEIPTS', 'Café'] }));
    expect(b.tags).toEqual(['Café', 'Receipts']);
    const receipts = (await stub.listTags()).find((t) => t.name === 'Receipts')!;
    expect(await stub.listTags()).toEqual([
      { id: receipts.id, name: 'Receipts', count: 2 },
      { id: expect.any(String), name: 'Café', count: 1 },
    ]);
    // NOCASE folds ASCII only, as it does for notebooks: CAFÉ is a tag of its own.
    await stub.update(a.id, { tags: ['Receipts', 'CAFÉ'] });
    expect((await stub.listTags()).map((t) => t.name).sort()).toEqual(['CAFÉ', 'Café', 'Receipts']);

    // Resending the tags a note has, in another case, is no edit, and does not re-date it.
    const before = (await stub.get(b.id))!;
    await stub.update(b.id, { tags: ['RECEIPTS', 'Café'] });
    expect((await stub.get(b.id))!.updatedAt).toBe(before.updatedAt);

    // Filters, counts and the search's scope find the notes in any case.
    expect((await stub.list({ limit: 10, tags: ['receipts'] })).map((n) => n.id).sort()).toEqual([a.id, b.id].sort());
    expect(await stub.count({ tags: ['RECEIPTS'] })).toBe(2);
    expect((await stub.search('lunch', 10, { tags: ['receipts'] })).map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    expect((await stub.tagCounts({ tags: ['receipts'] })).map((t) => t.name).sort()).toEqual(['CAFÉ', 'Café']);

    // The bulk verbs: adding a tag a note has in another case changes nothing; removing
    // one by another case takes it off.
    const none = await stub.updateMany([a.id, b.id], { addTags: ['receipts'] });
    expect(none.changed).toEqual([]);
    // In the store's order, which is the ids', not the order they were sent in.
    expect([...none.matched].sort()).toEqual([a.id, b.id].sort());
    expect((await stub.updateMany([a.id], { removeTags: ['RECEIPTS'] })).changed).toEqual([a.id]);
    expect((await stub.get(a.id))!.tags).toEqual(['CAFÉ']);
    // A tag named in both lists, in two cases, is added, as it would be in one.
    expect((await stub.updateMany([a.id], { addTags: ['Receipts'], removeTags: ['receipts'] })).changed).toEqual([a.id]);
    expect((await stub.get(a.id))!.tags).toEqual(['CAFÉ', 'Receipts']);

    // Changing only a tag's case is a plain rename — the one way to respell it now. A
    // merge into a name that exists in another case lands on the stored spelling.
    expect(await stub.renameTag(receipts.id, 'receipts')).toEqual({ id: receipts.id, name: 'receipts', merged: false });
    expect((await stub.get(b.id))!.tags).toEqual(['Café', 'receipts']);
    const cafe = (await stub.listTags()).find((t) => t.name === 'CAFÉ')!;
    expect(await stub.renameTag(cafe.id, 'RECEIPTS')).toBe('conflict');
    expect(await stub.renameTag(cafe.id, 'RECEIPTS', { merge: true })).toEqual({ id: receipts.id, name: 'receipts', merged: true });
    expect((await stub.get(a.id))!.tags).toEqual(['receipts']);
  });

  it('counts tags within a notebook or beside other tags, over live notes only', async () => {
    const { stub } = freshStore('tag-counts');
    await stub.create(note({ notebook: 'Coupons', tags: ['Acme', 'Food'] }));
    await stub.create(note({ notebook: 'Coupons', tags: ['Acme', 'Fuel'] }));
    await stub.create(note({ notebook: 'coupons', tags: ['Acme'] }));
    const gone = await stub.create(note({ notebook: 'Coupons', tags: ['Trashed only', 'Food'] }));
    await stub.create(note({ notebook: 'Taxes', tags: ['Acme', 'Food', 'Filed'] }));
    await stub.create(note({ tags: ['Acme', 'Loose'] }));
    await stub.remove(gone.id);
    const names = async (filter: Parameters<typeof stub.tagCounts>[0]) =>
      (await stub.tagCounts(filter)).map((t) => [t.name, t.count]);

    // A notebook: its live notes only, named in any case, most used first, ties by name.
    expect(await names({ notebook: 'COUPONS' })).toEqual([['Acme', 3], ['Food', 1], ['Fuel', 1]]);
    // A tag with no live note in the set is not there: "Trashed only" is on a trashed note.
    expect((await names({ notebook: 'Coupons' })).map(([n]) => n)).not.toContain('Trashed only');
    expect(await names({ notebook: UNFILED })).toEqual([['Acme', 1], ['Loose', 1]]);
    expect(await names({ notebook: 'No such notebook' })).toEqual([]);

    // Tags: the notes carrying every one, and the tags named are not in the answer.
    expect(await names({ tags: ['Acme'] })).toEqual([['Food', 2], ['Filed', 1], ['Fuel', 1], ['Loose', 1]]);
    expect(await names({ tags: ['Acme', 'Food'] })).toEqual([['Filed', 1]]);
    expect(await names({ tags: ['Nothing'] })).toEqual([]);
    // Both: the intersection, and counts agree with what `count` says the set holds.
    expect(await names({ notebook: 'Coupons', tags: ['Food'] })).toEqual([['Acme', 1]]);
    expect(await stub.count({ notebook: 'Coupons', tags: ['Food'] })).toBe(1);
    expect(await names({ notebook: 'Coupons', tags: ['Acme'] })).toEqual([['Food', 1], ['Fuel', 1]]);
  });

  it('creates, renames and deletes notebooks, keeping field values readable as tombstones', async () => {
    const { stub } = freshStore('notebooks');
    expect(await stub.createNotebook('  ')).toBeNull();
    const nb = (await stub.createNotebook('Coupons'))!;
    expect(await stub.createNotebook('coupons')).toBeNull();
    const other = (await stub.createNotebook('Other'))!;
    expect(await stub.updateNotebook(nb.id, { name: 'other' })).toBe('conflict');
    expect(await stub.updateNotebook(nb.id, { name: 'Deals', purpose: 'Savings', emoji: '💸' })).toBe('ok');
    expect(await stub.updateNotebook('ghost', {})).toBe('missing');
    expect(await stub.updateNotebook(nb.id, {})).toBe('ok');
    expect((await stub.listNotebooks()).map((n) => [n.name, n.purpose, n.emoji])).toEqual([
      ['Deals', 'Savings', '💸'],
      ['Other', null, null],
    ]);

    const store = (await stub.createField(nb.id, { name: 'Store', type: 'text', options: [] })) as { id: string };
    const held = await stub.create(note({ notebook: 'Deals', fields: { [store.id]: 'Acme' } }));
    const moved = await stub.create(note({ notebook: 'Deals', fields: { [store.id]: 'Globex' } }));
    await stub.update(moved.id, { notebook: 'Other' });
    const empty = await stub.create(note({ notebook: 'Deals' }));

    expect(await stub.deleteNotebook(nb.id, { trashNotes: true })).toBe(true);
    expect(await stub.deleteNotebook(nb.id)).toBe(false);
    // The notes went to the trash, unfiled; the one that had left stayed where it was.
    expect((await stub.list({ limit: 10, trashed: true })).map((n) => n.id).sort()).toEqual([held.id, empty.id].sort());
    expect((await stub.get(moved.id))!.notebook).toBe('Other');
    // The value survives as a tombstoned field labelled with the old notebook's name,
    // and comes back with a restore.
    await stub.restore(held.id);
    expect((await stub.get(held.id))!.fields).toEqual([
      expect.objectContaining({ name: 'Store', value: 'Acme', notebook: 'Deals', notebookId: nb.id }),
    ]);
    expect(await stub.fieldById(store.id)).toBeNull();
    // Clearing the last values sweeps the tombstone.
    await stub.update(held.id, { fields: { [store.id]: null } });
    await stub.update(moved.id, { fields: { [store.id]: null } });
    expect((await stub.stats()).counts.notebook_fields).toBe(0);
    expect(await stub.deleteNotebook(other.id)).toBe(true);
    expect((await stub.get(moved.id))!.notebook).toBeNull();
  });
});

describe('custom fields', () => {
  it('creates, reorders, converts, previews, counts options and removes one, and deletes', async () => {
    const { stub } = freshStore('fields');
    const nb = (await stub.createNotebook('Wine'))!;
    expect(await stub.createField('ghost', { name: 'X', type: 'text', options: [] })).toBe('missing');
    const rating = (await stub.createField(nb.id, { name: 'Rating', type: 'number', options: [], scale: { max: 10, step: 1 } })) as { id: string };
    const grape = (await stub.createField(nb.id, { name: 'Grape', type: 'text', options: [] })) as { id: string };
    expect(await stub.createField(nb.id, { name: 'grape', type: 'text', options: [] })).toBe('conflict');
    expect((await stub.listFields(nb.id))!.map((f) => f.name)).toEqual(['Rating', 'Grape']);
    expect(await stub.reorderFields(nb.id, [grape.id, rating.id])).toBe(true);
    expect(await stub.reorderFields(nb.id, [grape.id])).toBe(false);
    expect((await stub.listFields(nb.id))!.map((f) => f.name)).toEqual(['Grape', 'Rating']);
    expect(await stub.listFields('ghost')).toBeNull();

    const a = await stub.create(note({ notebook: 'Wine', fields: { [rating.id]: 9, [grape.id]: 'Syrah' } }));
    const b = await stub.create(note({ notebook: 'Wine', fields: { [rating.id]: 3, [grape.id]: 'Syrah' } }));
    const c = await stub.create(note({ notebook: 'Wine', fields: { [grape.id]: 'Malbec' } }));
    expect((await stub.listFields(nb.id, { counts: true }))!.map((f) => f.valueCount)).toEqual([3, 2]);

    // Tightening the scale clears the 9; a preview says so first.
    expect(await stub.previewConversion(nb.id, rating.id, 'number', { max: 5, step: 1 })).toEqual({ values: 2, incompatible: 1, scale: { max: 5, step: 1 } });
    // Asked to fit, the preview reads the scale from the values, and it keeps both.
    expect(await stub.previewConversion(nb.id, rating.id, 'number', 'fit')).toEqual({ values: 2, incompatible: 0, scale: { max: 9, step: 1 } });
    const tightened = await stub.updateField(nb.id, rating.id, { scale: { max: 5, step: 1 } });
    expect(tightened).toMatchObject({ cleared: 1, field: { scale: { max: 5, step: 1 } } });
    expect((await stub.get(a.id))!.fields!.map((v) => v.name)).toEqual(['Grape']);
    expect((await stub.get(b.id))!.fields!.find((v) => v.name === 'Rating')!.value).toBe(3);

    // Converting text to select seeds the options from the values held.
    const asSelect = await stub.updateField(nb.id, grape.id, { type: 'select' });
    expect(asSelect).toMatchObject({ cleared: 0, field: { type: 'select', options: ['Malbec', 'Syrah'] } });
    expect(await stub.countOptionUsage(nb.id, grape.id, 'Syrah')).toBe(2);
    expect(await stub.countOptionUsage(nb.id, rating.id, 'Syrah')).toBeNull();
    const removed = await stub.removeFieldOption(nb.id, grape.id, 'Syrah', true);
    expect(removed).toMatchObject({ cleared: 2, field: { options: ['Malbec'] } });
    expect((await stub.get(b.id))!.fields!.map((v) => v.name)).toEqual(['Rating']);
    expect(await stub.removeFieldOption(nb.id, grape.id, 'Nope', false)).toBeNull();
    expect(await stub.updateField(nb.id, grape.id, { name: 'rating' })).toBe('conflict');
    expect(await stub.updateField(nb.id, 'ghost', { name: 'x' })).toBe('missing');

    expect(await stub.deleteField(nb.id, grape.id)).toBe(true);
    expect(await stub.deleteField(nb.id, grape.id)).toBe(false);
    expect((await stub.get(c.id))!.fields).toBeUndefined();
    expect((await stub.listAllFields()).map((f) => f.name)).toEqual(['Rating']);
    expect(await stub.recountNotes()).toBe(0);
  });

  it('edits options by what changes, moving a renamed option\'s values with it', async () => {
    const { stub } = freshStore('option-edits');
    const nb = (await stub.createNotebook('Coupons'))!;
    const kind = (await stub.createField(nb.id, { name: 'Kind', type: 'select', options: ['Misc', 'fuel', 'Bank', 'Old'] })) as { id: string };
    const tags = (await stub.createField(nb.id, { name: 'Labels', type: 'multiselect', options: ['Grocery', 'Groceries', 'Gift'] })) as { id: string };
    const text = (await stub.createField(nb.id, { name: 'Store', type: 'text', options: [] })) as { id: string };
    const a = await stub.create(note({ notebook: 'Coupons', fields: { [kind.id]: 'Misc', [tags.id]: ['Grocery', 'Groceries'] } }));
    const b = await stub.create(note({ notebook: 'Coupons', fields: { [kind.id]: 'Old', [tags.id]: ['Grocery', 'Gift'] } }));
    const c = await stub.create(note({ notebook: 'Coupons', fields: { [kind.id]: 'fuel' } }));

    // Rename, remove, sort with a pin last: one call, and no list sent.
    let seq = await feedSeq(stub);
    const sorted = await stub.editFieldOptions(nb.id, kind.id, {
      rename: [{ from: 'Misc', to: 'Other' }],
      remove: ['Old'],
      sort: 'alpha',
      pinLast: ['Other'],
    });
    expect(sorted).toMatchObject({
      field: { options: ['Bank', 'fuel', 'Other'] },
      renamed: [{ from: 'Misc', to: 'Other', notes: 1 }],
      removed: [{ option: 'Old', notes: 1 }],
      added: [],
    });
    expect((await stub.get(a.id))!.fields!.find((v) => v.name === 'Kind')!.value).toBe('Other');
    // A removed option stays on the note that held it, as removeFieldOption leaves it.
    expect((await stub.get(b.id))!.fields!.find((v) => v.name === 'Kind')!.value).toBe('Old');
    expect((await stub.get(c.id))!.fields!.find((v) => v.name === 'Kind')!.value).toBe('fuel');
    expect(await feedRows(stub, seq)).toEqual([{ entity: 'notebook', id: nb.id }, { entity: 'note', id: a.id }]);

    // A rename onto an option that stands is refused unless asked, and moves nothing.
    expect(await stub.editFieldOptions(nb.id, tags.id, { rename: [{ from: 'Grocery', to: 'Groceries' }] })).toMatchObject({ refused: expect.stringContaining('merge') });
    expect((await stub.get(b.id))!.fields!.find((v) => v.name === 'Labels')!.value).toEqual(['Grocery', 'Gift']);
    // Asked, it merges them; a note holding both keeps one.
    const merged = await stub.editFieldOptions(nb.id, tags.id, { rename: [{ from: 'Grocery', to: 'Groceries' }], merge: true, add: ['Fuel'], position: 'alpha' });
    expect(merged).toMatchObject({ field: { options: ['Fuel', 'Groceries', 'Gift'] }, renamed: [{ notes: 2 }], added: ['Fuel'] });
    expect((await stub.get(a.id))!.fields!.find((v) => v.name === 'Labels')!.value).toEqual(['Groceries']);
    expect((await stub.get(b.id))!.fields!.find((v) => v.name === 'Labels')!.value).toEqual(['Groceries', 'Gift']);
    expect(await stub.countOptionUsage(nb.id, tags.id, 'Grocery')).toBe(0);

    // The field's own name rides along, and a clash refuses before any note moves.
    expect(await stub.editFieldOptions(nb.id, kind.id, { rename: [{ from: 'fuel', to: 'Fuel' }] }, { name: 'store' })).toBe('conflict');
    expect((await stub.get(c.id))!.fields!.find((v) => v.name === 'Kind')!.value).toBe('fuel');
    expect(await stub.editFieldOptions(nb.id, kind.id, { add: ['Cash'] }, { name: 'Category' })).toMatchObject({ field: { name: 'Category', options: ['Bank', 'fuel', 'Other', 'Cash'] } });

    // A whole list replaces it, and names each option it left out with the notes holding it.
    const replaced = await stub.editFieldOptions(nb.id, kind.id, { replace: ['Bank', 'Other', 'Petrol'] });
    expect(replaced).toMatchObject({
      field: { options: ['Bank', 'Other', 'Petrol'] },
      removed: [
        { option: 'fuel', notes: 1 },
        { option: 'Cash', notes: 0 },
      ],
      added: ['Petrol'],
    });
    expect((await stub.get(c.id))!.fields!.find((v) => v.name === 'Category')!.value).toBe('fuel');

    seq = await feedSeq(stub);
    expect(await stub.editFieldOptions(nb.id, kind.id, { remove: ['Nope'] })).toEqual({ refused: expect.stringContaining('not one of') });
    expect(await stub.editFieldOptions(nb.id, text.id, { add: ['x'] })).toEqual({ refused: expect.stringContaining('select') });
    expect(await stub.editFieldOptions(nb.id, crypto.randomUUID(), { add: ['x'] })).toBe('missing');
    expect(await feedSeq(stub)).toBe(seq);
  });

  it('holds a hundred field ids in one patch without running out of binds', async () => {
    const { stub } = freshStore('binds');
    const nb = (await stub.createNotebook('Wide'))!;
    // The notebook's own cap is lower than a hundred, so the definitions are seeded
    // directly; what is under test is the patch's two lookups, which each used to bind
    // one value past the engine's limit.
    const ids = Array.from({ length: 100 }, () => crypto.randomUUID());
    await runInDurableObject(stub, (_i, state) => {
      ids.forEach((id, i) => {
        state.storage.sql.exec(
          `INSERT INTO notebook_fields (id, notebook_id, name, type, position, created_at) VALUES (?1, ?2, ?3, 'text', ?4, 1)`,
          id,
          nb.id,
          `F${i}`,
          i,
        );
      });
    });
    const patch = Object.fromEntries(ids.map((id, i) => [id, `v${i}`]));
    const created = await stub.create(note({ notebook: 'Wide', fields: patch }));
    expect(created.fields!.length).toBe(100);
    await expect(stub.update(created.id, { fields: { ...patch, extra: 'x' } })).rejects.toMatchObject({ name: 'InvalidFieldValue' });
  });
});

describe('composites', () => {
  it('answer what a route asks in one call', async () => {
    const { stub } = freshStore('composite');
    const nb = (await stub.createNotebook('Receipts'))!;
    const a = await stub.create(note({ notebook: 'Receipts', tags: ['x'] }));
    await stub.create(note({ title: 'Loose' }));
    await stub.recordAttachment({ id: 'a1', noteId: a.id, filename: 'scan.pdf', contentType: 'application/pdf', size: 1, r2Key: 'k1' });

    const page = await stub.listPage({ limit: 10 }, {});
    expect(page.items.length).toBe(2);
    expect(page.total).toBe(2);
    expect((await stub.listPage({ limit: 10 }, null)).total).toBeNull();

    // A first page that came up short is its own total, and that page above was one, so
    // on its own it never counts. A full first page cannot know what is past it: it has
    // to count, from the stored number and from the rows alike, or a list of two says one.
    const full = await stub.listPage({ limit: 1 }, {});
    expect(full.items.length).toBe(1);
    expect(full.total).toBe(2);
    // One untagged note and a limit of one: full, so counted from the rows.
    expect((await stub.listPage({ limit: 1, untagged: true }, { untagged: true })).total).toBe(1);

    const got = await stub.getWithFiles(a.id);
    expect(got!.note.id).toBe(a.id);
    expect(got!.files).toEqual([{ filename: 'scan.pdf', contentType: 'application/pdf', size: 1, read: 'pending', summary: null }]);
    expect(await stub.getWithFiles('ghost')).toBeNull();

    const overview = await stub.notebooksOverview({ fields: true });
    expect(overview).toEqual({ notebooks: [expect.objectContaining({ id: nb.id, count: 1 })], unfiled: 1, fields: [] });

    expect(await stub.pendingText(10, undefined, true)).toEqual({
      files: [expect.objectContaining({ id: 'a1', noteId: a.id })],
      remaining: 1,
    });
    expect(await stub.pendingText(10, a.id, false)).toEqual({ files: [expect.objectContaining({ id: 'a1' })] });

    const prelude = await stub.autofillPrelude(a.id, 5);
    expect(prelude!.note.id).toBe(a.id);
    expect(prelude!.forText.map((f) => f.id)).toEqual(['a1']);
    expect(prelude!.forVision).toEqual([]);
    expect(await stub.autofillPrelude('ghost', 5)).toBeNull();

    const context = await stub.autofillContext(a.id, 3, 5);
    expect(context.files).toEqual([{ filename: 'scan.pdf', contentType: 'application/pdf', text: null, readBy: null }]);
    expect(context.notebooks.length).toBe(1);
    expect(context.examples.notebooks).toBeInstanceOf(Map);
    expect(context.examples.notebooks.get(nb.id)).toEqual([]);
    expect(context.examples.tags).toEqual([{ id: expect.any(String), name: 'x', examples: [] }]);
  });

  it('exports a page with its texts, and cuts a page that would be too large with its own cursor', async () => {
    const { stub } = freshStore('export');
    const big = 'x'.repeat(5 * 1024 * 1024);
    const one = await stub.create(note({ title: 'One', body: big }));
    const two = await stub.create(note({ title: 'Two', body: big }));
    const three = await stub.create(note({ title: 'Three', body: 'small' }));
    await stub.recordAttachment({ id: 'a1', noteId: three.id, filename: 'scan.pdf', contentType: 'application/pdf', size: 1, r2Key: 'k1' });
    await stub.recordText({ attachmentId: 'a1', noteId: three.id, filename: 'scan.pdf', text: 'held text', readBy: 'vision' });
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec(`UPDATE notes SET created_at = 1, updated_at = 1 WHERE id = ?1`, one.id);
      state.storage.sql.exec(`UPDATE notes SET created_at = 2, updated_at = 2 WHERE id = ?1`, two.id);
      state.storage.sql.exec(`UPDATE notes SET created_at = 3, updated_at = 3 WHERE id = ?1`, three.id);
    });

    const first = await stub.exportPage({ limit: 10, sort: 'created', order: 'asc' }, {});
    // Both big bodies would pass the budget, so the page stops after the first and says where.
    expect(first.notes.map((n) => n.title)).toEqual(['One']);
    expect(first.total).toBe(3);
    expect(first.cursor).toBe(encodeCursor(1, one.id));
    // The second big body and the small one fit together; a short page is the end.
    const second = await stub.exportPage({ limit: 10, sort: 'created', order: 'asc', cursor: first.cursor! }, null);
    expect(second.notes.map((n) => n.title)).toEqual(['Two', 'Three']);
    expect(second.notes[1]!.body).toBe('small');
    expect(second.texts).toEqual([{ noteId: three.id, filename: 'scan.pdf', text: 'held text', readBy: 'vision' }]);
    expect(second.cursor).toBeNull();
    // A full page that fits gets the ordinary cursor.
    const paged = await stub.exportPage({ limit: 1, sort: 'created', order: 'asc', cursor: first.cursor! }, null);
    expect(paged.notes.map((n) => n.title)).toEqual(['Two']);
    expect(paged.cursor).toBe(encodeCursor(2, two.id));
  });
});

describe('rows read on an archive-sized store', () => {
  /**
   * The planner hazard the shared database had on `user_id` — an equality on the first
   * column of every index that matched nearly every row — is `deleted_at`'s here. These
   * bound the hot queries on a store big enough to show a plan that walks the table, so
   * a `+deleted_at` that stopped working, or a new index that tempted the planner away
   * from the tag, fails a test rather than a read budget.
   */
  it('keeps the hot queries to a few hundred rows at three thousand notes', async () => {
    const { stub } = freshStore('scale');
    await runInDurableObject(stub, (_i, state) => {
      const sql = state.storage.sql;
      state.storage.transactionSync(() => {
        for (let n = 0; n < 6; n++) sql.exec(`INSERT INTO notebooks (id, name, created_at) VALUES (?1, ?2, 1)`, `nb${n}`, `Notebook ${n}`);
        sql.exec(`INSERT INTO tags (id, name) VALUES ('rare', 'rare'), ('common', 'common')`);
        sql.exec(`INSERT INTO notebook_fields (id, notebook_id, name, type, position, created_at) VALUES ('amount', 'nb0', 'Amount', 'number', 0, 1)`);
        sql.exec(`INSERT INTO notebook_fields (id, notebook_id, name, type, options, position, created_at) VALUES ('kind', 'nb0', 'Kind', 'select', '["Other","Fuel","Bank"]', 1, 1)`);
        for (let i = 0; i < 3000; i++) {
          // The last thirty are a notebook of their own: a measure that is fine on a big
          // notebook can still read the whole account for a small one.
          const nb = i >= 2970 ? 'nb5' : `nb${i % 5}`;
          sql.exec(
            `INSERT INTO notes (id, title, body, created_at, updated_at, notebook_id) VALUES (?1, ?2, 'receipt total due', ?3, ?3, ?4)`,
            `n${String(i).padStart(5, '0')}`,
            // A few notes per title: an archive repeats titles, and the title cursor
            // settles ties by id, which reads every tie before the boundary row.
            `Title ${String(i % 700).padStart(3, '0')}`,
            1_000_000 + i,
            nb,
          );
          // Notebook 4 is the one that has nearly been tidied: all but three of its notes
          // carry a tag. Looking for what is left there is the untagged filter's worst case
          // and its real one — nothing lets a page stop before the end of the notebook.
          const tidied = nb === 'nb4' && i > 14;
          if (i % 2 === 0 || tidied) sql.exec(`INSERT INTO note_tags VALUES (?1, 'common')`, `n${String(i).padStart(5, '0')}`);
          if (i % 1000 === 0) sql.exec(`INSERT INTO note_tags VALUES (?1, 'rare')`, `n${String(i).padStart(5, '0')}`);
          if (i % 5 === 0) sql.exec(`INSERT INTO note_fields (note_id, field_id, value_text, value_num) VALUES (?1, 'amount', ?2, ?2)`, `n${String(i).padStart(5, '0')}`, i);
          // Off the notes measured one by one, whose bounds count a note's values.
          if (i % 10 === 5) sql.exec(`INSERT INTO note_fields (note_id, field_id, value_text) VALUES (?1, 'kind', 'Fuel')`, `n${String(i).padStart(5, '0')}`);
          if (i % 3 === 0) sql.exec(`INSERT INTO attachments (id, note_id, filename, content_type, size, r2_key, created_at) VALUES (?1, ?2, 'scan.pdf', 'application/pdf', 10, ?1, 1)`, `att-n${String(i).padStart(5, '0')}`, `n${String(i).padStart(5, '0')}`);
          // Text for every file, so a read of files' text by id that walked the table would show.
          if (i % 3 === 0) sql.exec(`INSERT INTO attachment_text (attachment_id, note_id, filename, text, created_at) VALUES (?1, ?2, 'scan.pdf', 'scanned page', 1)`, `att-n${String(i).padStart(5, '0')}`, `n${String(i).padStart(5, '0')}`);
        }
        // The feed as an import leaves it — one row per note — and then a thousand edits
        // over the first hundred notes, so a page can be dense with repeats.
        // Dated now: rows past the age window would be pruned by the first write below,
        // and the trash measurements would then be paying for the prune.
        const now = Date.now();
        for (let i = 0; i < 4000; i++) {
          sql.exec(`INSERT INTO changes (seq, entity, id, deleted, at) VALUES (?1, 'note', ?2, 0, ?3)`, i + 1, `n${String(i < 3000 ? i : i % 100).padStart(5, '0')}`, now);
        }
        sql.exec(`UPDATE _meta SET value = '4000' WHERE key = 'seq'`);
        // Five hundred files let go of in the last month, none yet due, and five from
        // before it: what the hourly visit must find without reading the five hundred.
        for (let i = 0; i < 505; i++) {
          sql.exec(`INSERT INTO deleted_blobs (r2_key, deleted_at) VALUES (?1, ?2)`, `users/u/gone/${i}`, i < 5 ? now - 40 * 86_400_000 : now - (i % 30) * 86_400_000);
        }
        // A full history on the first three hundred notes, the newest copy an hour old, so
        // a read of one note's copies that walked the table would show as fifteen thousand.
        for (let i = 0; i < 300; i++) {
          for (let k = 0; k < REVISIONS_KEPT; k++) {
            sql.exec(
              `INSERT INTO note_revisions (note_id, title, body, size, created_at, through) VALUES (?1, 'Earlier title', 'an earlier body', 15, ?2, ?2)`,
              `n${String(i).padStart(5, '0')}`,
              now - 3_600_000 - k * 3_600_000,
            );
          }
        }
        // Two years of Auto-fill used every day, four rows a day (MAK-180): the year's read
        // must take this year's rows off the key and never last year's.
        const thisYear = new Date().getUTCFullYear();
        for (const year of [thisYear - 1, thisYear]) {
          for (let d = 0; d < 365; d++) {
            const day = new Date(Date.UTC(year, 0, 1 + d)).toISOString().slice(0, 10);
            sql.exec(`INSERT INTO llm_usage (day, job, model, requests) VALUES (?1, 'press', '', 3)`, day);
            for (const job of ['read', 'title', 'fields']) {
              sql.exec(`INSERT INTO llm_usage (day, job, model, requests, input_tokens, output_tokens) VALUES (?1, ?2, 'claude-opus-5', 3, 4000, 300)`, day, job);
            }
          }
        }
      });
    });
    expect(await stub.recountNotes()).toBe(0);

    const measure = async (label: string, run: () => Promise<unknown>) => {
      await stub.resetCounters();
      await run();
      const { rowsRead, rowsWritten } = await stub.counters();
      return { label, rowsRead, rowsWritten };
    };
    const sortField = (await stub.fieldById('amount'))!;
    const now = Date.now();
    let held = 0;
    const results = [
      await measure('first page', () => stub.list({ limit: 50 })),
      await measure('first page by title', () => stub.list({ limit: 50, sort: 'title', order: 'asc' })),
      await measure('deep page by title', () => stub.list({ limit: 50, sort: 'title', order: 'asc', cursor: `Title 500\u001Fn00500` })),
      await measure('notebook page', () => stub.list({ limit: 50, notebook: 'Notebook 3' })),
      await measure('notebook page by created', () => stub.list({ limit: 50, notebook: 'Notebook 3', sort: 'created' })),
      await measure('rare tag page', () => stub.list({ limit: 50, tags: ['rare'] })),
      await measure('rare tag count', () => stub.count({ tags: ['rare'], notebook: 'Notebook 0' })),
      // A selection's export: ninety notes named by id, spread over the archive, each a
      // primary-key lookup — never a walk of the live notes to test each against the list.
      await measure('export page of named notes', () => {
        const ids = Array.from({ length: 90 }, (_, k) => `n${String(k * 33).padStart(5, '0')}`);
        return stub.exportPage({ limit: 100, sort: 'created', ids }, { sort: 'created', ids });
      }),
      await measure('field sort page', () => stub.list({ limit: 50, notebook: 'Notebook 0', sortField })),
      // The tags of a set, counted within it: the cost is the set's, so these are the
      // three sizes it can be — a notebook of six hundred, one of thirty, and a tag on three.
      await measure('tag counts in a big notebook', () => stub.tagCounts({ notebook: 'Notebook 3' })),
      await measure('tag counts in a small notebook', () => stub.tagCounts({ notebook: 'Notebook 5' })),
      await measure('tag counts under a rare tag', () => stub.tagCounts({ tags: ['rare'] })),
      await measure('tag counts under a rare tag in a notebook', () => stub.tagCounts({ tags: ['rare'], notebook: 'Notebook 0' })),
      // Notes without a tag: a page stops once it has fifty, a notebook's count reads each
      // of its notes once, and the account's reads every note — the one that is dear.
      await measure('untagged page', () => stub.list({ limit: 50, untagged: true })),
      await measure('untagged page in a small notebook', () => stub.list({ limit: 50, untagged: true, notebook: 'Notebook 5' })),
      await measure('untagged count in a big notebook', () => stub.count({ untagged: true, notebook: 'Notebook 3' })),
      await measure('untagged count in a small notebook', () => stub.count({ untagged: true, notebook: 'Notebook 5' })),
      await measure('untagged count', () => stub.count({ untagged: true })),
      await measure('untagged page where few are left', () => stub.list({ limit: 50, untagged: true, notebook: 'Notebook 4' })),
      await measure('untagged page where few are left, with its total', () =>
        stub.listPage({ limit: 50, untagged: true, notebook: 'Notebook 4' }, { untagged: true, notebook: 'Notebook 4' })),
      await measure('untagged page with its total', () => stub.listPage({ limit: 50, untagged: true }, { untagged: true })),
      await measure('compact page of 500', () => stub.list({ limit: 500, compact: true })),
      await measure('compact page of 500 with field values', () => stub.list({ limit: 500, compact: true, compactFields: ['amount'] })),
      await measure('notebook by name', () => stub.notebookByName('notebook 0')),
      await measure('field targets for 500 notes', () => stub.fieldTargets(Array.from({ length: 500 }, (_, k) => `n${String(k * 5).padStart(5, '0')}`))),
      await measure('get', () => stub.get('n01500')),
      // MCP's get_note and list_notes with a line per file (MAK-172): every third note has
      // a scan with text, so a hundred-note page carries thirty-four.
      await measure('get with files', () => stub.getWithFiles('n01500')),
      await measure('page of 100', () => stub.listPage({ limit: 100 }, null)),
      await measure('page of 100 with file summaries', () => stub.listPage({ limit: 100 }, null, { summaries: true })),
      await measure('stored counts', async () => {
        await stub.count();
        await stub.count({ notebook: 'Notebook 1' });
        await stub.count({ tags: ['common'] });
        await stub.count({ trashed: true });
      }),
      await measure('search common word', () => stub.search('receipt', 50)),
      // One letter is sent as typed now; its prefix walk is the index's, not the meter's.
      // MCP's search with a line per file of each match (MAK-172): fifty matches, a third with a scan.
      await measure('search common word with file summaries', () => stub.searchWithFiles('receipt', 50)),
      await measure('search one letter', () => stub.search('r', 50)),
      await measure('search in a small tag', () => stub.search('receipt', 50, { tags: ['rare'] })),
      // A table's search: the page above, plus the rows the list would draw for its matches.
      await measure('search rows in a notebook', () => stub.searchRows('receipt', 50, { notebook: 'Notebook 0' })),
      // What the sweep reads every hour, for every account: it must never scan a table.
      await measure('usage', () => stub.usage()),
      // What every upload reads for the plan's quota (lib/quota.ts): the counts row alone.
      await measure('attachment bytes', () => stub.attachmentBytes()),
      await measure('sweep visit', () => stub.sweepVisit(now)),
      await measure('forget expired files', () => stub.forgetBlobs(Array.from({ length: 5 }, (_, i) => `users/u/gone/${i}`), now)),
      await measure('sweep visit with nothing due', () => stub.sweepVisit(now)),
      // The daily backup's dump (MAK-171): every row of every table, by design. Bounded
      // below against the store's own row count, not here.
      await measure('dump', async () => {
        // The rows it should read, counted on the raw storage, which the meter does not see.
        held = await runInDurableObject(stub, (_i, state) =>
          DUMP_TABLES.reduce((sum, table) => sum + state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n, 0),
        );
        const { chunks } = await beginDump(stub, 'scale');
        for await (const _ of chunks!);
      }),
      await measure('trash one', () => stub.remove('n00010')),
      await measure('trash many', () => stub.removeMany(['n00011', 'n00012', 'n00013'])),
      // The trash opening a note: the same read without `deleted_at`, which must stay a
      // lookup by id rather than a walk of the trash.
      await measure('get trashed', () => stub.get('n00010', { includeTrashed: true })),
      // The feed: a page of a hundred changed notes loaded whole, from the start and from
      // the dense tail; a hydration page of the same size; and the two checks a cursor
      // the feed cannot serve costs.
      await measure('feed page', () => stub.changesSince(0, 100)),
      await measure('feed page dense', () => stub.changesSince(3000, 100)),
      await measure('feed nothing new', async () => stub.changesSince((await stub.changesSince(99_999_999, 1)).seq, 100)),
      await measure('feed reset', () => stub.changesSince(99_999, 100)),
      await measure('snapshot page', () => stub.snapshotPage(null, 100)),
      await measure('snapshot page deep', () => stub.snapshotPage('n02000', 100)),
      await measure('texts by id', () => stub.textsById(Array.from({ length: 25 }, (_, k) => `att-n${String(k * 3).padStart(5, '0')}`))),
      // An Auto-fill press: the note, its unread files, and the day's press row checked and
      // counted. Then the year read back for Maintenance.
      await measure('autofill press', () => stub.autofillPrelude('n01500', 5, { cap: 1000 })),
      await measure('autofill usage', () => stub.autofillUsage()),
      // History. A save inside the window asks for the newest copy and keeps nothing;
      // one outside it keeps a copy and prunes the note's oldest. Then the sheet's
      // two reads, and a copy put back.
      await measure('save that keeps a copy', () => stub.update('n00020', { body: 'rewritten' })),
      await measure('save inside the window', () => stub.update('n00020', { body: 'rewritten again' })),
      // A save that changes no text keeps a copy too (MAK-170), and reads the note's
      // tags once more, by id, for what the copy holds. Then fifty notes changed at
      // once, each with a full history and outside the window: the worst a bulk verb
      // does per call, and what an assistant's batch does every time.
      await measure('tag-only save that keeps a copy', () => stub.update('n00023', { tags: ['filed'] })),
      await measure(
        'bulk change that keeps fifty copies',
        () => stub.updateMany(Array.from({ length: 50 }, (_, k) => `n${String(100 + k).padStart(5, '0')}`), { addTags: ['filed'] }),
      ),
      // The same fifty again, now inside their window: nothing is kept, and no note is
      // read whole to find that out.
      await measure(
        'bulk change inside the window',
        () => stub.updateMany(Array.from({ length: 50 }, (_, k) => `n${String(100 + k).padStart(5, '0')}`), { addTags: ['refiled'] }),
      ),
      // Fifty new notes into a big notebook, half of them titles it already holds: a probe
      // of the notebook's title index each, and the writes of the twenty-five made.
      await measure('create fifty, skipping titles held', () =>
        stub.createMany(
          Array.from({ length: 50 }, (_, k) => ({
            id: crypto.randomUUID(),
            title: k % 2 === 0 ? `Title ${String(k * 5).padStart(3, '0')}` : `Fresh ${k}`,
            body: '',
            tags: [],
            notebook: 'Notebook 0',
          })),
          { skipExisting: true },
        ),
      ),
      // The same for notes filed nowhere, the other statement the check has: the index's
      // null notebook run, which no note of this store is in.
      await measure('create fifty unfiled, skipping titles held', () =>
        stub.createMany(
          Array.from({ length: 50 }, (_, k) => ({ id: crypto.randomUUID(), title: `Fresh unfiled ${k % 25}`, body: '', tags: [] })),
          { skipExisting: true },
        ),
      ),
      await measure('history list', () => stub.listRevisions('n00021')),
      await measure('history copy', async () => stub.getRevision('n00021', (await stub.listRevisions('n00021'))![5]!.id)),
      await measure('history restore', async () => stub.restoreRevision('n00021', (await stub.listRevisions('n00021'))![5]!.id)),
      // A note with a full history, untouched above.
      await measure('history clear', () => stub.clearRevisions('n00022')),
      await measure('option sort', () => stub.editFieldOptions('nb0', 'kind', { sort: 'alpha', pinLast: ['Other'] })),
      await measure('option rename', () => stub.editFieldOptions('nb0', 'kind', { rename: [{ from: 'Fuel', to: 'Petrol' }] })),
    ];
    console.log(results.map((r) => `${r.label}: ${r.rowsRead} read, ${r.rowsWritten} written`).join('\n'));
    const bounds: Record<string, number> = {
      'first page': 400,
      'first page by title': 400,
      'deep page by title': 400,
      'notebook page': 400,
      'notebook page by created': 400,
      'rare tag page': 60,
      'rare tag count': 20,
      // Whole notes with their files' text, so dearer a note than a list row: 1,478 for
      // ninety (2026-10-09) — 180 of them the count, two a note. A plan that walked the
      // live notes would read three thousand before it started on the files.
      'export page of named notes': 1700,
      'field sort page': 600,
      // A notebook's tags cost about two and a half rows a note — the note, its links —
      // and no more: 1,489 for 594 notes, 77 for 30 (2026-10-04). A plan that started from
      // the links would read the account's 1,500 of them whatever the notebook, so the
      // small one is what shows it.
      'tag counts in a big notebook': 1800,
      'tag counts in a small notebook': 120,
      'tag counts under a rare tag': 60,
      'tag counts under a rare tag in a notebook': 60,
      // A note is read once and asked once of its links, so a count is a row and a half a
      // note in scope and a page stops after the first fifty that have no tag (measured
      // 2026-10-04: 313 and 97 for the pages, 893 and 46 in a notebook, 4,500 for all
      // 3,000 notes; the account-wide count is 4,796 now that one notebook is nearly all
      // tagged, a found link being a row where a missing one is not). The account-wide
      // count is the dear one, and why the tool's description tells a caller with a
      // large archive to name a notebook.
      'untagged page': 450,
      'untagged page in a small notebook': 150,
      'untagged count in a big notebook': 1200,
      'untagged count in a small notebook': 80,
      'untagged count': 5200,
      // The page that cannot stop early: three untagged notes in a notebook of 597, so
      // every note is read and asked for its links before the page comes back short —
      // two rows a note (1,193, measured 2026-10-04). This is what the filter costs when
      // it is used for what it is for.
      'untagged page where few are left': 1400,
      // With its total it costs the same 1,193: a first page that came up short is its
      // own count, where counting separately walked the notebook a second time.
      'untagged page where few are left, with its total': 1400,
      // A full first page still counts, since it cannot know what is past it: the page's
      // 313 and the account's 4,796 (5,151 measured).
      'untagged page with its total': 5600,
      // Three and a half rows a note: the note, its notebook, its tag links and their
      // names (1,749, measured 2026-10-04). The same page with its field values and files
      // read 2,885, and read every body into the object besides.
      'compact page of 500': 2000,
      // The same page with one field's values: a probe of the values' key per note for
      // the field named, and its definition for each value found. A note's other values
      // are never read, so this does not grow with how many fields a notebook has (2,295,
      // measured 2026-10-14).
      'compact page of 500 with field values': 2500,
      // A probe of the notebook's title index per note, a row or two, and the rows each
      // new note writes (228 read, measured 2026-10-14). A check that read the notebook
      // would be six hundred rows for each note.
      'create fifty, skipping titles held': 400,
      // Unfiled, on the same index's null run; a plan that looked for the null notebook by
      // walking the notes would read the store's three thousand (78, measured 2026-10-14).
      'create fifty unfiled, skipping titles held': 200,
      // The notebook's row by name and its definitions: nothing that grows with the notes.
      'notebook by name': 12,
      // Five hundred notes of one notebook by id, two rows a note — the key, then the
      // row — and the notebook's name and definitions once (1,003, measured 2026-10-04).
      // Joined to its notebook per note it was 1,502.
      'field targets for 500 notes': 1200,
      get: 10,
      // The note, its files by the note's index and each one's text by key (17, measured
      // 2026-10-05).
      'get with files': 30,
      // A full page, then the same page with a line per file: about six rows for each of
      // its thirty-four files and nothing that grows with the account (600 and 797,
      // measured 2026-10-05). A summary that walked the text table would be thousands.
      'page of 100': 700,
      'page of 100 with file summaries': 950,
      'stored counts': 10,
      // The press row by its key and its upsert, on top of the note and its files (21,
      // measured 2026-10-08).
      'autofill press': 30,
      // A year used every day is 1,460 rows, and that is what it reads: this year's, off
      // the primary key, and none of last year's 1,460 (1,460, measured 2026-10-08).
      // Maintenance's, once a visit, so a whole year is fine; a scan would be double.
      'autofill usage': 1600,
      // The counts row and the newest feed row, off its primary key.
      usage: 5,
      // One column of the counts row; the triggers (schema 0008) keep it, so it never
      // reads the files table however many files the account holds.
      'attachment bytes': 2,
      // Sorting, pinning or adding moves no value, so it reads the field's row and nothing
      // that grows with the notes (8, measured 2026-10-15). A rename reads the field's
      // values once and touches each holder, three rows a value with its search entry
      // (908 for three hundred values, measured 2026-10-15): the price of moving them.
      'option sort': 20,
      'option rename': 1100,
      // The counts row and the five due keys off the retention index; the five hundred
      // tombstones not yet due are never read (7, measured 2026-10-05), and with nothing
      // due the visit is the counts row and one index entry (2). The hourly sweep makes
      // this read on every account. Forgetting is four rows a key, the row and its two
      // index entries (20 for five); a thousand keys is four thousand, never the table.
      'sweep visit': 12,
      'forget expired files': 30,
      'sweep visit with nothing due': 4,
      'search common word': 2500,
      // The search's own 502 and the files of its fifty matches, each asked by the note's
      // index whether it has any (670, measured 2026-10-05).
      'search common word with file summaries': 800,
      'search one letter': 2500,
      'search in a small tag': 80,
      'search rows in a notebook': 1500,
      // A write reads its feed row back in (the insert counts one), the counter, and the
      // oldest row for the age prune: three more for one note, five for three (2026-10-02).
      'trash one': 20,
      'trash many': 50,
      'get trashed': 10,
      // About thirteen rows per note: its size, read ahead of the cut, then the note
      // whole — the row, its tags by id and name, values and files, each probed by id —
      // plus the hundred feed rows (measured 2026-10-02 at 1,336).
      'feed page': 1500,
      'feed page dense': 1500,
      'feed nothing new': 8,
      'feed reset': 4,
      'snapshot page': 1500,
      'snapshot page deep': 1500,
      // Twenty-five files of a thousand with text, by primary key: a walk of the table would be in the thousands.
      'texts by id': 160,
      // A save reads the note twice, before and after, and its feed rows; history adds
      // two for the newest copy. Keeping one adds the note's run of the index twice for
      // the prune, about fifty entries each, and its tags by id for what the copy holds
      // (measured 2026-10-04 at 134 and 25).
      'save that keeps a copy': 160,
      'save inside the window': 35,
      // The same save without the text, and with the tags read by id for the copy (127).
      'tag-only save that keeps a copy': 160,
      // A save's worth for each note changed: about 126 a note when every one has a full
      // history to prune, which is the ceiling; a note with a copy or two is about
      // twenty (6,305 for the fifty, measured 2026-10-04). It grows with the notes
      // written, never with the ids sent or the size of the archive. The route takes
      // five hundred ids (`MAX_BATCH_NOTES`), so the ceiling for one call is ten times
      // this, about 63,000 rows, and only for five hundred notes that each have fifty
      // copies and are all outside their window; a selection of ordinary notes is
      // nearer 10,000.
      'bulk change that keeps fifty copies': 7000,
      // About fifteen a note: the verb's own reads and feed rows, and each note's newest
      // copy asked for. No note is read whole (766, measured 2026-10-04).
      'bulk change inside the window': 900,
      // One note's fifty copies, of fifteen thousand (51 and 53).
      'history list': 65,
      'history copy': 70,
      // A restore keeps a copy too, so it is the list, the prune and the save (167).
      'history restore': 200,
      // The note's live row, then its fifty copies and their index entries (152).
      'history clear': 180,
    };
    for (const r of results) {
      if (r.label === 'dump') continue;
      expect(r.rowsRead, r.label).toBeLessThanOrEqual(bounds[r.label]!);
    }
    // A dump reads every row; what it must not do is read any of them twice, which a
    // slice that restarted its table, or a page by OFFSET, would. Every row once, plus
    // the schema's entries in `sqlite_master`, the feed's two `_meta` rows for the mark
    // and one row per slice cut (here none: this store is one slice). Measured
    // 2026-10-05: 27,008 read for 26,917 held.
    const dump = results.find((r) => r.label === 'dump')!;
    expect(dump.rowsRead).toBeGreaterThanOrEqual(held);
    expect(dump.rowsRead).toBeLessThanOrEqual(held + 150);
    expect(dump.rowsWritten).toBe(0);
    // Rows written are metered too, and a bulk change now keeps a copy of each note
    // outside its window: the copy, its index entry and the prune of the oldest, about
    // three rows a note on top of what the verb itself writes (551 against 406 inside
    // the window, measured 2026-10-04). Five hundred ids is ten times this.
    const writeBounds: Record<string, number> = {
      'bulk change that keeps fifty copies': 650,
      'bulk change inside the window': 480,
    };
    for (const r of results) {
      if (r.label in writeBounds) expect(r.rowsWritten, r.label).toBeLessThanOrEqual(writeBounds[r.label]!);
    }
  });
});

describe('notes: an id the client chose', () => {
  it('answers a taken id with the note that holds it, trashed or not, and writes nothing', async () => {
    const { stub } = freshStore('client-id');
    const first = await stub.createOrFind(note({ id: 'client-chosen', title: 'Mine' }));
    expect(first).toEqual({ note: expect.objectContaining({ id: 'client-chosen', title: 'Mine' }), existing: false });
    expect(first.note).not.toHaveProperty('existing');
    const again = await stub.createOrFind(note({ id: 'client-chosen', title: 'Replayed' }));
    expect(again).toEqual({ note: expect.objectContaining({ id: 'client-chosen', title: 'Mine' }), existing: true });
    expect(await stub.count()).toBe(1);
    await stub.remove('client-chosen');
    const trashed = await stub.createOrFind(note({ id: 'client-chosen', title: 'Replayed again' }));
    expect(trashed).toEqual({ note: expect.objectContaining({ id: 'client-chosen', title: 'Mine', deletedAt: expect.any(Number) }), existing: true });
    // The plain create keeps the insert's own refusal of a taken id.
    await expect(stub.create(note({ id: 'client-chosen', title: 'Again' }))).rejects.toThrow();
    // A duplicate replayed with the copy's id finds the copy.
    const source = await stub.create(note({ title: 'Source' }));
    const copy = await stub.duplicateOrFind(source.id, 'copy-chosen');
    expect(copy).toEqual({ note: expect.objectContaining({ id: 'copy-chosen', title: 'Source' }), existing: false });
    expect(await stub.duplicateOrFind(source.id, 'copy-chosen')).toEqual({ note: expect.objectContaining({ id: 'copy-chosen' }), existing: true });
    expect(await stub.duplicateOrFind('ghost', 'another')).toBeNull();
    expect(await stub.count()).toBe(2);
  });
});
