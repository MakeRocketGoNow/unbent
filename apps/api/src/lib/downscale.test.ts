import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_EDGE, downscale, downscaleTransform, jpegSize, LARGEST_MAX_EDGE, type Downscaler } from './downscale.js';

/**
 * What the Images binding is asked for (MAK-185's "a test pins the transform parameters"),
 * and the reader that tells the assistant the size it was sent.
 */

/** A JPEG's head as far as its frame header: SOI, an APP0 segment, then SOF0 or SOF2. */
function jpegHead(width: number, height: number, frame = 0xc0): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    // APP0, length 16: "JFIF\0" and its fields, which the reader skips by length.
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    // A DHT before the frame, as some encoders write it: C4 is in the SOF range and is not one.
    0xff, 0xc4, 0x00, 0x03, 0x00,
    // SOFn, length 17: precision, height, width, then the components.
    0xff, frame, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03,
    0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ]);
}

describe('downscaleTransform', () => {
  it('fits the long edge without enlarging, at the default and at the largest', () => {
    expect(downscaleTransform(DEFAULT_MAX_EDGE)).toEqual({ width: 1568, height: 1568, fit: 'scale-down' });
    expect(downscaleTransform(LARGEST_MAX_EDGE)).toEqual({ width: 2576, height: 2576, fit: 'scale-down' });
  });
});

describe('downscale', () => {
  it('asks for a JPEG on white and answers its bytes and size', async () => {
    const calls: unknown[] = [];
    const out = jpegHead(1176, 1568);
    const images: Downscaler = {
      input(stream) {
        calls.push(['input', stream instanceof ReadableStream]);
        const transformer = {
          transform(t: unknown) {
            calls.push(['transform', t]);
            return transformer;
          },
          async output(o: unknown) {
            calls.push(['output', o]);
            return { image: () => new Response(out).body!, contentType: () => 'image/jpeg', response: () => new Response(out) };
          },
        };
        return transformer as never;
      },
    };
    const result = await downscale(images, new Response(new Uint8Array([1, 2, 3])).body!, 1568);
    expect(calls).toEqual([
      ['input', true],
      ['transform', { width: 1568, height: 1568, fit: 'scale-down' }],
      ['output', { format: 'image/jpeg', quality: 85, background: '#ffffff' }],
    ]);
    expect(result).toMatchObject({ contentType: 'image/jpeg', width: 1176, height: 1568 });
    expect(new Uint8Array(result.bytes)).toEqual(out);
  });
});

describe('jpegSize', () => {
  it('reads a baseline and a progressive frame past the segments before it', () => {
    expect(jpegSize(jpegHead(1568, 1045).buffer as ArrayBuffer)).toEqual({ width: 1568, height: 1045 });
    expect(jpegSize(jpegHead(800, 2576, 0xc2).buffer as ArrayBuffer)).toEqual({ width: 800, height: 2576 });
  });

  it('answers null for what is not a whole JPEG head', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(jpegSize(png.buffer as ArrayBuffer)).toBeNull();
    expect(jpegSize(jpegHead(10, 10).slice(0, 30).buffer as ArrayBuffer)).toBeNull();
    expect(jpegSize(new ArrayBuffer(0))).toBeNull();
  });
});
