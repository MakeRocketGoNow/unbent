import { RESTORE_WINDOW_DAYS } from '@unbent/shared';

/**
 * What the object and the operator's route agree on about a point-in-time restore: the
 * shape of a bookmark, and the message the object restarts with, which is how the route
 * learns the restore's undo bookmark. Its own module, free of `cloudflare:workers`, so the
 * route and the unit tests can import it; see `UserStore.restoreTo` for the restore itself.
 */

/**
 * A bookmark as the runtime writes them: four dash-separated runs of hex, the last one
 * long. Checked before one is handed to the runtime, so a mistyped one is the operator's
 * 400 rather than the object's error. Looser than the exact widths on purpose; the
 * runtime is the judge of whether a well-formed one exists.
 */
export const BOOKMARK_PATTERN = /^[0-9a-f]{8}(-[0-9a-f]{8}){2}-[0-9a-f]{16,}$/i;

/** How far back the runtime keeps a store's history; the number itself is stated to the operator, so it lives in `@unbent/shared`. */
export const RESTORE_WINDOW_MS = RESTORE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

const MARK = 'store restore scheduled';
const REFUSED = 'store restore refused: ';

/**
 * The reason `restoreTo` aborts the object with. The runtime hands it, as the error's
 * message, to the request that was in flight (which is the operator's), so it carries
 * the undo bookmark out of a call that cannot otherwise return anything.
 */
export function restoreAbortReason(bookmark: string, undo: string): string {
  return `${MARK}: to=${bookmark} undo=${undo}`;
}

/**
 * What a failed `restoreTo` call says about the restore: `scheduled` when the error is the
 * object's own abort, so the restore happened, and the undo bookmark if the message still
 * carries it. Searched for rather than matched whole, since the runtime is free to wrap
 * the reason in words of its own on the way back.
 */
export function readRestoreAbort(err: unknown): { scheduled: boolean; undo: string | null } {
  const message = err instanceof Error ? err.message : String(err);
  if (!message.includes(MARK)) return { scheduled: false, undo: null };
  return { scheduled: true, undo: /undo=([0-9a-f-]+)/i.exec(message)?.[1] ?? null };
}

/**
 * The message `restoreTo` and `restorePreview` rethrow a runtime refusal with (an unknown
 * bookmark, a time out of reach, no history at all), so the route can tell "refused,
 * nothing happened" from every other failure. Anything without this mark or the abort's
 * is an outcome nobody knows: a dropped connection, an internal error, an abort whose
 * reason the runtime replaced. For a restore that may already have been scheduled, the
 * route says so rather than calling it refused.
 */
export function restoreRefusedReason(err: unknown): string {
  return `${REFUSED}${err instanceof Error ? err.message : String(err)}`;
}

/** The runtime's own words, if `err` is a refusal `restoreRefusedReason` marked; null otherwise. */
export function readRestoreRefusal(err: unknown): string | null {
  const message = err instanceof Error ? err.message : String(err);
  const at = message.indexOf(REFUSED);
  return at === -1 ? null : message.slice(at + REFUSED.length);
}

/** The runtime's refusal where there is no history to restore from: Miniflare, today. */
export function isRestoreUnsupported(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /does not implement point-in-time recovery/i.test(message);
}
