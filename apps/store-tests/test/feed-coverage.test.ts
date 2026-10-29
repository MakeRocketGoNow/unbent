import { describe, expect, it } from 'vitest';
import { feedSeq, freshStore } from './helpers.js';
// The object's source, read as text: what the RPC surface declares is what this holds.
import userStoreSource from '../../api/src/store/user-store.ts?raw';

/**
 * Every write records, held the way guards.test.ts holds the store's other rules: by
 * reading the source. The RPC surface is a list of methods a reader can grep, and this
 * test greps it, so a method added to the object lands in one of the three lists below or
 * fails here by name. For every write it then calls the method once on a seeded store and
 * checks that a call which wrote a data row also advanced the feed's counter: the one
 * property a forgotten `record` breaks and nothing else notices until a device is stale.
 */

type Stub = ReturnType<typeof freshStore>['stub'];

interface Seeded {
  stub: Stub;
  noteId: string;
  trashedId: string;
  notebookId: string;
  fieldId: string;
  selectId: string;
  tagId: string;
  otherTagId: string;
}

async function seeded(label: string): Promise<Seeded> {
  const { stub } = freshStore(label);
  const nb = (await stub.createNotebook('Coupons'))!;
  const field = (await stub.createField(nb.id, { name: 'Amount', type: 'text', options: [] })) as { id: string };
  const select = (await stub.createField(nb.id, { name: 'Kind', type: 'select', options: ['food', 'fuel'] })) as { id: string };
  const n = await stub.create({ id: crypto.randomUUID(), title: 'T', body: 'b', tags: ['home', 'acme'], notebook: 'Coupons', fields: { [field.id]: 'twelve', [select.id]: 'fuel' } });
  const t = await stub.create({ id: crypto.randomUUID(), title: 'Trashed', body: '', tags: ['home'] });
  await stub.remove(t.id);
  await stub.recordAttachment({ id: 'a1', noteId: n.id, filename: 'scan.pdf', contentType: 'application/pdf', size: 3, r2Key: 'k/a1' });
  await stub.recordText({ attachmentId: 'a1', noteId: n.id, filename: 'scan.pdf', text: 'acme' });
  await stub.recordAttachment({ id: 'a2', noteId: n.id, filename: 'bare.pdf', contentType: 'application/pdf', size: 3, r2Key: 'k/a2' });
  // A picture with no text: what an assistant may write for (a PDF nothing has read yet, like bare.pdf, is refused).
  await stub.recordAttachment({ id: 'a3', noteId: n.id, filename: 'card.jpg', contentType: 'image/jpeg', size: 3, r2Key: 'k/a3' });
  const tags = await stub.listTags();
  return {
    stub,
    noteId: n.id,
    trashedId: t.id,
    notebookId: nb.id,
    fieldId: field.id,
    selectId: select.id,
    tagId: tags.find((x) => x.name === 'home')!.id,
    otherTagId: tags.find((x) => x.name === 'acme')!.id,
  };
}

