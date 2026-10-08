import { describe, expect, it } from 'vitest';
import { classify, dumpOwner, liftLiterals, scanStatements, statementKind, statementText, tooLongToRun } from './load.js';

/**
 * The statement scanner a load runs a dump through, on the shapes a dump holds: literals
 * with semicolons and doubled quotes in them, comment lines, a `CREATE TRIGGER` whose
 * body has semicolons of its own, and a page boundary anywhere. The object's side — the
 * pages, the marker, the migration on finish — is in apps/store-tests/test/load.test.ts.
 */
describe('scanStatements', () => {
  it('ends a statement at a semicolon outside a literal and a comment', () => {
    const text = [
      `-- Unbent note store of account u1, dumped now`,
      `PRAGMA foreign_keys = OFF;`,
      `INSERT INTO notes (id, body) VALUES ('n1', 'a; semicolon -- and a dash; it''s all body');`,
      `INSERT INTO notes (id, body) VALUES ('n2', 'two`,
      `lines');`,
      `-- a comment with a ; in it`,
      `INSERT INTO tags (id) VALUES ('t1'`,
    ].join('\n');
    const { statements, rest } = scanStatements(text);
    expect(statements.map(statementText)).toEqual([
      `PRAGMA foreign_keys = OFF;`,
      `INSERT INTO notes (id, body) VALUES ('n1', 'a; semicolon -- and a dash; it''s all body');`,
      `INSERT INTO notes (id, body) VALUES ('n2', 'two\nlines');`,
    ]);
    expect(rest).toBe(`\n-- a comment with a ; in it\nINSERT INTO tags (id) VALUES ('t1'`);
  });

  it('keeps a trigger whole through the semicolons of its body, a CASE inside it, and a comment naming END', () => {
    const trigger = [
      `CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN`,
      `  -- the end is not here; begin again`,
      `  INSERT INTO notes_fts(rowid, title) VALUES (new.rowid, new.title);`,
      `  UPDATE note_counts SET live = live + CASE WHEN new.deleted_at IS NULL THEN 1 ELSE 0 END;`,
      `END;`,
    ].join('\n');
    const { statements, rest } = scanStatements(`${trigger}\nINSERT INTO x VALUES ('end; begin');`);
    expect(statements.map(statementText)).toEqual([trigger, `INSERT INTO x VALUES ('end; begin');`]);
    expect(rest).toBe('');
  });

  it('gives the same statements however the text is cut into pages (by character; bytes are the store test\'s)', () => {
    const text = [
      `CREATE TABLE t (a TEXT);`,
      `INSERT INTO t VALUES ('héllo; wörld ''quoted''');`,
      `CREATE TRIGGER tr AFTER INSERT ON t BEGIN`,
      `  INSERT INTO t VALUES ('x');`,
      `END;`,
      `INSERT INTO t VALUES (X'00ff');`,
      `-- the end`,
      ``,
    ].join('\n');
    const whole = scanStatements(text);
    for (const size of [1, 3, 7, 16, 64]) {
      const statements: string[] = [];
      let rest = '';
      for (let at = 0; at < text.length; at += size) {
        const scan = scanStatements(rest + text.slice(at, at + size));
        statements.push(...scan.statements);
        rest = scan.rest;
      }
      expect(statements, `page size ${size}`).toEqual(whole.statements);
      expect(rest).toBe(whole.rest);
    }
    expect(whole.rest).toBe('\n-- the end\n');
  });
});

