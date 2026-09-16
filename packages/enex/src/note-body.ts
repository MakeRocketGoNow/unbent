/**
 * How a note's body and its idempotency key are derived.
 *
 * Split out of `import.ts` so both importers can share it without also pulling in the ENEX
 * stream parser: the server converts ENML for syncing clients and never parses an ENEX
 * file. Sharing matters more than the file size — the two paths must produce byte-identical
 * bodies, because the hash of the body is what makes re-import idempotent. A note that hashed
 * differently depending on how it arrived would import twice.
 */

/**
 * sha256 of title and body — the idempotency key for a note from an Unbent export.
 *
 * `id` is included when the source named the note. Two empty Untitled drafts are two
 * notes; hashing title and body alone treated the second as a duplicate of the first and
 * dropped it, attachments and all. A note from Evernote has no id, and is keyed by
 * `enexNoteHash` instead.
 */
export async function contentHash(title: string, body: string, id?: string): Promise<string> {
  return sha256Hex(id ? `${id}\n${title}\n${body}` : `${title}\n${body}`);
}

/**
 * The idempotency key for a note from Evernote: everything the import keeps of it.
 *
 * ENEX gives a note no id, so a note already here can only be recognised by what it holds.
 * Title and body alone were not enough. A real export held pairs that shared both and
 * differed in the rest: a copy with its own photos under the same camera file names, a copy
 * with a tag the first lacked. Each second copy was matched to the first and skipped, and
 * what it carried was never imported. Filling in attachments by name could not catch it,
 * because a different photo under the same name looks like one that already landed.
 *
 * So the key is the whole note: title, body, tags, both dates, and the bytes of every
 * attachment. A note is skipped only when the one already here is the same in all of that,
 * which is what a resumed run or a repeated file needs and loses nothing. Two notes that
 * are identical in all of it still collapse into one; importing the second would add a
 * note nobody could tell apart from the first.
 *
 * Tags are compared as a set, trimmed, the way the server stores them, and attachments in
 * any order, so the importer and the ENML endpoint arrive at one key from their own inputs.
 * A missing date is keyed as missing rather than as the import time the note is given in
 * its place, or no resumed run would ever match.
 */
export async function enexNoteHash(note: {
  title: string;
  body: string;
  tags: readonly string[];
  created: number | undefined;
  updated: number | undefined;
  /** The md5 of each attachment's bytes, as `EnexResource.md5` has it. */
  attachments: readonly string[];
}): Promise<string> {
  const tags = [...new Set(note.tags.map((t) => t.trim()).filter((t) => t.length > 0))].sort();
  return sha256Hex(
    JSON.stringify([
      note.title,
      note.body,
      tags,
      note.created ?? null,
      note.updated ?? null,
      [...note.attachments].sort(),
    ]),
  );
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Prepends the source URL to a bookmark note's body.
 *
 * Kept in frontmatter by the server, but for a Pocket or Raindrop note the URL is the
 * substance of the note, so it also belongs where it can be clicked.
 */
export function withSourceLink(body: string, sourceUrl?: string): string {
  if (!sourceUrl) return body;
  if (body.includes(sourceUrl)) return body; // clipper often already included it
  return `<${sourceUrl}>\n\n${body}`.trim();
}
