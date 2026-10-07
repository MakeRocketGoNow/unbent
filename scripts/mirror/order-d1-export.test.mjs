import { test } from 'node:test';
import assert from 'node:assert/strict';
import { order, statements } from './order-d1-export.mjs';

const EXPORT = [
  'PRAGMA defer_foreign_keys=TRUE;',
  'CREATE TABLE IF NOT EXISTS "parent"(',
  '  id TEXT PRIMARY KEY,',
  '  ident TEXT NOT NULL',
  ');',
  `INSERT INTO "parent" ("id","ident") VALUES('p1','a; b');`,
  'CREATE TABLE child (id TEXT PRIMARY KEY, parent_ident TEXT REFERENCES parent(ident));',
  `INSERT INTO "child" ("id","parent_ident") VALUES('c1','a; b');`,
  'DELETE FROM sqlite_sequence;',
  `INSERT INTO "sqlite_sequence" ("name","seq") VALUES('d1_migrations',37);`,
  'CREATE UNIQUE INDEX idx_parent_ident ON parent(ident);',
  'CREATE TRIGGER t AFTER INSERT ON child BEGIN',
  '  UPDATE parent SET ident = ident;',
  'END;',
  '',
].join('\n');

test('splits on statement ends, keeping a trigger whole and a ; inside a value', () => {
  const s = statements(EXPORT);
  assert.equal(s.length, 9);
  assert.match(s[1], /^CREATE TABLE IF NOT EXISTS "parent"\(\n/);
  assert.match(s[2], /'a; b'/);
  assert.match(s[8], /^CREATE TRIGGER t[\s\S]*END;$/);
});

test('puts every CREATE before every INSERT and drops the PRAGMA and sqlite_sequence lines', () => {
  const r = order(EXPORT);
  const lines = r.sql.trim().split('\n');
  const firstInsert = lines.findIndex((l) => l.startsWith('INSERT'));
  const lastCreate = lines.map((l) => /^(CREATE|END;)/.test(l)).lastIndexOf(true);
  assert.ok(lastCreate < firstInsert, 'schema before rows');
  assert.equal(r.schema, 4);
  assert.equal(r.rows, 2);
  assert.equal(r.dropped.length, 3);
  assert.equal(r.unknown.length, 0);
  assert.doesNotMatch(r.sql, /sqlite_sequence|PRAGMA/);
});

test('keeps a statement it does not recognise, after the rows, and names it', () => {
  const r = order('CREATE TABLE a (x);\nUPDATE a SET x = 1;\nINSERT INTO "a" ("x") VALUES(2);\n');
  assert.equal(r.unknown.length, 1);
  assert.match(r.sql, /CREATE TABLE a \(x\);\nINSERT INTO "a" \("x"\) VALUES\(2\);\nUPDATE a SET x = 1;\n$/);
});
