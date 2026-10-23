/**
 * Builds Joplin exports for the tests, the way Joplin builds them.
 *
 * Items are serialised as `BaseItem.serialize` in Joplin's source writes them: the title,
 * a blank line, the body when there is one, a blank line, then every field of the item's
 * table in column order, `type_` last, with newlines in a value escaped as `\n` and times
 * as ISO 8601 in UTC. The tar is plain ustar with a checksum, which is what node-tar in
 * portable mode (Joplin's `tarCreate`) writes. Nothing here is from a real export: the
 * notes, names and numbers are invented.
 */

const NOTE_FIELDS = [
  'id', 'parent_id', 'created_time', 'updated_time', 'is_conflict', 'latitude', 'longitude',
  'altitude', 'author', 'source_url', 'is_todo', 'todo_due', 'todo_completed', 'source',
  'source_application', 'application_data', 'order', 'user_created_time', 'user_updated_time',
  'encryption_cipher_text', 'encryption_applied', 'markup_language', 'is_shared', 'share_id',
  'conflict_original_id', 'master_key_id', 'user_data', 'deleted_time',
];
const FOLDER_FIELDS = [
  'id', 'created_time', 'updated_time', 'user_created_time', 'user_updated_time',
  'encryption_cipher_text', 'encryption_applied', 'parent_id', 'is_shared', 'share_id',
  'master_key_id', 'icon', 'user_data', 'deleted_time',
];
const RESOURCE_FIELDS = [
  'id', 'mime', 'filename', 'created_time', 'updated_time', 'user_created_time',
  'user_updated_time', 'file_extension', 'encryption_cipher_text', 'encryption_applied',
  'encryption_blob_encrypted', 'size', 'is_shared', 'share_id', 'master_key_id', 'user_data',
  'blob_updated_time', 'ocr_text', 'ocr_details', 'ocr_status', 'ocr_error',
];
const TAG_FIELDS = [
  'id', 'created_time', 'updated_time', 'user_created_time', 'user_updated_time',
  'encryption_cipher_text', 'encryption_applied', 'is_shared', 'parent_id', 'user_data',
];
const NOTE_TAG_FIELDS = [
  'id', 'note_id', 'tag_id', 'created_time', 'updated_time', 'user_created_time',
  'user_updated_time', 'encryption_cipher_text', 'encryption_applied', 'is_shared',
];

const TIME_FIELDS = new Set(['created_time', 'updated_time', 'user_created_time', 'user_updated_time', 'sync_time']);

/** Defaults Joplin writes for a field nobody set. */
const DEFAULTS: Record<string, string> = {
  is_conflict: '0', latitude: '0.00000000', longitude: '0.00000000', altitude: '0.0000',
  is_todo: '0', todo_due: '0', todo_completed: '0', order: '0', encryption_applied: '0',
  markup_language: '1', is_shared: '0', deleted_time: '0', encryption_blob_encrypted: '0',
  ocr_status: '0', blob_updated_time: '0', size: '0',
};