/** Every method that writes a data table, with a call that makes it write. */
const WRITES: Record<string, (s: Seeded) => Promise<unknown>> = {
  create: (s) => s.stub.create({ id: crypto.randomUUID(), title: 'N', body: '', tags: [] }),
  duplicate: (s) => s.stub.duplicate(s.noteId, crypto.randomUUID()),
  createOrFind: (s) => s.stub.createOrFind({ id: crypto.randomUUID(), title: 'N', body: '', tags: [] }),
  createMany: (s) => s.stub.createMany([{ id: crypto.randomUUID(), title: 'N', body: '', tags: [] }]),
  duplicateOrFind: (s) => s.stub.duplicateOrFind(s.noteId, crypto.randomUUID()),
  update: (s) => s.stub.update(s.noteId, { title: 'Changed' }),
  appendToBody: (s) => s.stub.appendToBody(s.noteId, 'more'),
  restoreRevision: async (s) => {
    await s.stub.update(s.noteId, { body: 'replaced' });
    const [copy] = (await s.stub.listRevisions(s.noteId))!;
    // Measured from here: the update above recorded for itself.
    const before = await feedSeq(s.stub);
    await s.stub.resetCounters();
    await s.stub.restoreRevision(s.noteId, copy!.id);
    expect(await feedSeq(s.stub), 'a restore from history must record its note').toBeGreaterThan(before);
  },
  remove: (s) => s.stub.remove(s.noteId),
  restore: (s) => s.stub.restore(s.trashedId),
  purgeOne: (s) => s.stub.purgeOne(s.trashedId),
  removeMany: (s) => s.stub.removeMany([s.noteId]),
  restoreMany: (s) => s.stub.restoreMany([s.trashedId]),
  purgeMany: (s) => s.stub.purgeMany([s.trashedId]),
  // A field value alone, the newest way for it to write: tags and notebooks are pinned
  // in feed-writes.test.ts, and this is the one that a missing record would leave unnoticed.
  updateMany: (s) => s.stub.updateMany([s.noteId], { fields: { [s.fieldId]: 'bulk value' } }),
  importNote: (s) => s.stub.importNote({ title: 'I', body: 'b', tags: [], createdAt: 1, updatedAt: 1, contentHash: 'h' }),
  setBody: (s) => s.stub.setBody(s.noteId, 'replaced'),
  purge: (s) => s.stub.purge('trashed'),
  renameTag: (s) => s.stub.renameTag(s.tagId, 'house'),
  deleteTag: (s) => s.stub.deleteTag(s.otherTagId),
  recolorTag: (s) => s.stub.recolorTag(s.tagId, 7),
  createNotebook: (s) => s.stub.createNotebook('Taxes'),
  updateNotebook: (s) => s.stub.updateNotebook(s.notebookId, { emoji: '🧾' }),
  deleteNotebook: (s) => s.stub.deleteNotebook(s.notebookId),
  createField: (s) => s.stub.createField(s.notebookId, { name: 'Due', type: 'date', options: [] }),
  updateField: (s) => s.stub.updateField(s.notebookId, s.fieldId, { type: 'number' }),
  reorderFields: (s) => s.stub.reorderFields(s.notebookId, [s.selectId, s.fieldId]),
  deleteField: (s) => s.stub.deleteField(s.notebookId, s.fieldId),
  removeFieldOption: (s) => s.stub.removeFieldOption(s.notebookId, s.selectId, 'fuel', true),
  editFieldOptions: (s) => s.stub.editFieldOptions(s.notebookId, s.selectId, { rename: [{ from: 'fuel', to: 'petrol' }] }),
  importNotebook: (s) => s.stub.importNotebook({ name: 'Coupons', fields: [{ name: 'Store', type: 'text' }] }),
  recordAttachment: (s) => s.stub.recordAttachment({ id: 'a9', noteId: s.noteId, filename: 'new.pdf', contentType: 'application/pdf', size: 1, r2Key: 'k/a9' }),
  removeAttachment: (s) => s.stub.removeAttachment(s.noteId, 'scan.pdf'),
  recordText: (s) => s.stub.recordText({ attachmentId: 'a2', noteId: s.noteId, filename: 'bare.pdf', text: 'read' }),
  copyText: (s) => s.stub.copyText('a1', { attachmentId: 'a2', noteId: s.noteId, filename: 'bare.pdf' }),
  writeAssistantText: (s) => s.stub.writeAssistantText(s.noteId, 'card.jpg', 'what an assistant read'),
  createView: (s) => s.stub.createView(s.notebookId, 'Business 2026', { tag: ['acme'] }),
  // An edit and a delete need a view to act on, made inside the call and measured from
  // after it, as `restoreRevision` is: the create records for itself.
  updateView: (s) => afterView(s, (id) => s.stub.updateView(id, { name: 'Personal' })),
  deleteView: (s) => afterView(s, (id) => s.stub.deleteView(id)),
};

/** Makes a view, then runs `act` on it and checks that `act` itself recorded. */
async function afterView(s: Seeded, act: (id: string) => Promise<unknown>): Promise<void> {
  const view = await s.stub.createView(s.notebookId, 'Receipts by month', {});
  if (typeof view === 'string') throw new Error(`expected a view, got ${view}`);
  const before = await feedSeq(s.stub);
  await s.stub.resetCounters();
  await act(view.id);
  expect(await feedSeq(s.stub), 'a view write must record its view').toBeGreaterThan(before);
}

