import type { QueryClient } from '@tanstack/react-query';
import { claimCacheFor } from './queries.js';
import { claimImportFor } from './import-run.js';
import { acquireLibrary } from './store/library.js';

/**
 * Hands what the tab holds for one person to whoever the route guard found signed in.
 *
 * Called from the root `beforeLoad`, after the session gate, because that is the last
 * moment before a route's loaders run. Its own function so the two rules below can be
 * tested — the second is a one-line guard that reads like something to simplify.
 *
 * The cache: loaders resolve through `ensureQueryData`, so a second person signing in
 * without reloading was served the first one's notes out of it. See `claimCacheFor` for why
 * it is keyed on the user rather than hung off signing out.
 *
 * The import run: claimed here as the last line of defence rather than the first. By the
 * time a new person reaches the guard their sign-in has already set the cookie the worker
 * sends, so a run still going here has had a moment to send as them. What actually ends a
 * run is earlier — `useSignOut` and the shell drop it when the session goes, and the
 * importer stops on its first 401 — and this catches a sign-out none of those saw.
 *
 * Only a real user is passed to the run. The guard returns nobody for a public page even
 * when someone is signed in, and claiming nobody is a sign-out: opening `/privacy` mid-
 * import would throw the run away. See `ImportRun.claim`.
 */
export function handOver(queryClient: QueryClient, userId: string | undefined): void {
  claimCacheFor(queryClient, userId);
  if (userId) {
    claimImportFor(userId);
    // The local copy of the library, opened here so a route's loader finds it: every
    // note query reads it (`queries.ts`), and the guard is the last moment before the
    // loaders run. Not awaited — opening takes a few milliseconds on a warm device and
    // the queries await it themselves — and a different account opening theirs closes
    // the previous one; see `acquireLibrary`.
    void acquireLibrary(userId).catch(() => {});
  }
}
