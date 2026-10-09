import { describe, expect, it } from 'vitest';
import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { beginDump } from '@unbent/api/lib/dump';
import { scanStatements } from '@unbent/api/store/load';
import { SCHEMA } from '@unbent/api/store/schema/index';
import { freshStore } from './helpers.js';

/**
 * Loading a dump into a store (MAK-171, part 4), against the real object: a populated
 * store dumped through the stub, changed, and put back from the dump, with every table's
 * count and the search index compared; the same dump in pages cut anywhere; the marker
 * that keeps a half-loaded store from answering; and what finish checks before it clears
 * it. The route's streaming and the dump it writes first are in lib/load.ts and are
 * checked by the live suite's non-operator case and, for real, on the dev instance.
 */

/** One account's dump as the daily run and the dump route write it, as text. */
async function dumpOf(stub: ReturnType<typeof freshStore>['stub'], userId: string): Promise<string> {
  const dump = await beginDump(stub, userId);
  const parts: Uint8Array[] = [];
  for await (const chunk of dump.chunks!) parts.push(chunk);
  const whole = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    whole.set(p, at);
    at += p.byteLength;
  }
  return new TextDecoder().decode(whole);
}

/** The route's loop, with the page size a parameter: begin, every page, finish. */
async function load(stub: ReturnType<typeof freshStore>['stub'], text: string, pageBytes = 8 * 1024 * 1024) {
  const bytes = new TextEncoder().encode(text);
  const { loadId, undo } = await stub.loadBegin({ key: 'stores/test/2026-10-06.sql', before: null });
  let pages = 0;
  for (let at = 0; at < bytes.byteLength; at += pageBytes) {
    await stub.loadPage(loadId, bytes.subarray(at, Math.min(bytes.byteLength, at + pageBytes)));
    pages += 1;
  }
  const result = await stub.loadFinish(loadId);
  return { ...result, undo, pagesSent: pages };
}

/** A store with something in every data table: what a dump has to carry back whole. */
async function populate(stub: ReturnType<typeof freshStore>['stub']) {
  const notebook = (await stub.createNotebook('Coupons'))!;
  const field = (await stub.createField(notebook.id, { name: 'Store', type: 'select', options: ['Acme', 'Globex'] })) as { id: string };
  const kept = await stub.create({
    id: crypto.randomUUID(),
    title: 'Kept note',
    body: "it's got a 'quote'; and a semicolon\nand a second line",
    tags: ['one', 'two'],
    notebook: 'Coupons',
    fields: { [field.id]: 'Acme' },
  });
  // An edit keeps a revision of the first body.
  await stub.update(kept.id, { body: 'edited body about a hedgehog' });
  const trashed = await stub.create({ id: crypto.randomUUID(), title: 'Trashed', body: 'in the trash', tags: ['two'] });
  await stub.remove(trashed.id);
  await stub.recordAttachment({ id: `${kept.id}-scan`, noteId: kept.id, filename: 'scan.pdf', contentType: 'application/pdf', size: 10, r2Key: `users/x/${kept.id}/scan.pdf` });
  await stub.recordText({ attachmentId: `${kept.id}-scan`, noteId: kept.id, filename: 'scan.pdf', text: 'scanned words about a receipt' });
  // A file let go of, so `deleted_blobs` has a row the loaded store still owes.
  await stub.recordAttachment({ id: `${kept.id}-gone`, noteId: kept.id, filename: 'gone.pdf', contentType: 'application/pdf', size: 10, r2Key: `users/x/${kept.id}/gone.pdf` });
  await stub.removeAttachment(kept.id, 'gone.pdf');
  // An Auto-fill press and what its title cost, so `llm_usage` has rows to carry.
  await stub.autofillPrelude(kept.id, 5, { cap: null });
  await stub.recordLlmUsage([{ job: 'title', model: 'claude-opus-5', inputTokens: 400, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 }]);
  return { kept, trashed, notebook };
}

/**
 * Rows the runtime cannot run as one statement: a body of a megabyte and a half and a
 * file's text of half a million characters, each a dump statement past
 * `MAX_STATEMENT_CHARS`, which the load binds rather than runs as text. The real corpus
 * is PDFs whose extracted text runs long, so this is every archive's load.
 */
