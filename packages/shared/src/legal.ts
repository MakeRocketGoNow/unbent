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
 * sells a plan — billing on, or a front page stating the price — about payment, renewal and
 * refunds. An instance that sells nothing does not publish them, so it asks again with the plain "We’ve updated our terms" rather than a
 * sentence about terms its readers will not find (`legalVersionOf` in the API).
 */
export const LEGAL_CHANGE: { text: string; billingOnly: boolean } | undefined = {
  text:
    'The terms now say how a plan is billed, how it renews and how to cancel it, and that ' +
    `any charge is refunded in full if you ask within ${REFUND_DAYS} days.`,
  billingOnly: true,
};
