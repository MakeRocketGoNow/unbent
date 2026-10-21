import { COMPAT_LEVEL } from '@unbent/shared/compat';

/**
 * Whether the page has been told the deploy in charge is one it cannot run beside, for
 * `UpdateSnackbar` (through `useUpdateNotice` in `sw-register.ts`).
 *
 * Two things tell it, and either is enough: the service worker that takes charge of the
 * page answers its level (`BUILD` in `sw.ts`), and every API answer states it
 * (`COMPAT_HEADER`, read by `request()` in `notes-api.ts`). The worker alone was too
 * late: a tab that stays in view never asks for a new one, and a phone resumed after
 * weeks replays its queued writes before one has installed. Apart from `sw-register.ts`
 * so the API client can tell it without loading Workbox.
 */

/**
 * Whether a level the deploy in charge stated is one this page cannot run beside: any
 * level but the page's own (`COMPAT_LEVEL`).
 *
 * Lower as well as higher. A lower one is a bump that was reverted after this page
 * loaded it, and the page is then the newer side, which a reload fixes as surely: a page
 * load is answered from the network first, so it brings the build the server is on.
 *
 * Not whether it is another build. That was the rule, and it asked for a reload after
 * every deploy, which nothing about most deploys needs: this page keeps its own shell
 * while it is open, and the next load brings the newest build regardless. Unknown is not
 * another: a worker or a server from before levels states none, and a word that might be
 * wrong is worse than none.
 */
export function needsReload(page: number, deployed: number | null): boolean {
  return deployed !== null && deployed !== page;
}

let shown = false;
/** The level stated last, which is the one a dismissal is for. */
let seen: number | null = null;
/** The level the person dismissed the notice for, so the next answer does not bring it straight back. */
let dismissedFor: number | null = null;
const listeners = new Set<() => void>();

function set(next: boolean): void {
  if (shown === next) return;
  shown = next;
  for (const listener of listeners) listener();
}

/** A level the deploy in charge stated, from its worker or an API answer. */
export function sawLevel(level: number | null): void {
  if (level === null) return;
  seen = level;
  if (needsReload(COMPAT_LEVEL, level) && level !== dismissedFor) set(true);
}

export function noticeShown(): boolean {
  return shown;
}

export function subscribeNotice(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The person closed the notice. It stays closed for this level, since every request
 * would otherwise open it again at once; a deploy that moves the level again says so.
 */
export function dismissNotice(): void {
  dismissedFor = seen;
  set(false);
}

/** The notice is being answered by a reload. */
export function clearNotice(): void {
  set(false);
}

/** Forgets everything, for tests. */
export function resetNotice(): void {
  shown = false;
  seen = null;
  dismissedFor = null;
}
