import { describe, expect, it } from 'vitest';
import { Name, openPdf, parseValue, PdfError, PdfString, Ref } from './pdf-pages.js';
import { fakeJpeg, grey, page, pageTree, pdfOf, readPng, zlib } from './test-pdf.js';

/**
 * Taking a scan's pages out of a PDF (MAK-255): the pages in the page tree's order with
 * what they inherit, a JPEG page as it is, a Flate page as a PNG whose pixels are the
 * page's, and every shape this does not decode named rather than guessed at.
 */

const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

describe('parseValue', () => {
  it('reads the values a page tree and an image dictionary are made of', () => {
    const { value } = parseValue(
      enc('<< /Type /Page /Kids [3 0 R 4 0 R] /W 2.5 /Neg -3 /On true /Off null /Esc (a\\(b\\)\\n\\101) /Hex <4142 3> /Sp#20ace 1 >>'),
      0,
    );
    expect(value).toBeInstanceOf(Map);
    const d = value as Map<string, unknown>;
    expect(d.get('Type')).toEqual(new Name('Page'));
    expect(d.get('Kids')).toEqual([new Ref(3, 0), new Ref(4, 0)]);
    expect(d.get('W')).toBe(2.5);
    expect(d.get('Neg')).toBe(-3);
    expect(d.get('On')).toBe(true);
    expect(d.get('Off')).toBe(null);
    expect(d.get('Esc')).toEqual(new PdfString(enc('a(b)\nA')));
    expect(d.get('Hex')).toEqual(new PdfString(enc('AB0')));
    expect(d.get('Sp ace')).toBe(1);
  });

  it('refuses nesting no file has, rather than run out of stack', () => {
    expect(() => parseValue(enc('['.repeat(500)), 0)).toThrow(PdfError);
  });
});

