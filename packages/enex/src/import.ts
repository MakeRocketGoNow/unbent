import { enmlToMarkdown } from './enml-to-markdown.js';
import { parseEnexStream } from './parse.js';
import { extractPdfText, isExtractable } from './pdf-text.js';
import type { EnexNote } from './types.js';

/**
 * Drives an ENEX import: parse, convert, upload.
 *
 * Runs wherever it is called from — the API calls are injected — so the orchestration can
 * be tested against a fake client without a browser or a server.
 */

export interface ImportProgress {
  /** Notes handed to the server so far, including ones skipped as already-imported. */
  processed: number;
  created: number;
  skipped: number;
  failed: number;
  filesUploaded: number;
  /** Attachments whose embedded text was extracted and indexed. */
  filesIndexed: number;
  bytesRead: number;
  currentTitle: string;
}

export interface ImportFailure {
  title: string;
  reason: string;
}

export interface ImportClient {
  createNote: (input: {
    title: string;
    body: string;
    tags: string[];
    notebook?: string;
    createdAt: number;
    updatedAt: number;
    contentHash: string;
    sourceEnex?: string;
    sourceUrl?: string;
  }) => Promise<{ id: string; created: boolean }>;

  uploadFile: (
    noteId: string,
    filename: string,
    mime: string,
    bytes: Uint8Array,
  ) => Promise<{ filename: string }>;

  /** Rewrites the body once real attachment filenames are known. */
  updateBody?: (noteId: string, body: string) => Promise<void>;

  /** Stores text extracted from an attachment so search can reach it. */
  saveFileText?: (noteId: string, filename: string, text: string) => Promise<void>;
}

export interface ImportOptions {
  /** Applied to every note as the notebook column, not a tag. */
  notebookTag?: string;
  /**
   * Pull the text layer out of PDFs so scanned notes are searchable.
   *
   * Most notes in a real export are a scan with an empty body; without this they arrive
   * as title-only stubs. Costs roughly a second per PDF.
   */
  extractText?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: ImportProgress) => void;
  onFailure?: (failure: ImportFailure) => void;
}

/** sha256 of title and body — the server's idempotency key. */
export async function contentHash(title: string, body: string): Promise<string> {
  const data = new TextEncoder().encode(`${title}\n${body}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Prepends the source URL to a bookmark note's body.
 *
 * Kept in frontmatter by the server, but for a Pocket or Raindrop note the URL is the
 * substance of the note, so it also belongs where it can be clicked.
 */
function withSourceLink(body: string, sourceUrl?: string): string {
  if (!sourceUrl) return body;
  if (body.includes(sourceUrl)) return body; // clipper often already included it
  return `<${sourceUrl}>\n\n${body}`.trim();
}

export async function importEnex(
  file: { name: string; stream: () => ReadableStream<Uint8Array> },
  client: ImportClient,
  options: ImportOptions = {},
): Promise<ImportProgress> {
  const progress: ImportProgress = {
    processed: 0,
    created: 0,
    skipped: 0,
    failed: 0,
    filesUploaded: 0,
    filesIndexed: 0,
    bytesRead: 0,
    currentTitle: '',
  };

  const notebookTag = options.notebookTag ?? file.name.replace(/\.enex$/i, '');

  await parseEnexStream(file.stream(), {
    onProgress: (bytes) => {
      progress.bytesRead = bytes;
    },

    onNote: async (note: EnexNote) => {
      // A cancelled import is not a failed one: skip quietly rather than filling the
      // failure log with thousands of "aborted" entries the user cannot act on.
      if (options.signal?.aborted) return;

      progress.currentTitle = note.title || 'Untitled';

      try {
        await importOne(note, notebookTag, client, progress, file.name, options);
      } catch (err) {
        if (options.signal?.aborted) return;
        progress.failed += 1;
        options.onFailure?.({
          title: note.title || 'Untitled',
          reason: (err as Error).message,
        });
      }

      progress.processed += 1;
      options.onProgress?.({ ...progress });
    },
  });

  return progress;
}

async function importOne(
  note: EnexNote,
  notebookTag: string,
  client: ImportClient,
  progress: ImportProgress,
  sourceEnex: string,
  options: ImportOptions,
): Promise<void> {
  const { markdown, usedMd5 } = enmlToMarkdown(note.enml, note.resources);
  const body = withSourceLink(markdown, note.sourceUrl);

  const tags = [...new Set(note.tags.filter((t) => t.trim().length > 0))];
  const created = note.created?.getTime() ?? Date.now();

  const result = await client.createNote({
    title: note.title || 'Untitled',
    body,
    tags,
    notebook: notebookTag || undefined,
    createdAt: created,
    updatedAt: note.updated?.getTime() ?? created,
    contentHash: await contentHash(note.title, body),
    sourceEnex,
    sourceUrl: note.sourceUrl,
  });

  // Already imported: skip the attachments too, which is the expensive half of a resumed
  // run. This is what makes re-running a 3GB import cheap rather than a full repeat.
  if (!result.created) {
    progress.skipped += 1;
    return;
  }

  progress.created += 1;
  if (note.resources.length === 0) return;

  /**
   * Upload every resource, including ones no en-media element references.
   *
   * Evernote stores attachments that were added but never embedded in the note body, and
   * dropping them would lose files the user still considers part of the note. Unreferenced
   * ones are appended as links so they remain reachable.
   */
  const renames = new Map<string, string>();
  const unreferenced: string[] = [];

  for (const resource of note.resources) {
    const uploaded = await client.uploadFile(
      result.id,
      resource.filename,
      resource.mime,
      resource.bytes,
    );
    progress.filesUploaded += 1;

    // The server suffixes collisions, so the stored name may differ from the requested one.
    if (uploaded.filename !== resource.filename) {
      renames.set(resource.filename, uploaded.filename);
    }
    if (!usedMd5.has(resource.md5)) unreferenced.push(uploaded.filename);

    /**
     * Index the text already embedded in the file.
     *
     * Evernote OCR'd scanned attachments and left the layer in place, so this is
     * extraction rather than OCR. Roughly a fifth of real scans yield noise instead of
     * language; those are dropped rather than indexed, so a failed scan does not pollute
     * search with character soup.
     */
    if (options.extractText && client.saveFileText && isExtractable(resource.mime)) {
      const extracted = await extractPdfText(resource.bytes);
      if (extracted.quality.usable) {
        await client.saveFileText(result.id, uploaded.filename, extracted.text);
        progress.filesIndexed += 1;
      }
    }
  }

  if (renames.size === 0 && unreferenced.length === 0) return;

  let finalBody = body;
  for (const [from, to] of renames) {
    finalBody = finalBody.split(`files/${from}`).join(`files/${to}`);
  }
  if (unreferenced.length > 0) {
    const links = unreferenced.map((f) => `- [${f}](files/${f})`).join('\n');
    finalBody = `${finalBody}\n\n## Attachments\n\n${links}\n`.trim();
  }

  await client.updateBody?.(result.id, finalBody);
}
