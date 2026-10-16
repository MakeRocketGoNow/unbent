import {
  attachmentFilenamesInMarkdown,
  formatAttachmentMarkdown,
  type AttachmentInfo,
} from '@unbent/shared';
import type { AttachmentsRepo } from './attachments-repo.js';
import type { NotesRepo } from './notes-repo.js';
import { assertRoom, StorageFull } from './quota.js';

/** One file after a copy: what it was asked for as, and what it is called now. */
export interface CopiedAttachment extends AttachmentInfo {
  /** The name in the source note, as requested. */
  from: string;
  /** The relative markdown path in the destination, `files/<filename>`. */
  path: string;
  /** Whether the source file was deleted afterwards. Only ever true for a move. */
  moved: boolean;
}

export interface CopyAttachmentsResult {
  files: CopiedAttachment[];
  /** Requested names that the source note has no file for. */
  missing: string[];
}

/**
 * Copies files from one of the user's notes into another, as new rows and new objects.
 *
 * A copy, never a shared blob. The R2 key embeds the note id, the trash purge deletes a
 * note's keys without asking who else holds them, and the Attachments panel deletes by
 * `(note, filename)`: every one of those assumes a file belongs to exactly one note, and
 * the cheaper design of pointing two rows at one object would have to teach all of them
 * about refcounts. An R2 copy is one request and costs nothing per byte, so the invariant
 * is worth far more than the storage it spends.
 *
 * The bytes stream from one object to the other rather than through memory: a note's
 * files can be a hundred megabytes each, and the Worker has 128MB in total.
 *
 * `move` removes the source's row afterwards (its object stays in R2 under the store's
 * tombstone for thirty-five days, like any deleted file) but only when the source body
 * no longer links the file. A cut in the editor is the usual way here, and the cut's save may still be in
 * flight when the paste arrives; taking a file the source still shows would break that
 * note, so the move quietly becomes a copy and says so in `moved`. The same rule keeps a
 * file linked twice in the source: moving one occurrence is not moving the file.
 */
export async function copyAttachments(
  blobs: R2Bucket,
  repos: { attachments: AttachmentsRepo; notes: NotesRepo },
  input: {
    from: string;
    to: string;
    filenames: string[];
    move?: boolean;
    link?: boolean;
    /**
     * Keep the source's names, and skip a name the destination already holds rather
     * than suffixing a second copy. For a duplicate: the copy is meant to be the source,
     * and a replay of the request that is still running in the first (the usual reason
     * a client replays is a timeout on a note with large files) would otherwise have
     * both copy the same file, one of them as `scan-2.pdf`. The decision is the store's,
     * made when the row is recorded, so two requests cannot both pass it; the loser
     * deletes the object it had already written.
     */
    skipExisting?: boolean;
    /**
     * The plan's storage in bytes, or null for no limit (lib/quota.ts). A copy adds its
     * files' bytes to the account and is checked before the first one moves, on the
     * sizes the rows hold; a move adds nothing and is not.
     */
    quota: number | null;
  },
): Promise<CopyAttachmentsResult> {
  const { attachments } = repos;
  const files: CopiedAttachment[] = [];
  const missing: string[] = [];

  if (!input.move) {
    const wanted = new Set(input.filenames);
    const adding = (await attachments.listForNote(input.from)).filter((f) => wanted.has(f.filename)).reduce((n, f) => n + f.size, 0);
    await assertRoom(attachments, input.quota, adding);
  }

  // Read once, after the copies: the body that matters is the one stored when the
  // deletion is decided, not one read before the loop started.
  let stillLinked: Set<string> | null = null;
  const sourceStillLinks = async (filename: string) => {
    if (!stillLinked) {
      const source = await repos.notes.get(input.from);
      stillLinked = attachmentFilenamesInMarkdown(source?.body ?? '');
    }
    return stillLinked.has(filename);
  };

  for (const requested of [...new Set(input.filenames)]) {
    const source = await attachments.resolve(input.from, requested);
    if (!source) {
      missing.push(requested);
      continue;
    }

    const object = await blobs.get(source.r2_key);
    if (!object) {
      missing.push(requested);
      continue;
    }

    const filename = input.skipExisting ? requested : await attachments.availableFilename(input.to, requested);
    const id = crypto.randomUUID();
    const key = attachments.buildKey(input.to, id, filename);
    const stored = await blobs.put(key, object.body, {
      httpMetadata: { contentType: source.content_type },
    });
    if (!stored) throw new Error(`Copy failed for ${requested}`);

    const row = { id, noteId: input.to, filename, contentType: source.content_type, size: stored.size, r2Key: key };
    // The quota decided again as the row is recorded, atomically with the sum (see
    // `AttachmentsStore.record`); a move adds nothing and is not checked.
    const quota = input.move ? null : input.quota;
    let info: AttachmentInfo | null;
    try {
      info = input.skipExisting ? await attachments.record(row, { ifAbsent: true, quota }) : await attachments.record(row, { quota });
    } catch (err) {
      if (err instanceof StorageFull) await blobs.delete(key).catch(() => {});
      throw err;
    }
    if (!info) {
      // Another request recorded this name first; its copy is the file. Ours is an orphan.
      await blobs.delete(key);
      continue;
    }
    await attachments.copyText(source.id, { attachmentId: id, noteId: input.to, filename });

    let moved = false;
    if (input.move && !(await sourceStillLinks(requested))) {
      moved = (await attachments.remove(input.from, requested)) !== null;
    }

    const path = `files/${filename}`;
    // `filename`, not `requested`: a suffixed name is the one the link must point at.
    if (input.link) {
      await repos.notes.appendToBody(
        input.to,
        formatAttachmentMarkdown(filename, path, {
          image: source.content_type.startsWith('image/'),
        }),
      );
    }

    files.push({ ...info, from: requested, path, moved });
  }

  return { files, missing };
}
