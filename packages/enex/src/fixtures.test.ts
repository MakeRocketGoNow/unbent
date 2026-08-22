/**
 * Conversion against notes taken verbatim from a real Evernote export, rather than
 * hand-written ENML. Clipper output is stranger than anything worth inventing.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { enmlToMarkdown } from './enml-to-markdown.js';
import type { EnexResource } from './types.js';

function fixture(name: string): { enml: string; resources: EnexResource[] } {
  const raw = JSON.parse(readFileSync(new URL(`../test/fixtures/${name}.json`, import.meta.url), 'utf8'));
  return {
    enml: raw.enml,
    resources: (raw.resources ?? []).map((r: Omit<EnexResource, 'bytes'>) => ({
      ...r,
      bytes: new Uint8Array(0),
    })),
  };
}

describe('real export fixtures', () => {
  it('strips clipper styling from a quote note', () => {
    const { enml } = fixture('styled-quote');
    const { markdown } = enmlToMarkdown(enml, []);

    expect(markdown).toContain('Mara:');
    expect(markdown).toContain('Theo:');
    // The source is wrapped in spans carrying a dozen CSS declarations.
    expect(markdown).not.toContain('font-family');
    expect(markdown).not.toContain('style=');
    expect(markdown).not.toContain('<span');
  });

  it('keeps links in a bookmark note without hard-break noise', () => {
    const { enml } = fixture('bookmark');
    const { markdown } = enmlToMarkdown(enml, []);

    expect(markdown).toContain('video.example/watch');
    expect(markdown).toContain('ridgeline');
    // Evernote emits <br></br> pairs that become trailing-backslash hard breaks.
    expect(markdown).not.toMatch(/\\$/m);
  });

  it('resolves every attachment in a note carrying two PDFs', () => {
    const { enml, resources } = fixture('with-attachment');
    const { markdown, usedMd5 } = enmlToMarkdown(enml, resources);

    expect(resources.length).toBe(2);
    // Both, not just the first: en-media is a void element that an HTML parser would
    // otherwise nest, swallowing the sibling reference.
    expect(usedMd5.size).toBe(2);
    for (const r of resources) {
      expect(markdown).toContain(`files/${r.filename}`);
    }
    // Filenames are full of underscores and must not come out escaped.
    expect(markdown).not.toContain('\\_');
  });
});
