// @vitest-environment node
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { narrowings } from './schemas.js';

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
