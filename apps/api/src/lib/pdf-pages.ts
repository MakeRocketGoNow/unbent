/**
 * The pictures a scanned PDF is made of, page by page, for MCP's `get_attachment` (MAK-255).
 *
 * A scan with no text layer waited for an Auto-fill press, since nothing else on the
 * instance can read it and an assistant could not be handed it: `get_attachment` returns a
 * picture as an image block, and a PDF is not one. Sending the PDF itself was ruled out
 * first. MCP can carry one as an embedded resource, but claude.ai's hosted connectors have
 * been reported to refuse a binary resource outright and Claude Code to save it to a file
 * the model is only told the path of, so an image block per page is the one shape every
 * client reads.
 *
 * Why the pages are taken out rather than drawn: drawing a page needs a renderer, and the
 * Worker has no canvas. pdf.js decodes every encoding a scan uses but is a megabyte of
 * bundle and a decode per page that costs more CPU than Workers Free gives an invocation;
 * a wasm renderer is several megabytes on top. A scan does not need drawing, though: each
 * page is a picture the scanner made, stored whole inside the PDF, and for the common
 * encodings it is a file already. A JPEG page (`DCTDecode`) is a JPEG byte for byte; a
 * Flate-compressed page is pixels that become a PNG with a header round them, and with no
 * work at all when the writer used PNG's own row filters. Measured on the no-text PDFs of
 * a real archive (2026-11-17), those two were about 84% of them; CCITT fax (black and white
 * scans) was most of the rest, JPEG 2000 a couple, JBIG2 none. Those are named in the
 * answer, which points at Auto-fill, rather than decoded here.
 *
 * What this reads of the file. Every `N G obj` is found by searching the bytes, rather
 * than by trusting the cross-reference table, which is the part of a PDF most often wrong
 * in files that have been through a few programs; the last definition of a number wins,
 * as an incremental update means. A stream's body is skipped by its `/Length`, so the
 * search walks the objects' headers and not the megabytes of picture between them.
 * Objects packed into object streams (PDF 1.5) are unpacked after. The page tree then
 * gives the pages in order, with what each inherits; a page's pictures are the image
 * XObjects in its resources, and in those of a form it draws, one level down, which is
 * where some writers put them. A page drawn in several strips gives several pictures. A
 * picture drawn inline in the content stream (`BI … EI`) is not found: scanners do not
 * write them for a page.
 */

/** A reference to an object: `12 0 R`. */
export class Ref {
  constructor(
    readonly num: number,
    readonly gen: number,
  ) {}
}

/** A name, without its slash and with `#xx` escapes decoded. */
export class Name {
  constructor(readonly name: string) {}
}

/** A string's bytes, literal or hex. */
export class PdfString {
  constructor(readonly bytes: Uint8Array) {}
}

export type PdfDict = Map<string, PdfValue>;
export type PdfValue = null | boolean | number | Ref | Name | PdfString | PdfValue[] | PdfDict;

/** Thrown for a file that is not a PDF this can read; the message is for the log. */
export class PdfError extends Error {}

/** One object as found: its value, and where its stream's body is when it has one. */
interface Entry {
  value: PdfValue;
  stream?: { start: number; end: number };
  /** Where `N G obj` was found, which orders two candidate trailers. */
  offset: number;
}

const WS = new Set([0, 9, 10, 12, 13, 32]);
/** ( ) < > [ ] { } / % */
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const isWs = (c: number | undefined) => c !== undefined && WS.has(c);
const isDelim = (c: number | undefined) => c !== undefined && DELIM.has(c);
const isDigit = (c: number | undefined) => c !== undefined && c >= 0x30 && c <= 0x39;
const ascii = (s: string) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));

const OBJ = ascii('obj');
const STREAM = ascii('stream');
const ENDSTREAM = ascii('endstream');
const TRAILER = ascii('trailer');

/** Deeper than any real file nests; a crafted one is refused before the stack is. */
const MAX_DEPTH = 64;

/**
 * The most pixels a Flate page may be, in bytes, and the most any other stream may inflate
 * to. What a call holds at once is the file (up to `get_attachment`'s 16 MB), one page's
 * rows (up to this), and that page compressed again, copied once into the PNG: about 50 MB
 * at the caps, which the read gate (lib/reader-gate.ts) lets two calls hold beside each
 * other in the isolate's 128 MB. Nothing real comes near them. In the no-text PDFs of a real
 * archive the largest file was 8 MB and the largest Flate page 10.4 MB of pixels; a
 * full-colour letter page at 300 dpi is 25 MB, and is refused by name, as a page past
 * either is, rather than ending the isolate and every request on it.
 */
const MAX_PIXEL_BYTES = 12 * 1024 * 1024;
const MAX_STREAM_BYTES = 16 * 1024 * 1024;

