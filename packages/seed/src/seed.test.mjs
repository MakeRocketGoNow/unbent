/**
 * What the seed promises, held without a server: every note can be found again, every
 * value fits the field it is written to, every field type is there, and every file is one
 * a reader can open. A real load is still the proof that the API accepts it — `pnpm
 * seed:demo` against a dev server — but these catch the edits that would make it skip
 * values quietly, which the server reports and nobody reads.
 */
import { describe, expect, it } from 'vitest';
import { makePdf, makeReceiptPng } from './files.mjs';
import { seedNotes } from './load.mjs';
import { NOTEBOOKS } from './notebooks.mjs';

const FIELD_TYPES = ['text', 'number', 'date', 'checkbox', 'url', 'email', 'phone', 'select', 'multiselect'];

describe('the seed', () => {
  const notes = seedNotes();

  it('gives every note a key of its own, which is how a re-run finds it', () => {
    const keys = notes.map((n) => n.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps the showcase newest, so the list opens on the notes the screenshots are of', () => {
    const showcase = notes.filter((n) => n.key.startsWith('showcase/'));
    const rest = notes.filter((n) => !n.key.startsWith('showcase/'));
    expect(showcase).toHaveLength(10);
    expect(Math.max(...showcase.map((n) => n.age))).toBeLessThan(Math.min(...rest.map((n) => n.age)));
    expect(seedNotes({ small: true }).map((n) => n.key)).toEqual(showcase.map((n) => n.key));
  });

  it('files every note in a notebook it defines, or in none', () => {
    const names = new Set(NOTEBOOKS.map((n) => n.name));
    for (const note of notes) if (note.notebook) expect(names, note.key).toContain(note.notebook);
  });

  it('writes only fields its notebook defines, with values that fit them', () => {
    for (const note of notes) {
      const defs = new Map((NOTEBOOKS.find((n) => n.name === note.notebook)?.fields ?? []).map((f) => [f.name, f]));
      for (const [name, value] of Object.entries(note.fields ?? {})) {
        const def = defs.get(name);
        expect(def, `${note.key}: ${name}`).toBeDefined();
        const where = `${note.key}: ${name}`;
        switch (def.type) {
          case 'select':
            expect(def.options, where).toContain(value);
            break;
          case 'multiselect':
            for (const v of value) expect(def.options, where).toContain(v);
            break;
          case 'number':
            expect(typeof value, where).toBe('number');
            if (def.scale) {
              expect(value, where).toBeLessThanOrEqual(def.scale.max);
              expect(Number.isInteger(value / def.scale.step), where).toBe(true);
            }
            break;
          case 'checkbox':
            expect(typeof value, where).toBe('boolean');
            break;
          case 'date':
            expect(value, where).toEqual({ day: expect.any(Number) });
            break;
          default:
            expect(typeof value, where).toBe('string');
        }
      }
    }
  });

  it('covers every field type, and a number plain, as a rating, and as money', () => {
    const fields = NOTEBOOKS.flatMap((n) => n.fields);
    for (const type of FIELD_TYPES) expect(fields.map((f) => f.type)).toContain(type);
    const numbers = fields.filter((f) => f.type === 'number');
    expect(numbers.some((f) => !f.scale && !f.currency)).toBe(true);
    expect(numbers.some((f) => f.scale?.step === 1)).toBe(true);
    expect(numbers.some((f) => f.scale?.step === 0.5)).toBe(true);
    expect(numbers.some((f) => f.currency)).toBe(true);
  });

  it('gives every field a value on at least one note', () => {
    for (const notebook of NOTEBOOKS) {
      const filed = notes.filter((n) => n.notebook === notebook.name);
      for (const field of notebook.fields) {
        expect(filed.some((n) => n.fields && field.name in n.fields), `${notebook.name}: ${field.name}`).toBe(true);
      }
    }
  });
});

describe('the seed’s files', () => {
  it('draws a PDF whose cross-reference table points at its objects', () => {
    const text = new TextDecoder().decode(makePdf([['Title', 'a line'], ['page two']]));
    const offsets = [...text.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(offsets.length).toBeGreaterThan(0);
    offsets.forEach((at, i) => expect(text.slice(at, at + 12)).toMatch(new RegExp(`^${i + 1} 0 obj`)));
    const startxref = Number(text.match(/startxref\n(\d+)/)[1]);
    expect(text.slice(startxref, startxref + 4)).toBe('xref');
    expect(text).toContain('/Count 2');
  });

  it('refuses text the PDF font cannot draw, rather than drawing the wrong glyph', () => {
    expect(() => makePdf([['café']])).toThrow(/ASCII/);
  });

  it('draws a PNG with the signature and the size it was asked for', async () => {
    const png = await makeReceiptPng(4, { width: 40, height: 60 });
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(png.buffer);
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([40, 60]);
  });

  it('gives files to more than one notebook, so a kept notebook can be compared with one that is not', () => {
    const withFiles = new Set(seedNotes().filter((n) => n.files?.length).map((n) => n.notebook));
    expect(withFiles.size).toBeGreaterThanOrEqual(2);
    expect(withFiles).toContain('Receipts');
    expect(withFiles).toContain('Coupons');
  });

  it('names every seeded file once', () => {
    const names = seedNotes().flatMap((n) => (n.files ?? []).map((f) => f.name));
    expect(new Set(names).size).toBe(names.length);
  });

  it('keeps every seeded file to text a PDF can hold', () => {
    for (const note of seedNotes()) {
      for (const file of note.files ?? []) {
        if (file.image) continue;
        expect(() => makePdf(file.pages ?? [file.lines]), file.name).not.toThrow();
      }
    }
  });
});
