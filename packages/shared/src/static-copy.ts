/**
 * What a page's static copy says in place of the operator, for the Worker to fill in.
 *
 * The build writes the public pages out as HTML (`prerender.tsx` in the web app) and
 * cannot know who runs the instance it will be served from: that is `OPERATOR_NAME` and
 * `OPERATOR_EMAIL` on the Worker. Most copies simply leave the operator out, and the app
 * adds what it draws from them once it runs (the footer's Privacy and Terms links). The
 * support page cannot: its first sentence is the operator's address, and a copy without
 * it would say something else there and change under the reader once the app took over,
 * and a crawler would index a support page with no way to reach anyone.
 *
 * So the support page is rendered with these as the operator, and the Worker replaces
 * them with the instance's own (`fillOperator` in `apps/api/src/lib/front-pages.ts`), or
 * serves the shell where no operator is configured, as the app then draws the page
 * without one. Tokens rather than plausible values, so a copy read raw (the asset layer
 * answers `/support.html` itself, as it does every copy's file name) shows a blank to be
 * filled and claims nobody's address. Only characters that HTML escaping leaves alone, so
 * the token in the file is the token here.
 */
export const OPERATOR_PLACEHOLDER = {
  name: '__UNBENT_OPERATOR_NAME__',
  email: '__UNBENT_OPERATOR_EMAIL__',
} as const;
