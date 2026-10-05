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

  it('lists what each reader still has to read, account-wide and for one note', async () => {
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
    expect((await stub.needingVision(10)).map((f) => f.id).sort()).toEqual(['pdf-empty', 'pic']);
    expect(await stub.visionPending()).toBe(2);
    expect((await stub.needingVision(10, 'n1')).map((f) => f.id)).toEqual(['pdf-empty']);
    expect(await stub.visionPending('n1')).toBe(1);
    expect((await stub.needingVision(10, 'n2')).map((f) => f.id)).toEqual(['pic']);
    expect(await stub.visionPending('n2')).toBe(1);
    expect((await stub.needingVision(1)).length).toBe(1);
  });

  it('says what each file is in brief, on a note and on a page of notes', async () => {
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
    await stub.recordText({ attachmentId: 'layer', noteId: 'n1', filename: 'bill.pdf', text: `Globex Utilities\n\n  Statement  ${'x'.repeat(2000)}` });
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
    // A text layer has no name or description, so its summary is its opening, folded
    // onto one line and cut: never the whole text.
    const layer = one!.files.find((f) => f.filename === 'bill.pdf')!;
    expect(layer.read).toBe('text');
    expect(layer.summary).toMatch(/^Globex Utilities Statement x+…$/);
    expect(layer.summary!.length).toBeLessThanOrEqual(280);

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
