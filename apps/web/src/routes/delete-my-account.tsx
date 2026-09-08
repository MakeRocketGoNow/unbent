import { createFileRoute } from '@tanstack/react-router';
import { LegalDoc } from '../components/LegalDoc.js';
import { deletion } from '../legal/documents.js';

/**
 * How to delete your account, for a reader who is not signed in.
 *
 * The address the Play listing points at. It cannot be `/settings/maintenance`, where the
 * control actually lives: that is behind the session gate, so the console's check of the
 * URL came back 403 and a submission would have been rejected on it.
 *
 * Deliberately not `/delete-account`, which is a page about *one* deletion already in
 * progress — it spends the token from the confirmation mail. This one is about the process
 * in general and acts on nothing, which is why the two are separate routes rather than one
 * page branching on whether a token is present. A reader arriving here from a store listing
 * has no token and is not necessarily a user at all.
 *
 * On the `PUBLIC` list in `auth-gate.ts` for the same reason `/privacy` is, and with the
 * same consequence if anyone removes it: the default there is to gate a new route, and a
 * gated page at this address is the 403 all over again.
 */
export const Route = createFileRoute('/delete-my-account')({
  component: () => <LegalDoc doc={deletion} />,
});
