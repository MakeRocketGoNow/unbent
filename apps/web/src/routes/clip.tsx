import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { ClipPage } from '../components/ClipPage.js';

/**
 * `url` is where the bookmarklet's page is: what `/clip` offers to fetch when the tab
 * never sends the page itself. `catch`-ed so a stray or mangled visit renders the page's
 * explanation rather than an error.
 */
const search = z.object({
  url: z.string().max(8192).optional().catch(undefined),
});

export const Route = createFileRoute('/clip')({
  validateSearch: search,
  component: ClipRoute,
});

function ClipRoute() {
  const { url } = Route.useSearch();
  return <ClipPage url={url && /^https?:\/\//i.test(url) ? url : undefined} />;
}
