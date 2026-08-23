import { describe, expect, it } from 'vitest';
import {
  FALLBACK_CONTENT_TYPE,
  isInlineSafe,
  normalizeContentType,
  serveContentType,
  serveDisposition,
} from './content-type.js';

describe('normalizeContentType', () => {
  it('strips parameters', () => {
    expect(normalizeContentType('text/html; charset=utf-8')).toBe('text/html');
  });

  it('lowercases', () => {
    expect(normalizeContentType('Application/PDF')).toBe('application/pdf');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeContentType('  application/pdf  ')).toBe('application/pdf');
  });

  it('treats missing values as empty', () => {
    expect(normalizeContentType(null)).toBe('');
    expect(normalizeContentType(undefined)).toBe('');
    expect(normalizeContentType('')).toBe('');
  });
});

/**
 * The executable types. Each of these, served inline from our own origin, is a
 * same-origin document that can script the app and call the API with the user's session.
 */
describe('types that must never be served as declared', () => {
  const dangerous = [
    'text/html',
    'application/xhtml+xml',
    // An image to a person, a scriptable document to a browser.
    'image/svg+xml',
    // Can carry an XSLT stylesheet that renders as markup.
    'text/xml',
    'application/xml',
    'text/css',
    'application/javascript',
    'text/javascript',
    'application/ecmascript',
  ];

  for (const type of dangerous) {
    it(`downgrades ${type}`, () => {
      expect(isInlineSafe(type)).toBe(false);
      expect(serveContentType(type)).toBe(FALLBACK_CONTENT_TYPE);
      expect(serveDisposition(type)).toBe('attachment');
    });
  }

  it('is not fooled by a charset parameter', () => {
    // Comparing the raw header instead of the normalized one would let this through.
    expect(serveContentType('text/html; charset=utf-8')).toBe(FALLBACK_CONTENT_TYPE);
  });

  it('is not fooled by casing', () => {
    expect(serveContentType('TEXT/HTML')).toBe(FALLBACK_CONTENT_TYPE);
  });

  it('is not fooled by leading whitespace', () => {
    expect(serveContentType(' text/html')).toBe(FALLBACK_CONTENT_TYPE);
  });
});

describe('types that must keep rendering inline', () => {
  // PDFs are the corpus: 78 stored locally, ~2,400 in the full export.
  const safe = [
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/tiff',
    'audio/mpeg',
    'video/mp4',
    'video/quicktime',
    'text/plain',
    'text/csv',
  ];

  for (const type of safe) {
    it(`serves ${type} unchanged`, () => {
      expect(isInlineSafe(type)).toBe(true);
      expect(serveContentType(type)).toBe(type);
      expect(serveDisposition(type)).toBe('inline');
    });
  }
});

/**
 * Real MIME values counted across the user's own Evernote export. These must not error or
 * be lost — they are downloaded rather than rendered, which is the correct handling for a
 * type a browser cannot safely display.
 */
describe('other types present in the real corpus', () => {
  const corpus = [
    'application/octet-stream',
    'application/zip',
    'application/x-zip-compressed',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/msword',
    'application/json',
    'text/markdown',
    'application/epub+zip',
    'application/java-archive',
    'application/vnd.android.package-archive',
    'application/x-x509-ca-cert',
  ];

  for (const type of corpus) {
    it(`downloads ${type} rather than rendering it`, () => {
      expect(serveContentType(type)).toBe(FALLBACK_CONTENT_TYPE);
      expect(serveDisposition(type)).toBe('attachment');
    });
  }
});

describe('missing or malformed values', () => {
  for (const value of [null, undefined, '', '   ', 'nonsense', 'text/', '/', ';;;']) {
    it(`falls back for ${JSON.stringify(value)}`, () => {
      expect(serveContentType(value)).toBe(FALLBACK_CONTENT_TYPE);
      expect(serveDisposition(value)).toBe('attachment');
    });
  }
});
