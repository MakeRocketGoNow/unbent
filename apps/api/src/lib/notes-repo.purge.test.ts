import { describe, expect, it } from 'vitest';
import { NotesRepo, keysOfDeletedNotes } from './notes-repo.js';

/**
 * A purge that races with a restore: the SELECT has already seen the files, the note
 * is live again by the time the DELETE runs, and the keys must not go out to R2.
 *
 * HTTP cannot inject a restore between those two statements, which is why this lives
 * against a stub D1 rather than the live Worker. The stub answers the SELECT with keys
 * for both notes and the DELETE with only one of them — the shape of "one of the two
 * was restored in between."
 */

describe('keysOfDeletedNotes', () => {
  it('drops keys whose note was not among the deleted ids', () => {
    expect(
      keysOfDeletedNotes(
        [
          { r2_key: 'users/a/kept.pdf', note_id: 'kept' },
          { r2_key: 'users/a/gone.pdf', note_id: 'gone' },
          { r2_key: 'users/a/gone-scan.pdf', note_id: 'gone' },
        ],
        ['gone'],
      ),
    ).toEqual(['users/a/gone.pdf', 'users/a/gone-scan.pdf']);
  });

  it('returns nothing when the delete touched no rows', () => {
    expect(
      keysOfDeletedNotes([{ r2_key: 'users/a/kept.pdf', note_id: 'kept' }], []),
    ).toEqual([]);
  });
});

function fakeDb(opts: {
  keyRows: Array<{ r2_key: string; note_id: string }>;
  deletedIds: string[];
}): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return {
            async all() {
              if (/SELECT a\.r2_key/.test(sql)) return { results: opts.keyRows };
              if (/DELETE FROM notes/.test(sql)) {
                return { results: opts.deletedIds.map((id) => ({ id })) };
              }
              return { results: [] };
            },
            async run() {
              return { meta: { changes: 0 }, success: true };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe('NotesRepo.purgeMany', () => {
  it('does not return keys for a note the DELETE left in place', async () => {
    const db = fakeDb({
      keyRows: [
        { r2_key: 'users/u/restored.pdf', note_id: 'restored' },
        { r2_key: 'users/u/trashed.pdf', note_id: 'trashed' },
      ],
      deletedIds: ['trashed'],
    });
    const repo = new NotesRepo(db, 'user-1');
    const result = await repo.purgeMany(['restored', 'trashed']);
    expect(result).toEqual({ deleted: 1, keys: ['users/u/trashed.pdf'] });
  });

  it('returns no keys when every named note was restored before the DELETE', async () => {
    const db = fakeDb({
      keyRows: [{ r2_key: 'users/u/restored.pdf', note_id: 'restored' }],
      deletedIds: [],
    });
    const repo = new NotesRepo(db, 'user-1');
    const result = await repo.purgeMany(['restored']);
    expect(result).toEqual({ deleted: 0, keys: [] });
  });
});

describe('NotesRepo.purgeOne', () => {
  it('returns no keys when the DELETE did not remove the row', async () => {
    const db = {
      prepare(sql: string) {
        return {
          bind() {
            return {
              async all() {
                return { results: [{ r2_key: 'users/u/kept.pdf' }] };
              },
              async run() {
                // Restore won: the row is live, so this matches nothing.
                return { meta: { changes: sql.includes('DELETE FROM notes') ? 0 : 1 }, success: true };
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    const repo = new NotesRepo(db, 'user-1');
    expect(await repo.purgeOne('restored')).toEqual({ deleted: false, keys: [] });
  });
});