function startsWith(b: Uint8Array, at: number, seq: Uint8Array): boolean {
  if (at < 0 || at + seq.length > b.length) return false;
  for (let k = 0; k < seq.length; k++) if (b[at + k] !== seq[k]) return false;
  return true;
}

/** `seq` in `b` from `from`, by the native search for its first byte. */
function indexOfSeq(b: Uint8Array, seq: Uint8Array, from: number): number {
  for (let i = b.indexOf(seq[0]!, from); i >= 0; i = b.indexOf(seq[0]!, i + 1)) {
    if (startsWith(b, i, seq)) return i;
  }
  return -1;
}

function lastIndexOfSeq(b: Uint8Array, seq: Uint8Array): number {
  for (let i = b.lastIndexOf(seq[0]!); i >= 0; i = i === 0 ? -1 : b.lastIndexOf(seq[0]!, i - 1)) {
    if (startsWith(b, i, seq)) return i;
  }
  return -1;
}

/** Past whitespace and comments. */
function skipWs(b: Uint8Array, i: number): number {
  while (i < b.length) {
    const c = b[i]!;
    if (WS.has(c)) i++;
    else if (c === 0x25) {
      while (i < b.length && b[i] !== 10 && b[i] !== 13) i++;
    } else break;
  }
  return i;
}

/** A run of regular characters: a number or a keyword. */
function token(b: Uint8Array, i: number): { text: string; end: number } {
  let end = i;
  while (end < b.length && !isWs(b[end]) && !isDelim(b[end])) end++;
  return { text: String.fromCharCode(...b.subarray(i, end)), end };
}

const hexValue = (c: number) =>
  c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 0x37 : c >= 0x61 && c <= 0x66 ? c - 0x57 : -1;

/**
 * One value at `i`, and where it ends. Throws on anything that is not a value, a keyword
 * (`endobj`, `stream`) included; the callers look for those first.
 */
export function parseValue(b: Uint8Array, i: number, depth = 0): { value: PdfValue; end: number } {
  if (depth > MAX_DEPTH) throw new PdfError('nested too deep');
  i = skipWs(b, i);
  const c = b[i];
  if (c === undefined) throw new PdfError('unexpected end');

  if (c === 0x2f) {
    // A name: up to the next delimiter, with #xx standing for a byte.
    const { text, end } = token(b, i + 1);
    return { value: new Name(text.replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))), end };
  }

  if (c === 0x3c && b[i + 1] === 0x3c) {
    const dict: PdfDict = new Map();
    let j = i + 2;
    for (;;) {
      j = skipWs(b, j);
      if (b[j] === 0x3e && b[j + 1] === 0x3e) return { value: dict, end: j + 2 };
      const key = parseValue(b, j, depth + 1);
      if (!(key.value instanceof Name)) throw new PdfError('dictionary key is not a name');
      const val = parseValue(b, key.end, depth + 1);
      dict.set(key.value.name, val.value);
      j = val.end;
    }
  }

  if (c === 0x3c) {
    const end = b.indexOf(0x3e, i + 1);
    if (end < 0) throw new PdfError('unterminated hex string');
    const digits: number[] = [];
    for (let k = i + 1; k < end; k++) {
      const v = hexValue(b[k]!);
      if (v >= 0) digits.push(v);
    }
    if (digits.length % 2) digits.push(0);
    const bytes = new Uint8Array(digits.length / 2);
    for (let k = 0; k < bytes.length; k++) bytes[k] = (digits[2 * k]! << 4) | digits[2 * k + 1]!;
    return { value: new PdfString(bytes), end: end + 1 };
  }

  if (c === 0x28) {
    const out: number[] = [];
    let nest = 1;
    let j = i + 1;
    while (j < b.length) {
      const ch = b[j]!;
      if (ch === 0x5c) {
        const e = b[j + 1];
        j += 2;
        if (e === undefined) break;
        const simple: Record<number, number> = { 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12, 0x28: 0x28, 0x29: 0x29, 0x5c: 0x5c };
        if (simple[e] !== undefined) out.push(simple[e]);
        else if (e >= 0x30 && e <= 0x37) {
          let v = e - 0x30;
          for (let n = 0; n < 2 && b[j]! >= 0x30 && b[j]! <= 0x37; n++, j++) v = v * 8 + (b[j]! - 0x30);
          out.push(v & 0xff);
        } else if (e === 13) {
          if (b[j] === 10) j++;
        } else if (e !== 10) out.push(e);
        continue;
      }
      if (ch === 0x28) nest++;
      if (ch === 0x29 && --nest === 0) return { value: new PdfString(Uint8Array.from(out)), end: j + 1 };
      out.push(ch);
      j++;
    }
    throw new PdfError('unterminated string');
  }

  if (c === 0x5b) {
    const arr: PdfValue[] = [];
    let j = i + 1;
    for (;;) {
      j = skipWs(b, j);
      if (b[j] === 0x5d) return { value: arr, end: j + 1 };
      const item = parseValue(b, j, depth + 1);
      arr.push(item.value);
      j = item.end;
    }
  }

  const { text, end } = token(b, i);
  if (text === 'true' || text === 'false') return { value: text === 'true', end };
  if (text === 'null') return { value: null, end };
  const n = Number(text);
  if (text === '' || Number.isNaN(n)) throw new PdfError(`not a value: ${text.slice(0, 20)}`);
  // `12 0 R`: two non-negative integers and an R make one reference.
  if (/^\d+$/.test(text)) {
    const j = skipWs(b, end);
    const gen = token(b, j);
    if (/^\d+$/.test(gen.text)) {
      const k = skipWs(b, gen.end);
      const r = token(b, k);
      if (r.text === 'R') return { value: new Ref(n, Number(gen.text)), end: r.end };
    }
  }
  return { value: n, end };
}

