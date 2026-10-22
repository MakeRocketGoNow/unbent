import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { Plan } from '../components/Plan.js';

/**
 * `checkout=complete` is what Stripe sends the person back with once a checkout is paid
 * (the server puts it on the success address it hands Stripe); the page reads it once
 * and takes it off the address. Anything else in its place is ignored rather than an
 * error page, since the address is typed into by hand as often as followed.
 */
const search = z.object({
  checkout: z.enum(['complete']).optional().catch(undefined),
});

export const Route = createFileRoute('/settings/plan')({
  validateSearch: search,
  component: Plan,
});
