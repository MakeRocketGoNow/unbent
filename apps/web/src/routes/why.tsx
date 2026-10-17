import { createFileRoute, redirect } from '@tanstack/react-router';
import { ensureSession } from '../auth-client.js';
import { LOGIN } from '../auth-gate.js';
import { configQuery } from '../queries.js';
import { WhyPage } from '../components/WhyPage.js';

/**
 * Why Unbent exists: the origin story, on an address of its own (MAK-240).
 *
 * The pricing page's rules, for the pricing page's reasons: a page, not a doorway, so a
 * signed-in person who follows a link to it reads it rather than landing in their notes;
 * public through `shellFor` (`WHY` in `auth-gate.ts`), since the person it is for has no
 * account yet; and on an instance with no front page the sign-in screen instead, so a
 * fork deployed unchanged tells nobody's story but its own. The session is asked for
 * beside the config so the page draws once, with the right way out for whoever is
 * reading.
 *
 * The build also writes this page out as static HTML (`prerender.tsx`), which the Worker
 * serves in place of the shell on an instance with a front page (`lib/front-pages.ts`),
 * so a crawler or a link preview reads the story without running the app. The route
 * here is what the app draws once it is running, and what the dev server draws always.
 */
export const Route = createFileRoute('/why')({
  beforeLoad: async ({ context }) => {
    const [, config] = await Promise.all([
      ensureSession(),
      context.queryClient.ensureQueryData(configQuery()).catch(() => undefined),
    ]);
    if (!config?.frontPage) throw redirect({ to: LOGIN, replace: true });
  },
  component: WhyPage,
});
