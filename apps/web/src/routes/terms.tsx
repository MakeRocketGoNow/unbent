import { createFileRoute } from '@tanstack/react-router';
import { LegalPage } from '../components/LegalPage.js';

/** The terms of service. Public for the same reasons as the privacy policy beside it. */
export const Route = createFileRoute('/terms')({
  component: () => <LegalPage which="terms" />,
});
