// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { constant, declarations, interfaceParts, normalize, relativeImports, shorthandKeys, signature } from './surfaces.js';

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
