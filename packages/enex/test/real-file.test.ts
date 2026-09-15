/**
 * Parses real files from an Evernote export.
 *
 * Skipped unless ENEX_DIR points at one, so the suite stays runnable without the corpus.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { enmlToMarkdown } from '../src/enml-to-markdown.js';
import { parseEnexStream } from '../src/parse.js';
import type { EnexNote } from '../src/types.js';

const DIR = process.env['ENEX_DIR'];
/**
 * The export's notebook of scanned PDFs, by file name. Configurable because the notebook
 * this was measured against is a real one, and its name does not belong in the repo.
 */
const PDF_FILE = process.env['ENEX_PDF_FILE'] ?? 'Scans.enex';
const available = DIR !== undefined && existsSync(DIR);

function streamOf(path: string): ReadableStream<Uint8Array> {
  return Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>;
}

describe.skipIf(!available)('real export files', () => {
  it('parses a small notebook completely', async () => {
    const path = `${DIR}/Quotes.enex`;
    const notes: EnexNote[] = [];
    const result = await parseEnexStream(streamOf(path), { onNote: (n) => void notes.push(n) });

    expect(result.errors).toBe(0);
    expect(result.notes).toBe(16);
    expect(notes.every((n) => n.title.length > 0)).toBe(true);
    expect(notes.every((n) => n.created instanceof Date)).toBe(true);
    expect(notes.some((n) => n.tags.includes('Quotes'))).toBe(true);
  }, 60_000);

  it('extracts source-url from bookmark notes', async () => {
    const notes: EnexNote[] = [];
    await parseEnexStream(streamOf(`${DIR}/Raindrop.io.enex`), {
      onNote: (n) => {
        if (notes.length < 50) notes.push(n);
      },
    });

    const withUrl = notes.filter((n) => n.sourceUrl);
    expect(withUrl.length).toBeGreaterThan(0);
    expect(withUrl[0]!.sourceUrl).toMatch(/^https?:\/\//);
  }, 60_000);

  /** The end-to-end property: en-media hashes must resolve against decoded resources. */
  it('resolves attachments by computed md5 in a notebook full of PDFs', async () => {
    const notes: EnexNote[] = [];
    await parseEnexStream(streamOf(`${DIR}/${PDF_FILE}`), {
      onNote: (n) => {
        if (n.resources.length > 0 && notes.length < 20) notes.push(n);
      },
    });

    expect(notes.length).toBeGreaterThan(0);

    let referenced = 0;
    let resolved = 0;
    for (const note of notes) {
      const { usedMd5 } = enmlToMarkdown(note.enml, note.resources);
      referenced += (note.enml.match(/<en-media/g) ?? []).length;
      resolved += usedMd5.size;
      // Every resource carries a filename, either its own or one derived from the md5.
      expect(note.resources.every((r) => r.filename.length > 0)).toBe(true);
    }

    expect(referenced).toBeGreaterThan(0);
    // A computed hash that did not match would leave resolved at zero.
    expect(resolved).toBeGreaterThan(0);
  }, 120_000);

  /**
   * The design claim: memory stays flat regardless of input size. Measured on a real
   * 3.4GB notebook — 3,335 notes and 3,896 attachments in 69s with a 134MB peak heap.
   * Skipped by default because it reads the whole file; set ENEX_BENCH=1 to run it.
   */
  it.skipIf(process.env['ENEX_BENCH'] !== '1')(
    'streams a multi-gigabyte file with bounded memory',
    async () => {
      const path = `${DIR}/Archive.enex`;
      if (!existsSync(path)) return;
      expect(statSync(path).size / 1e9).toBeGreaterThan(1);

      let notes = 0;
      let peakHeapMb = 0;

      await parseEnexStream(streamOf(path), {
        onNote: () => {
          notes += 1;
          if (notes % 200 === 0) {
            peakHeapMb = Math.max(peakHeapMb, process.memoryUsage().heapUsed / 1e6);
          }
        },
      });

      expect(notes).toBeGreaterThan(3000);
      // Bounded by one note plus its attachments, not by the size of the file.
      expect(peakHeapMb).toBeLessThan(600);
    },
    600_000,
  );
});