/**
 * The number before `obj` at `at`, if `at` really is an object's header: `N G obj`, with
 * N and G digits, whitespace between, and nothing but whitespace or a delimiter before N.
 */
function headerAt(b: Uint8Array, at: number): { num: number; start: number } | null {
  let k = at - 1;
  if (!isWs(b[k])) return null;
  while (k >= 0 && isWs(b[k])) k--;
  const genEnd = k + 1;
  while (k >= 0 && isDigit(b[k])) k--;
  if (k + 1 === genEnd || !isWs(b[k])) return null;
  while (k >= 0 && isWs(b[k])) k--;
  const numEnd = k + 1;
  while (k >= 0 && isDigit(b[k])) k--;
  if (k + 1 === numEnd) return null;
  if (k >= 0 && !isWs(b[k]) && !isDelim(b[k])) return null;
  return { num: Number(String.fromCharCode(...b.subarray(k + 1, numEnd))), start: k + 1 };
}

/** Every object in the file, by number; the last definition of a number wins. */
function scanObjects(b: Uint8Array): Map<number, Entry> {
  const entries = new Map<number, Entry>();
  let from = 0;
  for (;;) {
    const at = indexOfSeq(b, OBJ, from);
    if (at < 0) break;
    from = at + OBJ.length;
    // `endobj` ends in the same three letters, and has no number before it.
    const after = b[at + OBJ.length];
    if (after !== undefined && !isWs(after) && !isDelim(after)) continue;
    const header = headerAt(b, at);
    if (!header) continue;
    let parsed: { value: PdfValue; end: number };
    try {
      parsed = parseValue(b, at + OBJ.length);
    } catch {
      continue;
    }
    const next = skipWs(b, parsed.end);
    if (parsed.value instanceof Map && startsWith(b, next, STREAM)) {
      let start = next + STREAM.length;
      if (b[start] === 13) start++;
      if (b[start] === 10) start++;
      // By its length when that is a number and lands on `endstream`; otherwise (a length
      // held in another object, or one that is wrong) by searching for `endstream`, less
      // the end of line before it.
      const length = parsed.value.get('Length');
      let end = -1;
      if (typeof length === 'number' && length >= 0 && startsWith(b, skipWs(b, start + length), ENDSTREAM)) {
        end = start + length;
      }
      if (end < 0) {
        const found = indexOfSeq(b, ENDSTREAM, start);
        end = found < 0 ? b.length : found;
        if (b[end - 1] === 10) end--;
        if (b[end - 1] === 13) end--;
        end = Math.max(end, start);
      }
      entries.set(header.num, { value: parsed.value, stream: { start, end }, offset: header.start });
      from = end;
    } else {
      entries.set(header.num, { value: parsed.value, offset: header.start });
      from = parsed.end;
    }
  }
  return entries;
}

/** `bytes` as a stream, without the copy `new Blob([bytes])` would make of them first. */
function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * Inflates zlib data into `sink`, chunk by chunk as it comes, so a caller that knows where
 * the bytes go never holds them twice. Tolerates what some writers leave after the data's
 * end: an error after output has come keeps the output, since everything the stream held
 * arrived before it. Refuses past `limit` bytes of output.
 */
async function inflateTo(bytes: Uint8Array, limit: number, sink: (chunk: Uint8Array) => void): Promise<void> {
  const reader = streamOf(bytes).pipeThrough(new DecompressionStream('deflate')).getReader();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new PdfError('too large inflated');
      }
      sink(value);
    }
  } catch (err) {
    if (err instanceof PdfError || total === 0) throw err;
  }
}

/** Inflates zlib data whole, for the small streams that are needed whole: an object stream, a palette. */
export async function inflate(bytes: Uint8Array, limit = MAX_STREAM_BYTES): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  await inflateTo(bytes, limit, (c) => chunks.push(c));
  return concat(chunks);
}

