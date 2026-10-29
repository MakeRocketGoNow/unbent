import { formatAttachmentMarkdown } from '@unbent/shared';
import { enmlToMarkdown } from './enml-to-markdown.js';
import { parseEnexStream } from './parse.js';
import { enexNoteHash, withSourceLink } from './note-body.js';
import {
  ImportRun,
  applyRenames,
  storedName,
  uploadFiles,
  type ImportClient,
  type ImportOptions,
  type ImportProgress,
} from './import-run.js';
import type { EnexNote } from './types.js';

/**
 * Drives an ENEX import: parse, convert, upload.
 *
 * Runs wherever it is called from (the API calls are injected) so the orchestration can
 * be tested against a fake client without a browser or a server. What is specific to
 * Evernote is here; the accounting and the uploads are `import-run.ts`, shared with the
 * importer for Unbent's own archives.
 */

export {
  FAILURE_STREAK_LIMIT,
  TRANSIENT_RETRY_LIMIT,
  ImportStoppedError,
  type ImportClient,
  type ImportFailure,
  type ImportOptions,
  type ImportProgress,
  type ImportSkip,
} from './import-run.js';
export { contentHash, enexNoteHash, withSourceLink } from './note-body.js';

export async function importEnex(
  file: { name: string; stream: () => ReadableStream<Uint8Array> },
  client: ImportClient,
  options: ImportOptions = {},
): Promise<ImportProgress> {
  const run = new ImportRun(options);
  const { progress } = run;

  const notebookTag = options.notebookTag ?? file.name.replace(/\.enex$/i, '');

  try {
    await parseEnexStream(file.stream(), {
      signal: run.halt.signal,

      onProgress: (bytes) => {
        progress.bytesRead = bytes;
      },

      onNote: (note: EnexNote) =>
        run.attempt(note.title || 'Untitled', () =>
          importOne(note, notebookTag, client, run, file.name, options),
        ),
    });
  } finally {
    run.release();
  }

  return run.finish();
}

async function importOne(
  note: EnexNote,
  notebookTag: string,
  client: ImportClient,
  run: ImportRun,
  sourceEnex: string,
  options: ImportOptions,
): Promise<void> {
  const { progress } = run;
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
    contentHash: await enexNoteHash({
      title: note.title,
      body,
      tags,
      created: note.created?.getTime(),
      updated: note.updated?.getTime(),
      attachments: note.resources.map((r) => r.md5),
    }),
    sourceEnex,
    sourceUrl: note.sourceUrl,
  });

  // Already imported: skip the note, but still fill attachments a prior run may have
  // missed. Without this, a worker crash mid-PDF leaves a permanent hole: re-import
  // sees the content hash, returns skipped, and never retries the upload.
  if (!result.created) {
    run.skipped(result.id);
    if (note.resources.length > 0 && client.listFiles) {
      const existing = new Set(await client.listFiles(result.id));
      const missing = note.resources.filter((r) => !existing.has(r.filename));
      if (missing.length > 0) {
        await uploadFiles(missing, result.id, client, progress, options);
      }
    }
    return;
  }

  run.created(result.id);
  if (note.resources.length === 0) return;

  /**
   * Upload every resource, including ones no en-media element references.
   *
   * Evernote stores attachments that were added but never embedded in the note body, and
   * dropping them would lose files the user still considers part of the note. Unreferenced
   * ones are appended as links so they remain reachable.
   */
  const renames = await uploadFiles(note.resources, result.id, client, progress, options);
  const unreferenced = note.resources
    .filter((r) => !usedMd5.has(r.md5))
    .map((r) => storedName(renames, r.filename));

  if (renames.size === 0 && unreferenced.length === 0) return;

  let finalBody = applyRenames(body, renames);
  if (unreferenced.length > 0) {
    const links = unreferenced.map((f) => `- ${formatAttachmentMarkdown(f, `files/${f}`)}`).join('\n');
    finalBody = `${finalBody}\n\n## Attachments\n\n${links}\n`.trim();
  }

  await client.updateBody?.(result.id, finalBody);
}
