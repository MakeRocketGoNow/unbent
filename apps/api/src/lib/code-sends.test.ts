import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  ADDRESS_CODES_PER_DAY,
  ADDRESS_CODE_INTERVAL_MS,
  STRANGER_CODES_PER_DAY,
  codeRequestOf,
  codeSendsDay,
  recordCodeRequest,
  type CodeSendsDb,
  type CodeSendsStatement,
} from './code-sends.js';

/**
 * A D1 over a real SQLite with migration 0046 applied, so the bounds that live in the
 * statements' own conditions are checked as SQLite runs them. A batch is one
 * transaction, as D1 makes it.
 */
function fakeDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(join(import.meta.dirname, '../../migrations/0046_code_sends.sql'), 'utf8'));
  const statement = (sql: string, binds: unknown[]): CodeSendsStatement => ({
    all: async <T>() => ({ results: sqlite.prepare(sql).all(...(binds as SQLInputValue[])) as T[] }),
  });
  const db: CodeSendsDb = {
    prepare: (sql) => ({ bind: (...binds) => statement(sql, binds) }),
    // Each statement's SQL runs when `all` is called, so the whole transaction happens
    // before the first await and two batches in flight never interleave inside one.
    batch: async (statements) => {
      sqlite.exec('BEGIN');
      let pending;
      try {
        pending = statements.map((s) => s.all());
        sqlite.exec('COMMIT');
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
      return Promise.all(pending);
    },
  };
  const rows = {
    values: () => sqlite.prepare('SELECT day, scope, count, last_at FROM code_sends ORDER BY day, scope').all() as Array<{
      day: string;
      scope: string;
      count: number;
      last_at: number;
    }>,
    keys: () => rows.values().map((r) => `${r.day}\0${r.scope}`),
  };
  return { db, rows };
}

const T0 = Date.UTC(2026, 9, 17, 12, 0, 0);
const MINUTE = 60_000;

describe('recordCodeRequest', () => {
  it('allows a first code and counts it against the address, and the strangers when unknown', async () => {
    const { db, rows } = fakeDb();
    expect(await recordCodeRequest(db, 'New@Example.com', false, T0)).toBeNull();
    expect(rows.values().map((r) => [r.scope, r.count])).toEqual([
      ['address:new@example.com', 1],
      ['strangers', 1],
    ]);
  });

  it('does not count an account holder against the strangers', async () => {
    const { db, rows } = fakeDb();
    expect(await recordCodeRequest(db, 'me@example.com', true, T0)).toBeNull();
    expect(rows.keys().some((k) => k.endsWith('strangers'))).toBe(false);
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

  it('holds every bound against a burst in flight at once', async () => {
    const { db } = fakeDb();
    const strangers = await Promise.all(
      Array.from({ length: 50 }, (_, i) => recordCodeRequest(db, `bot${i}@example.com`, false, T0)),
    );
    expect(strangers.filter((r) => r === null)).toHaveLength(STRANGER_CODES_PER_DAY);
    const one = await Promise.all(Array.from({ length: 5 }, () => recordCodeRequest(db, 'me@example.com', true, T0)));
    expect(one.filter((r) => r === null)).toHaveLength(1);
  });

  it('a refusal writes nothing', async () => {
    const { db, rows } = fakeDb();
    await recordCodeRequest(db, 'me@example.com', true, T0);
    const before = JSON.stringify(rows.values());
    await recordCodeRequest(db, 'me@example.com', true, T0 + 1);
    expect(JSON.stringify(rows.values())).toBe(before);
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
    expect(rows.values().map((r) => r.day)).toEqual(['2026-10-17']);
  });
});

describe('codeRequestOf', () => {
  it('counts every route that mails a code, not only the sign-in one', () => {
    const body = { email: 'Me@Example.com', type: 'sign-in' };
    expect(codeRequestOf('/email-otp/send-verification-otp', body)).toEqual({
      email: 'me@example.com',
      toStrangers: true,
    });
    for (const path of ['/email-otp/request-password-reset', '/forget-password/email-otp']) {
      expect(codeRequestOf(path, { email: 'me@example.com' })).toEqual({ email: 'me@example.com', toStrangers: false });
    }
  });

  it('ignores routes that send nothing, and bodies with no address', () => {
    expect(codeRequestOf('/sign-in/email-otp', { email: 'me@example.com', otp: '123456' })).toBeNull();
    expect(codeRequestOf(undefined, { email: 'me@example.com' })).toBeNull();
    expect(codeRequestOf('/email-otp/send-verification-otp', {})).toBeNull();
    expect(codeRequestOf('/email-otp/send-verification-otp', undefined)).toBeNull();
  });

  it('ignores what the route refuses before sending: a malformed address, an unknown or change-email type', () => {
    const send = '/email-otp/send-verification-otp';
    expect(codeRequestOf(send, { email: 'not an address', type: 'sign-in' })).toBeNull();
    expect(codeRequestOf(send, { email: 'me@example.com', type: 'change-email' })).toBeNull();
    expect(codeRequestOf(send, { email: 'me@example.com', type: 'bogus' })).toBeNull();
    expect(codeRequestOf(send, { email: 'me@example.com' })).toBeNull();
  });

  it('reaches a stranger only for a sign-in code', () => {
    const send = '/email-otp/send-verification-otp';
    expect(codeRequestOf(send, { email: 'me@example.com', type: 'sign-in' })?.toStrangers).toBe(true);
    for (const type of ['email-verification', 'forget-password']) {
      expect(codeRequestOf(send, { email: 'me@example.com', type })?.toStrangers).toBe(false);
    }
  });
});