/** Compresses `bytes`, answering the chunks as they came rather than joining them. */
async function deflate(bytes: Uint8Array): Promise<Uint8Array[]> {
  const reader = streamOf(bytes).pipeThrough(new CompressionStream('deflate')).getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return chunks;
    chunks.push(value);
  }
}

function concat(chunks: Uint8Array[], total = chunks.reduce((n, c) => n + c.byteLength, 0)): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** A parsed PDF: its objects, and the means to follow a reference. */
class Pdf {
  constructor(
    readonly bytes: Uint8Array,
    readonly entries: Map<number, Entry>,
  ) {}

  resolve(v: PdfValue | undefined): PdfValue {
    for (let hops = 0; v instanceof Ref && hops < 32; hops++) v = this.entries.get(v.num)?.value;
    return v === undefined || v instanceof Ref ? null : v;
  }

  dict(v: PdfValue | undefined): PdfDict | null {
    const d = this.resolve(v);
    return d instanceof Map ? d : null;
  }

  entry(v: PdfValue | undefined): Entry | null {
    return v instanceof Ref ? (this.entries.get(v.num) ?? null) : null;
  }

  raw(entry: Entry): Uint8Array {
    return entry.stream ? this.bytes.subarray(entry.stream.start, entry.stream.end) : new Uint8Array();
  }

  /** A stream's body with its filters undone, when they are Flate alone (or none). */
  async decoded(entry: Entry): Promise<Uint8Array> {
    const dict = entry.value instanceof Map ? entry.value : new Map<string, PdfValue>();
    let data = this.raw(entry);
    for (const f of filtersOf(this, dict)) {
      if (f !== 'FlateDecode') throw new PdfError(`filter ${f}`);
      data = await inflate(data);
    }
    return data;
  }
}

const nameOf = (v: PdfValue) => (v instanceof Name ? v.name : null);

function filtersOf(pdf: Pdf, dict: PdfDict): string[] {
  const f = pdf.resolve(dict.get('Filter'));
  const list = Array.isArray(f) ? f.map((x) => pdf.resolve(x)) : f === null ? [] : [f];
  return list.map((x) => nameOf(x) ?? '?').map((n) => (n === 'Fl' ? 'FlateDecode' : n === 'DCT' ? 'DCTDecode' : n));
}

function parmsOf(pdf: Pdf, dict: PdfDict, index: number): PdfDict | null {
  const p = pdf.resolve(dict.get('DecodeParms') ?? dict.get('DP'));
  if (Array.isArray(p)) return pdf.dict(p[index] ?? null);
  return index === 0 ? pdf.dict(p) : null;
}

/** Unpacks every object stream, keeping a number already defined in the file as it is. */
async function unpackObjectStreams(pdf: Pdf): Promise<void> {
  for (const entry of [...pdf.entries.values()]) {
    if (!(entry.value instanceof Map) || nameOf(entry.value.get('Type') ?? null) !== 'ObjStm' || !entry.stream) continue;
    let data: Uint8Array;
    try {
      data = await pdf.decoded(entry);
    } catch {
      continue;
    }
    const n = pdf.resolve(entry.value.get('N'));
    const first = pdf.resolve(entry.value.get('First'));
    if (typeof n !== 'number' || typeof first !== 'number') continue;
    let at = 0;
    const pairs: Array<[number, number]> = [];
    try {
      for (let k = 0; k < n; k++) {
        const num = parseValue(data, at);
        const off = parseValue(data, num.end);
        if (typeof num.value !== 'number' || typeof off.value !== 'number') break;
        pairs.push([num.value, off.value]);
        at = off.end;
      }
    } catch {
      // A header cut short keeps the pairs it gave.
    }
    for (const [num, off] of pairs) {
      if (pdf.entries.has(num)) continue;
      try {
        pdf.entries.set(num, { value: parseValue(data, first + off).value, offset: entry.offset });
      } catch {
        // One unreadable object is one missing object, not an unreadable file.
      }
    }
  }
}

/**
 * The file's trailer: the last `trailer` dictionary or cross-reference stream that names a
 * catalog, which in an updated file is the newest. Null when there is none to be found.
 */
function trailerOf(pdf: Pdf): PdfDict | null {
  const candidates: Array<{ offset: number; dict: PdfDict }> = [];
  const at = lastIndexOfSeq(pdf.bytes, TRAILER);
  if (at >= 0) {
    try {
      const trailer = parseValue(pdf.bytes, at + TRAILER.length).value;
      if (trailer instanceof Map && trailer.has('Root')) candidates.push({ offset: at, dict: trailer });
    } catch {
      // Fall through to the cross-reference streams.
    }
  }
  for (const e of pdf.entries.values()) {
    if (e.value instanceof Map && nameOf(e.value.get('Type') ?? null) === 'XRef' && e.value.has('Root')) {
      candidates.push({ offset: e.offset, dict: e.value });
    }
  }
  candidates.sort((a, b) => b.offset - a.offset);
  return candidates[0]?.dict ?? null;
}