async function populateBig(stub: ReturnType<typeof freshStore>['stub']) {
  const big = await stub.create({ id: crypto.randomUUID(), title: 'Big body', body: `start; it's long. ${'word '.repeat(300_000)} the needle-in-a-haystack end`, tags: [] });
  await stub.recordAttachment({ id: `${big.id}-scan`, noteId: big.id, filename: 'long.pdf', contentType: 'application/pdf', size: 10, r2Key: `users/x/${big.id}/long.pdf` });
  await stub.recordText({ attachmentId: `${big.id}-scan`, noteId: big.id, filename: 'long.pdf', text: `${'text '.repeat(100_000)} a rare-word at the end` });
  // Forty thousand CJK characters: under the limit counted as characters, over it in
  // bytes, which is the limit the runtime applies.
  await stub.create({ id: crypto.randomUUID(), title: 'Wide body', body: `${'中'.repeat(40_000)} 終わり`, tags: [] });
  return big;
}

describe('loading a dump', () => {
  it('puts a changed store back as the dump had it, with its counts, its search index and a new epoch', async () => {
    const { userId, stub } = freshStore('load');
    const { kept } = await populate(stub);
    const before = await stub.stats();
    const epochBefore = await runInDurableObject(stub, (_i, state) =>
      state.storage.sql.exec<{ value: string }>(`SELECT value FROM _meta WHERE key = 'feed_epoch'`).toArray()[0]!.value,
    );
    const text = await dumpOf(stub, userId);
    for (const table of Object.keys(before.counts)) expect(before.counts[table as keyof typeof before.counts], table).toBeGreaterThan(0);

    // Change the store past recognition, then load the dump over it.
    await stub.purge('all');
    await stub.create({ id: crypto.randomUUID(), title: 'After the dump', body: 'not in it', tags: [] });
    expect((await stub.stats()).counts.notes).toBe(1);

    const result = await load(stub, text);
    expect(result.stats.counts).toEqual(before.counts);
    expect(result.stats.migrations).toEqual(before.migrations);
    expect(result.stats.loading).toBeNull();
    expect(result.migrated).toEqual([]);
    expect(result.foreignKeyViolations).toBe(0);
    expect(result.statements).toBeGreaterThan(20);
    expect(result.pages).toBe(1);
    // Miniflare keeps no history to restore to and answers a bookmark of zeros, which
    // reads as none; a deployed object answers a real one.
    expect(result.undo).toBeNull();
    expect(result.feedEpoch).not.toBe(epochBefore);

    // The note is back with its body, tags, field and file; the search index, rebuilt
    // from the rows, finds it by body and by its file's text; the counts the triggers keep
    // need no correction; the feed's counter is the dump's.
    const note = await stub.get(kept.id);
    expect(note).toMatchObject({ title: 'Kept note', body: 'edited body about a hedgehog', tags: ['one', 'two'] });
    expect((await stub.listAttachments(kept.id)).map((a) => a.filename)).toEqual(['scan.pdf']);
    expect((await stub.search('hedgehog', 10)).map((r) => r.id)).toEqual([kept.id]);
    expect((await stub.search('receipt', 10)).map((r) => r.id)).toEqual([kept.id]);
    expect(await stub.recountNotes()).toBe(0);
    expect((await stub.listRevisions(kept.id))!.length).toBe(before.counts.note_revisions);
    expect((await stub.tombstonedBlobKeys()).keys.length).toBe(1);
    const meta = await runInDurableObject(stub, (_i, state) =>
      Object.fromEntries(state.storage.sql.exec<{ key: string; value: string }>(`SELECT key, value FROM _meta`).toArray().map((r) => [r.key, r.value])),
    );
    expect(meta.user_id).toBe(userId);
    expect(meta.feed_epoch).toBe(result.feedEpoch);
    // The store can be written to again, and the write records after the dump's counter.
    await stub.create({ id: crypto.randomUUID(), title: 'After the load', body: 'written again', tags: [] });
    expect((await stub.stats()).counts.notes).toBe(before.counts.notes + 1);
  });

  it('runs a row too long for one statement with its values bound, whole and across pages', async () => {
    const { userId, stub } = freshStore('load-big');
    await populate(stub);
    const big = await populateBig(stub);
    const before = await stub.stats();
    const text = await dumpOf(stub, userId);
    expect(text.length).toBeGreaterThan(2_000_000);
    for (const size of [8 * 1024 * 1024, 65_536]) {
      const result = await load(stub, text, size);
      expect(result.stats.counts, `page size ${size}`).toEqual(before.counts);
      const note = await stub.get(big.id);
      expect(note!.body.length).toBeGreaterThan(1_500_000);
      expect(note!.body.endsWith('the needle-in-a-haystack end')).toBe(true);
      expect((await stub.search('needle-in-a-haystack', 10)).map((r) => r.id)).toEqual([big.id]);
      expect((await stub.search('rare-word', 10)).map((r) => r.id)).toEqual([big.id]);
      expect((await stub.search('終わり', 10)).length, `page size ${size}`).toBe(1);
    }
  });

  it('loads the same whatever the page size, with statements and characters split across pages', async () => {
    const { userId, stub } = freshStore('load-pages');
    await populate(stub);
    // Multibyte characters, so a page cut inside one has to be joined by the decoder.
    await stub.create({ id: crypto.randomUUID(), title: 'Ünïcödé — 日本語', body: '😀'.repeat(300), tags: ['émoji'] });
    const before = await stub.stats();
    const text = await dumpOf(stub, userId);
    for (const size of [1000, 7, 65_536]) {
      const result = await load(stub, text, size);
      expect(result.stats.counts, `page size ${size}`).toEqual(before.counts);
      expect(result.pages, `page size ${size}`).toBe(result.pagesSent);
      expect((await stub.search('émoji', 10)).length, `page size ${size}`).toBe(1);
      expect((await stub.listTags()).map((t) => t.name).sort()).toEqual(['one', 'two', 'émoji']);
    }
  });

  it('leaves the runtime\'s key-value table out of a dump taken after a load, and loads a dump that carries it', async () => {
    // A load writes the object's key-value storage, which is when `_cf_KV` appears in
    // `sqlite_master`; the day's dump then carried its CREATE, and could not be loaded
    // into an object that has the table already (MAK-197, found in the rehearsal).
    const { stub, userId } = freshStore('kv-table');
    await populate(stub);
    const before = await dumpOf(stub, userId);
    await load(stub, before);
    const after = await dumpOf(stub, userId);
    expect(after).not.toContain('_cf_KV');
    expect(await runInDurableObject(stub, (_i, state) => state.storage.sql.exec(`SELECT name FROM sqlite_master WHERE name = '_cf_KV'`).toArray().length)).toBe(1);
    // A dump written before the fix, with the runtime's table in it, loads as if it were not there.
    const old = before.replace('BEGIN;', `BEGIN;\nCREATE TABLE _cf_KV (\n        key TEXT PRIMARY KEY,\n        value BLOB\n      ) WITHOUT ROWID;`);
    expect(old).toContain('_cf_KV');
    const result = await load(stub, old);
    expect(result.stats.loading).toBeNull();
    expect(result.stats.counts.notes).toBeGreaterThan(0);
  });

  it('refuses every data call while loading, across an eviction, and a page from a load that is over', async () => {
    const { userId, stub } = freshStore('load-marker');
    await populate(stub);
    const text = await dumpOf(stub, userId);
    const { loadId } = await stub.loadBegin({ key: 'stores/test/2026-10-06.sql', before: 'stores/test/first-before-load.sql' });
    const stats = await stub.stats();
    expect(stats.loading).toMatchObject({ id: loadId, key: 'stores/test/2026-10-06.sql', pages: 0, before: 'stores/test/first-before-load.sql' });
    expect(stats.counts.notes).toBe(0);

    // Evicted mid-load: the marker is read before any schema is built, the store still
    // refuses, and the page cannot continue, since the remainder went with the instance.
    // (Evicted before any call is refused: a call the object threw out of holds a
    // reference the eviction waits on, measured 2026-10-06.)
    await evictDurableObject(stub);
    const woke = env.USER_STORE.get(env.USER_STORE.idFromName(userId));
    await expect(woke.list({ limit: 10 })).rejects.toMatchObject({ name: 'StoreLoading', retryable: true });
    await expect(woke.usage()).rejects.toMatchObject({ retryable: true });
    await expect(woke.dumpBegin()).rejects.toMatchObject({ retryable: true });
    expect((await woke.stats()).loading).toMatchObject({ id: loadId });
    await expect(woke.loadPage(loadId, new TextEncoder().encode('CREATE TABLE x (a);'))).rejects.toThrow(/interrupted/);
    await expect(woke.loadFinish(loadId)).rejects.toThrow(/interrupted/);
    const tables = await runInDurableObject(woke, (_i, state) =>
      state.storage.sql.exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'`).toArray(),
    );
    expect(tables).toEqual([]);

    // Starting again is the way out — the route does it with no dump taken first, since
    // the store holds nothing worth one — and the object keeps the first attempt's ways
    // back rather than offering a bookmark of the half-loaded store. A page of the old
    // load is refused once it has.
    const again = await woke.loadBegin({ key: 'stores/test/2026-10-07.sql', before: null });
    expect(again.before).toBe('stores/test/first-before-load.sql');
    expect((await woke.stats()).loading).toMatchObject({ id: again.loadId, before: 'stores/test/first-before-load.sql', undo: null });
    const result = await load(woke, text);
    expect(result.stats.loading).toBeNull();
    await expect(woke.loadPage(loadId, new Uint8Array())).rejects.toThrow(/no load is in flight/);
    expect((await woke.list({ limit: 10 })).length).toBe(1);
  });

  it('applies the schema files a dump from an older schema lacks, before the store answers', async () => {
    const { userId, stub } = freshStore('load-older');
    await populate(stub);
    const before = await stub.stats();
    const text = await dumpOf(stub, userId);
    // The dump as a store at 0004 would have written it: no deleted_blobs table, no rows
    // for it, no record of 0005, and none of what came after — 0006's index, 0007's table.
    const scan = scanStatements(text);
    const older =
      scan.statements.filter((s) => !/deleted_blobs|0005-deleted-blobs|idx_tags_name_nocase|0006-tags-nocase|llm_usage|0007-llm-usage/.test(s)).join('') +
      scan.rest;
    expect(older).not.toBe(text);
    const result = await load(stub, older);
    expect(result.migrated).toEqual(['0005-deleted-blobs', '0006-tags-nocase', '0007-llm-usage']);
    expect(result.stats.migrations).toEqual(SCHEMA.map((f) => f.name));
    expect(result.stats.counts).toEqual({ ...before.counts, deleted_blobs: 0, llm_usage: 0 });
    // The table the file added is there to be written.
    await stub.removeAttachment((await stub.list({ limit: 1 }))[0]!.id, 'scan.pdf');
    expect((await stub.stats()).counts.deleted_blobs).toBe(1);
  });

  it('refuses at finish a dump of another account, of a newer schema, or that is not a dump, and stays loading', async () => {
    const { userId, stub } = freshStore('load-refuse');
    await populate(stub);
    const text = await dumpOf(stub, userId);
    const cases: Array<[string, string, RegExp]> = [
      ['another account', text.replace(`('user_id', '${userId}')`, `('user_id', 'someone-else')`), /of account someone-else/],
      ['a newer schema', text.replace(`('0005-deleted-blobs', `, `('0009-from-the-future', `), /newer schema.*0009-from-the-future/],
      ['no _meta row', text.replace(/^INSERT INTO _meta \(key, value\) VALUES \('user_id'.*$/m, ''), /no _meta\.user_id row/],
      ['a statement a load does not run', text.replace(/^(INSERT INTO tags .*)$/m, 'DELETE FROM notes;\n$1'), /does not run: DELETE FROM notes/],
      ['a file cut short', text.slice(0, text.lastIndexOf("INSERT INTO changes") + 40), /ended inside a statement/],
    ];
    // And bytes that are not UTF-8 at all, which must stop the load rather than load as
    // replacement characters inside a note.
    const { loadId } = await stub.loadBegin({ key: 'stores/test/damaged.sql', before: null });
    await expect(stub.loadPage(loadId, new Uint8Array([0x49, 0x4e, 0xff, 0xfe]))).rejects.toThrow();
    expect((await stub.stats()).loading).not.toBeNull();
    for (const [name, broken, message] of cases) {
      expect(broken, name).not.toBe(text);
      await expect(load(stub, broken), name).rejects.toThrow(message);
      expect((await stub.stats()).loading, name).not.toBeNull();
      await expect(stub.list({ limit: 1 }), name).rejects.toMatchObject({ retryable: true });
    }
    // And the good dump still loads over the refused one.
    const result = await load(stub, text);
    expect(result.stats.loading).toBeNull();
    expect(result.stats.counts.notes).toBe(2);
  });

  it('a wipe ends a load, as account deletion must', async () => {
    const { stub } = freshStore('load-wipe');
    await populate(stub);
    await stub.loadBegin({ key: 'stores/test/2026-10-06.sql', before: null });
    await stub.wipe();
    expect(await stub.stats()).toMatchObject({ wiped: true, loading: null });
    expect((await stub.usage()).wiped).toBe(true);
    // And a wiped store takes a load: the marker goes on after `deleteAll`.
    const text = await (async () => {
      const { userId: other, stub: source } = freshStore('load-wipe-source');
      await populate(source);
      return (await dumpOf(source, other)).replace(`('user_id', '${other}')`, `('user_id', '${(await stub.ping()).userId}')`);
    })();
    expect((await load(stub, text)).stats.counts.notes).toBe(2);
  });

  it('reads each row once past the index rebuild and the final count, at three thousand notes', async () => {
    const { userId, stub } = freshStore('load-scale');
    await runInDurableObject(stub, (_i, state) => {
      const sql = state.storage.sql;
      state.storage.transactionSync(() => {
        sql.exec(`INSERT INTO notebooks (id, name, created_at) VALUES ('nb', 'Notebook', 1)`);
        sql.exec(`INSERT INTO tags (id, name) VALUES ('t', 'tag')`);
        for (let i = 0; i < 3000; i++) {
          const id = `n${String(i).padStart(5, '0')}`;
          sql.exec(`INSERT INTO notes (id, title, body, created_at, updated_at, notebook_id) VALUES (?1, ?2, 'a body of some words', ?3, ?3, 'nb')`, id, `Title ${i}`, 1_000_000 + i);
          if (i % 2 === 0) sql.exec(`INSERT INTO note_tags VALUES (?1, 't')`, id);
          if (i % 3 === 0) {
            sql.exec(`INSERT INTO attachments (id, note_id, filename, content_type, size, r2_key, created_at) VALUES (?1, ?2, 'scan.pdf', 'application/pdf', 10, ?1, 1)`, `att-${id}`, id);
            sql.exec(`INSERT INTO attachment_text (attachment_id, note_id, filename, text, created_at) VALUES (?1, ?2, 'scan.pdf', 'scanned page', 1)`, `att-${id}`, id);
          }
          sql.exec(`INSERT INTO changes (seq, entity, id, deleted, at) VALUES (?1, 'note', ?2, 0, 1)`, i + 1, id);
        }
        sql.exec(`UPDATE _meta SET value = '3000' WHERE key = 'seq'`);
      });
    });
    expect(await stub.recountNotes()).toBe(0);
    const before = await stub.stats();
    const rows = Object.values(before.counts).reduce((a, b) => a + b, 0);
    expect(rows).toBeGreaterThan(8000);
    const text = await dumpOf(stub, userId);

    await stub.resetCounters();
    const result = await load(stub, text);
    expect(result.stats.counts).toEqual(before.counts);
    const { rowsRead, rowsWritten } = await stub.counters();
    // Written once each (the runtime counts an index entry as a row written, so the
    // number is a few times the rows). Read: the search indexes are rebuilt from the
    // four tables they shadow, and `stats` at the end counts every table; nothing else
    // should walk one. Measured 2026-10-06: 12,563 read for 9,502 rows, 4,001 of them
    // indexed.
    const indexed = before.counts.notes + before.counts.attachment_text + before.counts.note_fields + before.counts.tags;
    expect(rowsWritten).toBeGreaterThanOrEqual(rows);
    expect(rowsRead).toBeLessThanOrEqual(indexed + rows + 200);
  });
});
