import { describe, expect, it } from 'vitest';
import { InvalidFieldValue } from '@unbent/shared';
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

  it('passes every other error through untouched', () => {
    const other = new Error('no such table: notes');
    expect(translateStoreError(other)).toBe(other);
    expect(translateStoreError('a string')).toBe('a string');
  });
});
