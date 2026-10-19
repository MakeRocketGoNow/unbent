import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  FEEDBACK_KEPT_MS,
  FEEDBACK_PER_DAY,
  FEEDBACK_PER_DAY_INSTANCE,
  listFeedback,
  markFeedbackRead,
  recordFeedback,
  type FeedbackDb,
  type FeedbackStatement,
  type NewFeedback,
} from './assistant-feedback.js';

/**
 * A D1 over a real SQLite with migration 0047 applied, beside the two columns of `user`
 * and `oauthClient` it reads, so the day's bound and the prune are checked as SQLite runs
 * the statements' own conditions. A batch is one transaction, as D1 makes it.
 */
function fakeDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE user (id TEXT PRIMARY KEY, email TEXT NOT NULL);
    CREATE TABLE oauthClient (id TEXT PRIMARY KEY, clientId TEXT NOT NULL UNIQUE, name TEXT);`);
  sqlite.exec(readFileSync(join(import.meta.dirname, '../../migrations/0047_assistant_feedback.sql'), 'utf8'));
  sqlite.exec(`INSERT INTO user VALUES ('u1', 'one@example.com'), ('u2', 'two@example.com');
    INSERT INTO oauthClient VALUES ('c', 'client-1', 'Example Assistant');`);
  const statement = (sql: string, binds: unknown[]): FeedbackStatement => ({
    all: async <T>() => ({ results: sqlite.prepare(sql).all(...(binds as SQLInputValue[])) as T[] }),
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...(binds as SQLInputValue[])).changes) } }),
  });
  const db: FeedbackDb = {
    prepare: (sql) => ({ bind: (...binds) => statement(sql, binds) }),
    batch: async (statements) => {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const s of statements) results.push(await s.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    },
  };
  return { db, sqlite, count: () => (sqlite.prepare('SELECT COUNT(*) AS n FROM assistant_feedback').get() as { n: number }).n };
}

const T0 = Date.UTC(2026, 9, 19, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

const sample = (over: Partial<NewFeedback> = {}): NewFeedback => ({
  userId: 'u1',
  clientId: 'client-1',
  category: 'error-message',
  tool: 'edit_note',
  body: 'The refusal for a find that matched twice did not say which lines matched.',
  ...over,
});

describe('recordFeedback', () => {
  it('keeps the feedback with the client name it registered under, and lists it with the address', async () => {
    const { db } = fakeDb();
    expect(await recordFeedback(db, sample(), T0)).toBe('kept');
    const page = await listFeedback(db);
    expect(page.more).toBe(false);
    expect(page.feedback).toEqual([
      {
        id: expect.any(Number),
        userId: 'u1',
        email: 'one@example.com',
        clientId: 'client-1',
        clientName: 'Example Assistant',
        category: 'error-message',
        tool: 'edit_note',
        body: sample().body,
        createdAt: T0,
      },
    ]);
  });

  it('keeps a client it cannot name by its id alone', async () => {
    const { db } = fakeDb();
    await recordFeedback(db, sample({ clientId: 'gone' }), T0);
    expect((await listFeedback(db)).feedback[0]).toMatchObject({ clientId: 'gone', clientName: null });
  });

  it("refuses an account's feedback past the day's bound, for that account alone, and again once the day has rolled", async () => {
    const { db, count } = fakeDb();
    for (let i = 0; i < FEEDBACK_PER_DAY; i++) expect(await recordFeedback(db, sample({ body: `report ${i}` }), T0 + i)).toBe('kept');
    expect(await recordFeedback(db, sample({ body: 'one more' }), T0 + HOUR)).toBe('limit');
    expect(await recordFeedback(db, sample({ userId: 'u2', body: 'one more' }), T0 + HOUR)).toBe('kept');
    expect(count()).toBe(FEEDBACK_PER_DAY + 1);
    // A rolling day: the first of the twenty is past it a millisecond after its 24 hours.
    expect(await recordFeedback(db, sample({ body: 'one more' }), T0 + 24 * HOUR + 1)).toBe('kept');
  });

  it("refuses the account's own words a second time in a day, whatever else differs, and takes them again after", async () => {
    const { db, count } = fakeDb();
    expect(await recordFeedback(db, sample(), T0)).toBe('kept');
    expect(await recordFeedback(db, sample({ category: 'other', tool: null, clientId: 'gone' }), T0 + HOUR)).toBe('repeat');
    // Another account saying the same thing is a second report, not a repeat.
    expect(await recordFeedback(db, sample({ userId: 'u2' }), T0 + HOUR)).toBe('kept');
    expect(await recordFeedback(db, sample(), T0 + 24 * HOUR + 1)).toBe('kept');
    expect(count()).toBe(3);
  });

  it("refuses every account once the instance has taken its day's worth, and says it was the instance", async () => {
    const { db, sqlite } = fakeDb();
    // The day's worth from accounts other than u1, written straight in: the bound being
    // tested is the instance's, which no one account's twenty can reach.
    sqlite.exec(`INSERT INTO user VALUES ('others', 'others@example.com')`);
    const insert = sqlite.prepare(`INSERT INTO assistant_feedback (user_id, client_id, category, body, created_at) VALUES ('others', 'c', 'other', ?, ?)`);
    for (let i = 0; i < FEEDBACK_PER_DAY_INSTANCE; i++) insert.run(`report ${i}`, T0 + i);
    expect(await recordFeedback(db, sample(), T0 + HOUR)).toBe('full');
    // A rolling day: once the first of them is past it, there is room again.
    expect(await recordFeedback(db, sample(), T0 + 24 * HOUR + 1)).toBe('kept');
  });

  it('prunes what is past its age on the next write, read or not', async () => {
    const { db, count } = fakeDb();
    await recordFeedback(db, sample({ body: 'first' }), T0);
    await recordFeedback(db, sample({ body: 'second' }), T0 + HOUR);
    const [first] = (await listFeedback(db)).feedback.slice(-1);
    await markFeedbackRead(db, first!.id, true, T0 + 2 * HOUR);
    await recordFeedback(db, sample({ userId: 'u2' }), T0 + FEEDBACK_KEPT_MS + HOUR / 2);
    expect(count()).toBe(2);
    expect((await listFeedback(db)).feedback.map((f) => f.createdAt)).toEqual([T0 + FEEDBACK_KEPT_MS + HOUR / 2, T0 + HOUR]);
  });

  it("goes with the account's user row", async () => {
    const { db, sqlite, count } = fakeDb();
    await recordFeedback(db, sample(), T0);
    sqlite.exec(`DELETE FROM user WHERE id = 'u1'`);
    expect(count()).toBe(0);
  });
});

describe('listFeedback', () => {
  it('lists unread rows newest first, a page at a time, and says when there are more', async () => {
    const { db } = fakeDb();
    for (let i = 0; i < 4; i++) await recordFeedback(db, sample({ body: `note ${i}` }), T0 + i);
    const page = await listFeedback(db, 3);
    expect(page.feedback.map((f) => f.body)).toEqual(['note 3', 'note 2', 'note 1']);
    expect(page.more).toBe(true);
  });

  it('leaves a dismissed row out, and lists it again once it is brought back', async () => {
    const { db } = fakeDb();
    await recordFeedback(db, sample(), T0);
    const [row] = (await listFeedback(db)).feedback;
    expect(await markFeedbackRead(db, row!.id, true, T0 + HOUR)).toBe(true);
    expect((await listFeedback(db)).feedback).toEqual([]);
    expect(await markFeedbackRead(db, row!.id, false)).toBe(true);
    expect((await listFeedback(db)).feedback.map((f) => f.id)).toEqual([row!.id]);
    expect(await markFeedbackRead(db, 9999, true)).toBe(false);
  });
});