describe('classify', () => {
  it('runs CREATE and INSERT, skips the wrapper, and refuses anything else', () => {
    expect(classify(`-- head\nCREATE TABLE t (a);`)).toBe('run');
    expect(classify(`INSERT INTO t VALUES (1);`)).toBe('run');
    expect(classify(`\nBEGIN;`)).toBe('skip');
    expect(classify(`COMMIT;`)).toBe('skip');
    expect(classify(`PRAGMA foreign_keys = ON;`)).toBe('skip');
    expect(classify(`-- only a comment\n`)).toBe('skip');
    expect(classify(`;`)).toBe('skip');
    expect(classify(`DROP TABLE notes;`)).toBe('refuse');
    expect(classify(`DELETE FROM notes;`)).toBe('refuse');
    // The runtime's and SQLite's own, which a dump taken before MAK-197 carries.
    expect(classify(`CREATE TABLE _cf_KV (\n        key TEXT PRIMARY KEY,\n        value BLOB\n      ) WITHOUT ROWID;`)).toBe('skip');
    expect(classify(`INSERT INTO _cf_KV (key, value) VALUES ('x', X'00');`)).toBe('skip');
    expect(classify(`INSERT INTO "sqlite_sequence" ("name","seq") VALUES('t', 1);`)).toBe('skip');
    expect(classify(`CREATE INDEX idx_kv ON _cf_KV (value);`)).toBe('skip');
    expect(classify(`CREATE TABLE cf_things (a);`)).toBe('run');
    expect(classify(`ATTACH 'x' AS y;`)).toBe('refuse');
  });
});

describe('statementKind', () => {
  it('names the verb and the table and never a value', () => {
    expect(statementKind(`-- head\nINSERT INTO notes (id, body) VALUES ('n1', 'the secret body');`)).toBe('INSERT INTO notes');
    expect(statementKind(`INSERT OR REPLACE INTO tags VALUES ('x');`)).toBe('INSERT INTO tags');
    expect(statementKind(`CREATE VIRTUAL TABLE notes_fts USING fts5(title);`)).toBe('CREATE VIRTUAL TABLE notes_fts');
    expect(statementKind(`DELETE FROM notes;`)).toBe('DELETE FROM notes');
    expect(statementKind(`CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN`)).toBe('CREATE TRIGGER notes_ai');
    expect(statementKind(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT);`)).toBe('CREATE TABLE _migrations');
    expect(statementKind(`'a literal that leads'`)).toBe('unrecognised');
  });
});

describe('tooLongToRun', () => {
  it('measures bytes, not characters', () => {
    expect(tooLongToRun(`INSERT INTO t VALUES ('${'a'.repeat(80_000)}');`)).toBe(false);
    expect(tooLongToRun(`INSERT INTO t VALUES ('${'a'.repeat(95_000)}');`)).toBe(true);
    // 40,000 CJK characters are 120 KB.
    expect(tooLongToRun(`INSERT INTO t VALUES ('${'中'.repeat(40_000)}');`)).toBe(true);
    expect(tooLongToRun(`INSERT INTO t VALUES ('${'中'.repeat(29_000)}');`)).toBe(false);
  });
});

describe('liftLiterals', () => {
  it('binds every string and blob literal, keeps numbers and NULL in the text, and unescapes quotes', () => {
    const big = "it''s ".repeat(20_000);
    const { sql, values } = liftLiterals(`INSERT INTO notes (id, title, body, n, k, b) VALUES ('n1', 'T; -- not a comment', '${big}', 42, NULL, X'00ff10');`);
    expect(sql).toBe(`INSERT INTO notes (id, title, body, n, k, b) VALUES (?1, ?2, ?3, 42, NULL, ?4);`);
    expect(values.slice(0, 2)).toEqual(['n1', 'T; -- not a comment']);
    expect(values[2]).toBe("it's ".repeat(20_000));
    expect(values[3]).toEqual(new Uint8Array([0, 255, 16]));
    expect(() => liftLiterals(`INSERT INTO t VALUES ('open`)).toThrow(/never closes/);
  });
});

describe('dumpOwner', () => {
  it('reads the account out of the first line and nothing else', () => {
    expect(dumpOwner(`-- Unbent note store of account abc-123, dumped 2026-10-06T00:47:00.000Z`)).toBe('abc-123');
    expect(dumpOwner(`-- something else`)).toBeNull();
    expect(dumpOwner(`PRAGMA foreign_keys = OFF;`)).toBeNull();
  });
});