/** The catalog, from the trailer, or any catalog at all when no trailer leads to one. */
function catalogOf(pdf: Pdf, trailer: PdfDict | null): PdfDict | null {
  const root = trailer ? pdf.dict(trailer.get('Root')) : null;
  if (root) return root;
  for (const e of pdf.entries.values()) {
    if (e.value instanceof Map && nameOf(e.value.get('Type') ?? null) === 'Catalog') return e.value;
  }
  return null;
}

/** One picture on a page, not yet decoded. */
interface ImageRef {
  entry: Entry;
  width: number;
  height: number;
}

/** A page as this reads it: its pictures, and whether it has any text of its own. */
export interface PdfPage {
  /** Degrees the page is turned clockwise when shown (`/Rotate`), 0, 90, 180 or 270. */
  rotate: number;
  images: ImageRef[];
  /** Whether its resources name a font: text drawn on the page, or a scan's OCR layer. */
  hasText: boolean;
}

/**
 * Below this on either side a picture is a logo, a stamp or a rule, not a page. A page
 * drawn in strips has strips a few hundred pixels tall, well over it.
 */
const MIN_IMAGE_SIDE = 48;

/** More than any document an assistant would read a page at a time. */
const MAX_PAGES = 5000;

function pageContents(pdf: Pdf, resources: PdfDict | null, depth: number, seen: Set<number>): { images: ImageRef[]; hasText: boolean } {
  const images: ImageRef[] = [];
  let hasText = false;
  if (!resources) return { images, hasText };
  const fonts = pdf.dict(resources.get('Font'));
  if (fonts && fonts.size) hasText = true;
  const xobjects = pdf.dict(resources.get('XObject'));
  for (const v of xobjects?.values() ?? []) {
    if (!(v instanceof Ref) || seen.has(v.num)) continue;
    seen.add(v.num);
    const entry = pdf.entry(v);
    if (!entry || !(entry.value instanceof Map)) continue;
    const subtype = nameOf(pdf.resolve(entry.value.get('Subtype')));
    if (subtype === 'Image') {
      const width = pdf.resolve(entry.value.get('Width') ?? entry.value.get('W'));
      const height = pdf.resolve(entry.value.get('Height') ?? entry.value.get('H'));
      if (typeof width !== 'number' || typeof height !== 'number') continue;
      if (width < MIN_IMAGE_SIDE || height < MIN_IMAGE_SIDE) continue;
      images.push({ entry, width, height });
    } else if (subtype === 'Form' && depth < 2) {
      // A form's resources are its own; one that names none uses the page's.
      const inner = pageContents(pdf, pdf.dict(entry.value.get('Resources')) ?? resources, depth + 1, seen);
      images.push(...inner.images);
      hasText ||= inner.hasText;
    }
  }
  return { images, hasText };
}

/** The pages in order, from the page tree, each with what it inherits. */
function pagesOf(pdf: Pdf, trailer: PdfDict | null): PdfPage[] {
  const pages: PdfPage[] = [];
  const visited = new Set<number>();
  const walk = (node: PdfValue, resources: PdfDict | null, rotate: number, depth: number) => {
    if (pages.length >= MAX_PAGES || depth > MAX_DEPTH) return;
    if (node instanceof Ref) {
      if (visited.has(node.num)) return;
      visited.add(node.num);
    }
    const dict = pdf.dict(node);
    if (!dict) return;
    const own = pdf.dict(dict.get('Resources'));
    const turn = pdf.resolve(dict.get('Rotate'));
    const r = typeof turn === 'number' ? turn : rotate;
    const kids = pdf.resolve(dict.get('Kids'));
    if (Array.isArray(kids) && nameOf(pdf.resolve(dict.get('Type'))) !== 'Page') {
      for (const kid of kids) walk(kid, own ?? resources, r, depth + 1);
      return;
    }
    const { images, hasText } = pageContents(pdf, own ?? resources, 0, new Set());
    pages.push({ rotate: (((Math.round(r / 90) * 90) % 360) + 360) % 360, images, hasText });
  };
  const catalog = catalogOf(pdf, trailer);
  if (catalog) walk(catalog.get('Pages') ?? null, null, 0, 0);
  if (pages.length) return pages;
  // No page tree that leads anywhere: every page object, in the order it is in the file.
  const loose = [...pdf.entries.values()]
    .filter((e) => e.value instanceof Map && nameOf(e.value.get('Type') ?? null) === 'Page')
    .sort((a, b) => a.offset - b.offset);
  for (const e of loose.slice(0, MAX_PAGES)) {
    const dict = e.value as PdfDict;
    const turn = pdf.resolve(dict.get('Rotate'));
    const { images, hasText } = pageContents(pdf, pdf.dict(dict.get('Resources')), 0, new Set());
    pages.push({ rotate: typeof turn === 'number' ? ((turn % 360) + 360) % 360 : 0, images, hasText });
  }
  return pages;
}

