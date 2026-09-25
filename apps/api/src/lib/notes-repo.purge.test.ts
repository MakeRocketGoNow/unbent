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

/**
 * A stub D1 holding a set of note ids and a `note_counts` row that disagrees with it, for
 * the paging in `purge`: it must end on what its own query saw, not on the stored counts,
 * and it must sweep tags and tombstoned fields on whichever call finds the scope empty.
 */
function pagingDb(ids: string[], storedCount: number) {
  const notes = new Set(ids);
  const sweeps: string[] = [];
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...bound: unknown[]) => statement(sql, bound),
    async all() {
      if (/^SELECT id FROM notes/.test(sql)) {
        return { results: [...notes].slice(0, args[1] as number).map((id) => ({ id })) };
      }
      if (/DELETE FROM notes/.test(sql)) {
        const gone = (args.slice(1) as string[]).filter((id) => notes.delete(id));
        return { results: gone.map((id) => ({ id })) };
      }
      return { results: [] };
    },
    async first() {
      return /note_counts/.test(sql) ? { live: storedCount, trashed: 0 } : null;
    },
    async run() {
      if (/DELETE FROM tags/.test(sql)) sweeps.push('tags');
      if (/DELETE FROM notebook_fields/.test(sql)) sweeps.push('fields');
      return { meta: { changes: 0 }, success: true };
    },
  });
  const db = {
    prepare: (sql: string) => statement(sql),
    batch: (stmts: Array<ReturnType<typeof statement>>) => Promise.all(stmts.map((s) => s.all())),
  } as unknown as D1Database;
  return { db, notes, sweeps };
}

/** Calls `purge` the way the clients do, until it says nothing is left. */
async function purgeAll(repo: NotesRepo, limit: number) {
  const calls: Array<{ notes: number; remaining: number }> = [];
  for (let i = 0; i < 10; i++) {
    const { notes, remaining } = await repo.purge('all', limit);
    calls.push({ notes, remaining });
    if (remaining === 0) break;
  }
  return calls;
}

describe('NotesRepo.purge', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];

  it('pages through every note and sweeps once, on the last page', async () => {
    const { db, notes, sweeps } = pagingDb(ids, 3);
    const calls = await purgeAll(new NotesRepo(db, 'user-1'), 2);
    expect(calls.map((c) => c.notes)).toEqual([2, 2, 1]);
    expect(calls.at(-1)?.remaining).toBe(0);
    expect(notes.size).toBe(0);
    expect(sweeps).toEqual(['tags', 'fields']);
  });

  it('keeps going when the stored count says nothing is left', async () => {
    const { db, notes } = pagingDb(ids, 0);
    const calls = await purgeAll(new NotesRepo(db, 'user-1'), 2);
    expect(calls[0]?.remaining).toBeGreaterThan(0);
    expect(notes.size).toBe(0);
  });

  it('sweeps on the call that finds nothing when the stored count is too high', async () => {
    const { db, notes, sweeps } = pagingDb(ids.slice(0, 4), 50);
    const calls = await purgeAll(new NotesRepo(db, 'user-1'), 2);
    expect(calls).toEqual([
      { notes: 2, remaining: 50 },
      { notes: 2, remaining: 50 },
      { notes: 0, remaining: 0 },
    ]);
    expect(notes.size).toBe(0);
    expect(sweeps).toEqual(['tags', 'fields']);
  });
});
