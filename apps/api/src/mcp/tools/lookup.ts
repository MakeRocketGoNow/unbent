import type { NotesRepo } from '../../lib/notes-repo.js';

/**
 * Lookups by the names a model reads, shared by the read and write tools.
 *
 * Ids never reach a model unless a tool asks for one, so anything that takes a notebook
 * by name has to find it here first.
 */

/** The id of a notebook by name, case-insensitively, or null when there is none yet. */
export async function notebookIdByName(notes: NotesRepo, name: string): Promise<string | null> {
  const all = await notes.listNotebooks();
  return all.find((nb) => nb.name.toLowerCase() === name.trim().toLowerCase())?.id ?? null;
}