function format(key: string, value: string | number | undefined): string {
  if (TIME_FIELDS.has(key)) return value ? new Date(value).toISOString() : '';
  const text = value === undefined ? DEFAULTS[key] ?? '' : String(value);
  return text.replace(/\\n/g, '\\\\n').replace(/\\r/g, '\\\\r').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

function serialize(type: number, fields: string[], item: Record<string, string | number | undefined>, title?: string, body?: string): string {
  const props = [...fields.map((k) => `${k}: ${format(k, item[k])}`), `type_: ${type}`].join('\n');
  const parts: string[] = [];
  if (title !== undefined) parts.push(title);
  if (body) parts.push(body);
  parts.push(props);
  return parts.join('\n\n');
}

export interface JexNote {
  id: string;
  title: string;
  body: string;
  parent: string;
  created?: number;
  updated?: number;
  /** The sync times, which differ from what Joplin shows; set to check the user's are preferred. */
  syncCreated?: number;
  syncUpdated?: number;
  sourceUrl?: string;
  html?: boolean;
  deleted?: number;
  encrypted?: boolean;
}

export interface JexResource {
  id: string;
  title: string;
  mime: string;
  ext: string;
  /** Omit to leave the record in the export without its bytes. */
  bytes?: Uint8Array;
  /** The bytes are still Joplin's ciphertext: `encryption_blob_encrypted: 1`. */
  blobEncrypted?: boolean;
}

export interface JexContent {
  folders: Array<{ id: string; title: string; parent?: string; deleted?: number }>;
  notes: JexNote[];
  tags?: Array<{ id: string; title: string }>;
  noteTags?: Array<{ id: string; note: string; tag: string }>;
  resources?: JexResource[];
}

const T0 = Date.UTC(2026, 0, 2, 3, 4, 5, 678);

/** Every file the export holds, by its path in the tar. */
export function jexFiles(content: JexContent): Array<[string, Uint8Array]> {
  const enc = new TextEncoder();
  const files: Array<[string, Uint8Array]> = [];
  const add = (path: string, text: string) => files.push([path, enc.encode(text)]);

  for (const f of content.folders) {
    add(`${f.id}.md`, serialize(2, FOLDER_FIELDS, {
      id: f.id, created_time: T0, updated_time: T0, user_created_time: T0, user_updated_time: T0,
      parent_id: f.parent ?? '', deleted_time: f.deleted ?? 0,
    }, f.title));
  }
  for (const n of content.notes) {
    add(`${n.id}.md`, serialize(1, NOTE_FIELDS, {
      id: n.id, parent_id: n.parent,
      created_time: n.syncCreated ?? n.created ?? T0, updated_time: n.syncUpdated ?? n.updated ?? T0,
      user_created_time: n.created ?? T0, user_updated_time: n.updated ?? T0,
      source_url: n.sourceUrl ?? '', source: 'joplin-desktop', source_application: 'net.cozic.joplin-desktop',
      markup_language: n.html ? 2 : 1, deleted_time: n.deleted ?? 0,
      encryption_applied: n.encrypted ? 1 : 0, encryption_cipher_text: n.encrypted ? 'JED01000022...' : '',
    }, n.encrypted ? '' : n.title, n.encrypted ? '' : n.body));
  }
  for (const t of content.tags ?? []) {
    add(`${t.id}.md`, serialize(5, TAG_FIELDS, { id: t.id, created_time: T0, updated_time: T0, user_created_time: T0, user_updated_time: T0 }, t.title));
  }
  for (const nt of content.noteTags ?? []) {
    add(`${nt.id}.md`, serialize(6, NOTE_TAG_FIELDS, {
      id: nt.id, note_id: nt.note, tag_id: nt.tag, created_time: T0, updated_time: T0, user_created_time: T0, user_updated_time: T0,
    }));
  }
  for (const r of content.resources ?? []) {
    add(`${r.id}.md`, serialize(4, RESOURCE_FIELDS, {
      id: r.id, mime: r.mime, filename: '', created_time: T0, updated_time: T0, user_created_time: T0,
      user_updated_time: T0, file_extension: r.ext, size: r.bytes?.length ?? 0, blob_updated_time: T0,
      encryption_blob_encrypted: r.blobEncrypted ? 1 : 0,
    }, r.title));
    if (r.bytes) files.push([`resources/${r.id}${r.ext ? `.${r.ext}` : ''}`, r.bytes]);
  }
  return files;
}

function octal(n: number, width: number): string {
  return `${n.toString(8).padStart(width - 1, '0')}\0`;
}

/** A ustar archive of the files, as node-tar writes one. */
export function tar(files: Array<[string, Uint8Array]>): Uint8Array {
  const chunks: Uint8Array[] = [];
  const enc = new TextEncoder();
  for (const [name, data] of files) {
    const header = new Uint8Array(512);
    header.set(enc.encode(name).subarray(0, 100), 0);
    header.set(enc.encode(octal(0o644, 8)), 100);
    header.set(enc.encode(octal(0, 8)), 108);
    header.set(enc.encode(octal(0, 8)), 116);
    header.set(enc.encode(octal(data.length, 12)), 124);
    header.set(enc.encode(octal(Math.floor(T0 / 1000), 12)), 136);
    header.fill(0x20, 148, 156);
    header[156] = 0x30;
    header.set(enc.encode('ustar\u000000'), 257);
    let sum = 0;
    for (const b of header) sum += b;
    header.set(enc.encode(`${sum.toString(8).padStart(6, '0')}\0 `), 148);
    chunks.push(header, data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  chunks.push(new Uint8Array(1024));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export function jex(content: JexContent): Blob {
  return new Blob([tar(jexFiles(content)) as BlobPart]);
}

/** Ids for the sample, as Joplin mints them: v4 UUIDs without their dashes. */
export const ID = {
  household: 'a1a1a1a1a1a14a1a8a1a1a1a1a1a1a01',
  receipts: 'a1a1a1a1a1a14a1a8a1a1a1a1a1a1a02',
  kitchen: 'a1a1a1a1a1a14a1a8a1a1a1a1a1a1a03',
  trashedFolder: 'a1a1a1a1a1a14a1a8a1a1a1a1a1a1a04',
  kettle: 'b2b2b2b2b2b24b2b8b2b2b2b2b2b2b01',
  soup: 'b2b2b2b2b2b24b2b8b2b2b2b2b2b2b02',
  clip: 'b2b2b2b2b2b24b2b8b2b2b2b2b2b2b03',
  trashed: 'b2b2b2b2b2b24b2b8b2b2b2b2b2b2b04',
  locked: 'b2b2b2b2b2b24b2b8b2b2b2b2b2b2b05',
  loose: 'b2b2b2b2b2b24b2b8b2b2b2b2b2b2b06',
  receiptPdf: 'c3c3c3c3c3c34c3c8c3c3c3c3c3c3c01',
  photo: 'c3c3c3c3c3c34c3c8c3c3c3c3c3c3c02',
  photoAgain: 'c3c3c3c3c3c34c3c8c3c3c3c3c3c3c03',
  missing: 'c3c3c3c3c3c34c3c8c3c3c3c3c3c3c04',
  pasted: 'c3c3c3c3c3c34c3c8c3c3c3c3c3c3c05',
  tagTax: 'd4d4d4d4d4d44d4d8d4d4d4d4d4d4d01',
  tagWarranty: 'd4d4d4d4d4d44d4d8d4d4d4d4d4d4d02',
  nt1: 'e5e5e5e5e5e54e5e8e5e5e5e5e5e5e01',
  nt2: 'e5e5e5e5e5e54e5e8e5e5e5e5e5e5e02',
  nt3: 'e5e5e5e5e5e54e5e8e5e5e5e5e5e5e03',
} as const;

export const KETTLE_CREATED = Date.UTC(2025, 4, 6, 7, 8, 9, 123);
export const KETTLE_UPDATED = Date.UTC(2025, 5, 7, 8, 9, 10, 456);

/** A real one-pixel PNG, so the pictures draw when the sample is imported in a browser. */
export const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

/**
 * A small library with every case the importer handles: a nested notebook, tags, a PDF
 * receipt, two pictures of one name, a resized picture, a link between notes, a web clip
 * in HTML, an attachment whose bytes are missing, and a note each in the trash and still
 * encrypted. `pdf` is the receipt's bytes, so a test can pass a PDF with a text layer.
 */
export function sampleJex(pdf: Uint8Array): JexContent {
  return {
    folders: [
      { id: ID.household, title: 'Household' },
      { id: ID.receipts, title: 'Receipts', parent: ID.household },
      { id: ID.kitchen, title: 'Kitchen' },
      { id: ID.trashedFolder, title: 'Old stuff', deleted: Date.UTC(2026, 1, 1) },
    ],
    notes: [
      {
        id: ID.kettle,
        title: 'Kettle receipt',
        parent: ID.receipts,
        created: KETTLE_CREATED,
        updated: KETTLE_UPDATED,
        syncCreated: Date.UTC(2026, 9, 1),
        syncUpdated: Date.UTC(2026, 9, 2),
        body: [
          'Bought at Acme Appliances. Two-year warranty.',
          '',
          `[Kettle receipt.pdf](:/${ID.receiptPdf})`,
          '',
          `![kettle.png](:/${ID.photo}) and the box: ![kettle.png](:/${ID.photoAgain})`,
          '',
          `<img src=":/${ID.pasted}" alt="label" width="240"/>`,
          '',
          `Lost: [manual.pdf](:/${ID.missing})`,
          '',
          `Recipe it boils water for: [Tomato soup](:/${ID.soup}#method)`,
        ].join('\n'),
      },
      {
        id: ID.soup,
        title: 'Tomato soup',
        parent: ID.kitchen,
        created: Date.UTC(2024, 10, 11, 12, 0, 0),
        updated: Date.UTC(2024, 10, 12, 12, 0, 0),
        body: '# Method\n\nSimmer for 20 minutes.\n\nkey: not a property, because a blank line follows\n',
      },
      {
        id: ID.clip,
        title: 'Example article',
        parent: ID.kitchen,
        html: true,
        sourceUrl: 'https://example.com/articles/soup',
        body: '<h2>Soup basics</h2><p>Start with <strong>stock</strong>.</p>',
      },
      { id: ID.trashed, title: 'Thrown away', parent: ID.kitchen, body: 'Gone.', deleted: Date.UTC(2026, 2, 3) },
      { id: ID.locked, title: '', parent: ID.kitchen, body: '', encrypted: true },
      { id: ID.loose, title: 'No notebook', parent: 'f6f6f6f6f6f64f6f8f6f6f6f6f6f6f01', body: 'Exported on its own.' },
    ],
    tags: [
      { id: ID.tagTax, title: 'tax' },
      { id: ID.tagWarranty, title: 'warranty' },
    ],
    noteTags: [
      { id: ID.nt1, note: ID.kettle, tag: ID.tagTax },
      { id: ID.nt2, note: ID.kettle, tag: ID.tagWarranty },
      { id: ID.nt3, note: ID.soup, tag: ID.tagTax },
    ],
    resources: [
      { id: ID.receiptPdf, title: 'Kettle receipt.pdf', mime: 'application/pdf', ext: 'pdf', bytes: pdf },
      { id: ID.photo, title: 'kettle.png', mime: 'image/png', ext: 'png', bytes: PNG },
      { id: ID.photoAgain, title: 'kettle.png', mime: 'image/png', ext: 'png', bytes: PNG },
      { id: ID.pasted, title: '', mime: 'application/octet-stream', ext: 'png', bytes: PNG },
      { id: ID.missing, title: 'manual.pdf', mime: 'application/pdf', ext: 'pdf' },
    ],
  };
}
