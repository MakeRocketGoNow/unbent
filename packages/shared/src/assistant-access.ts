import { z } from 'zod';

/**
 * What one connected assistant may do with an account (MAK-264): which notebooks it
 * reaches, and whether it may change anything. Chosen by the person when they connect
 * it, on the consent screen, and changed afterwards in Settings under Connected apps.
 *
 * - `notebooks` is the ids of the notebooks it was given, or `null` for the whole
 *   library, which is what connecting an assistant has always granted. `null` and a
 *   list are different promises: a list never grows on its own, so a notebook made
 *   next month is not in it, and `null` covers that notebook the day it is made.
 * - `unfiled` is whether it also reaches the notes filed in no notebook. Only read
 *   beside a list; the whole library has them in it.
 * - `readOnly` withholds every tool that changes something, whatever it can see.
 *
 * An id that names no notebook grants nothing and is not an error: a notebook deleted
 * since the grant was saved leaves its id behind, and ids are never used twice.
 */
export interface AssistantGrant {
  notebooks: string[] | null;
  unfiled: boolean;
  readOnly: boolean;
}

/** A connection nobody has restricted: every notebook, and free to write. What a connection made before grants existed has. */
export const FULL_GRANT: AssistantGrant = { notebooks: null, unfiled: true, readOnly: false };

/**
 * How many notebooks a grant may name: a bound on what is stored and on what crosses to
 * the note store with every tool call, far past any library. Someone giving an
 * assistant that many has given it the library, which is the other choice.
 */
export const ASSISTANT_GRANT_MAX_NOTEBOOKS = 2000;

/** The body of `PUT /api/connected-apps/grants/:clientId`. */
export const assistantGrantSchema = z.object({
  notebooks: z.array(z.string().min(1).max(64)).max(ASSISTANT_GRANT_MAX_NOTEBOOKS).nullable(),
  unfiled: z.boolean(),
  readOnly: z.boolean(),
});

/** Whether a grant leaves anything out: some notebooks only, or reading only. */
export function grantIsRestricted(grant: AssistantGrant): boolean {
  return grant.notebooks !== null || grant.readOnly;
}
