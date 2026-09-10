import { fieldsByName, type NoteSummary } from '@unbent/shared';

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
 */
export function noteRef(note: NoteSummary) {
  return {
    id: note.id,
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
