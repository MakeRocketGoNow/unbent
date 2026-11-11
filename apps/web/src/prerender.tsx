import type { FunctionComponent } from 'react';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { OPERATOR_PLACEHOLDER, type AppConfig } from '@unbent/shared';
import { keys } from './queries.js';
import { FrontPage, FRONT_META } from './components/FrontPage.js';
import { WhyPage, WHY_META } from './components/WhyPage.js';
import { FeaturesPage, FEATURES_META } from './components/FeaturesPage.js';
import {
  CompareIndexPage,
  EvernoteComparison,
  JoplinComparison,
  NotionComparison,
  PaperlessNgxComparison,
} from './components/ComparePage.js';
import { COMPARE_META, comparison } from './components/comparisons.js';
import { PricingPage, PRICING_META } from './components/PricingPage.js';
import { SupportPage, SUPPORT_META } from './components/SupportPage.js';
import type { PageMeta } from './page-meta.js';

/**
 * The pages the build writes out as static HTML, so that a crawler and a link preview,
 * which run no script, read the page and not the empty shell (MAK-240).
 *
 * Run by the `prerender` plugin in `vite.config.ts`, in Node, after the client build:
 * the plugin loads this module through Vite, renders each page here to a string, and
 * writes it into a copy of the built `index.html` under `file`, with `meta` in the head.
 * The Worker hands that file over for the page's address and completes the addresses in
 * its head (`apps/api/src/lib/front-pages.ts`); the app then takes over in the browser,
 * as `main.tsx` describes.
 *
 * Only the pages for people who are not signed in belong here. The story, the
 * comparisons, the features page and the front page went first, as the ones a search
 * lands on; pricing and support followed on 2026-11-11 (MAK-257), when a search listed
 * both as "Unbent" with the front page's sentence, which is all the shell says.
 *
 * The front page is written to a file of its own, never into `index.html`: that is the
 * shell for every route of the app, so a copy of the front page there would be drawn for
 * a moment on every page load of the notes. The Worker hands the copy over for `/` only
 * to a request with no session cookie (`hasSessionCookie` in `front-pages.ts`), which is
 * a crawler, a link preview and a first visit; anyone signed in gets the shell, and the
 * router sends them on to their notes as before. It was left out until 2026-11-05 for
 * that reason, and the result was the one page a search for the name lands on reaching
 * Google as an empty `#root`.
 *
 * What the page is rendered with is the least the shell needs: a config that says there
 * is a front page, and nothing of the operator (`legal`, `operator`), which the build
 * cannot know. The footer's Privacy and Terms links are therefore missing from
 * the static copy and arrive when the app runs. No session either, so the way out is the
 * trial, which is what a visitor who has never signed in should read.
 *
 * The support page is the one exception to "nothing of the operator": its first sentence
 * is their address, so it is rendered with placeholders the Worker fills in
 * (`OPERATOR_PLACEHOLDER`, whose comment says why), through the page's `config`.
 */
export interface PrerenderedPage {
  component: FunctionComponent;
  meta: PageMeta;
  /** The file under `dist/`, which the asset layer serves for the page's address. */
  file: string;
  /** What the page is rendered with beyond the least every page gets. */
  config?: Partial<AppConfig>;
}

/**
 * Each page's file is flat, `compare-joplin.html` rather than `compare/joplin.html`. The
 * asset layer still serves each at its name without `.html`, raw; why that is left so is
 * on the Worker's `PRERENDERED` (`apps/api/src/lib/front-pages.ts`), which names the
 * same files and must be kept in step, as its `FRONT_FILE` must with the front page's
 * (`prerender.test.tsx` fails when they are not).
 */
export const PAGES: Record<string, PrerenderedPage> = {
  '/': { component: FrontPage, meta: FRONT_META, file: 'front-page.html' },
  '/why': { component: WhyPage, meta: WHY_META, file: 'why.html' },
  '/features': { component: FeaturesPage, meta: FEATURES_META, file: 'features.html' },
  '/compare': { component: CompareIndexPage, meta: COMPARE_META, file: 'compare.html' },
  '/compare/evernote': { component: EvernoteComparison, meta: comparison('evernote').meta, file: 'compare-evernote.html' },
  '/compare/notion': { component: NotionComparison, meta: comparison('notion').meta, file: 'compare-notion.html' },
  '/compare/joplin': { component: JoplinComparison, meta: comparison('joplin').meta, file: 'compare-joplin.html' },
  '/compare/paperless-ngx': {
    component: PaperlessNgxComparison,
    meta: comparison('paperless-ngx').meta,
    file: 'compare-paperless-ngx.html',
  },
  '/pricing': { component: PricingPage, meta: PRICING_META, file: 'pricing.html' },
  '/support': {
    component: SupportPage,
    meta: SUPPORT_META,
    file: 'support.html',
    // No page reads the host, so it is not a placeholder of its own.
    config: { operator: { ...OPERATOR_PLACEHOLDER, host: '' } },
  },
};

/** The page at `path`, as HTML for the inside of `#root`. */
export async function render(path: string): Promise<string> {
  const page = PAGES[path];
  if (!page) throw new Error(`No page to prerender at ${path}`);
  const rootRoute = createRootRoute();
  const route = createRoute({ getParentRoute: () => rootRoute, path, component: page.component });
  const router = createRouter({
    routeTree: rootRoute.addChildren([route]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  const client = new QueryClient();
  client.setQueryData(keys.config(), { providers: [], frontPage: true, ...page.config });
  return renderToString(
    <QueryClientProvider client={client}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
}
