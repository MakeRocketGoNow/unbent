import { fieldsByName, type Note, type NoteSummary } from '@unbent/shared';
import type { AppLinks } from '../../lib/app-links.js';

/**
 * How every tool here answers.
 *
 * MCP tool results are content blocks, and the useful shape for structured data is one text
 * block holding JSON. Pretty-printing is deliberate: the model reads this, and a wall of
 * minified JSON costs it more attention than the whitespace costs in tokens.
 */
export function jsonResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

/**
 * A note as every tool reports it.
 *
 * Timestamps go out as ISO-8601 rather than the epoch milliseconds the database holds. A
 * model reading `1788743954000` has to be told what it is; a model reading
 * `2026-09-06T20:39:14Z` does not, and can compare two of them without arithmetic.
 *
 * Custom field values go out keyed by field name as typed JSON — `{"Merchant": "Acme",
 * "Amount": 12.5}` — for the same reason: that needs no explanation, where a list of
 * `{fieldId, type, value}` records would. The names are also what the write tools take.
 *
 * `url` is the address the note opens at in the web app, absolute, so an assistant can
 * hand the person a link instead of an id they cannot use; see lib/app-links.ts. Every
 * note a tool returns goes through here, which is what keeps it from being missed on one.
 */
export function noteRef(note: NoteSummary, links: AppLinks) {
  return {
    id: note.id,
    url: links.note(note.id, { trashed: Boolean(note.deletedAt) }),
    title: note.title,
    createdAt: new Date(note.createdAt).toISOString(),
    updatedAt: new Date(note.updatedAt).toISOString(),
    tags: note.tags,
    notebook: note.notebook ?? null,
    ...(note.fields?.length ? { fields: fieldsByName(note.fields, note.notebookId ?? null) } : {}),
    ...(note.excerpt ? { excerpt: note.excerpt } : {}),
    ...(note.deletedAt ? { trashedAt: new Date(note.deletedAt).toISOString() } : {}),
  };
}

/**
 * A missing note and a note belonging to someone else are the same answer, deliberately:
 * the repos scope every lookup by user, so this is reached for both, and distinguishing them
 * would confirm that an id exists. The HTTP API answers 404 for the same reason.
 */
export function notFound(kind: string, what: string) {
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: `No such ${kind}: ${what}` }],
  };
}

/**
 * A failure the model should read and act on, rather than an exception.
 *
 * `isError` is how MCP says "this call failed" without ending the conversation: the text
 * goes back to the model, which can correct itself and try again. So these read as
 * instructions to the caller, not as log lines.
 */
export function toolError(message: string) {
  return { isError: true as const, content: [{ type: 'text' as const, text: message }] };
}

/**
 * A write refused because the note was saved after the copy it was built from — by the
 * person in the editor, or another agent. The note as it now stands goes back with the
 * error, so the model can redo its change against the current text in one more call
 * rather than reading the note again first.
 */
export function staleNote(current: Note, links: AppLinks) {
  return toolError(
    `The note changed after you read it (it was saved at ${new Date(current.updatedAt).toISOString()}), ` +
      'so nothing was written. Redo the change against the note as it is now:\n\n' +
      JSON.stringify({ ...noteRef(current, links), body: current.body }, null, 2),
  );
}

/**
 * The link each note in a set opens at, keyed by id, for the tools that act on many notes
 * and answer with ids rather than notes. A map rather than a list beside `noteIds`, so the
 * pairing cannot be read off by position and get one wrong.
 */
export function noteUrls(ids: string[], links: AppLinks, opts?: { trashed?: boolean }) {
  return Object.fromEntries(ids.map((id) => [id, links.note(id, opts)]));
}

/**
 * Said in the description of every tool that changes a note, since the description is
 * what an assistant reads: a link in the answer that nothing asks it to pass on is a link
 * the person never sees.
 */
export const SHARE_NOTE_LINK =
  ' The answer carries url, the absolute address the note opens at in Unbent: give it to ' +
  'the person as a link whenever you create or change a note, so they can open it.';

/** The same, for the tools that answer with `urls` by id. */
export const SHARE_NOTE_LINKS =
  ' The answer carries urls, the absolute address each note it reached opens at in Unbent, ' +
  'keyed by id: give the person those links when you tell them what changed, or for a ' +
  'large set a few of them and the count.';
