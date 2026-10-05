/**
 * Opening the welcome note for a brand-new account on a desktop.
 *
 * A new account is made holding one note, the welcome note (apps/api/src/lib/welcome-note.ts).
 * On a desktop the first screen would otherwise be a one-row list beside a pane saying
 * "Select a note, or create one." — an instruction to click the only thing there, before
 * the person has seen what a note looks like. So the first time, the note is opened for
 * them. On a phone nothing happens: the list is the whole screen there, a list with one
 * note in it is the right first screen, and opening the note would hide the list they
 * have not yet seen.
 *
 * The rule is deliberately narrow, because a note that opens by itself is a surprise
 * everywhere but here:
 *
 * - **Created in the last ten minutes.** This is about arriving, not about having one
 *   note. Someone who has trashed everything but one note, or who signs in on a new
 *   computer a month later, is not arriving, and the note opening for them would be the
 *   app doing something nobody asked for.
 * - **Exactly one live note, in a whole library.** Not "the welcome note": nothing marks
 *   it, and its title is the person's to change. A new account with one note is that
 *   note; one that has started an import or written something already has somewhere it is
 *   going, and the list is where to see it.
 * - **Once per account per device.** Remembered when it happens, so closing the note and
 *   coming back to the list in the same ten minutes leaves the list alone.
 * - **All notes with nothing applied, at the two-pane width.** A link to a notebook or a
 *   search is somewhere the person chose to go.
 * - **Not while a new note is being asked for** (`/notes?new=1`, the address an app's
 *   "New note" shortcut opens). That request opens a note of its own, and two navigations
 *   replacing the same entry race: the welcome note could win and carry `new=1` with it,
 *   so the next reload would make another note.
 *
 * Why not "always select the first note", as some mail apps do: the list is sorted by
 * whatever the person picked and filtered by wherever they are, so the first row is a
 * different note every time, and a pane that fills itself on every visit to the list
 * takes away the one screen that says nothing is open.
 */

/** How long after the account was made it still counts as arriving. */
export const FIRST_RUN_WINDOW_MS = 10 * 60 * 1000;

export interface FirstRun {
  /** Two panes side by side: the desktop layout, not the phone's. */
  twoPane: boolean;
  /** The view is All notes with nothing applied (`showsWholeAccount`). */
  wholeAccount: boolean;
  /** When the account was made, from the session; null when the session does not say. */
  createdAt: number | null;
  now: number;
  /** Live notes in the account, or null while that is not known (`useLibraryTotal`). */
  total: number | null;
  /** Whether this device has already opened it for this account. */
  alreadyOpened: boolean;
  /** The address asks for a new note (`?new=1`, see `useNewNoteRequest`). */
  newRequested: boolean;
}

/** Whether to open the account's one note in place of the empty workspace. See above. */
export function shouldOpenFirstNote(run: FirstRun): boolean {
  return (
    run.twoPane &&
    run.wholeAccount &&
    run.createdAt !== null &&
    run.now - run.createdAt < FIRST_RUN_WINDOW_MS &&
    run.total === 1 &&
    !run.alreadyOpened &&
    !run.newRequested
  );
}

/** The account's creation time in milliseconds, from whichever shape the session carries. */
export function createdAtMs(createdAt: Date | string | undefined): number | null {
  if (createdAt === undefined) return null;
  const ms = new Date(createdAt).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The accounts this device has opened the first note for, under the `unbent.` prefix the
 * app's other per-device preferences use. Each entry is kept only until its account's
 * first-run window closes (`until`): after that the window says no on its own, so the
 * entry has nothing left to decide, and an id kept past it would only be an account
 * remembered on this browser after it signed out. Expired entries are dropped whenever the
 * list is written, so it holds an account or two at most.
 *
 * A list rather than a key per account so there is one entry to find. Every access is
 * guarded: storage can be off, full or throwing (Safari's private mode), and a lost answer
 * only means the note might open once more. An entry of any other shape — the bare ids the
 * first version of this wrote — is read as expired, which it would be by now anyway.
 */
const KEY = 'unbent.firstNoteOpened';

interface Opened {
  id: string;
  until: number;
}

function opened(): Opened[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is Opened =>
        typeof e === 'object' && e !== null && typeof e.id === 'string' && typeof e.until === 'number',
    );
  } catch {
    return [];
  }
}

export function firstNoteOpened(userId: string, now: number): boolean {
  return opened().some((e) => e.id === userId && e.until > now);
}

/** Remembers it for this account until `until`, the end of its first-run window. */
export function rememberFirstNoteOpened(userId: string, until: number, now: number): void {
  try {
    const kept = opened().filter((e) => e.until > now && e.id !== userId);
    localStorage.setItem(KEY, JSON.stringify([...kept, { id: userId, until }]));
  } catch {
    // Quota or private browsing: the note may open once more, which is all this costs.
  }
}
