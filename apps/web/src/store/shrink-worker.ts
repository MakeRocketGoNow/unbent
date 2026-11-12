/// <reference lib="webworker" />
import { shrinkAndRemove, type ShrinkMessage, type ShrinkRoot } from './shrink.js';

/**
 * Empties and removes the store files a wipe names (`shrink.ts` says why), off the page
 * because a sync access handle exists only in a dedicated worker. Its own small worker
 * rather than the import worker, the one other dedicated worker the app has: that one is
 * the importer and the indexer, the largest chunk after pdf.js, and a sign-out must not
 * fetch it. One message in, the names; one message out per file removed, then `done`. The
 * page terminates it after.
 */
self.onmessage = async (event: MessageEvent<{ names?: unknown }>) => {
  const names = Array.isArray(event.data?.names) ? event.data.names.filter((n): n is string => typeof n === 'string') : [];
  const post = (message: ShrinkMessage) => self.postMessage(message);
  try {
    const root = (await navigator.storage.getDirectory()) as unknown as ShrinkRoot;
    await shrinkAndRemove(root, names, (removed) => post({ removed }));
  } catch {
    // No file system here: the page removes everything.
  }
  post({ done: true });
};
