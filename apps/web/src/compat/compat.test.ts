// @vitest-environment node
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { narrowings } from './schemas.js';
import { constant, declarations, interfaceParts, normalize, relativeImports, shorthandKeys, signature } from './surfaces.js';

/** What `contract.test.ts` compares: a zod schema as JSON Schema, from the sender's side. */
const json = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
const between = (prev: z.ZodType, next: z.ZodType) => narrowings(json(next), json(prev));
const kinds = (prev: z.ZodType, next: z.ZodType) => between(prev, next).map((n) => `${n.severity} ${n.path}`);

describe('narrowings', () => {
  const note = z.object({ title: z.string().max(500), tags: z.array(z.string().min(1).max(100)).max(100).optional() });

  /* A longer limit or a new optional field reaches an old page harmlessly: it ignores what it does not know. */
  it('finds nothing when the schema accepts at least what it did and gained no value or type', () => {
    expect(between(note, note)).toEqual([]);
    expect(between(note, note.extend({ pinned: z.boolean().optional() }))).toEqual([]);
    expect(between(note, z.object({ title: z.string().max(1000), tags: z.array(z.string().max(200)).optional() }))).toEqual([]);
  });

  /* What a body may carry is what the server stores and answers back to every page, old ones included. */
  it('is unsure of a value or a type it gained', () => {
    expect(kinds(z.enum(['a', 'b']), z.enum(['a', 'b', 'c']))).toEqual(['unsure ']);
    expect(between(z.enum(['a', 'b']), z.enum(['a', 'b', 'c']))[0]?.what).toMatch(/^accepts "c" now/);
    expect(kinds(z.string(), z.string().nullable())).toEqual(['unsure ']);
    expect(kinds(note, note.extend({ title: z.string().max(500).nullable() }))).toEqual(['unsure .title']);
    expect(kinds(z.enum(['a']), z.string())).toEqual(['unsure ']);
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
    expect(kinds(fields, z.record(z.uuid(), z.union([z.string().max(1000), z.number(), z.boolean(), z.null()])))).toEqual(['unsure {key}']);
    expect(between(fields, z.record(z.uuid(), z.union([z.string().max(2000), z.number(), z.null()])))).toEqual([]);
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

  /* Read as a split, a branch added to the union would be a member gained, which fits without asking. */
  it('keeps a union written over several lines as one member', () => {
    const [declaration] = declarations("export interface Field {\n  kind:\n    | 'text'\n    | 'number';\n  name: string;\n}").values();
    expect(interfaceParts(declaration!)?.members).toEqual(["kind: | 'text' | 'number'", 'name: string']);
  });

  it('is null for a type alias', () => {
    expect(interfaceParts("export type Sort = 'a' | 'b';")).toBeNull();
  });
});

describe('constant and shorthandKeys', () => {
  it('reads a list of names declared as a const', () => {
    const source = '/** The calls. */\nexport const forwardable = {\n  saveNote,\n  createNote,\n};\nconst other = 1;';
    const list = constant(source, 'forwardable');
    expect(list).toBe('export const forwardable = {\nsaveNote,\ncreateNote,\n};');
    expect(shorthandKeys(list!)).toEqual(['saveNote', 'createNote']);
    expect(constant(source, 'missing')).toBeNull();
  });
});

describe('signature', () => {
  it('reads a function to the brace its body opens with', () => {
    const source = [
      '/** Saves. */',
      'export async function saveNote(input: Save, opts: { quiet: boolean } = { quiet: false }): Promise<{ id: string } | Note> {',
      '  return api.save(input);',
      '}',
      'export function plain<T>(',
      '  value: T,',
      '): (x: T) => void {',
      '  return () => {};',
      '}',
    ].join('\n');
    expect(signature(source, 'saveNote')).toBe('export async function saveNote(input: Save, opts: { quiet: boolean } = { quiet: false }): Promise<{ id: string } | Note>');
    expect(signature(source, 'plain')).toBe('export function plain<T>(\nvalue: T,\n): (x: T) => void');
    expect(signature(source, 'missing')).toBeNull();
  });

  /* The body is no other build's business, and changes far more often than the signature. */
  it('is the same when only the body changes', () => {
    expect(signature('function a(x: string): void {\n  one();\n}', 'a')).toBe(signature('function a(x: string): void {\n  two();\n}', 'a'));
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
