import { describe, expect, it } from 'vitest';
import {
  ADDRESS_CODES_PER_DAY,
  ADDRESS_CODE_INTERVAL_MS,
  STRANGER_CODES_PER_DAY,
  codeSendsDay,
  recordCodeRequest,
  type CodeSendsDb,
} from './code-sends.js';

/**
 * A D1 that keeps `code_sends` in a map and answers the two statements the library
 * sends, so the rules are checked against the rows a real table would hold. The SQL
 * itself is applied to a real SQLite by migrations.test.ts.
 */
function fakeDb() {
  const rows = new Map<string, { day: string; scope: string; count: number; last_at: number }>();
  const key = (day: string, scope: string) => `${day}\0${scope}`;
  const statement = (sql: string, binds: unknown[]) => ({
    all: async <T>() => {
      const [day, a, b] = binds as [string, string, string];
      const results = [...rows.values()].filter((r) => r.day === day && (r.scope === a || r.scope === b));
      return { results: results as T[] };
    },
    run: async () => {
      if (sql.startsWith('DELETE')) {
        const [day] = binds as [string];
        for (const [k, r] of rows) if (r.day < day) rows.delete(k);
      } else {
        const [day, scope, now] = binds as [string, string, number];
        const existing = rows.get(key(day, scope));
        if (existing) {
          existing.count += 1;
          existing.last_at = now;
        } else rows.set(key(day, scope), { day, scope, count: 1, last_at: now });
      }
      return {};
    },
  });
  const db: CodeSendsDb = {
    prepare: (sql) => ({ bind: (...binds) => statement(sql, binds) }),
    batch: async (statements) => {
      for (const s of statements) await s.run();
      return [];
    },
  };
  return { db, rows };
}

const T0 = Date.UTC(2026, 9, 17, 12, 0, 0);
const MINUTE = 60_000;

describe('recordCodeRequest', () => {
  it('allows a first code and counts it against the address, and the strangers when unknown', async () => {
    const { db, rows } = fakeDb();
    expect(await recordCodeRequest(db, 'New@Example.com', false, T0)).toBeNull();
    expect([...rows.values()].map((r) => [r.scope, r.count])).toEqual([
      ['address:new@example.com', 1],
      ['strangers', 1],
    ]);
  });

  it('does not count an account holder against the strangers', async () => {
    const { db, rows } = fakeDb();
    expect(await recordCodeRequest(db, 'me@example.com', true, T0)).toBeNull();
    expect([...rows.keys()].some((k) => k.endsWith('strangers'))).toBe(false);
  });

  it('refuses a second code to the same address within the interval, and allows it after', async () => {
    const { db } = fakeDb();
    await recordCodeRequest(db, 'me@example.com', true, T0);
    expect(await recordCodeRequest(db, 'me@example.com', true, T0 + 5_000)).toBe('interval');
    expect(await recordCodeRequest(db, 'me@example.com', true, T0 + ADDRESS_CODE_INTERVAL_MS)).toBeNull();
  });

  it('refuses an address past its codes for the day, account or not', async () => {
    const { db } = fakeDb();
    for (let i = 0; i < ADDRESS_CODES_PER_DAY; i++) {
      expect(await recordCodeRequest(db, 'me@example.com', true, T0 + i * MINUTE)).toBeNull();
    }
    const later = T0 + ADDRESS_CODES_PER_DAY * MINUTE;
    expect(await recordCodeRequest(db, 'me@example.com', true, later)).toBe('address');
    // The day's bound outranks the interval: it is the sentence that tells them to try tomorrow.
    expect(await recordCodeRequest(db, 'me@example.com', true, later + 1)).toBe('address');
  });

  it('refuses strangers past their share while accounts still get codes', async () => {
    const { db } = fakeDb();
    for (let i = 0; i < STRANGER_CODES_PER_DAY; i++) {
      expect(await recordCodeRequest(db, `bot${i}@example.com`, false, T0 + i)).toBeNull();
    }
    expect(await recordCodeRequest(db, 'another@example.com', false, T0 + MINUTE)).toBe('strangers');
    expect(await recordCodeRequest(db, 'me@example.com', true, T0 + MINUTE)).toBeNull();
  });

  it('a refusal writes nothing', async () => {
    const { db, rows } = fakeDb();
    await recordCodeRequest(db, 'me@example.com', true, T0);
    const before = JSON.stringify([...rows.values()]);
    await recordCodeRequest(db, 'me@example.com', true, T0 + 1);
    expect(JSON.stringify([...rows.values()])).toBe(before);
  });

  it('starts afresh at midnight UTC and prunes the day before', async () => {
    const { db, rows } = fakeDb();
    const lateYesterday = Date.UTC(2026, 9, 16, 23, 59, 30);
    const start = lateYesterday - ADDRESS_CODES_PER_DAY * MINUTE;
    for (let i = 0; i < ADDRESS_CODES_PER_DAY; i++) {
      expect(await recordCodeRequest(db, 'me@example.com', true, start + i * MINUTE)).toBeNull();
    }
    expect(await recordCodeRequest(db, 'me@example.com', true, lateYesterday)).toBe('address');
    const justAfterMidnight = Date.UTC(2026, 9, 17, 0, 0, 10);
    expect(codeSendsDay(justAfterMidnight)).toBe('2026-10-17');
    expect(await recordCodeRequest(db, 'me@example.com', true, justAfterMidnight)).toBeNull();
    expect([...rows.values()].map((r) => r.day)).toEqual(['2026-10-17']);
  });
});
