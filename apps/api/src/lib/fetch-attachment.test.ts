import { describe, expect, it } from 'vitest';
import {
  checkSourceUrl,
  chooseContentType,
  chooseFilename,
  filenameFromContentDisposition,
  filenameFromUrl,
} from './fetch-attachment.js';

/**
 * The decisions made before a byte is fetched: which URLs are even attempted, and what a
 * file will be called and typed once it arrives. Each is a pure function over headers and
 * strings, and each has a wrong answer that would be silent — a PDF stored as a generic
 * binary never gets its text indexed, and a name taken from the wrong place is a note
 * full of files called `upload.pdf`.
 */

describe('checkSourceUrl', () => {
  it('accepts http and https to a routable host', () => {
    expect(checkSourceUrl('https://files.example.com/a.pdf')).toHaveProperty('url');
    expect(checkSourceUrl('http://files.example.com/a.pdf')).toHaveProperty('url');
  });

  it('refuses a scheme that is another system\'s internal reference, and says what to do', () => {
    const result = checkSourceUrl('file://abc-123/upload.pdf');
    expect(result).toHaveProperty('error');
    if ('error' in result) {
      expect(result.error).toContain('this one is file');
      expect(result.error).toContain('download URL');
    }
    expect(checkSourceUrl('notion://page/abc')).toHaveProperty('error');
    expect(checkSourceUrl('ftp://host/a.pdf')).toHaveProperty('error');
  });

  it('refuses what is not a URL at all', () => {
    expect(checkSourceUrl('upload.pdf')).toHaveProperty('error');
    expect(checkSourceUrl('')).toHaveProperty('error');
  });

  it('refuses credentials in the URL', () => {
    expect(checkSourceUrl('https://user:secret@example.com/a.pdf')).toHaveProperty('error');
  });

  it('refuses loopback and private-network hosts (SSRF), the same guard the image fetch uses', () => {
    expect(checkSourceUrl('http://127.0.0.1/secret')).toHaveProperty('error');
    expect(checkSourceUrl('http://localhost:8809/api/mcp')).toHaveProperty('error');
    expect(checkSourceUrl('http://169.254.169.254/latest/meta-data/')).toHaveProperty('error');
    expect(checkSourceUrl('http://10.0.0.5/x')).toHaveProperty('error');
    expect(checkSourceUrl('http://192.168.1.1/x')).toHaveProperty('error');
    expect(checkSourceUrl('http://[::1]/x')).toHaveProperty('error');
  });

  it('allows loopback only when the caller opts in, for local development', () => {
    expect(checkSourceUrl('http://127.0.0.1/a.pdf', { allowLoopback: true })).toHaveProperty('url');
    // A private-network host is refused even then; the escape hatch is loopback only.
    expect(checkSourceUrl('http://10.0.0.5/x', { allowLoopback: true })).toHaveProperty('error');
  });
});

describe('filenameFromContentDisposition', () => {
  it('reads a quoted filename', () => {
    expect(filenameFromContentDisposition('attachment; filename="Lab Results (2026).pdf"')).toBe(
      'Lab Results (2026).pdf',
    );
  });

  it('reads a bare filename', () => {
    expect(filenameFromContentDisposition('inline; filename=scan.pdf')).toBe('scan.pdf');
  });

  it('prefers the extended form, which can spell what the plain one cannot', () => {
    const header =
      'attachment; filename="resume.pdf"; filename*=UTF-8\'\'r%C3%A9sum%C3%A9%20(final).pdf';
    expect(filenameFromContentDisposition(header)).toBe('résumé (final).pdf');
  });

  it('falls back to the plain form when the extended one does not decode', () => {
    expect(
      filenameFromContentDisposition('attachment; filename="ok.pdf"; filename*=UTF-8\'\'%E0%A4%A'),
    ).toBe('ok.pdf');
  });

  it('unescapes a quoted name', () => {
    expect(filenameFromContentDisposition('attachment; filename="say \\"hi\\".txt"')).toBe(
      'say "hi".txt',
    );
  });

  it('answers null for no header and for a disposition with no name', () => {
    expect(filenameFromContentDisposition(null)).toBeNull();
    expect(filenameFromContentDisposition('inline')).toBeNull();
    expect(filenameFromContentDisposition('attachment; filename=""')).toBeNull();
  });
});