describe('openPdf', () => {
  it('finds the pages in order, with the rotation and resources they inherit, and the text and pictures on each', async () => {
    const jpeg = fakeJpeg(1700, 2200);
    const file = pdfOf([
      // A page tree two levels deep, turned 90° at the top, with one page turning itself back.
      { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { num: 2, body: '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 3 /Rotate 90 >>' },
      { num: 3, body: '<< /Type /Pages /Parent 2 0 R /Kids [4 0 R 5 0 R] /Count 2 /Resources << /XObject << /Im0 10 0 R >> >> >>' },
      // Inherits its node's resources: the JPEG.
      { num: 4, body: '<< /Type /Page /Parent 3 0 R >>' },
      { ...page(5, [], { font: true, rotate: 0 }) },
      // The picture inside a form, one level down, and a logo too small to be a page.
      { num: 6, body: '<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Fm0 7 0 R /Logo 8 0 R >> >> >>' },
      { num: 7, body: '<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] /Resources << /XObject << /Im1 10 0 R >> >> >>', stream: enc('q /Im1 Do Q') },
      { num: 8, body: '<< /Type /XObject /Subtype /Image /Width 32 /Height 32 /ColorSpace /DeviceGray /BitsPerComponent 8 >>', stream: new Uint8Array(32 * 32) },
      { num: 10, body: '<< /Type /XObject /Subtype /Image /Width 1700 /Height 2200 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode >>', stream: jpeg },
    ]);
    const pdf = await openPdf(file);
    expect(pdf.encrypted).toBe(false);
    expect(pdf.pages.map((p) => ({ rotate: p.rotate, images: p.images.length, hasText: p.hasText }))).toEqual([
      { rotate: 90, images: 1, hasText: false },
      { rotate: 0, images: 0, hasText: true },
      { rotate: 90, images: 1, hasText: false },
    ]);
    const pic = await pdf.picture(pdf.pages[0]!.images[0]!);
    expect(pic).toEqual({ ok: true, bytes: jpeg, contentType: 'image/jpeg', width: 1700, height: 2200 });
  });

  it('reads a page tree packed into an object stream, behind a cross-reference stream', async () => {
    const packed = '1 0 2 50 ';
    const objects = '<< /Type /Catalog /Pages 2 0 R >>'.padEnd(50) + '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
    const file = pdfOf(
      [
        { num: 20, body: `<< /Type /ObjStm /N 2 /First ${packed.length} /Filter /FlateDecode >>`, stream: await zlib(enc(packed + objects)) },
        page(3, [10]),
        { num: 10, body: '<< /Subtype /Image /Width 64 /Height 64 /Filter /DCTDecode >>', stream: fakeJpeg(64, 64) },
        { num: 21, body: '<< /Type /XRef /Root 1 0 R /Size 22 /W [1 2 1] >>', stream: new Uint8Array(4) },
      ],
      // No classic trailer: the cross-reference stream is the only one.
      '<< >>',
    );
    const pdf = await openPdf(file);
    expect(pdf.pages).toHaveLength(1);
    expect(pdf.pages[0]!.images).toHaveLength(1);
  });

  it('finds a stream whose length is held in another object, and the newest of two definitions', async () => {
    const jpeg = fakeJpeg(100, 100);
    const file = pdfOf([
      ...pageTree([3]),
      // An older page 3 with no picture, then the one an update wrote after it.
      page(3, []),
      { num: 10, body: '<< /Subtype /Image /Width 100 /Height 100 /Filter [/DCTDecode] >>', stream: jpeg, length: '11 0 R' },
      { num: 11, body: String(jpeg.length) },
      page(3, [10]),
    ]);
    const pdf = await openPdf(file);
    const pic = await pdf.picture(pdf.pages[0]!.images[0]!);
    expect(pic.ok && pic.bytes).toEqual(jpeg);
  });

  it('turns Flate pixels into a PNG with the same pixels', async () => {
    const pixels = grey(64, 50);
    const file = pdfOf([
      ...pageTree([3]),
      page(3, [10]),
      { num: 10, body: '<< /Subtype /Image /Width 64 /Height 50 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode >>', stream: await zlib(pixels) },
    ]);
    const pdf = await openPdf(file);
    const pic = await pdf.picture(pdf.pages[0]!.images[0]!);
    if (!pic.ok) throw new Error(pic.reason);
    expect(pic.contentType).toBe('image/png');
    const png = await readPng(pic.bytes);
    expect(png).toMatchObject({ width: 64, height: 50, depth: 8, colorType: 0, palette: null });
    expect(png.filters.every((f) => f === 0)).toBe(true);
    expect(png.rows.flatMap((r) => [...r])).toEqual([...pixels]);
  });

  it("uses data already in PNG's row filters as it is", async () => {
    // Every row with filter byte 0, then the pixels: what /Predictor 15 means.
    const rows = new Uint8Array(51 * 50);
    for (let y = 0; y < 50; y++) rows.set(grey(50, 1), y * 51 + 1);
    const stream = await zlib(rows);
    const file = pdfOf([
      ...pageTree([3]),
      page(3, [10]),
      {
        num: 10,
        body: '<< /Subtype /Image /Width 50 /Height 50 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /DecodeParms << /Predictor 15 /Columns 50 >> >>',
        stream,
      },
    ]);
    const pdf = await openPdf(file);
    const pic = await pdf.picture(pdf.pages[0]!.images[0]!);
    if (!pic.ok) throw new Error(pic.reason);
    // The stream's own bytes are the IDAT, untouched.
    const at = pic.bytes.length - 12 - stream.length - 4;
    expect([...pic.bytes.subarray(at, at + stream.length)]).toEqual([...stream]);
    expect((await readPng(pic.bytes)).rows[3]).toEqual(grey(50, 1));
  });

  it('draws an inverted 1-bit mask through an inverted palette, and CMYK and a palette as RGB', async () => {
    const bits = new Uint8Array(8 * 48).fill(0b10101010);
    const cmyk = new Uint8Array(48 * 48 * 4);
    for (let i = 0; i < 48 * 48; i++) cmyk.set([0, 255, 255, 0], i * 4); // red
    const file = pdfOf([
      ...pageTree([3]),
      page(3, [10, 11, 12]),
      { num: 10, body: '<< /Subtype /Image /Width 64 /Height 48 /ImageMask true /Decode [1 0] /Filter /FlateDecode >>', stream: await zlib(bits) },
      { num: 11, body: '<< /Subtype /Image /Width 48 /Height 48 /ColorSpace /DeviceCMYK /BitsPerComponent 8 /Filter /FlateDecode >>', stream: await zlib(cmyk) },
      { num: 12, body: '<< /Subtype /Image /Width 48 /Height 48 /ColorSpace [/Indexed /DeviceRGB 1 <ff0000 0000ff>] /BitsPerComponent 8 /Filter /FlateDecode >>', stream: await zlib(new Uint8Array(48 * 48).fill(1)) },
    ]);
    const pdf = await openPdf(file);
    const [mask, red, indexed] = await Promise.all(pdf.pages[0]!.images.map((im) => pdf.picture(im)));
    if (!mask!.ok || !red!.ok || !indexed!.ok) throw new Error('a picture was refused');
    const m = await readPng(mask!.bytes);
    expect(m).toMatchObject({ depth: 1, colorType: 3 });
    expect([...m.palette!]).toEqual([255, 255, 255, 0, 0, 0]);
    expect(m.rows[0]![0]).toBe(0b10101010);
    const r = await readPng(red!.bytes);
    expect(r).toMatchObject({ depth: 8, colorType: 2 });
    expect([...r.rows[0]!.subarray(0, 3)]).toEqual([255, 0, 0]);
    const p = await readPng(indexed!.bytes);
    expect(p).toMatchObject({ colorType: 3 });
    expect([...p.palette!]).toEqual([255, 0, 0, 0, 0, 255]);
  });

  it('names an encoding it does not decode, and a file that is encrypted or not a PDF', async () => {
    const fax = pdfOf([
      ...pageTree([3]),
      page(3, [10]),
      { num: 10, body: '<< /Subtype /Image /Width 1700 /Height 2200 /ImageMask true /Filter /CCITTFaxDecode /DecodeParms << /K -1 >> >>', stream: new Uint8Array(10) },
    ]);
    const pdf = await openPdf(fax);
    expect(await pdf.picture(pdf.pages[0]!.images[0]!)).toEqual({ ok: false, reason: 'encoded as CCITT fax (a black and white scan)' });

    const locked = await openPdf(pdfOf([...pageTree([3]), page(3, [])], '<< /Root 1 0 R /Encrypt 9 0 R >>'));
    expect(locked).toMatchObject({ encrypted: true, pages: [] });

    await expect(openPdf(enc('PK\x03\x04 not a pdf'))).rejects.toThrow(PdfError);
  });

  it('refuses a page too large to decode before inflating it', async () => {
    const file = pdfOf([
      ...pageTree([3]),
      page(3, [10]),
      { num: 10, body: '<< /Subtype /Image /Width 9000 /Height 9000 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode >>', stream: await zlib(new Uint8Array(1)) },
    ]);
    const pdf = await openPdf(file);
    expect(await pdf.picture(pdf.pages[0]!.images[0]!)).toEqual({ ok: false, reason: 'too large to decode here' });
  });
});
