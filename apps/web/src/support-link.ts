import type { AppConfig } from '@unbent/shared';
import { SUPPORT } from './auth-gate.js';

/** How this instance's operator is reached, from the app: a page, an address, or nothing. */
export type SupportLink = { kind: 'page'; to: typeof SUPPORT } | { kind: 'mail'; href: string; email: string };

/**
 * Where "Support" goes, for the account menu and the help page alike, so the two cannot
 * come to disagree.
 *
 * The support page when the instance has one: it carries the operator's address too, and
 * answers most of what people write in about (a charge, signing in, getting notes out)
 * without opening a mail client on someone who only wanted to know how to cancel, which is
 * why it replaced the front page footer's mailto. It exists only where the front page does
 * (`routes/support.tsx` sends everyone else to sign in), so an instance that names an
 * operator without publishing a front page gets the bare address instead.
 *
 * Nothing at all with no operator, under the legal links' both-or-nothing rule
 * (`operatorOf` on the server): a support item that leads nowhere reads as a broken app.
 */
export function supportLink(config: AppConfig | undefined): SupportLink | null {
  const email = config?.operator?.email;
  if (!email) return null;
  if (config.frontPage) return { kind: 'page', to: SUPPORT };
  return { kind: 'mail', href: `mailto:${email}`, email };
}