/** Methods that write without the feed needing to know, each with its reason. */
const EXEMPT: Record<string, string> = {
  recountNotes: 'corrects the stored counts, which a client derives for itself',
  wipe: 'empties the store, feed included; the account is gone',
  restorePreview: 'reads a bookmark',
  restoreTo: 'winds the whole store back; the restore route changes the epoch afterwards',
  resetCounters: 'the metering, not data',
  feedRestored: 'is the epoch change itself',
  clearRevisions: 'deletes note history, which is not in the feed and no client holds',
  forgetBlobs: 'drops the tombstones of deleted files the sweep has removed from R2; a client holds no deleted files',
  loadBegin: 'empties the store for a dump; the feed in the dump replaces it',
  loadPage: 'writes the dump\'s own rows, feed table included',
  loadFinish: 'names a new epoch itself, so every client starts over from the loaded rows',
  autofillPrelude: 'counts an Auto-fill press against the day\'s cap, which is metering no client holds',
  recordLlmUsage: 'counts what the language model cost, which is metering no client holds',
};

/** Reads, composites and the operator surface: nothing to record. */
const READS = new Set([
  'ping', 'stats', 'usage', 'attachmentBytes', 'sweepVisit', 'readOnlySql', 'dumpBegin', 'dumpSlice', 'schemaSql', 'counters',
  'list', 'listFull', 'count', 'get', 'linkedFilenames', 'search', 'listTags', 'tagCounts', 'fieldTargets', 'notebookByName', 'sampleTitles', 'countUnfiledNotes',
  'listNotebooks', 'listFields', 'fieldById', 'listAllFields', 'previewConversion', 'countOptionUsage',
  'resolveAttachment', 'listAttachments', 'ownsNote', 'availableFilename', 'needingText',
  'pendingTextCount', 'textFor', 'textWithRead', 'textsForNote', 'textsForNotes', 'textsById', 'attachmentIdFor',
  'keysForNote', 'allBlobKeys', 'tombstonedBlobKeys',
  'listPage', 'searchRows', 'searchWithFiles', 'exportPage', 'getWithFiles', 'filesForNote', 'notebooksOverview', 'pendingText',
  'autofillContext', 'uploadPrelude', 'autofillUsage',
  'changesSince', 'snapshotPage',
  'listRevisions', 'getRevision',
  'listViews',
]);

/** The public methods `UserStore` declares, read off its source. */
function declaredMethods(): string[] {
  const names: string[] = [];
  for (const line of userStoreSource.split('\n')) {
    const m = /^  (?:async )?([a-zA-Z]\w*)\s*(?:<[^>]*>)?\(/.exec(line);
    if (!m) continue;
    const name = m[1]!;
    // Statements at the class's indent inside a multi-line expression look like calls.
    if (['constructor', 'if', 'for', 'while', 'switch', 'return', 'catch'].includes(name)) continue;
    if (line.startsWith('  private ')) continue;
    names.push(name);
  }
  return names;
}

describe('every write on the object records in the feed', () => {
  it('names every public method in exactly one of the three lists', () => {
    const declared = declaredMethods();
    expect(declared.length).toBeGreaterThan(40);
    const unlisted = declared.filter((n) => !(n in WRITES) && !(n in EXEMPT) && !READS.has(n));
    expect(unlisted, 'add the method to WRITES (with a call), EXEMPT (with a reason) or READS').toEqual([]);
    const unknown = [...Object.keys(WRITES), ...Object.keys(EXEMPT), ...READS].filter((n) => !declared.includes(n));
    // A name here that the object no longer declares is a stale list, except the two
    // the feed's reader adds in its own commit.
    expect(unknown.filter((n) => !['changesSince', 'snapshotPage', 'feedRestored'].includes(n))).toEqual([]);
  });

  for (const [name, call] of Object.entries(WRITES)) {
    it(`${name} advances the feed when it writes`, async () => {
      const s = await seeded(`cover-${name}`);
      const before = await feedSeq(s.stub);
      await s.stub.resetCounters();
      await call(s);
      const { rowsWritten } = await s.stub.counters();
      expect(rowsWritten, 'the sample call must write').toBeGreaterThan(0);
      expect(await feedSeq(s.stub), 'wrote a data row without recording it').toBeGreaterThan(before);
    });
  }
});
