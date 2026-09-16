/**
 * How a note's body and its idempotency key are derived.
 *
 * Split out of `import.ts` so both importers can share it without also pulling in the ENEX
 * stream parser: the server converts ENML for syncing clients and never parses an ENEX
 * file. Sharing matters more than the file size — the two paths must produce byte-identical
 * bodies, because `contentHash` is what makes re-import idempotent. A note that hashed
 * differently depending on how it arrived would import twice.
 */

/**
 * sha256 of title and body — the server's idempotency key.
 *
 * `id` is included when the source named the note (an Unbent export). Two empty
 * Untitled drafts are two notes; hashing title and body alone treated the second
 * as a duplicate of the first and dropped it, attachments and all. ENEX has no
 * stable id and omits this, so two identical Evernote notes still collapse the
 * way they always have.
 */
export async function contentHash(title: string, body: string, id?: string): Promise<string> {
  const data = new TextEncoder().encode(id ? `${id}\n${title}\n${body}` : `${title}\n${body}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
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
