/**
 * A reader for the tar files Joplin writes as `.jex`, over a `Blob`.
 *
 * Joplin builds its export with node-tar in portable mode: plain ustar, uncompressed,
 * a 512-byte header before each file and the file padded to the next 512. That is all
 * this reads. pax and GNU long-name headers are honoured as well, so a JEX someone
 * unpacked and packed again with another tool still reads; anything else that is not a
 * regular file (a directory, a link) is passed over.
 *
 * No library: the format is a page of code, and the two on npm that read tar both want a
 * Node stream, which a Web Worker does not have. This one never holds more than one
 * window of the file in memory. Headers are read through that window, so the many small
 * items of a JEX (every note, tag and notebook is its own file) cost one read per
 * megabyte rather than one per item, and a large attachment is jumped over without being
 * read at all until it is uploaded.
 */

export interface TarEntry {
  /** The path inside the archive, `/`-separated, with no leading `./`. */
  name: string;
  /** Where the file's bytes start in the archive. */
  offset: number;
  size: number;
}

const BLOCK = 512;
const WINDOW = 1 << 20;

/** Reads byte ranges of a blob through one cached window. */
export class BlobWindow {
  private start = 0;
  private bytes = new Uint8Array(0);

  constructor(readonly blob: Blob) {}

  async read(offset: number, length: number): Promise<Uint8Array> {
    const end = offset + length;
    if (offset < this.start || end > this.start + this.bytes.length) {
      // Anything bigger than the window is read on its own and not kept: holding a 50 MB
      // scan as the window would keep it in memory for the rest of the walk.
      if (length > WINDOW) {
        return new Uint8Array(await this.blob.slice(offset, end).arrayBuffer());
      }
      this.start = offset;
      this.bytes = new Uint8Array(await this.blob.slice(offset, offset + WINDOW).arrayBuffer());
    }
    return this.bytes.subarray(offset - this.start, end - this.start);
  }

  async text(entry: TarEntry): Promise<string> {
    return new TextDecoder().decode(await this.read(entry.offset, entry.size));
  }

  /** A copy, since the window's bytes are reused by the next read. */
  async bytesOf(entry: TarEntry): Promise<Uint8Array> {
    return (await this.read(entry.offset, entry.size)).slice();
  }
}

/** A NUL-terminated header field. */
function field(header: Uint8Array, start: number, length: number): string {
  const raw = header.subarray(start, start + length);
  const nul = raw.indexOf(0);
  return new TextDecoder().decode(nul < 0 ? raw : raw.subarray(0, nul));
}

/** A size field: octal, or GNU's base-256 when its top bit is set. */
function size(header: Uint8Array): number {
  if (header[124]! & 0x80) {
    let n = 0;
    for (let i = 125; i < 136; i += 1) n = n * 256 + header[i]!;
    return n;
  }
  const text = field(header, 124, 12).trim();
  return text === '' ? 0 : parseInt(text, 8);
}

/** The `path=` record of a pax header, if it has one. */
function paxPath(records: string): string | undefined {
  // Each record is `<length> <key>=<value>\n`; the length counts the whole record.
  let i = 0;
  while (i < records.length) {
    const space = records.indexOf(' ', i);
    if (space < 0) break;
    const length = parseInt(records.slice(i, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = records.slice(space + 1, i + length - 1);
    const eq = record.indexOf('=');
    if (record.slice(0, eq) === 'path') return record.slice(eq + 1);
    i += length;
  }
  return undefined;
}

/** Whether a block is a valid header: the checksum matches the sum of its bytes. */
function checksumOk(header: Uint8Array): boolean {
  const stored = parseInt(field(header, 148, 8).trim(), 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
  return stored === sum;
}

/**
 * Every regular file in the archive, in order.
 *
 * Throws when the first block is not a tar header, which is what a file renamed to
 * `.jex` that is not one looks like, so the run says so rather than importing nothing.
 * Stops where it is when `signal` aborts: on an archive of small scans the walk reads
 * most of the file, and Stop has to reach it.
 */
export async function listTar(window: BlobWindow, signal?: AbortSignal): Promise<TarEntry[]> {
  const entries: TarEntry[] = [];
  const total = window.blob.size;
  let pos = 0;
  let longName: string | undefined;

  while (pos + BLOCK <= total && !signal?.aborted) {
    const header = await window.read(pos, BLOCK);
    // Two zero blocks end the archive; one is enough to know nothing follows.
    if (header.every((b) => b === 0)) break;
    if (!checksumOk(header)) {
      if (pos === 0) throw new Error('This is not a Joplin export: the file is not a tar archive.');
      throw new Error(`The export is damaged at byte ${pos.toLocaleString()}.`);
    }

    const length = size(header);
    const type = String.fromCharCode(header[156] || 0x30);
    const dataAt = pos + BLOCK;
    // An entry whose bytes run past the end is a copy cut short. `blob.slice` would hand
    // back what is there without a word, and that would be uploaded as the whole file; a
    // later import of the complete export would then find the name stored and skip it,
    // so the broken copy would stay. Refusing the archive is the only safe answer. Joplin
    // writes `resources/` after the items, so the entry cut is almost always a file.
    if (dataAt + length > total) {
      throw new Error('The export is cut short: the file ends partway through it. Copy the .jex again and import it.');
    }
    pos = dataAt + Math.ceil(length / BLOCK) * BLOCK;

    if (type === 'x' || type === 'L') {
      const data = new TextDecoder().decode(await window.read(dataAt, length));
      longName = type === 'L' ? data.replace(/\0+$/, '') : paxPath(data) ?? longName;
      continue;
    }
    if (type === 'g') continue;

    const prefix = field(header, 345, 155);
    const name = longName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    longName = undefined;
    // '0' and the old NUL are regular files; '7' is a contiguous file, read the same.
    if (type !== '0' && type !== '7') continue;

    entries.push({ name: name.replace(/\\/g, '/').replace(/^(\.\/)+/, ''), offset: dataAt, size: length });
  }

  return entries;
}
