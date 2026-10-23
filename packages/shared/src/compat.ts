/**
 * Which builds can run side by side. A page learns the level of the deploy in charge from
 * the worker that takes charge of it and from every answer the API gives
 * (`COMPAT_HEADER`), and says a reload is needed (`UpdateSnackbar` in the web app) only
 * when that level is not its own; a deploy at the same level says nothing, and the next
 * load, whenever it comes, brings it.
 *
 * In `@unbent/shared`, under an entry point of its own (`@unbent/shared/compat`), because
 * the Worker states it and the page and its service worker compare it: one number for one
 * build, and the service worker must not pull the whole package in to read it.
 *
 * It used to be said for every deploy, by comparing commits, and with several merges a
 * day the people trying the app were asked to reload more often than they did anything
 * else. Nothing about an ordinary deploy needs one: every build an open page runs keeps
 * its shell (`tidyShellCaches` in `sw.ts`) and a page load is always the newest build.
 * What does need one is a change the page still open cannot live with: the API refusing
 * what it sends, a worker or another tab speaking a protocol it does not know, a local
 * database laid out in a way it cannot read.
 *
 * Raised only by `pnpm compat:bump`, never by hand, because the contract test
 * (`apps/web/src/compat/contract.test.ts`) records the level beside the shapes it was
 * decided for. That test is what asks the question: it fails on a change to what two
 * builds share, and says which kind it is. See "Builds side by side" in AGENTS.md.
 */
export const COMPAT_LEVEL = 3;

/** The header every API answer states `COMPAT_LEVEL` in. */
export const COMPAT_HEADER = 'X-Unbent-Compat';
