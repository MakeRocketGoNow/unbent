/**
 * Small PDFs written for the tests of lib/pdf-pages.ts and `get_attachment`, made up
 * object by object, so each test says exactly what shape of file it reads. Nothing here is
 * taken from a real scan: a scan's private content sits in its pixels, so a fixture is
 * pixels invented here (`grey`) or a JPEG's header and nothing else (`fakeJpeg`).
 */

const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

/** One object: its dictionary or value as PDF text, and a stream body when it has one. */
export interface TestObject {
  num: number;
  /** For a stream, the dictionary without `/Length`, which is added (unless `length` says otherwise). */
  body: string;
  stream?: Uint8Array;
  /** What `/Length` says, when it should not be the body's own length: `"9 0 R"`, say. */
  length?: string;
}

/** A PDF of these objects, ending in a classic trailer naming `root` (or `trailer` as given). */
export function pdfOf(objects: TestObject[], trailer = '<< /Root 1 0 R >>'): Uint8Array {
  const parts: Uint8Array[] = [latin1('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')];
  for (const o of objects) {
    if (o.stream) {
      const dict = o.body.replace(/>>\s*$/, ` /Length ${o.length ?? o.stream.length} >>`);
      parts.push(latin1(`${o.num} 0 obj\n${dict}\nstream\n`), o.stream, latin1('\nendstream\nendobj\n'));
    } else parts.push(latin1(`${o.num} 0 obj\n${o.body}\nendobj\n`));
  }
  parts.push(latin1(`trailer\n${trailer}\nstartxref\n0\n%%EOF\n`));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A catalog (object 1) and a page tree (object 2) over the page objects named. */
export function pageTree(pageNums: number[], pagesExtra = ''): TestObject[] {
  return [
    { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { num: 2, body: `<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageNums.length} ${pagesExtra}>>` },
  ];
}

/** A page drawing the image XObjects given (by object number), with fonts if `font`. */
export function page(num: number, images: number[], opts: { font?: boolean; rotate?: number } = {}): TestObject {
  const xobjects = images.map((n, i) => `/Im${i} ${n} 0 R`).join(' ');
  return {
    num,
    body:
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]` +
      (opts.rotate !== undefined ? ` /Rotate ${opts.rotate}` : '') +
      ` /Resources << /XObject << ${xobjects} >>${opts.font ? ' /Font << /F1 99 0 R >>' : ''} >> >>`,
  };
}

/**
 * The start of a JPEG of the given size: SOI and a baseline frame header. Enough for
 * anything here that reads a JPEG's size, and for the reader, which hands a JPEG page over
 * byte for byte without decoding it.
 */
export function fakeJpeg(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03,
    0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
  ]);
}

/** A grey ramp of `width` by `height` at 8 bits: each pixel's value is its column, wrapped. */
export function grey(width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) out[y * width + x] = x & 0xff;
  return out;
}

export async function zlib(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function unzlib(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A PNG read back: its header, palette, and its rows with their filter bytes taken off. */
export async function readPng(bytes: Uint8Array): Promise<{
  width: number;
  height: number;
  depth: number;
  colorType: number;
  palette: Uint8Array | null;
  rows: Uint8Array[];
  filters: number[];
}> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let palette: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (at < bytes.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      depth = body[8]!;
      colorType = body[9]!;
    } else if (type === 'PLTE') palette = body;
    else if (type === 'IDAT') idat.push(body);
    at += 12 + length;
  }
  const raw = await unzlib(new Uint8Array(idat.flatMap((c) => [...c])));
  const channels = colorType === 2 ? 3 : 1;
  const rowBytes = Math.ceil((width * channels * depth) / 8);
  const rows: Uint8Array[] = [];
  const filters: number[] = [];
  for (let y = 0; y < height; y++) {
    filters.push(raw[y * (rowBytes + 1)]!);
    rows.push(raw.subarray(y * (rowBytes + 1) + 1, (y + 1) * (rowBytes + 1)));
  }
  return { width, height, depth, colorType, palette, rows, filters };
}