/** An opened PDF: its pages, and the means to turn one of their pictures into a file. */
export interface PdfPages {
  /**
   * Whether the file is encrypted. Its streams are then ciphertext, the pictures among
   * them, and so are object streams, which can hold the page tree; nothing here decrypts,
   * so an encrypted file answers with no pages, and this says why. (Most such files open
   * without a password, being locked only against printing or copying; a reader would
   * have to implement the standard security handler's RC4 and AES to read them.)
   */
  encrypted: boolean;
  pages: PdfPage[];
  picture(image: ImageRef): Promise<Picture>;
}

/** A page's picture as a file a model takes, or why it could not be made one. */
export type Picture =
  | { ok: true; bytes: Uint8Array; contentType: 'image/jpeg' | 'image/png'; width: number; height: number }
  | { ok: false; reason: string };

/** Opens a PDF for its pages. Throws `PdfError` for bytes that are not one. */
export async function openPdf(bytes: Uint8Array): Promise<PdfPages> {
  if (indexOfSeq(bytes.subarray(0, 1024), ascii('%PDF-'), 0) < 0) throw new PdfError('not a PDF');
  const pdf = new Pdf(bytes, scanObjects(bytes));
  const trailer = trailerOf(pdf);
  if (trailer?.has('Encrypt')) return { encrypted: true, pages: [], picture: async () => ({ ok: false, reason: 'encrypted' }) };
  await unpackObjectStreams(pdf);
  return { encrypted: false, pages: pagesOf(pdf, trailer), picture: (image) => picture(pdf, image) };
}

/** What the filters this does not decode are called, for the sentence that names one. */
const FILTER_NAMES: Record<string, string> = {
  CCITTFaxDecode: 'CCITT fax (a black and white scan)',
  CCF: 'CCITT fax (a black and white scan)',
  JBIG2Decode: 'JBIG2 (a black and white scan)',
  JPXDecode: 'JPEG 2000',
  LZWDecode: 'LZW',
  RunLengthDecode: 'run-length',
  ASCII85Decode: 'ASCII85',
  ASCIIHexDecode: 'ASCII hex',
};

async function picture(pdf: Pdf, image: ImageRef): Promise<Picture> {
  const dict = image.entry.value as PdfDict;
  const filters = filtersOf(pdf, dict);
  const unsupported = (f: string): Picture => ({ ok: false, reason: `encoded as ${FILTER_NAMES[f] ?? f}` });
  try {
    // Flate in front of the last filter is undone; any other filter anywhere is named.
    const last = filters.at(-1);
    const leading = filters.slice(0, -1);
    const other = [...leading, ...(last === 'DCTDecode' || last === undefined ? [] : [last])].find((f) => f !== 'FlateDecode');
    if (other) return unsupported(other);
    let data = pdf.raw(image.entry);
    for (const _ of leading) data = await inflate(data);
    if (last === 'DCTDecode') {
      if (data[0] !== 0xff || data[1] !== 0xd8) return { ok: false, reason: 'its JPEG data is damaged' };
      return { ok: true, bytes: data, contentType: 'image/jpeg', width: image.width, height: image.height };
    }
    // The last Flate is left to `toPng`, which can sometimes use its data as it is.
    const flate = last === 'FlateDecode';
    return await toPng(pdf, dict, image, data, flate ? parmsOf(pdf, dict, filters.length - 1) : null, flate);
  } catch (err) {
    if (err instanceof PdfError && err.message === 'too large inflated') return { ok: false, reason: 'too large to decode here' };
    return { ok: false, reason: 'its picture data could not be read' };
  }
}

type Space =
  | { kind: 'gray' | 'rgb' | 'cmyk' }
  | { kind: 'indexed'; base: 'gray' | 'rgb' | 'cmyk'; hival: number; lookup: Uint8Array }
  | { kind: 'unsupported'; name: string };

const COMPONENTS = { gray: 1, rgb: 3, cmyk: 4 } as const;

