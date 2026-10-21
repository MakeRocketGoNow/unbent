// @vitest-environment node
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { narrowings } from './schemas.js';
import { declarations, interfaceParts, normalize, relativeImports } from './surfaces.js';

/** What `contract.test.ts` compares: a zod schema as JSON Schema, from the sender's side. */
const json = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
const between = (prev: z.ZodType, next: z.ZodType) => narrowings(json(next), json(prev));
const kinds = (prev: z.ZodType, next: z.ZodType) => between(prev, next).map((n) => `${n.severity} ${n.path}`);

describe('narrowings', () => {
  const note = z.object({ title: z.string().max(500), tags: z.array(z.string().min(1).max(100)).max(100).optional() });

  it('finds nothing when the schema accepts at least what it did', () => {
    expect(between(note, note)).toEqual([]);
    expect(between(note, note.extend({ pinned: z.boolean().optional() }))).toEqual([]);
    expect(between(note, z.object({ title: z.string().max(1000), tags: z.array(z.string().max(200)).optional() }))).toEqual([]);
    expect(between(z.enum(['a', 'b']), z.enum(['a', 'b', 'c']))).toEqual([]);
    expect(between(z.string(), z.string().nullable())).toEqual([]);
    expect(between(z.number().int(), z.number())).toEqual([]);
  });

  /* An old page omits a field it never knew about, and is refused. */
  it('breaks on a field that is required now', () => {
    expect(kinds(note, note.extend({ pinned: z.boolean() }))).toEqual(['breaks .pinned']);
    expect(kinds(note, note.extend({ tags: z.array(z.string().min(1).max(100)).max(100) }))).toEqual(['breaks .tags']);
  });

  it('breaks on a lower limit, a narrower type or a value no longer allowed', () => {
    expect(kinds(note, note.extend({ title: z.string().max(200) }))).toEqual(['breaks .title']);
    expect(kinds(note, note.extend({ tags: z.array(z.string().min(2).max(100)).max(100).optional() }))).toEqual(['breaks .tags[]']);
    expect(kinds(z.string().nullable(), z.string())).toEqual(['breaks ']);
    expect(kinds(z.enum(['a', 'b']), z.enum(['a']))).toEqual(['breaks ']);
    expect(kinds(z.string(), z.enum(['a']))).toEqual(['breaks ']);
    expect(kinds(z.string(), z.uuid())).toContain('breaks ');
    expect(kinds(z.number(), z.number().min(0))).toEqual(['breaks ']);
    expect(kinds(z.number().min(0), z.number().gt(0))).toEqual(['breaks ']);
  });

  /* zod strips an unknown key without a word: the old page is not refused, but what it sent is lost. */
  it('is unsure of a field the schema no longer reads, and breaks on one it refuses', () => {
    expect(kinds(note, z.object({ title: z.string().max(500) }))).toEqual(['unsure .tags']);
    expect(kinds(note, z.strictObject({ title: z.string().max(500) }))).toEqual(['breaks .tags']);
  });

  it('reads records and nested unions', () => {
    const fields = z.record(z.uuid(), z.union([z.string().max(1000), z.number(), z.null()]));
    expect(between(fields, z.record(z.uuid(), z.union([z.string().max(1000), z.number(), z.boolean(), z.null()])))).toEqual([]);
    expect(kinds(fields, z.record(z.uuid(), z.union([z.string().max(1000), z.null()])))).toEqual(['breaks {key}']);
  });

  it('is unsure of a pattern it cannot compare', () => {
    expect(kinds(z.string().regex(/^a/), z.string().regex(/^[ab]/))).toEqual(['unsure ']);
  });

  it('ends on a recursive schema', () => {
    type Node = { name: string; children?: Node[] };
    const node: z.ZodType<Node> = z.lazy(() => z.object({ name: z.string(), children: z.array(node).optional() }));
    expect(between(node, node)).toEqual([]);
    const narrower: z.ZodType<Node> = z.lazy(() => z.object({ name: z.string().max(10), children: z.array(narrower).optional() }));
    expect(kinds(node, narrower)).toContain('breaks .name');
  });
});

describe('normalize', () => {
  it('takes out comments and spacing and leaves the code', () => {
    const source = [
      '/**',
      ' * Why this is so.',
      ' */',
      'export const A = 1; // the one',
      '',
      '/*',
      '   An aside.',
      '*/',
      '  // a line of its own',
      "const url = 'https://example.com';",
    ].join('\n');
    expect(normalize(source)).toBe("export const A = 1;\nconst url = 'https://example.com';");
  });

  it('is the same for a rewritten comment and different for changed code', () => {
    expect(normalize('/** Old words. */\nconst a = 1;')).toBe(normalize('/**\n * New words,\n * longer.\n */\nconst a = 1;'));
    expect(normalize('const a = 1;')).not.toBe(normalize('const a = 2;'));
  });
});

describe('declarations', () => {
  it('reads each interface and type by name, to its end', () => {
    const source = [
      '/** A note. */',
      'export interface Note extends Omit<Base, "tags"> {',
      '  id: string;',
      '  fields: { [id: string]: { value: string } };',
      '}',
      "export type Sort = 'updated' | 'created';",
      'export type Ids = Array<{',
      '  id: string;',
      '}>;',
      'const notAType = 1;',
    ].join('\n');
    const found = declarations(source);
    expect([...found.keys()]).toEqual(['Note', 'Sort', 'Ids']);
    expect(found.get('Note')).toBe('export interface Note extends Omit<Base, "tags"> {\nid: string;\nfields: { [id: string]: { value: string } };\n}');
    expect(found.get('Sort')).toBe("export type Sort = 'updated' | 'created';");
    expect(found.get('Ids')).toBe('export type Ids = Array<{\nid: string;\n}>;');
  });
});

describe('interfaceParts', () => {
  it('splits an interface into its heading and members, keeping nested shapes whole', () => {
    const [declaration] = declarations('export interface Note extends Base {\n  id: string;\n  fields: {\n    a: string;\n  };\n  tags?: Array<{ id: string; name: string }>\n}').values();
    expect(interfaceParts(declaration!)).toEqual({
      head: 'export interface Note extends Base',
      members: ['id: string', 'fields: {\na: string;\n}', 'tags?: Array<{ id: string; name: string }>'],
    });
  });

  it('is null for a type alias', () => {
    expect(interfaceParts("export type Sort = 'a' | 'b';")).toBeNull();
  });
});

describe('relativeImports', () => {
  it('finds the relative modules a file imports, and only those', () => {
    const source = [
      "import { a } from './a.js';",
      "import type { B } from '../b.js';",
      "import './side-effect.js';",
      "const c = await import('./c.js');",
      "export { d } from './d.js';",
      "import { z } from 'zod';",
    ].join('\n');
    expect(relativeImports(source).sort()).toEqual(['../b.js', './a.js', './c.js', './d.js', './side-effect.js']);
  });
});
