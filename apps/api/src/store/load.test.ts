import { describe, expect, it } from 'vitest';
import { classify, dumpOwner, scanStatements, statementText } from './load.js';

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

  it('keeps a trigger whole through the semicolons of its body, and a CASE inside it', () => {
    const trigger = [
      `CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN`,
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
    expect(classify(`ATTACH 'x' AS y;`)).toBe('refuse');
  });
});

describe('dumpOwner', () => {
  it('reads the account out of the first line and nothing else', () => {
    expect(dumpOwner(`-- Unbent note store of account abc-123, dumped 2026-10-06T00:47:00.000Z`)).toBe('abc-123');
    expect(dumpOwner(`-- something else`)).toBeNull();
    expect(dumpOwner(`PRAGMA foreign_keys = OFF;`)).toBeNull();
  });
});
