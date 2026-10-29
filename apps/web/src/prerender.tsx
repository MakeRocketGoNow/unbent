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
import { keys } from './queries.js';
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
 * Only the pages for people who are not signed in belong here, and not all of those:
 * `/` is served as `index.html`, which is the shell for every route of the app, so a
 * copy of the front page written there would be drawn for a moment on every page load
 * of the notes. The pricing page could join the list; the story, the comparisons and
 * the features page are the ones a search lands on, so they went first.
 *
 * What the page is rendered with is the least the shell needs: a config that says there
 * is a front page, and nothing of the operator (`legal`, `operator`), which the build
 * cannot know. The footer's Privacy and Terms links are therefore missing from
 * the static copy and arrive when the app runs. No session either, so the way out is the
 * trial, which is what a visitor who has never signed in should read.
 */
export interface PrerenderedPage {
  component: FunctionComponent;
  meta: PageMeta;
  /** The file under `dist/`, which the asset layer serves for the page's address. */
  file: string;
}

/**
 * Each page's file is flat, `compare-joplin.html` rather than `compare/joplin.html`, so no
 * address the asset layer resolves on its own lands on one. The Worker's `PRERENDERED`
 * (`apps/api/src/lib/front-pages.ts`) names the same files and must be kept in step.
 */
export const PAGES: Record<string, PrerenderedPage> = {
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
  client.setQueryData(keys.config(), { providers: [], frontPage: true });
  return renderToString(
    <QueryClientProvider client={client}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
}
