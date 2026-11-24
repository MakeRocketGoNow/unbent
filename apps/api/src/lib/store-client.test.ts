import { describe, expect, it } from 'vitest';
import { InvalidFieldValue } from '@unbent/shared';
import { AccessRefused } from './access.js';
import { NotesRepo, noWriteLimits } from './notes-repo.js';
import { StorageFull } from './quota.js';
import { StoreUnavailable, translateStoreError } from './store-client.js';

/**
 * What comes back over RPC is a plain `Error` carrying the thrown error's name and own
 * properties; this is the translation the facades apply so the routes keep their
 * `instanceof` checks and a transient object failure reads as "try again shortly".
 */
describe('translateStoreError', () => {
  it('rebuilds a real InvalidFieldValue from the name and field that crossed RPC', () => {
    const arrived = Object.assign(new Error('must be a number'), { name: 'InvalidFieldValue', fieldName: 'Amount' });
    const translated = translateStoreError(arrived);
    expect(translated).toBeInstanceOf(InvalidFieldValue);
    expect(translated).toMatchObject({ fieldName: 'Amount', message: 'must be a number' });
  });

  it('turns the runtime\'s transient failures into StoreUnavailable', () => {
    for (const message of [
      'Durable Object is overloaded.',
      'Durable Object reset because its code was updated.',
      'Network connection lost.',
      'Durable Object storage operation exceeded timeout which caused object to be reset.',
      'Too many subrequests.',
    ]) {
      const translated = translateStoreError(new Error(message));
      expect(translated, message).toBeInstanceOf(StoreUnavailable);
      expect((translated as StoreUnavailable).retryAfterSeconds).toBe(60);
    }
    expect(translateStoreError(Object.assign(new Error('x'), { retryable: true }))).toBeInstanceOf(StoreUnavailable);
    expect(translateStoreError(Object.assign(new Error('x'), { overloaded: true }))).toBeInstanceOf(StoreUnavailable);
  });

  it('rebuilds a StorageFull for the bound that refused: the files, or the store itself', () => {
    const files = translateStoreError(Object.assign(new Error('x'), { name: 'StorageExceeded', code: 'STORAGE_FULL', usedBytes: 900, quotaBytes: 1000, addingBytes: 101 }));
    expect(files).toBeInstanceOf(StorageFull);
    expect(files).toMatchObject({ of: 'files', usedBytes: 900, quotaBytes: 1000, addingBytes: 101 });
    expect((files as StorageFull).message).toContain('storage is full');
    const notes = translateStoreError(Object.assign(new Error('x'), { name: 'StoreFull', code: 'STORAGE_FULL', of: 'notes', usedBytes: 2000, quotaBytes: 1000 }));
    expect(notes).toBeInstanceOf(StorageFull);
    expect(notes).toMatchObject({ of: 'notes', usedBytes: 2000, quotaBytes: 1000, addingBytes: 0 });
    expect((notes as StorageFull).message).toContain('notes take more room');
  });

  it('rebuilds an AccessRefused with the sentence for its reason', () => {
    const arrived = Object.assign(new Error('refused for a restricted connection: manage'), { name: 'AccessRefusal', code: 'ACCESS_REFUSED', reason: 'manage' });
    const translated = translateStoreError(arrived);
    expect(translated).toBeInstanceOf(AccessRefused);
    expect((translated as AccessRefused).message).toContain('Settings under AI assistants');
    // A reason this build does not know is not dressed up as one it does.
    const unknown = Object.assign(new Error('x'), { code: 'ACCESS_REFUSED', reason: 'later' });
    expect(translateStoreError(unknown)).toBe(unknown);
  });

  it('passes every other error through untouched', () => {
    const other = new Error('no such table: notes');
    expect(translateStoreError(other)).toBe(other);
    expect(translateStoreError('a string')).toBe('a string');
  });
});

/**
 * A repo built with a grant has one way to its store (MAK-264): `scoped`, with the
 * grant and the name of the method it wanted. The stub here records what is asked of
 * it and has nothing else to call, so a facade method that reached the store any other
 * way would throw rather than pass.
 */
describe('a restricted repo', () => {
  const access = { notebooks: ['nb-1'], unfiled: false };
  function recording() {
    const calls: Array<{ access: unknown; method: string; args: unknown[] }> = [];
    const stub = {
      scoped: async (given: unknown, method: string, args: unknown[]) => {
        calls.push({ access: given, method, args });
        return null;
      },
    };
    return { calls, stub: stub as unknown as ConstructorParameters<typeof NotesRepo>[0] };
  }

  it('sends every call through scoped, with its grant', async () => {
    const { calls, stub } = recording();
    const notes = new NotesRepo(stub, 'user-1', noWriteLimits, access);
    await notes.get('note-1', { includeTrashed: true });
    await notes.listTags();
    await notes.remove('note-2');
    expect(calls).toEqual([
      { access, method: 'get', args: ['note-1', { includeTrashed: true }] },
      { access, method: 'listTags', args: [] },
      { access, method: 'remove', args: ['note-2'] },
    ]);
  });

  it('leaves a repo with no grant calling its store directly', async () => {
    const asked: string[] = [];
    const stub = { get: async (id: string) => (asked.push(id), null) } as unknown as ConstructorParameters<typeof NotesRepo>[0];
    await new NotesRepo(stub, 'user-1', noWriteLimits).get('note-1');
    expect(asked).toEqual(['note-1']);
  });

  it('translates what the store refuses', async () => {
    const stub = {
      scoped: async () => {
        throw Object.assign(new Error('x'), { code: 'ACCESS_REFUSED', reason: 'method' });
      },
    } as unknown as ConstructorParameters<typeof NotesRepo>[0];
    await expect(new NotesRepo(stub, 'user-1', noWriteLimits, access).listTags()).rejects.toBeInstanceOf(AccessRefused);
  });
});
