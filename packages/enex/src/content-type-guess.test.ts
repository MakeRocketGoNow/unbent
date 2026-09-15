import { describe, expect, it } from 'vitest';
import { guessContentType } from './content-type-guess.js';

const ascii = (s: string) => new TextEncoder().encode(s);

describe('guessContentType', () => {
  it('reads the type from the bytes when the name has no extension', () => {
    expect(guessContentType('Menu Card', ascii('%PDF-1.4 rest'))).toBe('application/pdf');
    expect(guessContentType('photo', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0]))).toBe(
      'image/png',
    );
    expect(guessContentType('photo', new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(guessContentType('anim', ascii('GIF89a'))).toBe('image/gif');
    expect(guessContentType('pic', ascii('RIFF....WEBPVP8 '))).toBe('image/webp');
  });

  it('trusts the bytes over a misleading extension', () => {
    expect(guessContentType('scan.txt', ascii('%PDF-1.7'))).toBe('application/pdf');
  });

  it('falls back to the extension for types the bytes cannot settle', () => {
    expect(guessContentType('report.docx', new Uint8Array([0x50, 0x4b, 3, 4]))).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(guessContentType('Notes.TXT', ascii('hello'))).toBe('text/plain');
    expect(guessContentType('clip.MOV', new Uint8Array(0))).toBe('video/quicktime');
  });

  it('gives up to the generic binary type, never a guess', () => {
    expect(guessContentType('blob', ascii('hello'))).toBe('application/octet-stream');
    expect(guessContentType('weird.xyz', ascii('hello'))).toBe('application/octet-stream');
    expect(guessContentType('.pdf', ascii('hello'))).toBe('application/octet-stream');
  });
});
