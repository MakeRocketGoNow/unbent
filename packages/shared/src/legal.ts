/**
 * Which version of the terms and privacy policy an account is asked to agree to (MAK-209).
 *
 * Every account records the version it agreed to (`user.legalVersion`), and the app asks
 * again whenever that does not cover the one its instance asks for now. So adding a
 * change below is how a change to the documents is put to people: the next time each
 * person opens the app they see the agreement step, worded as an update, before anything
 * else.
 *
 * Deliberately not the documents' effective dates (`EFFECTIVE` and `PRIVACY_EFFECTIVE` in
 * the web app's `legal/documents.ts`). Those move for every correction (the privacy
 * policy's moved twice in one week for a sentence about backups) and asking everyone to
 * agree again for each would teach them to press through it without reading. Add a
 * change only for one worth interrupting someone for, and move the effective dates with it.
 *
 * A date because it says when, and because two people comparing versions should not need
 * a table to know which came first. Shared because the Worker announces it in
 * `/api/config` and refuses an agreement to any other, while the web app's tests check
 * the documents' dates are not older than the newest.
 */

/**
 * How long after a charge it can be refunded in full, for any reason.
 *
 * Fourteen days because that is the floor Paddle's review accepts, and the right to cancel
 * that a consumer in Europe or the UK has anyway. It covers a renewal as much as a first
 * charge: a renewal is the charge someone is most likely to have forgotten was coming.
 *
 * Here beside the version because the terms ("Refunds" in the web app's
 * `legal/documents.ts`) and a sentence in `LEGAL_CHANGES` both state it, and the sentence
 * describing a change must not disagree with the terms it describes.
 */
export const REFUND_DAYS = 14;

/** The version before any change below: the first one anybody agreed to (MAK-209). */
export const LEGAL_BASE_VERSION = '2026-10-09';

/** What an instance's built-in documents contain beyond what every instance publishes. */
export interface LegalPublishes {
  /** The terms' sections on payment, renewal and refunds, and Paddle in the policy (MAK-108). */
  sellsPlan: boolean;
  /** What Auto-fill sends, and to whom, in the policy (MAK-230). */
  autofill: boolean;
}

export interface LegalChange {
  version: string;
  /**
   * One sentence on what changed, for the people who agreed to an earlier version. Shown
   * under "We’ve updated our terms", so they can tell a new clause from a reworded one
   * without reading both documents again. Say what changed for the reader, not which
   * sections were edited.
   */
  text: string;
  /**
   * Set when what changed is only in text an instance publishes because of this, and
   * absent when it is in text every instance publishes. An instance that does not publish
   * the changed text has nothing new to agree to, and stays on the version before: asking
   * a self-hosted instance's accounts to agree to text that reads word for word as before
   * would teach them to press through the step.
   */
  onlyWhere?: keyof LegalPublishes;
}

/**
 * Every change since `LEGAL_BASE_VERSION`, oldest first. An instance asks for the newest
 * one that applies to it (`legalVersionFor`), with its sentence.
 *
 * A list rather than one change and the version it moved from, which is what it was
 * while the only conditional change was the plan's. The second, Auto-fill's, applies to a
 * different set of instances, and "the version before" was then a different version for
 * each: an instance that sells nothing and has no Auto-fill is still on the base.
 */
export const LEGAL_CHANGES: readonly LegalChange[] = [
  {
    version: '2026-10-14',
    text:
      'The terms now say how a plan is billed, how it renews and how to cancel it, and that ' +
      `any charge is refunded in full if you ask within ${REFUND_DAYS} days.`,
    onlyWhere: 'sellsPlan',
  },
  {
    version: '2026-10-16',
    text:
      'The privacy policy now says what Auto-fill sends when you press it, to which outside ' +
      'services, and what they keep.',
    onlyWhere: 'autofill',
  },
];

/** The newest version there is; what an instance publishing everything asks for. */
export const LEGAL_VERSION = LEGAL_CHANGES[LEGAL_CHANGES.length - 1]?.version ?? LEGAL_BASE_VERSION;

/**
 * The version an instance with the built-in documents asks for, and the sentence on what
 * it changed: the newest change whose text this instance publishes. Only the newest
 * sentence is said, so someone who skipped a version on an instance that changed twice
 * is told the latest change and agrees to documents holding both.
 */
export function legalVersionFor(publishes: LegalPublishes): { version: string; change?: string } {
  let newest: LegalChange | undefined;
  for (const change of LEGAL_CHANGES) if (!change.onlyWhere || publishes[change.onlyWhere]) newest = change;
  return newest ? { version: newest.version, change: newest.text } : { version: LEGAL_BASE_VERSION };
}

const BUILT_IN_VERSIONS = new Set([LEGAL_BASE_VERSION, ...LEGAL_CHANGES.map((c) => c.version)]);

/**
 * Whether an account that agreed to `agreed` has agreed to `required`, the version its
 * instance asks for now (`legalVersionFor`).
 *
 * Equality, or a later built-in version than the one asked for: an instance that stops
 * selling a plan, or turns Auto-fill off, asks for an earlier version again, and an
 * account that agreed to a later one agreed to everything in it and more. Without this,
 * every account on it would be asked again, under "We’ve updated our terms", for text it
 * had already agreed to. An operator's own documents' versions are not dates in this list
 * and compare by equality alone.
 *
 * The one case it lets through that it should not: an instance that turns a condition on
 * after its accounts agreed to a later change under another (Auto-fill's version agreed
 * on an instance that then starts selling a plan) asks for that same version, so those
 * accounts are not asked about the terms of sale. Selling is switched on once, by the
 * operator, before anyone could buy; a version per combination of conditions was the
 * alternative, and would ask everyone again for each.
 *
 * The one place the comparison is made, for the server's refusal and the app's gate alike.
 */
export function coversLegalVersion(agreed: string | null | undefined, required: string): boolean {
  if (agreed === required) return true;
  if (!agreed || !BUILT_IN_VERSIONS.has(agreed) || !BUILT_IN_VERSIONS.has(required)) return false;
  return agreed > required;
}
