import { createFileRoute, redirect } from '@tanstack/react-router';
import { ensureSession } from '../auth-client.js';
import { LOGIN } from '../auth-gate.js';
import { configQuery } from '../queries.js';
import { FeaturesPage } from '../components/FeaturesPage.js';

/**
 * Every feature, shown: pictures and clips of the app, on an address of its own.
 *
 * The story's rules, for the story's reasons (`routes/why.tsx`): a page, not a doorway,
 * so a signed-in person who follows a link to it reads it; public through `shellFor`
 * (`FEATURES` in `auth-gate.ts`); and the sign-in screen instead on an instance with no
 * front page, so a fork deployed unchanged shows nobody pictures of the demo library
 * under its own name. The build writes it out as static HTML too (`prerender.tsx`),
 * which the Worker serves in place of the shell (`lib/front-pages.ts`), so a search
 * lands on the page and not the empty shell.
 */
export const Route = createFileRoute('/features')({
  beforeLoad: async ({ context }) => {
    const [, config] = await Promise.all([
      ensureSession(),
      context.queryClient.ensureQueryData(configQuery()).catch(() => undefined),
    ]);
    if (!config?.frontPage) throw redirect({ to: LOGIN, replace: true });
  },
  component: FeaturesPage,
});