async function colorSpace(pdf: Pdf, v: PdfValue): Promise<Space> {
  v = pdf.resolve(v);
  const device = (name: string | null): 'gray' | 'rgb' | 'cmyk' | null =>
    name === 'DeviceGray' || name === 'G' || name === 'CalGray'
      ? 'gray'
      : name === 'DeviceRGB' || name === 'RGB' || name === 'CalRGB'
        ? 'rgb'
        : name === 'DeviceCMYK' || name === 'CMYK'
          ? 'cmyk'
          : null;
  if (v instanceof Name) {
    const k = device(v.name);
    return k ? { kind: k } : { kind: 'unsupported', name: v.name };
  }
  if (!Array.isArray(v) || !v.length) return { kind: 'unsupported', name: 'none' };
  const family = nameOf(pdf.resolve(v[0]!));
  if (family === 'CalGray' || family === 'CalRGB') return { kind: device(family)! };
  if (family === 'ICCBased') {
    const stream = pdf.dict(v[1] ?? null);
    const n = stream ? pdf.resolve(stream.get('N')) : null;
    if (n === 1) return { kind: 'gray' };
    if (n === 3) return { kind: 'rgb' };
    if (n === 4) return { kind: 'cmyk' };
    return { kind: 'unsupported', name: 'ICCBased' };
  }
  if (family === 'Indexed' || family === 'I') {
    const base = await colorSpace(pdf, v[1] ?? null);
    const hival = pdf.resolve(v[2] ?? null);
    const table = v[3] ?? null;
    if (base.kind !== 'gray' && base.kind !== 'rgb' && base.kind !== 'cmyk') return { kind: 'unsupported', name: 'Indexed' };
    if (typeof hival !== 'number') return { kind: 'unsupported', name: 'Indexed' };
    const lookupValue = pdf.resolve(table);
    const entry = pdf.entry(table);
    const lookup =
      lookupValue instanceof PdfString ? lookupValue.bytes : entry?.stream ? await pdf.decoded(entry) : null;
    if (!lookup) return { kind: 'unsupported', name: 'Indexed' };
    return { kind: 'indexed', base: base.kind, hival, lookup };
  }
  return { kind: 'unsupported', name: family ?? 'unknown' };
}

const cmykToRgb = (c: number, m: number, y: number, k: number) => [
  ((255 - c) * (255 - k)) / 255,
  ((255 - m) * (255 - k)) / 255,
  ((255 - y) * (255 - k)) / 255,
];

/**
 * A page's rows, given PNG's filter byte (0, none) in front of each and CMYK turned into
 * RGB on the way, compressed for an `IDAT`. Written into one buffer as the inflated data
 * arrives, a row at a time, so the page's pixels are never held twice; the CMYK sum is
 * written out inline, since a three-number array a pixel is millions of allocations a page.
 */
async function pngRows(
  data: Uint8Array,
  flate: boolean,
  rowBytes: number,
  height: number,
  cmyk: boolean,
  width: number,
): Promise<Uint8Array[] | null> {
  const outRow = cmyk ? width * 3 : rowBytes;
  const filtered = new Uint8Array((outRow + 1) * height);
  // CMYK needs a whole row to convert; anything else goes straight to its place.
  const row = cmyk ? new Uint8Array(rowBytes) : null;
  let y = 0;
  let x = 0;
  const put = (chunk: Uint8Array) => {
    let i = 0;
    while (i < chunk.length && y < height) {
      const n = Math.min(rowBytes - x, chunk.length - i);
      if (row) row.set(chunk.subarray(i, i + n), x);
      else filtered.set(chunk.subarray(i, i + n), y * (outRow + 1) + 1 + x);
      x += n;
      i += n;
      if (x < rowBytes) continue;
      if (row) {
        const at = y * (outRow + 1) + 1;
        for (let p = 0; p < width; p++) {
          const s = p * 4;
          const o = at + p * 3;
          const k = 255 - row[s + 3]!;
          filtered[o] = ((255 - row[s]!) * k) / 255;
          filtered[o + 1] = ((255 - row[s + 1]!) * k) / 255;
          filtered[o + 2] = ((255 - row[s + 2]!) * k) / 255;
        }
      }
      y++;
      x = 0;
    }
  };
  // Output past the page's rows is ignored; the limit only stops a stream that never ends.
  if (flate) await inflateTo(data, 2 * rowBytes * height + 1024, put);
  else put(data);
  return y < height ? null : deflate(filtered);
}

/**
 * Pixels as a PNG. The colour types PNG has are grey, RGB and a palette; CMYK is turned
 * into RGB, and a grey whose `/Decode` inverts it is drawn through a palette of inverted
 * greys rather than by rewriting every pixel.
 *
 * `flate` says `data` is still the stream's zlib data. When the writer used PNG's row
 * filters (`/Predictor` 10 and up, with the image's own colours, depth and width), that
 * data is a PNG's `IDAT` already and goes in untouched; otherwise it is inflated, given
 * the filter byte PNG puts in front of every row, and compressed again.
 */
