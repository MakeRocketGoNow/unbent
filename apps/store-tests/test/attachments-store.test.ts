import { describe, expect, it } from 'vitest';
import { runInDurableObject } from 'cloudflare:test';
import { feedRows, freshStore } from './helpers.js';

/** `AttachmentsStore` through the object, with the `has_text` and FTS triggers live. */
describe('attachments', () => {
  const file = (noteId: string, over: Partial<{ id: string; filename: string; contentType: string; r2Key: string }> = {}) => ({
    id: over.id ?? crypto.randomUUID(),
    noteId,
    filename: over.filename ?? 'scan.pdf',
    contentType: over.contentType ?? 'application/pdf',
    size: 3,
    r2Key: over.r2Key ?? `users/u/notes/${noteId}/files/${over.id ?? 'x'}-${over.filename ?? 'scan.pdf'}`,
  });

  /**
   * The bytes the account holds (0008), kept by triggers on every way a row comes and
   * goes: recorded, removed by name, and taken by the cascade when the note is purged.
   * What the plan's quota is measured against, so a miss here is an upload refused or
   * let through for the wrong reason.
   */
  it('keeps the sum of its files\' bytes on the totals row', async () => {
    const { stub } = freshStore('att-bytes');
    expect(await stub.attachmentBytes()).toBe(0);
    const n = await stub.create({ id: 'n1', title: 'T', body: '', tags: [] });
    await stub.recordAttachment({ ...file(n.id, { id: 'a1' }), size: 1000 });
    await stub.recordAttachment({ ...file(n.id, { id: 'a2', filename: 'two.pdf' }), size: 24 });
    expect(await stub.attachmentBytes()).toBe(1024);
    expect((await stub.usage()).attachmentBytes).toBe(1024);
    await stub.removeAttachment(n.id, 'two.pdf');
    expect(await stub.attachmentBytes()).toBe(1000);
    // Trashed, the file still counts: it is still in the bucket. Purged, it does not.
    await stub.remove(n.id);
    expect(await stub.attachmentBytes()).toBe(1000);
    await stub.purge('trashed');
    expect(await stub.attachmentBytes()).toBe(0);
    // And the recount agrees with the triggers.
    expect(await stub.recountNotes()).toBe(0);
  });

  it('records, resolves, lists, names around collisions and removes', async () => {
    const { stub } = freshStore('att');
    const n = await stub.create({ id: 'n1', title: 'T', body: '', tags: [] });
    expect(await stub.recordAttachment(file(n.id, { id: 'a1' }))).toEqual({ filename: 'scan.pdf', contentType: 'application/pdf', size: 3 });
    expect(await stub.availableFilename(n.id, 'scan.pdf')).toBe('scan-2.pdf');
    expect(await stub.availableFilename(n.id, 'other.pdf')).toBe('other.pdf');
    await stub.recordAttachment(file(n.id, { id: 'a2', filename: 'scan-2.pdf' }));
    expect(await stub.availableFilename(n.id, 'scan.pdf')).toBe('scan-3.pdf');

    expect(await stub.resolveAttachment(n.id, 'scan.pdf')).toMatchObject({ id: 'a1', r2_key: expect.stringContaining('a1-scan.pdf') });
    expect(await stub.attachmentIdFor(n.id, 'scan-2.pdf')).toBe('a2');
    expect(await stub.attachmentIdFor(n.id, 'nope.pdf')).toBeNull();
    // What an upload naming its own id asks first: the note, and who holds the id.
    expect(await stub.uploadPrelude(n.id, 'a2')).toEqual({ live: true, existing: { noteId: n.id, filename: 'scan-2.pdf', contentType: 'application/pdf', size: 3 } });
    expect(await stub.uploadPrelude(n.id, 'a9')).toEqual({ live: true, existing: null });
    expect(await stub.uploadPrelude('ghost', 'a1')).toMatchObject({ live: false, existing: { noteId: n.id } });
    expect((await stub.listAttachments(n.id)).map((f) => f.filename)).toEqual(['scan.pdf', 'scan-2.pdf']);
    expect((await stub.keysForNote(n.id)).length).toBe(2);
    expect(await stub.ownsNote(n.id)).toBe(true);
    expect(await stub.ownsNote('ghost')).toBe(false);

    // A trashed note's files resolve to nothing for anything that would change them, and
    // come back with the note. Only the trash's own view of the note reads them.
    await stub.remove(n.id);
    expect(await stub.resolveAttachment(n.id, 'scan.pdf')).toBeNull();
    expect(await stub.ownsNote(n.id)).toBe(false);
    expect(await stub.resolveAttachment(n.id, 'scan.pdf', { includeTrashed: true })).toMatchObject({ id: 'a1' });
    expect((await stub.filesForNote(n.id))!.map((f) => f.filename)).toEqual(['scan.pdf', 'scan-2.pdf']);
    expect(await stub.filesForNote('ghost')).toBeNull();
    await stub.restore(n.id);
    expect(await stub.removeAttachment(n.id, 'scan.pdf')).toEqual(expect.stringContaining('a1-scan.pdf'));
    expect(await stub.removeAttachment(n.id, 'scan.pdf')).toBeNull();
    expect((await stub.listAttachments(n.id)).map((f) => f.filename)).toEqual(['scan-2.pdf']);
  });

  it('cuts an answer of texts on bytes, and names what it had no room for', async () => {
    // The budget is the store's own and not a caller's to choose, so it is met with real
    // sizes: three scans' text of four hundred thousand characters against a megabyte.
    const { stub } = freshStore('budget');
    await stub.create({ id: 'n1', title: 'T', body: '', tags: [] });
    const long = (letter: string) => `${letter} `.repeat(200_000);
    for (const [id, letter] of [['b1', 'x'], ['b2', 'y'], ['b3', 'z']] as const) {
      await stub.recordAttachment(file('n1', { id, filename: `${id}.pdf` }));
      await stub.recordText({ attachmentId: id, noteId: 'n1', filename: `${id}.pdf`, text: long(letter) });
    }
    const answer = await stub.textsById(['b1', 'b2', 'b3']);
    expect(answer.texts.map((t) => t.id)).toEqual(['b1', 'b2']);
    expect(answer.left).toEqual(['b3']);
    expect((await stub.textsById(answer.left)).texts.map((t) => t.id)).toEqual(['b3']);
  });

  it('keeps has_text and the FTS index in step with the text rows, and copies text', async () => {
    const { stub } = freshStore('text');
    await stub.create({ id: 'n1', title: 'T', body: '', tags: [] });
    await stub.recordAttachment(file('n1', { id: 'a1' }));
    expect(await stub.textFor('n1', 'scan.pdf')).toBe('');
    expect(await stub.textFor('n1', 'missing.pdf')).toBeNull();
    expect(await stub.pendingTextCount()).toBe(1);

    await stub.recordText({ attachmentId: 'a1', noteId: 'n1', filename: 'scan.pdf', text: 'acme corporation invoice' });
    expect(await stub.textFor('n1', 'scan.pdf')).toBe('acme corporation invoice');
    expect(await stub.pendingTextCount()).toBe(0);
    expect((await stub.search('acme', 5)).map((r) => r.matchedFile)).toEqual(['scan.pdf']);
    // The upsert path: new text, the flag stays, the index follows.
    await stub.recordText({ attachmentId: 'a1', noteId: 'n1', filename: 'scan.pdf', text: 'globex receipt', readBy: 'vision' });
    expect(await stub.search('acme', 5)).toEqual([]);
    expect((await stub.search('globex', 5)).length).toBe(1);
    expect(await stub.textsForNote('n1')).toEqual([{ filename: 'scan.pdf', contentType: 'application/pdf', text: 'globex receipt', readBy: 'vision' }]);

    await stub.recordAttachment(file('n1', { id: 'a2', filename: 'copy.pdf' }));
    await stub.copyText('a1', { attachmentId: 'a2', noteId: 'n1', filename: 'copy.pdf' });
    expect(await stub.textFor('n1', 'copy.pdf')).toBe('globex receipt');
    expect(await stub.textsForNotes(['n1', 'nope'])).toEqual([
      { noteId: 'n1', filename: 'scan.pdf', text: 'globex receipt', readBy: 'vision' },
      { noteId: 'n1', filename: 'copy.pdf', text: 'globex receipt', readBy: 'vision' },
    ]);
    expect(await stub.textsForNotes([])).toEqual([]);

    // By id, for a device's offline index: only files with text, and nothing for an id
    // that has none.
    await stub.recordAttachment(file('n1', { id: 'a3', filename: 'unread.pdf' }));
    expect(await stub.textsById(['a1', 'a3', 'ghost'])).toEqual({ texts: [{ id: 'a1', text: 'globex receipt' }], left: [] });
    expect(await stub.textsById([])).toEqual({ texts: [], left: [] });
    const before = (await stub.counters()).rowsRead;
    await stub.textsById(['a1', 'a2']);
    // Six rows a file as the meter counts them, by primary key; the archive-sized test
    // in notes-store.test.ts is what shows it does not grow with the account.
    expect((await stub.counters()).rowsRead - before).toBeLessThanOrEqual(12);
    await stub.removeAttachment('n1', 'unread.pdf');

    // Removing the attachment cascades its text and the flag no longer matters; the
    // FTS entry goes with the row.
    await stub.removeAttachment('n1', 'scan.pdf');
    expect((await stub.search('globex', 5)).map((r) => r.matchedFile)).toEqual(['copy.pdf']);
    const flags = await runInDurableObject(stub, (_i, state) =>
      state.storage.sql.exec<{ id: string; has_text: number }>('SELECT id, has_text FROM attachments').toArray(),
    );
    expect(flags).toEqual([{ id: 'a2', has_text: 1 }]);
  });

  it('lists what each reader still has to read: PDFs for the account or one note, pictures for one note only', async () => {
    const { stub } = freshStore('pending');
    await stub.create({ id: 'n1', title: 'T', body: '', tags: [] });
    await stub.create({ id: 'n2', title: 'T', body: '', tags: [] });
    await stub.create({ id: 'trashed', title: 'T', body: '', tags: [] });
    await stub.recordAttachment(file('n1', { id: 'pdf-unread' }));
    await stub.recordAttachment(file('n1', { id: 'pdf-empty', filename: 'empty.pdf' }));
    await stub.recordText({ attachmentId: 'pdf-empty', noteId: 'n1', filename: 'empty.pdf', text: '' });
    await stub.recordAttachment(file('n1', { id: 'pdf-seen', filename: 'seen.pdf' }));
    await stub.recordText({ attachmentId: 'pdf-seen', noteId: 'n1', filename: 'seen.pdf', text: '', readBy: 'vision' });
    await stub.recordAttachment(file('n2', { id: 'pic', filename: 'card.jpg', contentType: 'image/jpeg' }));
    await stub.recordAttachment(file('n2', { id: 'pic-read', filename: 'read.png', contentType: 'image/png' }));
    await stub.recordText({ attachmentId: 'pic-read', noteId: 'n2', filename: 'read.png', text: 'a card', readBy: 'vision' });
    await stub.recordAttachment(file('n2', { id: 'other', filename: 'notes.txt', contentType: 'text/plain' }));
    await stub.recordAttachment(file('trashed', { id: 'gone' }));
    await stub.recordAttachment(file('trashed', { id: 'gone-pic', filename: 'x.jpg', contentType: 'image/jpeg' }));
    await stub.remove('trashed');

    expect((await stub.needingText(10)).map((f) => f.id)).toEqual(['pdf-unread']);
    expect(await stub.pendingTextCount()).toBe(1);
    expect((await stub.needingText(10, 'n1')).map((f) => f.id)).toEqual(['pdf-unread']);
    expect(await stub.pendingTextCount('n1')).toBe(1);
    expect(await stub.needingText(10, 'n2')).toEqual([]);
    expect(await stub.pendingTextCount('n2')).toBe(0);

    // Vision: the picture without text and the PDF whose text layer was empty and that
    // the model has not seen; not the one it has, not the read picture, not the trash.
    // Only through the press that asks (`autofillPrelude`), one note at a time: the model
    // has had no account-wide list to read from since MAK-179.
    const forVision = async (id: string) => (await stub.autofillPrelude(id, 10))?.forVision.map((f) => f.id) ?? [];
    expect(await forVision('n1')).toEqual(['pdf-empty']);
    expect(await forVision('n2')).toEqual(['pic']);
    expect(await forVision('trashed')).toEqual([]);
    expect((await stub.autofillPrelude('n1', 1))!.forVision.length).toBe(1);

    // An assistant's words over MCP are a hint, not the model's reading: the press is
    // offered the file again, told whose words stand, so it can have the model read it.
    await stub.recordAttachment(file('n2', { id: 'told', filename: 'told.jpg', contentType: 'image/jpeg' }));
    expect(await stub.writeAssistantText('n2', 'told.jpg', 'A card for a plumber')).toEqual({ ok: true, reason: null });
    const offered = (await stub.autofillPrelude('n2', 10))!.forVision.map((f) => [f.id, f.writtenBy ?? null]).sort();
    expect(offered).toEqual([['pic', null], ['told', 'assistant']]);

    // Untouched files first, whatever their age: a file the model declined over an
    // assistant's words comes back on every press, and must not take the slots of files
    // nothing has read. The newest picture, untouched, still comes before the older told one.
    await stub.recordAttachment(file('n2', { id: 'newer', filename: 'newer.jpg', contentType: 'image/jpeg' }));
    const order = (await stub.autofillPrelude('n2', 10))!.forVision.map((f) => f.id);
    expect(order.indexOf('newer')).toBeLessThan(order.indexOf('told'));
    expect(order.indexOf('told')).toBe(order.length - 1);
    expect(['pic', 'newer']).toContain((await stub.autofillPrelude('n2', 1))!.forVision[0]!.id);
  });

  it('takes an assistant’s text where nothing or only its own words stand, and says whose it is', async () => {
    const { stub } = freshStore('assistant');
    await stub.create({ id: 'n1', title: 'T', body: '', tags: [] });
    await stub.recordAttachment(file('n1', { id: 'pic', filename: 'card.jpg', contentType: 'image/jpeg' }));
    await stub.recordAttachment(file('n1', { id: 'layer', filename: 'bill.pdf' }));
    await stub.recordText({ attachmentId: 'layer', noteId: 'n1', filename: 'bill.pdf', text: 'Total due 84.12' });
    await stub.recordAttachment(file('n1', { id: 'seen', filename: 'seen.jpg', contentType: 'image/jpeg' }));
    await stub.recordText({ attachmentId: 'seen', noteId: 'n1', filename: 'seen.jpg', text: 'A plate\nMeal: lasagna.\n\n', readBy: 'vision' });
    await stub.recordAttachment(file('n1', { id: 'declined', filename: 'declined.jpg', contentType: 'image/jpeg' }));
    await stub.recordText({ attachmentId: 'declined', noteId: 'n1', filename: 'declined.jpg', text: '', readBy: 'vision' });
    await stub.recordAttachment(file('n1', { id: 'fresh', filename: 'fresh.pdf' }));
    await stub.recordAttachment(file('n1', { id: 'blank', filename: 'blank.pdf' }));
    await stub.recordText({ attachmentId: 'blank', noteId: 'n1', filename: 'blank.pdf', text: '' });

    // Nothing there, its own earlier words, or a row the model left empty: all yield.
    expect(await stub.writeAssistantText('n1', 'card.jpg', 'Plumber card\nJane Doe, Acme Plumbing, 555-0100')).toEqual({ ok: true, reason: null });
    expect(await stub.writeAssistantText('n1', 'card.jpg', 'Jane Doe, Acme Plumbing')).toEqual({ ok: true, reason: null });
    expect(await stub.writeAssistantText('n1', 'declined.jpg', 'A receipt the model would not read')).toEqual({ ok: true, reason: null });
    // A PDF whose layer came back empty yields; one the free reader has not reached does
    // not, or it would never be reached and the next press would pay the model for it.
    expect(await stub.writeAssistantText('n1', 'blank.pdf', 'A scan with no layer, read by eye')).toEqual({ ok: true, reason: null });
    expect(await stub.writeAssistantText('n1', 'fresh.pdf', 'x')).toEqual({ ok: false, reason: 'unread' });
    expect((await stub.autofillPrelude('n1', 10))!.forText.map((f) => f.id)).toEqual(['fresh']);
    // The file's own text layer and the model's reading do not.
    expect(await stub.writeAssistantText('n1', 'bill.pdf', 'x')).toEqual({ ok: false, reason: 'layer' });
    expect(await stub.writeAssistantText('n1', 'seen.jpg', 'x')).toEqual({ ok: false, reason: 'vision' });
    expect(await stub.writeAssistantText('n1', 'ghost.jpg', 'x')).toEqual({ ok: false, reason: 'missing' });

    // Read back as the assistant's, summarised as a text layer is, and found by search.
    expect(await stub.textWithRead('n1', 'card.jpg')).toEqual({ read: 'assistant', text: 'Jane Doe, Acme Plumbing' });
    const card = (await stub.getWithFiles('n1'))!.files.find((f) => f.filename === 'card.jpg');
    expect(card).toMatchObject({ read: 'assistant', summary: 'Jane Doe, Acme Plumbing' });
    expect((await stub.search('plumbing', 5)).map((r) => r.matchedFile)).toEqual(['card.jpg']);
    expect((await stub.textsForNote('n1')).find((f) => f.filename === 'card.jpg')!.readBy).toBe('assistant');
  });

  it('says what each file is in brief, on a note and on a page of notes', async () => {
    const BILL = `Globex Utilities\n\n  Statement  ${'x'.repeat(2000)}\nStatement date: 03/02/2026\nTotal amount due $84.12\n`;
    const { stub } = freshStore('summaries');
    await stub.create({ id: 'n1', title: 'T', body: '', tags: [] });
    await stub.create({ id: 'n2', title: 'T', body: '', tags: [] });
    await stub.create({ id: 'bare', title: 'T', body: '', tags: [] });
    // A reading as `formatReading` writes it: name, what it is, a blank line, the text.
    await stub.recordAttachment(file('n1', { id: 'pic', filename: 'receipt.jpg', contentType: 'image/jpeg' }));
    await stub.recordText({
      attachmentId: 'pic',
      noteId: 'n1',
      filename: 'receipt.jpg',
      text: 'Acme Diner receipt\nReceipt: lunch for two on 2026-09-21, $17.27 by card.\n\nACME DINER\n123 Main St\nTOTAL 17.27',
      readBy: 'vision',
    });
    await stub.recordAttachment(file('n1', { id: 'layer', filename: 'bill.pdf' }));
    await stub.recordText({ attachmentId: 'layer', noteId: 'n1', filename: 'bill.pdf', text: BILL });
    await stub.recordAttachment(file('n2', { id: 'unread', filename: 'unread.pdf' }));
    await stub.recordAttachment(file('n2', { id: 'empty', filename: 'empty.pdf' }));
    await stub.recordText({ attachmentId: 'empty', noteId: 'n2', filename: 'empty.pdf', text: '' });
    await stub.recordAttachment(file('n2', { id: 'seen', filename: 'seen.pdf' }));
    await stub.recordText({ attachmentId: 'seen', noteId: 'n2', filename: 'seen.pdf', text: '', readBy: 'vision' });
    await stub.recordAttachment(file('n2', { id: 'other', filename: 'notes.txt', contentType: 'text/plain' }));

    const one = await stub.getWithFiles('n1');
    expect(one!.files.find((f) => f.filename === 'receipt.jpg')).toEqual({
      filename: 'receipt.jpg',
      contentType: 'image/jpeg',
      size: 3,
      read: 'vision',
      summary: 'Acme Diner receipt — Receipt: lunch for two on 2026-09-21, $17.27 by card.',
    });
    // A text layer has no name or description, so its summary is its opening, cut, and
    // the facts found in the text — here a total and a date two thousand characters in,
    // past the head a vision reading is cut from (MAK-177). Never the whole text.
    const layer = one!.files.find((f) => f.filename === 'bill.pdf')!;
    expect(layer.read).toBe('text');
    expect(layer.summary).toMatch(/^Globex Utilities Statement x+… · Total: \$84\.12 · Date: 2026-03-02$/);
    expect(layer.summary!.length).toBeLessThanOrEqual(400);

    const page = await stub.listPage({ limit: 10 }, null, { summaries: true });
    expect(page.summaries!['n2']!.map((f) => [f.filename, f.read, f.summary])).toEqual([
      ['unread.pdf', 'pending', null],
      // The text layer found nothing and the model has not been asked: still waiting.
      ['empty.pdf', 'pending', null],
      ['seen.pdf', 'none', null],
      ['notes.txt', 'none', null],
    ]);
    expect(page.summaries!['n1']!.map((f) => f.read)).toEqual(['vision', 'text']);
    // Nothing is asked about a note with no files, and nothing at all unless asked.
    expect(page.summaries!['bare']).toBeUndefined();
    expect((await stub.listPage({ limit: 10 }, null)).summaries).toBeUndefined();
    // Without the vision model, what only it would read is never going to be read: a
    // picture and a scan whose text layer was empty. An unread PDF still waits, for the
    // browser reads text layers wherever the server does not.
    const blind = await stub.listPage({ limit: 10 }, null, { summaries: true, vision: false });
    expect(blind.summaries!['n2']!.map((f) => [f.filename, f.read])).toEqual([
      ['unread.pdf', 'pending'],
      ['empty.pdf', 'none'],
      ['seen.pdf', 'none'],
      ['notes.txt', 'none'],
    ]);
    await stub.recordAttachment(file('n2', { id: 'new-pic', filename: 'new.png', contentType: 'image/png' }));
    expect((await stub.getWithFiles('n2', { vision: false }))!.files.find((f) => f.filename === 'new.png')!.read).toBe('none');
    expect((await stub.getWithFiles('n2'))!.files.find((f) => f.filename === 'new.png')!.read).toBe('pending');

    // One file's text with the same status, for get_attachment_text: the whole text
    // when it was read, and which kind of nothing when it was not.
    expect(await stub.textWithRead('n1', 'bill.pdf')).toEqual({ read: 'text', text: BILL });
    expect(await stub.textWithRead('n2', 'empty.pdf')).toEqual({ read: 'pending', text: null });
    expect(await stub.textWithRead('n2', 'empty.pdf', false)).toEqual({ read: 'none', text: null });
    expect(await stub.textWithRead('n2', 'seen.pdf')).toEqual({ read: 'none', text: null });
    expect(await stub.textWithRead('n2', 'ghost.pdf')).toBeNull();

    // A search carries the same lines for its matches, in the one call.
    await stub.update('n1', { body: 'lunch with the team' });
    const found = await stub.searchWithFiles('lunch', 5);
    expect(found.results.map((r) => r.id)).toEqual(['n1']);
    expect(found.summaries['n1']!.map((f) => f.read)).toEqual(['vision', 'text']);

    // A compact page knows nothing of its notes' files, which must not read as "none".
    const compact = await stub.listPage({ limit: 10, compact: true }, null, { summaries: true });
    expect(Object.keys(compact.summaries!).sort()).toEqual(['n1', 'n2']);
  });

  it('pages every blob key by rowid', async () => {
    const { stub } = freshStore('keys');
    await stub.create({ id: 'n1', title: 'T', body: '', tags: [] });
    for (let i = 0; i < 5; i++) await stub.recordAttachment(file('n1', { id: `a${i}`, filename: `f${i}.pdf`, r2Key: `k${i}` }));
    const first = await stub.allBlobKeys(0, 2);
    expect(first.keys).toEqual(['k0', 'k1']);
    const second = await stub.allBlobKeys(first.nextRowid!, 2);
    expect(second.keys).toEqual(['k2', 'k3']);
    const third = await stub.allBlobKeys(second.nextRowid!, 2);
    expect(third).toEqual({ keys: ['k4'], nextRowid: null });
  });
});

describe('attachments: recording a name the note already holds', () => {
  it('is refused by the index, or skipped with ifAbsent, and never recorded twice in the feed', async () => {
    const { stub } = freshStore('att-absent');
    const n = await stub.create({ id: 'n1', title: 'T', body: '', tags: [] });
    const row = (id: string) => ({ id, noteId: n.id, filename: 'scan.pdf', contentType: 'application/pdf', size: 3, r2Key: `k/${id}` });
    expect(await stub.recordAttachment(row('a1'))).toEqual({ filename: 'scan.pdf', contentType: 'application/pdf', size: 3 });
    await expect(stub.recordAttachment(row('a2'))).rejects.toThrow();
    expect(await stub.recordAttachment(row('a3'), { ifAbsent: true })).toBeNull();
    expect((await stub.listAttachments(n.id)).map((f) => f.filename)).toEqual(['scan.pdf']);
    const rows = await feedRows(stub);
    expect(rows.filter((r) => r.entity === 'attachment')).toEqual([{ entity: 'attachment', id: 'a1' }]);
  });
});
