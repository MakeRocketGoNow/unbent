#!/usr/bin/env node
/**
 * Generates the scanned-attachment fixtures under test/fixtures.
 *
 * The originals were real scans from an Evernote export — a pharmacy receipt and two
 * clinic statements — and their OCR layers carried a full name, a home address, a
 * prescription and a pharmacist's name. They have been withdrawn from the repository and
 * its history. These stand in for them.
 *
 * What the tests actually depend on is the *shape* of Evernote's OCR output, not the
 * documents: a scan is a page-sized image with an invisible text layer laid over it, the
 * good ones read as letter-spaced prose full of spaced-out digits, and the failed ones
 * read as a handful of isolated symbols. All of that is reproduced here with invented
 * people, places and numbers. The thresholds in `ocr-text.ts` were tuned against the
 * originals and are unchanged; these samples are built to sit on the same side of them.
 *
 * Run from the package root: `node scripts/make-scan-fixtures.mjs`. Deterministic, so
 * a re-run produces byte-identical files.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');

/** A tiny deterministic PRNG, so the "paper" texture is the same on every run. */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/**
 * A page-sized grayscale image that looks like scanned paper: an off-white ground with
 * grain, and dark bands where lines of text would be. Nothing in it is legible, which is
 * the point — the text a reader gets is the invisible layer, exactly as with a real scan.
 */
function paperImage(width, height, seed, { lines, bandHeight, noise }) {
  const rnd = lcg(seed);
  const px = Buffer.alloc(width * height);
  const bands = [];
  for (let i = 0; i < lines; i++) {
    const y = Math.floor(height * (0.08 + (0.84 * i) / lines));
    bands.push([y, y + bandHeight, 0.15 + rnd() * 0.5]);
  }
  for (let y = 0; y < height; y++) {
    const band = bands.find(([top, bottom]) => y >= top && y < bottom);
    for (let x = 0; x < width; x++) {
      let v = 236 + (rnd() - 0.5) * noise;
      if (band && x > width * 0.1 && x < width * (0.1 + band[2] + rnd() * 0.3)) {
        v = 40 + rnd() * 90;
      }
      px[y * width + x] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  return px;
}

function pdfString(s) {
  return '(' + s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)') + ')';
}

/**
 * One page: the image, then the text layer in rendering mode 3 (invisible), one line per
 * text object so extraction sees the same line structure Evernote's OCR produces.
 */
function scanPdf({ width, height, image, lines }) {
  const pageW = 612;
  const pageH = 792;
  const imageData = deflateSync(image);
  const content = [
    `q ${pageW} 0 0 ${pageH} 0 0 cm /Im0 Do Q`,
    'BT 3 Tr /F1 9 Tf',
    ...lines.map((text, i) => `1 0 0 1 36 ${pageH - 48 - i * 14} Tm ${pdfString(text)} Tj`),
    'ET',
  ].join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] ` +
      '/Resources << /Font << /F1 4 0 R >> /XObject << /Im0 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    {
      dict:
        `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
        `/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${imageData.length} >>`,
      stream: imageData,
    },
    { dict: `<< /Length ${Buffer.byteLength(content)} >>`, stream: Buffer.from(content) },
  ];

  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets = [];
  let pos = parts[0].length;
  objects.forEach((obj, i) => {
    offsets.push(pos);
    const body =
      typeof obj === 'string'
        ? Buffer.from(`${i + 1} 0 obj\n${obj}\nendobj\n`, 'latin1')
        : Buffer.concat([
            Buffer.from(`${i + 1} 0 obj\n${obj.dict}\nstream\n`, 'latin1'),
            obj.stream,
            Buffer.from('\nendstream\nendobj\n', 'latin1'),
          ]);
    parts.push(body);
    pos += body.length;
  });
  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}

/** Letter-spaces a string the way the original OCR did: `Harborview` -> `H a r b o r v i e w`. */
const spaced = (s) => s.split('').join(' ');

// --- The good scan: a pharmacy receipt with a readable OCR layer. -----------------------

const receiptLines = [
  'Northfield Pharmacy #4410 (555) 010-2233 Lindqvist, Casey M Rx# 1234567',
  '12 Example Ave Springfield 00000 Okafor, Riley',
  'Lindqvist, Casey M 12 Example Ave Apt 3 Date 11/03/19 Multivitamin Tab 11/03/19 qam',
  `${spaced('Springfield')}, For> Daily Supplement 00000-0000 Ph#(555) 010-2244 TPPaidAmt $9.30`,
  `${spaced('Okafor, Riley')} Copay $0.00`,
  'Take one tablet by mouth daily with food. Refills remaining: 2. Discard after 11/03/20.',
  'Prescriber: Dr. Sam Reyes. Questions about this prescription? Call the pharmacy.',
  'Your pharmacist has reviewed this medication with you. Keep out of reach of children.',
  `${spaced('Northfield Pharmacy')} thanks you for choosing us for your prescription needs.`,
  'Store at room temperature away from moisture and heat. Do not share this medication.',
  'Patient counseling is available at the counter or by telephone during business hours.',
  'Hours: Monday to Friday 8am to 9pm, Saturday 9am to 6pm, Sunday 10am to 5pm.',
  'Automatic refills can be arranged at the counter. Ask about our text message reminders.',
  'This receipt is your record of purchase. Retain it for insurance or flexible spending claims.',
  `${spaced('Thank you')} for your visit. Prescription ready for pickup ${spaced('11/03/19')}.`,
];

