import { describe, expect, it } from 'vitest';
import { fallbackFilename, md5Hex, parseEnexDate, resourceFilename } from './parse.js';

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
 * Evernote writes `<file-name>` as a label rather than a path. A real Coupons export has
 * two PDFs named `Menu Card` and `Lease Summary - DRAFT DRAFT ` — no extension, one with
 * a trailing space — and both arrived as files nothing downstream could recognise as PDFs.
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
});
