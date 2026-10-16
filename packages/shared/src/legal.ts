/**
 * Which version of the terms and privacy policy an account is asked to agree to (MAK-209).
 *
 * Every account records the version it agreed to (`user.legalVersion`), and the app asks
 * again whenever that is not this. So moving it is how a change to the documents is put to
 * everyone: the next time each person opens the app they see the agreement step, worded
 * as an update, before anything else.
 *
 * Deliberately not the documents' effective dates (`EFFECTIVE` and `PRIVACY_EFFECTIVE` in
 * the web app's `legal/documents.ts`). Those move for every correction (the privacy
 * policy's moved twice in one week for a sentence about backups) and asking everyone to
 * agree again for each would teach them to press through it without reading. Move this
 * only for a change worth interrupting someone for, and move the effective dates with it.
 *
 * A date because it says when, and because two people comparing versions should not need
 * a table to know which came first. Shared because the Worker announces it in
 * `/api/config` and refuses an agreement to any other, while the web app's tests check
 * the documents' dates are not older than it.
 */
export const LEGAL_VERSION = '2026-10-14';

/**
 * How long after a charge it can be refunded in full, for any reason.
 *
 * Fourteen days because that is the floor Paddle's review accepts, and the right to cancel
 * that a consumer in Europe or the UK has anyway. It covers a renewal as much as a first
 * charge: a renewal is the charge someone is most likely to have forgotten was coming.
 *
 * Here beside the version because the terms ("Refunds" in the web app's
 * `legal/documents.ts`) and `LEGAL_CHANGE`'s sentence both state it, and the sentence
 * describing a change must not disagree with the terms it describes.
 */
export const REFUND_DAYS = 14;

/** A billing-only change names the version it moved from; any other moves every instance. */
type LegalChange = { text: string; billingOnly: true; since: string } | { text: string; billingOnly?: false };

/**
 * One sentence on what changed in `LEGAL_VERSION`, for the people who agreed to an earlier
 * one. Shown under "We’ve updated our terms", so they can tell a new
 * clause from a reworded one without reading both documents again.
 *
 * Undefined for the first version, which nobody had agreed to before. Set it in the same
 * commit that moves the version, and say what changed for the reader, not which sections
 * were edited.
 *
 * `billingOnly` when what changed is only in the sections an instance publishes because it
 * sells a plan (billing on, or a front page stating the price) about payment, renewal
 * and refunds. An instance that sells nothing does not publish them, so for it nothing
 * changed: it stays on `since`, the version this one moved from, and asks nobody again
 * (`legalVersionOf` in the API). Asking a self-hosted instance's accounts to agree to text
 * that reads word for word as before would teach them to press through the step. The
 * next change that is not billing-only drops both fields, and every instance moves to it
 * together.
 */
export const LEGAL_CHANGE: LegalChange | undefined = {
  text:
    'The terms now say how a plan is billed, how it renews and how to cancel it, and that ' +
    `any charge is refunded in full if you ask within ${REFUND_DAYS} days.`,
  billingOnly: true,
  since: '2026-10-09',
};

/**
 * Whether an account that agreed to `agreed` has agreed to `required`, the version its
 * instance asks for now (`legalVersionOf` in the API).
 *
 * Equality, with one case more: an instance that sold a plan and stopped (the Paddle
 * settings removed, or its front page turned off) asks for `since` again, the version
 * before a billing-only change, and an account that agreed to `LEGAL_VERSION` agreed to
 * everything in it and more. Without this, every account on it would be asked again,
 * under "We’ve updated our terms", for text it had already agreed to. The one place the
 * comparison is made, for the server's refusal and the app's gate alike.
 */
export function coversLegalVersion(agreed: string | null | undefined, required: string): boolean {
  if (agreed === required) return true;
  return LEGAL_CHANGE?.billingOnly === true && required === LEGAL_CHANGE.since && agreed === LEGAL_VERSION;
}
