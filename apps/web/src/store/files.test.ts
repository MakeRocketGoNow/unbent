import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearShelf, filesSupported, findFile, listShelf, readFile, readKeptNotebooks, removeFile, shelfName, writeFile, writeKeptNotebooks } from './files.js';
import { installMemoryOpfs, type MemoryDirectory } from './test-opfs.js';

let root: MemoryDirectory;
beforeEach(() => {
  root = installMemoryOpfs();
});
afterEach(() => vi.unstubAllGlobals());

const pdf = (text: string) => new Blob([text], { type: 'application/pdf' });

describe('the files an account keeps on a device', () => {
  it('are written under the account, the shelf, the note and the name, and read back', async () => {
    expect(filesSupported()).toBe(true);
    await writeFile('u1', 'kept', 'n1', 'Report (final) v2.pdf', pdf('kept bytes'));
    await writeFile('u1', 'pending', 'n1', 'photo.jpg', pdf('waiting'));
    expect(root.paths()).toEqual(['unbent-files-u1/kept/n1/Report (final) v2.pdf', 'unbent-files-u1/pending/n1/photo.jpg']);
    expect(await (await readFile('u1', 'kept', 'n1', 'Report (final) v2.pdf'))!.text()).toBe('kept bytes');
    expect(await readFile('u1', 'kept', 'n1', 'photo.jpg')).toBeNull();
    expect(await readFile('u2', 'kept', 'n1', 'Report (final) v2.pdf')).toBeNull();
  });

  it('takes a stream, which is how a kept file arrives from the network', async () => {
    // jsdom's Blob has no `stream()`; a response body is one of these.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('stream'));
        controller.enqueue(new TextEncoder().encode('ed'));
        controller.close();
      },
    });
    await writeFile('u1', 'kept', 'n1', 'scan.pdf', body);
    expect(await (await readFile('u1', 'kept', 'n1', 'scan.pdf'))!.text()).toBe('streamed');
  });

  it('leaves nothing behind when the bytes stop arriving part-way', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('half'));
        controller.error(new TypeError('network error'));
      },
    });
    await expect(writeFile('u1', 'kept', 'n1', 'scan.pdf', body)).rejects.toThrow('network error');
    expect(await readFile('u1', 'kept', 'n1', 'scan.pdf')).toBeNull();
    // And a file that was whole before a failed rewrite is still whole.
    await writeFile('u1', 'kept', 'n1', 'whole.pdf', pdf('whole'));
    const again = new ReadableStream<Uint8Array>({ pull: (c) => c.error(new TypeError('network error')) });
    await expect(writeFile('u1', 'kept', 'n1', 'whole.pdf', again)).rejects.toThrow();
    expect(await (await readFile('u1', 'kept', 'n1', 'whole.pdf'))!.text()).toBe('whole');
  });

  it('removes a file, and its note’s directory once that is empty', async () => {
    await writeFile('u1', 'kept', 'n1', 'a.pdf', pdf('a'));
    await writeFile('u1', 'kept', 'n1', 'b.pdf', pdf('b'));
    await removeFile('u1', 'kept', 'n1', 'a.pdf');
    expect(root.paths()).toEqual(['unbent-files-u1/kept/n1/b.pdf']);
    await removeFile('u1', 'kept', 'n1', 'b.pdf');
    expect(root.paths()).toEqual([]);
    // Not there, not an error: an upload refused twice removes its file twice.
    await removeFile('u1', 'kept', 'n1', 'b.pdf');
    await removeFile('nobody', 'pending', 'n9', 'x');
  });

  it('lists a shelf with sizes, and empties it without touching the other', async () => {
    await writeFile('u1', 'kept', 'n1', 'a.pdf', pdf('12345'));
    await writeFile('u1', 'kept', 'n2', 'b.pdf', pdf('123'));
    await writeFile('u1', 'pending', 'n2', 'c.jpg', pdf('1'));
    expect((await listShelf('u1', 'kept')).sort((x, y) => x.name.localeCompare(y.name))).toEqual([
      { noteId: 'n1', name: 'a.pdf', size: 5 },
      { noteId: 'n2', name: 'b.pdf', size: 3 },
    ]);
    expect(await listShelf('u2', 'kept')).toEqual([]);
    await clearShelf('u1', 'kept');
    expect(root.paths()).toEqual(['unbent-files-u1/pending/n2/c.jpg']);
    await clearShelf('u1', 'kept');
  });

  it('cuts a long name and keeps two long names apart', () => {
    expect(shelfName('scan.pdf')).toBe('scan.pdf');
    const long = `${'a'.repeat(700)}.pdf`;
    const other = `${'a'.repeat(700)}.png`;
    expect(shelfName(long).length).toBeLessThan(100);
    expect(shelfName(long)).not.toBe(shelfName(other));
    expect(shelfName(long)).toBe(shelfName(long));
  });
});

describe('findFile, which the service worker asks by address', () => {
  it('finds a file in whichever account’s directory holds it, a waiting upload before a kept copy', async () => {
    await writeFile('u1', 'kept', 'n1', 'scan.pdf', pdf('kept'));
    expect(await (await findFile('n1', 'scan.pdf'))!.text()).toBe('kept');
    await writeFile('u1', 'pending', 'n1', 'scan.pdf', pdf('waiting'));
    expect(await (await findFile('n1', 'scan.pdf'))!.text()).toBe('waiting');
    expect(await findFile('n1', 'other.pdf')).toBeNull();
    expect(await findFile('n2', 'scan.pdf')).toBeNull();
  });

  it('ignores what is not a files directory', async () => {
    const db = await root.getDirectoryHandle('unbent-u1.sqlite', { create: true });
    await (await db.getDirectoryHandle('kept', { create: true })).getDirectoryHandle('n1', { create: true });
    expect(await findFile('n1', 'scan.pdf')).toBeNull();
  });
});

describe('the notebooks a device keeps', () => {
  it('are a list in the account’s directory, empty until one is chosen', async () => {
    expect(await readKeptNotebooks('u1')).toEqual([]);
    await writeKeptNotebooks('u1', ['nb1', 'nb2']);
    expect(await readKeptNotebooks('u1')).toEqual(['nb1', 'nb2']);
    expect(await readKeptNotebooks('u2')).toEqual([]);
    expect(root.paths()).toEqual(['unbent-files-u1/kept.json']);
  });

  it('is an error, not an empty list, when the list is there and cannot be read', async () => {
    await writeKeptNotebooks('u1', ['nb1']);
    const account = await root.getDirectoryHandle('unbent-files-u1');
    const real = account.getFileHandle.bind(account);
    account.getFileHandle = async () => {
      throw Object.assign(new Error('busy'), { name: 'InvalidStateError' });
    };
    await expect(readKeptNotebooks('u1')).rejects.toThrow('busy');
    account.getFileHandle = real;
    const writable = await (await account.getFileHandle('kept.json')).createWritable();
    await writable.write('{not json');
    await writable.close();
    await expect(readKeptNotebooks('u1')).rejects.toThrow();
  });
});
