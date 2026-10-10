/**
 * Which version of the terms and privacy policy an account is asked to agree to (MAK-209).
 *
 * Every account records the version it agreed to (`user.legalVersion`), and the app asks
 * again whenever that is not this. So moving it is how a change to the documents is put to
 * everyone: the next time each person opens the app they see the agreement step, worded
 * as an update, before anything else.
 *
 * Deliberately not the documents' effective dates (`EFFECTIVE` and `PRIVACY_EFFECTIVE` in
 * the web app's `legal/documents.ts`). Those move for every correction — the privacy
 * policy's moved twice in one week for a sentence about backups — and asking everyone to
 * agree again for each would teach them to press through it without reading. Move this
 * only for a change worth interrupting someone for, and move the effective dates with it.
 *
 * A date because it says when, and because two people comparing versions should not need
 * a table to know which came first. Shared because the Worker announces it in
 * `/api/config` and refuses an agreement to any other, while the web app's tests check
 * the documents' dates are not older than it.
 */
export const LEGAL_VERSION = '2026-10-09';

/**
 * One sentence on what changed in `LEGAL_VERSION`, for the people who agreed to an earlier
 * one. Shown under "We've updated our Terms and Privacy Policy", so they can tell a new
 * clause from a reworded one without reading both documents again.
 *
 * Undefined for the first version, which nobody had agreed to before. Set it in the same
 * commit that moves the version, and say what changed for the reader, not which sections
 * were edited.
 */
export const LEGAL_CHANGE: string | undefined = undefined;