async function toPng(
  pdf: Pdf,
  dict: PdfDict,
  image: ImageRef,
  data: Uint8Array,
  parms: PdfDict | null,
  flate: boolean,
): Promise<Picture> {
  const { width, height } = image;
  const mask = pdf.resolve(dict.get('ImageMask') ?? dict.get('IM')) === true;
  const bpcValue = pdf.resolve(dict.get('BitsPerComponent') ?? dict.get('BPC'));
  const bpc = mask ? 1 : typeof bpcValue === 'number' ? bpcValue : 8;
  const space: Space = mask ? { kind: 'gray' } : await colorSpace(pdf, dict.get('ColorSpace') ?? dict.get('CS') ?? null);
  if (space.kind === 'unsupported') return { ok: false, reason: `in a colour space this does not read (${space.name})` };
  if (![1, 2, 4, 8, 16].includes(bpc)) return { ok: false, reason: `at ${bpc} bits a sample` };
  const decode = pdf.resolve(dict.get('Decode') ?? dict.get('D'));
  // A stencil mask paints where a sample is 0, which is grey's black; `/Decode [1 0]` swaps both.
  const inverted = Array.isArray(decode) && decode[0] === 1 && decode[1] === 0;

  const components = space.kind === 'indexed' ? 1 : COMPONENTS[space.kind];
  const rowBytes = Math.ceil((width * components * bpc) / 8);
  if (rowBytes * height > MAX_PIXEL_BYTES) return { ok: false, reason: 'too large to decode here' };

  let colorType: 0 | 2 | 3;
  let depth = bpc;
  let palette: Uint8Array | null = null;
  if (space.kind === 'gray') {
    if (inverted) {
      if (bpc > 8) return { ok: false, reason: 'an inverted 16-bit grey' };
      colorType = 3;
      const levels = 1 << bpc;
      palette = new Uint8Array(levels * 3);
      for (let v = 0; v < levels; v++) palette.fill(255 - Math.round((v * 255) / (levels - 1)), v * 3, v * 3 + 3);
    } else colorType = 0;
  } else if (space.kind === 'rgb') {
    if (bpc < 8) return { ok: false, reason: `RGB at ${bpc} bits a sample` };
    colorType = 2;
  } else if (space.kind === 'indexed') {
    if (bpc > 8) return { ok: false, reason: 'a palette past 8 bits' };
    colorType = 3;
    const n = COMPONENTS[space.base];
    const count = Math.min(space.hival + 1, 1 << bpc, Math.floor(space.lookup.length / n));
    palette = new Uint8Array(count * 3);
    for (let k = 0; k < count; k++) {
      const s = space.lookup.subarray(k * n, k * n + n);
      const rgb = space.base === 'gray' ? [s[0]!, s[0]!, s[0]!] : space.base === 'rgb' ? [...s] : cmykToRgb(s[0]!, s[1]!, s[2]!, s[3]!);
      palette.set(rgb.map(Math.round), k * 3);
    }
  } else {
    if (bpc !== 8) return { ok: false, reason: `CMYK at ${bpc} bits a sample` };
    colorType = 2;
  }

  const predictor = parms ? pdf.resolve(parms.get('Predictor')) : null;
  const filteredAlready =
    flate &&
    typeof predictor === 'number' &&
    predictor >= 10 &&
    (pdf.resolve(parms!.get('Colors')) ?? 1) === components &&
    (pdf.resolve(parms!.get('BitsPerComponent')) ?? 8) === bpc &&
    (pdf.resolve(parms!.get('Columns')) ?? 1) === width;

  let idat: Uint8Array[];
  if (filteredAlready && space.kind !== 'cmyk') {
    idat = [data];
  } else {
    if (typeof predictor === 'number' && predictor > 1) return { ok: false, reason: `with a predictor this does not undo (${predictor})` };
    const rows = await pngRows(data, flate, rowBytes, height, space.kind === 'cmyk', width);
    if (!rows) return { ok: false, reason: 'its picture data is cut short' };
    if (space.kind === 'cmyk') depth = 8;
    idat = rows;
  }
  return { ok: true, bytes: png(width, height, depth, colorType, palette, idat), contentType: 'image/png', width, height };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC_TABLE[(c ^ p[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * A PNG from its parts, written into one buffer. The compressed data goes in as the chunks
 * it came in, each its own `IDAT` (PNG reads consecutive ones as one stream), so it is
 * copied once, into the file, and never joined first.
 */
function png(width: number, height: number, depth: number, colorType: 0 | 2 | 3, palette: Uint8Array | null, idat: Uint8Array[]): Uint8Array {
  const ihdr = new Uint8Array(13);
  const head = new DataView(ihdr.buffer);
  head.setUint32(0, width);
  head.setUint32(4, height);
  ihdr[8] = depth;
  ihdr[9] = colorType;
  const parts: Array<[string, Uint8Array]> = [['IHDR', ihdr], ...(palette ? [['PLTE', palette] as [string, Uint8Array]] : []), ...idat.map((c) => ['IDAT', c] as [string, Uint8Array]), ['IEND', new Uint8Array()]];
  const out = new Uint8Array(8 + parts.reduce((n, [, body]) => n + 12 + body.length, 0));
  const view = new DataView(out.buffer);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let at = 8;
  for (const [type, body] of parts) {
    const name = ascii(type);
    view.setUint32(at, body.length);
    out.set(name, at + 4);
    out.set(body, at + 8);
    view.setUint32(at + 8 + body.length, crc32([name, body]));
    at += 12 + body.length;
  }
  return out;
}
