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
/** The level stated last, which is what `behindDeploy` reads. */
let seen: number | null = null;
/**
 * The last level stated that was not the page's own, which is the one a dismissal is
 * for. Not `seen`: while a deploy reaches the edges the last answer may be at the page's
 * own level, and a dismissal recorded for that one was undone by the next answer.
 */
let other: number | null = null;
/** The level the person dismissed the notice for, so the next answer does not bring it straight back. */
let dismissedFor: number | null = null;
const listeners = new Set<() => void>();

function set(next: boolean): void {
  if (shown === next) return;
  shown = next;
  for (const listener of listeners) listener();
}

/**
 * How long answers must keep stating the page's own level, with no other in between,
 * before an open notice closes. A deploy takes some seconds to reach every edge, and
 * meanwhile one tab's requests are answered by both versions in turn: closing on the
 * first answer at the page's own level made the notice blink with every request.
 */
export const SETTLED_MS = 60_000;

let otherAt = 0;

/**
 * A level the deploy in charge stated, from its worker or an API answer. Another level
 * opens the notice at once. Back at the page's own for `SETTLED_MS` (a bump reverted
 * before the person answered) it closes, since there is nothing left to reload for.
 */
export function sawLevel(level: number | null, now = Date.now()): void {
  if (level === null) return;
  seen = level;
  if (needsReload(COMPAT_LEVEL, level)) {
    otherAt = now;
    other = level;
    if (level !== dismissedFor) set(true);
  } else if (now - otherAt >= SETTLED_MS) set(false);
}

/**
 * Whether this page is behind the deploy that answered it last: a build the server may
 * refuse. The outbox reads it to keep a write the server refused rather than end it
 * (`refusal` in `store/actions.ts`), since the build a reload brings may be able to send it.
 */
export function behindDeploy(): boolean {
  return needsReload(COMPAT_LEVEL, seen);
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
  dismissedFor = other;
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
  other = null;
  dismissedFor = null;
  otherAt = 0;
}
