import { createFileRoute } from '@tanstack/react-router';
import { LegalDoc } from '../components/LegalDoc.js';
import { terms } from '../legal/documents.js';

/** The terms of service. Public for the same reasons as the privacy policy beside it. */
export const Route = createFileRoute('/terms')({
  component: () => <LegalDoc doc={terms} />,
});
