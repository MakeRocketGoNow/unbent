import type { LocalNote } from './collections.js';

/**
 * Which queries a change to the library reaches; see `installLibraryQueries` in
 * `queries.ts`. In a file of its own, beside `library.ts`, because the tab that serves
 * its library to the account's other tabs (`library-serve.ts`) names the roots on each
 * batch of changes it forwards, and `library.ts` is what starts that serving.
 */

/** The query roots a change to the library can reach. */
export const LIBRARY_ROOTS: ReadonlySet<string> = new Set(['notes', 'note', 'trash', 'tags', 'notebooks', 'notebook-fields', 'attachments', 'views']);

/**
 * The roots a change to the saved views reaches: their own list and nothing else. No list
 * of notes, count or name is derived from a view, so a view saved, renamed or reordered
 * refetching every query (as a notebook's or a tag's change does) would be work for nothing.
 */
export const VIEW_ROOTS: ReadonlySet<string> = new Set(['views']);

/** A change message as the collection reports it; the rows are read as notes. */
export type NoteChange = { type: string; value?: object | undefined; previousValue?: object | undefined };
type LocalNoteLike = Pick<LocalNote, 'deletedAt' | 'notebookId' | 'notebookName' | 'tagIds' | 'tagNames' | 'fields'>;

/** The roots a batch of note changes reaches: the text's alone when that is all that changed. */
export function rootsOfNoteChanges(changes: ReadonlyArray<NoteChange>): ReadonlySet<string> {
  const roots = new Set<string>(['notes', 'note']);
  for (const c of changes) {
    const v = c.value as LocalNoteLike | undefined;
    const p = c.previousValue as LocalNoteLike | undefined;
    if (c.type !== 'update' || !v || !p) return LIBRARY_ROOTS;
    if (v.deletedAt !== undefined || p.deletedAt !== undefined) roots.add('trash');
    const same =
      v.deletedAt === p.deletedAt &&
      v.notebookId === p.notebookId &&
      v.notebookName === p.notebookName &&
      v.tagIds.length === p.tagIds.length &&
      v.tagIds.every((t, i) => t === p.tagIds[i]) &&
      JSON.stringify(v.tagNames) === JSON.stringify(p.tagNames) &&
      JSON.stringify(v.fields) === JSON.stringify(p.fields);
    if (!same) return LIBRARY_ROOTS;
  }
  return roots;
}
