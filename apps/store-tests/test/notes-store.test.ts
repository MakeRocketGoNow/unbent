import { describe, expect, it } from 'vitest';
import { runInDurableObject } from 'cloudflare:test';
import { UNFILED } from '@unbent/shared';
import { freshStore } from './helpers.js';

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
    const inTag = await stub.create(note({ title: 'Car', body: 'nothing', tags: ['Alfa Romeo Stelvio'] }));
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
    expect(await stub.search('stelvio', 20)).toEqual([expect.objectContaining({ id: inTag.id, matchedTag: 'Alfa Romeo Stelvio' })]);
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
    expect(second.skipped).toEqual([
      { kind: 'emoji', name: '🧾', reason: 'Already 🎟️ here; left as it is' },
      { name: 'value', reason: 'Already here as number, not text; left as it is' },
    ]);
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
    expect(await stub.previewConversion(nb.id, rating.id, 'number', { max: 5, step: 1 })).toEqual({ values: 2, incompatible: 1 });
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

    const got = await stub.getWithFiles(a.id);
    expect(got!.note.id).toBe(a.id);
    expect(got!.files).toEqual([{ filename: 'scan.pdf', contentType: 'application/pdf', size: 1 }]);
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

    const read = await stub.attachmentReadPrelude(a.id, 'scan.pdf', 5);
    expect(read).toEqual({ text: '', forText: [expect.objectContaining({ id: 'a1' })], forVision: [] });
    expect(await stub.attachmentReadPrelude('ghost', 'scan.pdf', 5)).toBeNull();
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
    expect(first.cursor).toBe(`1\u001F${one.id}`);
    // The second big body and the small one fit together; a short page is the end.
    const second = await stub.exportPage({ limit: 10, sort: 'created', order: 'asc', cursor: first.cursor! }, null);
    expect(second.notes.map((n) => n.title)).toEqual(['Two', 'Three']);
    expect(second.notes[1]!.body).toBe('small');
    expect(second.texts).toEqual([{ noteId: three.id, filename: 'scan.pdf', text: 'held text', readBy: 'vision' }]);
    expect(second.cursor).toBeNull();
    // A full page that fits gets the ordinary cursor.
    const paged = await stub.exportPage({ limit: 1, sort: 'created', order: 'asc', cursor: first.cursor! }, null);
    expect(paged.notes.map((n) => n.title)).toEqual(['Two']);
    expect(paged.cursor).toBe(`2\u001F${two.id}`);
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
          if (i % 2 === 0) sql.exec(`INSERT INTO note_tags VALUES (?1, 'common')`, `n${String(i).padStart(5, '0')}`);
          if (i % 1000 === 0) sql.exec(`INSERT INTO note_tags VALUES (?1, 'rare')`, `n${String(i).padStart(5, '0')}`);
          if (i % 5 === 0) sql.exec(`INSERT INTO note_fields (note_id, field_id, value_text, value_num) VALUES (?1, 'amount', ?2, ?2)`, `n${String(i).padStart(5, '0')}`, i);
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
      });
    });
    expect(await stub.recountNotes()).toBe(0);

    const measure = async (label: string, run: () => Promise<unknown>) => {
      await stub.resetCounters();
      await run();
      const { rowsRead } = await stub.counters();
      return { label, rowsRead };
    };
    const sortField = (await stub.fieldById('amount'))!;
    const results = [
      await measure('first page', () => stub.list({ limit: 50 })),
      await measure('first page by title', () => stub.list({ limit: 50, sort: 'title', order: 'asc' })),
      await measure('deep page by title', () => stub.list({ limit: 50, sort: 'title', order: 'asc', cursor: `Title 500\u001Fn00500` })),
      await measure('notebook page', () => stub.list({ limit: 50, notebook: 'Notebook 3' })),
      await measure('notebook page by created', () => stub.list({ limit: 50, notebook: 'Notebook 3', sort: 'created' })),
      await measure('rare tag page', () => stub.list({ limit: 50, tags: ['rare'] })),
      await measure('rare tag count', () => stub.count({ tags: ['rare'], notebook: 'Notebook 0' })),
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
      await measure('get', () => stub.get('n01500')),
      await measure('stored counts', async () => {
        await stub.count();
        await stub.count({ notebook: 'Notebook 1' });
        await stub.count({ tags: ['common'] });
        await stub.count({ trashed: true });
      }),
      await measure('search common word', () => stub.search('receipt', 50)),
      // One letter is sent as typed now; its prefix walk is the index's, not the meter's.
      await measure('search one letter', () => stub.search('r', 50)),
      await measure('search in a small tag', () => stub.search('receipt', 50, { tags: ['rare'] })),
      // A table's search: the page above, plus the rows the list would draw for its matches.
      await measure('search rows in a notebook', () => stub.searchRows('receipt', 50, { notebook: 'Notebook 0' })),
      // What the sweep reads every hour, for every account: it must never scan a table.
      await measure('usage', () => stub.usage()),
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
    ];
    console.log(results.map((r) => `${r.label}: ${r.rowsRead}`).join('\n'));
    const bounds: Record<string, number> = {
      'first page': 400,
      'first page by title': 400,
      'deep page by title': 400,
      'notebook page': 400,
      'notebook page by created': 400,
      'rare tag page': 60,
      'rare tag count': 20,
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
      // 3,000 notes). The account-wide count is the dear one, and why the tool's
      // description tells a caller with a large archive to name a notebook.
      'untagged page': 450,
      'untagged page in a small notebook': 150,
      'untagged count in a big notebook': 1200,
      'untagged count in a small notebook': 80,
      'untagged count': 5200,
      get: 10,
      'stored counts': 10,
      usage: 4,
      'search common word': 2500,
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
    };
    for (const r of results) {
      expect(r.rowsRead, r.label).toBeLessThanOrEqual(bounds[r.label]!);
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
