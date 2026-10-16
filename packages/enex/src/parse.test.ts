import { filenameSchema } from '@unbent/shared';
import { describe, expect, it } from 'vitest';
import {
  fallbackFilename,
  md5Hex,
  parseEnexDate,
  parseEnexStream,
  resourceFilename,
  uniqueResourceFilenames,
} from './parse.js';
import type { EnexResource } from './types.js';

/**
 * MD5 is implemented here because WebCrypto omits it and en-media hashes are MD5s.
 * A wrong digest means every attachment silently fails to resolve, so it is checked
 * against the RFC 1321 test suite.
 */
describe('md5', () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  it.each([
    ['', 'd41d8cd98f00b204e9800998ecf8427e'],
    ['a', '0cc175b9c0f1b6a831c399e269772661'],
    ['abc', '900150983cd24fb0d6963f7d28e17f72'],
    ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
    ['abcdefghijklmnopqrstuvwxyz', 'c3fcd3d76192e4007dfb496cca67e13b'],
    [
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
      'd174ab98d277d9f5a5611c2c9f419d9f',
    ],
    [
      '12345678901234567890123456789012345678901234567890123456789012345678901234567890',
      '57edf4a22be3c955ac49da2e2107b67a',
    ],
  ])('hashes %j', (input, expected) => {
    expect(md5Hex(enc(input))).toBe(expected);
  });

  it('handles binary and block-boundary lengths', () => {
    // 55, 56, 64 bytes straddle the padding boundary, where MD5 implementations break.
    for (const n of [55, 56, 57, 63, 64, 65, 128]) {
      const bytes = new Uint8Array(n).map((_, i) => i % 256);
      expect(md5Hex(bytes)).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it('is stable across calls', () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    expect(md5Hex(bytes)).toBe(md5Hex(bytes));
  });
});

/** ENEX uses ISO-8601 basic format, which `new Date()` does not parse. */
describe('parseEnexDate', () => {
  it('parses the basic format as UTC', () => {
    expect(parseEnexDate('20170105T161432Z')?.toISOString()).toBe('2017-01-05T16:14:32.000Z');
  });

  it('parses without a trailing Z', () => {
    expect(parseEnexDate('20221202T215157')?.toISOString()).toBe('2022-12-02T21:51:57.000Z');
  });

  it('returns undefined for junk', () => {
    expect(parseEnexDate('not a date')).toBeUndefined();
    expect(parseEnexDate('')).toBeUndefined();
  });

  it('handles epoch and far-future dates', () => {
    expect(parseEnexDate('19700101T000000Z')?.getTime()).toBe(0);
    expect(parseEnexDate('20381231T235959Z')?.getUTCFullYear()).toBe(2038);
  });
});

describe('fallbackFilename', () => {
  it('derives an extension from the mime type', () => {
    expect(fallbackFilename('a'.repeat(32), 'image/png')).toBe('aaaaaaaaaaaa.png');
    expect(fallbackFilename('b'.repeat(32), 'application/pdf')).toBe('bbbbbbbbbbbb.pdf');
  });

  it('falls back to .bin for unknown types', () => {
    expect(fallbackFilename('c'.repeat(32), 'application/x-weird')).toBe('cccccccccccc.bin');
  });
});

/**
 * Evernote writes `<file-name>` as a label rather than a path. A real export had two PDFs
 * named like `Menu Card` and `Lease Summary - DRAFT DRAFT ` (no extension, one with
 * a trailing space) and both arrived as files nothing downstream could recognise as PDFs.
 */
describe('resourceFilename', () => {
  const MD5 = 'a'.repeat(32);

  it('appends the extension the mime implies when the name has none', () => {
    expect(resourceFilename('Menu Card', MD5, 'application/pdf')).toBe('Menu Card.pdf');
  });

  it('trims a trailing space before appending', () => {
    expect(resourceFilename('Lease Summary - DRAFT DRAFT ', MD5, 'application/pdf')).toBe(
      'Lease Summary - DRAFT DRAFT.pdf',
    );
  });

  it('trims a name that already has an extension', () => {
    expect(resourceFilename('  scan.pdf  ', MD5, 'application/pdf')).toBe('scan.pdf');
  });

  it('leaves an existing extension alone, even a disagreeing one', () => {
    expect(resourceFilename('receipt.jpeg', MD5, 'image/jpeg')).toBe('receipt.jpeg');
    expect(resourceFilename('scan.png', MD5, 'application/pdf')).toBe('scan.png');
  });

  it('leaves a name alone when the mime implies no extension', () => {
    expect(resourceFilename('archive', MD5, 'application/zip')).toBe('archive');
  });

  it('treats a trailing dot as no extension', () => {
    expect(resourceFilename('Rev.', MD5, 'application/pdf')).toBe('Rev..pdf');
  });

  it('does not mistake a dotted stem for an extension', () => {
    // `Dr. Smith` ends in `Smith`, not an extension, so it still needs one.
    expect(resourceFilename('Dr. Smith', MD5, 'application/pdf')).toBe('Dr. Smith.pdf');
  });

  it('falls back to the md5 name when there is no file-name at all', () => {
    expect(resourceFilename('', MD5, 'application/pdf')).toBe('aaaaaaaaaaaa.pdf');
    expect(resourceFilename('   ', MD5, 'image/png')).toBe('aaaaaaaaaaaa.png');
  });

  /**
   * These three are the notes a full import of the real export actually failed on, each
   * with a 400 the upload was right to return and the parser wrong to provoke.
   */
  describe('names the upload would reject', () => {
    it('replaces the separators in a label written as a path', () => {
      expect(
        resourceFilename('Special Characters and Symbols for HTML, CSS and JS / ASCII / Unicode', MD5, 'application/pdf'),
      ).toBe('Special Characters and Symbols for HTML, CSS and JS - ASCII - Unicode.pdf');
    });

    it('replaces a backslash too, and does not let one collapse into a neighbour', () => {
      expect(resourceFilename('a\\b/c', MD5, 'image/png')).toBe('a-b-c.png');
    });

    it('keeps the extension when truncating an over-long label', () => {
      const long = 'x'.repeat(900);
      const out = resourceFilename(long, MD5, 'application/pdf');
      expect(out.length).toBeLessThanOrEqual(768);
      expect(out.endsWith('.pdf')).toBe(true);
    });

    it('truncates even when the label brought its own extension', () => {
      const out = resourceFilename(`${'x'.repeat(900)}.pdf`, MD5, 'application/pdf');
      expect(out.length).toBeLessThanOrEqual(768);
    });

    it('does not split a surrogate pair when truncating', () => {
      const LONE_SURROGATE =
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
      // An odd-length run before the emoji puts the cut between the halves of a pair.
      for (const pad of [0, 1, 2, 3]) {
        const out = resourceFilename(
          'a'.repeat(pad) + '\u{1F600}'.repeat(500),
          MD5,
          'application/pdf',
        );
        expect(LONE_SURROGATE.test(out), `pad=${pad}`).toBe(false);
        expect(out.length).toBeLessThanOrEqual(768);
      }
    });

    it('drops a leading dot, which filenameSchema reserves', () => {
      expect(resourceFilename('.hidden', MD5, 'application/pdf')).toBe('hidden.pdf');
    });

    it('falls back when sanitizing leaves nothing behind', () => {
      expect(resourceFilename('/', MD5, 'image/png')).toBe('aaaaaaaaaaaa.png');
      expect(resourceFilename('...', MD5, 'image/png')).toBe('aaaaaaaaaaaa.png');
    });
  });

  /**
   * Every name this function can emit must satisfy the schema the upload applies, since a
   * name that fails there costs the note its attachment. This is also the guard on the
   * limit being duplicated in parse.ts: raising one without the other fails here.
   */
  it('emits names filenameSchema accepts', () => {
    const cases = [
      'Special Characters and Symbols for HTML, CSS and JS / ASCII / Unicode',
      'Athletic Greens Jar, Scoop, and Shaker',
      'x'.repeat(900),
      `${'\u00e9'.repeat(900)}.pdf`,
      '.hidden',
      'Lease Summary - DRAFT DRAFT ',
      'a\\b/c',
    ];
    for (const c of cases) {
      const out = resourceFilename(c, MD5, 'application/pdf');
      expect(filenameSchema.safeParse(out).success, `rejected: ${out.slice(0, 60)}`).toBe(true);
    }
  });
});

describe('uniqueResourceFilenames', () => {
  const file = (filename: string, md5: string): EnexResource => ({
    filename,
    md5,
    mime: 'image/jpeg',
    bytes: new Uint8Array(),
  });

  it('leaves a single file, and distinct names, alone', () => {
    const one = [file('scan.jpg', '1'.repeat(32))];
    expect(uniqueResourceFilenames(one)).toBe(one);

    const distinct = [file('a.jpg', '1'.repeat(32)), file('b.jpg', '2'.repeat(32))];
    expect(uniqueResourceFilenames(distinct)).toEqual(distinct);
  });

  it('suffixes a second file that shares its name, the way the upload would', () => {
    const out = uniqueResourceFilenames([
      file('image.png', '1'.repeat(32)),
      file('image.png', '2'.repeat(32)),
      file('image.png', '3'.repeat(32)),
    ]);
    expect(out.map((r) => r.filename)).toEqual(['image.png', 'image-2.png', 'image-3.png']);
    expect(out[0]?.md5).toBe('1'.repeat(32));
    expect(out[1]?.md5).toBe('2'.repeat(32));
  });

  it('does not steal a name that is already a neighbour', () => {
    // `image-2.png` is already in the note, so the colliding second `image.png` has to
    // skip it rather than overwrite that neighbour's link, even when the neighbour
    // appears after the duplicates in the ENEX.
    const after = uniqueResourceFilenames([
      file('image.png', '1'.repeat(32)),
      file('image.png', '2'.repeat(32)),
      file('image-2.png', '3'.repeat(32)),
    ]);
    expect(after.map((r) => r.filename)).toEqual(['image.png', 'image-3.png', 'image-2.png']);

    const before = uniqueResourceFilenames([
      file('image.png', '1'.repeat(32)),
      file('image-2.png', '2'.repeat(32)),
      file('image.png', '3'.repeat(32)),
    ]);
    expect(before.map((r) => r.filename)).toEqual(['image.png', 'image-2.png', 'image-3.png']);
  });

  it('keeps two labels that sanitizing would otherwise collapse', () => {
    // `resourceFilename` replaces separators so `a/b.png` and `a-b.png` become the same
    // string; without this pass they would share a link and one of the files would vanish.
    const out = uniqueResourceFilenames([
      file('a-b.png', '1'.repeat(32)),
      file('a-b.png', '2'.repeat(32)),
    ]);
    expect(out.map((r) => r.filename)).toEqual(['a-b.png', 'a-b-2.png']);
  });
});

/**
 * Stopping a parse partway.
 *
 * The importer's breaker and its cancel button both come down to this: a run that has
 * stopped caring must stop reading too. The largest real export is 3.6GB, so continuing to
 * the end of the file is a minute of CPU spent on notes nobody will look at.
 */
describe('parseEnexStream signal', () => {
  const noteXml = (title: string) =>
    `<note><title>${title}</title><created>20240115T093000Z</created>` +
    `<content><![CDATA[<en-note><div>x</div></en-note>]]></content></note>`;

  /** Emits each note as its own chunk, so a stop can be observed between them. */
  function chunked(count: number): { stream: ReadableStream<Uint8Array>; total: number } {
    const parts = [
      '<?xml version="1.0" encoding="UTF-8"?><en-export>',
      ...Array.from({ length: count }, (_, i) => noteXml(`N${i}`)),
      '</en-export>',
    ];
    const encoded = parts.map((p) => new TextEncoder().encode(p));
    let i = 0;
    return {
      total: encoded.reduce((n, c) => n + c.byteLength, 0),
      stream: new ReadableStream({
        pull(controller) {
          if (i < encoded.length) controller.enqueue(encoded[i++]!);
          else controller.close();
        },
      }),
    };
  }

  it('stops reading rather than draining the rest of the file', async () => {
    const controller = new AbortController();
    const seen: string[] = [];
    let bytesRead = 0;
    const { stream, total } = chunked(50);

    await parseEnexStream(stream, {
      signal: controller.signal,
      onProgress: (bytes) => {
        bytesRead = bytes;
      },
      onNote: (note) => {
        seen.push(note.title);
        controller.abort();
      },
    });

    expect(seen).toEqual(['N0']);
    expect(bytesRead).toBeLessThan(total);
  });

  it('reads to the end when nothing stops it', async () => {
    const seen: string[] = [];
    const { stream } = chunked(5);

    const result = await parseEnexStream(stream, {
      onNote: (note) => {
        seen.push(note.title);
      },
    });

    expect(seen).toEqual(['N0', 'N1', 'N2', 'N3', 'N4']);
    expect(result.notes).toBe(5);
  });

  it('does not report an error for the tags a stopped file never closed', async () => {
    const controller = new AbortController();
    const errors: string[] = [];
    const { stream } = chunked(50);

    await parseEnexStream(stream, {
      signal: controller.signal,
      onError: (message) => errors.push(message),
      onNote: () => controller.abort(),
    });

    expect(errors).toEqual([]);
  });
});