// --- The failed scan: what Evernote's OCR made of an unreadable page. -------------------

const noiseLines = ['> CO 5 I > - O - - f O 1" 2 o in in I s I'];

// --- OCR text samples, for the cleaning and quality thresholds. -------------------------

const statementLines = [
  `${spaced('Harborview')}`,
  `${spaced('HEALTH')}`,
  `Statement Date ${spaced('03/14/2019')}`,
  `Patient Services Provided ${spaced('30919277')}`,
  spaced('Date'),
  'CLINIC SERVICES',
  'Description',
  spaced('Current'),
  'CASEY MORGAN LINDQVIST',
  spaced('27311908'),
  ...Array(8).fill(spaced('02/26/2019')),
  'Office Visit Established Patient Level Three',
  'Laboratory Comprehensive Metabolic Panel',
  'Radiology Chest Two Views',
  'Pharmacy Tetanus Booster Administration',
  `Amount Due ${spaced('96.20')} Please remit payment within thirty days of the statement date`,
  'Payments received after the statement date may not be reflected on this statement',
  'Questions about your bill? Call patient financial services at (555) 010-2200',
  'Insurance claims for these services have been submitted on your behalf and adjudicated.',
  'The amounts shown reflect contractual adjustments applied by your insurance carrier.',
  `Previous balance ${spaced('0.00')} New charges ${spaced('240.00')} Payments ${spaced('143.80')}`,
  'Please make checks payable to Harborview Health and include your account number.',
];

const summaryLines = [
  spaced('Harborview'),
  'PO Box 880',
  `Springfield 00000-0880 ${spaced('HARBORVIEW')}`,
  spaced('This is a Summarized Account Statement'),
  'Important Messages',
  'Thank you for choosing Harborview for your healthcare',
  'needs. This is a summarized statement of your',
  'account that includes the following people:',
  spaced('118204-003-001-002961-000000'),
  spaced('CASEY'),
  spaced('12 Example Ave'),
  spaced('Springfield 00000'),
  'Visit Date Provider Department Charges Insurance Paid Patient Balance',
  '02/26/2019 Reyes, Sam Family Medicine 240.00 143.80 96.20',
  'Your insurance has processed these claims. The balance shown is your responsibility.',
  'Payment options: online at the patient portal, by telephone, or by mail with the stub below.',
  'If you have questions about a charge, please contact the department listed for that visit.',
  'Financial assistance may be available. Ask patient financial services for an application.',
  'Please detach and return the portion below with your payment. Thank you.',
  'Account Number 27311908 Statement Date 03/14/2019 Amount Due 96.20 Amount Enclosed',
];

const samples = [
  { file: 'p2.pdf', sample: noiseLines.join('\n') },
  { file: 'p1.pdf', sample: statementLines.join('\n') },
  { file: 'p0.pdf', sample: summaryLines.join('\n') },
  { file: 'p12.pdf', sample: receiptLines.join('\n') },
].map((s) => ({ file: s.file, len: s.sample.length, sample: s.sample }));

// --- Write everything. ------------------------------------------------------------------

const good = scanPdf({
  width: 850,
  height: 1100,
  image: paperImage(850, 1100, 1, { lines: 34, bandHeight: 14, noise: 18 }),
  lines: receiptLines,
});
const poor = scanPdf({
  width: 850,
  height: 1100,
  image: paperImage(850, 1100, 2, { lines: 6, bandHeight: 60, noise: 90 }),
  lines: noiseLines,
});

writeFileSync(join(OUT, 'scan-good.pdf'), good);
writeFileSync(join(OUT, 'scan-good.b64.txt'), good.toString('base64') + '\n');
writeFileSync(join(OUT, 'scan-poor.pdf'), poor);
writeFileSync(join(OUT, 'ocr-samples.json'), JSON.stringify(samples, null, 2) + '\n');

console.log(
  `wrote scan-good.pdf (${good.length} bytes), scan-poor.pdf (${poor.length} bytes), ` +
    `scan-good.b64.txt, ocr-samples.json (${samples.map((s) => s.len).join('/')} chars)`,
);
