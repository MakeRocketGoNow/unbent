/**
 * The seed's attachments, drawn in code rather than checked in as binaries.
 *
 * A seeded receipt needs a file that opens, renders a thumbnail, and says the same thing
 * its stored text does, so that search-in-files finds what the viewer shows. Fixture PDFs
 * checked in beside this would do that once and then drift from the text in `notes.mjs`
 * the first time either changed; generating both from one list of lines keeps them the
 * same thing. They are also reviewable: nobody can tell what a checked-in scan contains
 * without opening it, and this repository is public.
 *
 * `packages/enex/scripts/make-scan-fixtures.mjs` draws PDFs too, of a different kind: a
 * page-sized image under an invisible OCR layer, which is what the OCR heuristics are
 * tested against and runs to tens of kilobytes a file. A seeded receipt needs none of that
 * — plain text a reader can select is what search and the viewer exercise — so these are
 * a few hundred bytes each, and the two generators stay separate.
 *
 * Portable on purpose — no `node:` imports. `CompressionStream` and `TextEncoder` are
 * globals in Node 22 and in every browser this app supports, so the loader can run in a
 * page later as well as from `pnpm seed:demo`.
 */

const encoder = new TextEncoder();

/**
 * A PDF of one or more pages of plain lines, the first line of the first page larger.
 *
 * Helvetica is one of the fourteen fonts every PDF reader carries, so nothing is embedded
 * and the file stays a few hundred bytes. That font's encoding covers ASCII and not much
 * else predictably, so anything outside printable ASCII is refused rather than drawn as
 * the wrong glyph — the seed's text is ours to keep plain.
 *
 * Offsets in the cross-reference table are byte offsets, which is why the text is held to
 * ASCII here too: one character is then one byte, and `length` is the offset.
 */
export function makePdf(pages) {
  for (const line of pages.flat()) {
    if (!/^[\x20-\x7e]*$/.test(line)) throw new Error(`PDF text must be printable ASCII: ${line}`);
  }
  const escape = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length;
  };

  const catalog = add(null);
  const pagesObj = add(null);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = [];
  pages.forEach((lines, i) => {
    const ops = ['BT', '72 720 Td'];
    lines.forEach((line, j) => {
      if (i === 0 && j === 0) {
        ops.push('/F1 18 Tf', `(${escape(line)}) Tj`, '/F1 11 Tf', '0 -30 Td', '16 TL');
      } else {
        if (j === 0) ops.push('/F1 11 Tf', '16 TL');
        ops.push(`(${escape(line)}) Tj`, 'T*');
      }
    });
    ops.push('ET');
    const content = ops.join('\n');
    const stream = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] ` +
          `/Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${stream} 0 R >>`,
      ),
    );
  });
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] =
    `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;

  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) out += `${String(at).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return encoder.encode(out);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(encoder.encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function deflate(bytes) {
  // `deflate` is the zlib-wrapped format, which is exactly what a PNG's IDAT holds.
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * A PNG that reads as a photographed slip of paper: an off-white page on a darker ground,
 * with grey bars where lines of print would be, one bar per line of the stored text.
 *
 * It carries no legible text, and does not need to — the note stores the text beside it,
 * the way a photo's text arrives from the vision reader — but its shape is what a phone
 * capture of a receipt looks like in a thumbnail, which is what the list and the panel
 * need to show something real.
 */
export async function makeReceiptPng(lineCount, { width = 240, height = 360 } = {}) {
  const ground = [74, 84, 92];
  const paper = [246, 243, 236];
  const ink = [150, 150, 150];
  const margin = 24;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = new Uint8Array(1 + width * 3); // filter byte 0: none
    for (let x = 0; x < width; x++) {
      let px = ground;
      const onPaper = x >= margin && x < width - margin && y >= margin && y < height - margin;
      if (onPaper) {
        px = paper;
        const line = Math.floor((y - margin - 20) / 18);
        const inBar = (y - margin - 20) % 18 < 7 && line >= 0 && line < lineCount;
        // Ragged right edge, so the bars read as text rather than a table.
        const barEnd = width - margin - 16 - ((line * 37) % 60);
        if (inBar && x >= margin + 14 && x < barEnd) px = ink;
      }
      row.set(px, 1 + x * 3);
    }
    rows.push(row);
  }
  const raw = new Uint8Array(rows.length * rows[0].length);
  rows.forEach((r, i) => raw.set(r, i * r.length));

  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit, truecolour, deflate, adaptive filter, no interlace

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', await deflate(raw)),
    chunk('IEND', new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
