import { createFileRoute } from '@tanstack/react-router';
import { LegalPage } from '../components/LegalPage.js';

/**
 * The privacy policy, which has to be readable by anyone.
 *
 * Play requires a policy at a public URL and checks that it loads without signing in, so
 * this is on the `PUBLIC` list in `auth-gate.ts`: the default there is to gate a new
 * route, which for this page would fail review.
 */
export const Route = createFileRoute('/privacy')({
  component: () => <LegalPage which="privacy" />,
});