describe('filenameFromUrl', () => {
  it('takes the last path segment, decoded, and ignores the query', () => {
    const url = new URL(
      'https://bucket.s3.example.com/abc/def/Report%20(final)%20v2.pdf?X-Amz-Signature=abc&X-Amz-Expires=3600',
    );
    expect(filenameFromUrl(url)).toBe('Report (final) v2.pdf');
  });

  it('answers null for a bare origin, a trailing slash, or a segment of punctuation', () => {
    expect(filenameFromUrl(new URL('https://example.com'))).toBeNull();
    expect(filenameFromUrl(new URL('https://example.com/files/'))).toBeNull();
    expect(filenameFromUrl(new URL('https://example.com/files/---'))).toBeNull();
  });

  it('keeps a segment whose encoding is broken rather than failing', () => {
    expect(filenameFromUrl(new URL('https://example.com/100%.pdf'))).toBe('100%.pdf');
  });
});

describe('chooseFilename', () => {
  const url = new URL('https://files.example.com/x/upload.pdf?sig=1');

  it('takes the requested name first', () => {
    expect(
      chooseFilename({
        requested: 'Insurance card.pdf',
        contentDisposition: 'attachment; filename="upload.pdf"',
        url,
        contentType: 'application/pdf',
      }),
    ).toBe('Insurance card.pdf');
  });

  it('then the Content-Disposition name, then the URL', () => {
    expect(
      chooseFilename({
        contentDisposition: 'attachment; filename="scan 3.pdf"',
        url,
        contentType: 'application/pdf',
      }),
    ).toBe('scan 3.pdf');
    expect(chooseFilename({ contentDisposition: null, url, contentType: 'application/pdf' })).toBe(
      'upload.pdf',
    );
  });

  it('skips a candidate the upload would refuse', () => {
    // A dotfile is refused by filenameSchema, so the URL's name is the one that stands.
    expect(
      chooseFilename({
        contentDisposition: 'attachment; filename=".hidden"',
        url,
        contentType: 'application/pdf',
      }),
    ).toBe('upload.pdf');
  });

  it('invents a name from the type when nothing usable is known', () => {
    const bare = new URL('https://files.example.com/');
    expect(chooseFilename({ contentDisposition: null, url: bare, contentType: 'application/pdf' })).toBe(
      'attachment.pdf',
    );
    expect(chooseFilename({ contentDisposition: null, url: bare, contentType: 'image/png' })).toBe(
      'attachment.png',
    );
    expect(chooseFilename({ contentDisposition: null, url: bare, contentType: null })).toBe(
      'attachment',
    );
  });
});

describe('chooseContentType', () => {
  it('keeps a declared type, normalized', () => {
    expect(chooseContentType('Application/PDF; charset=binary', 'x.bin')).toBe('application/pdf');
  });

  it('reads the extension when the source declared nothing, or only "binary"', () => {
    expect(chooseContentType(null, 'scan.PDF')).toBe('application/pdf');
    expect(chooseContentType('application/octet-stream', 'photo.jpg')).toBe('image/jpeg');
    expect(chooseContentType('binary/octet-stream', 'photo.jpg')).toBe('image/jpeg');
  });

  it('does not infer a type a browser could execute', () => {
    expect(chooseContentType(null, 'page.html')).toBe('application/octet-stream');
    expect(chooseContentType(null, 'logo.svg')).toBe('application/octet-stream');
  });

  it('falls back to the generic binary type for an unknown extension', () => {
    expect(chooseContentType(null, 'data.xyz')).toBe('application/octet-stream');
    expect(chooseContentType('binary/octet-stream', 'data.xyz')).toBe('binary/octet-stream');
  });
});
