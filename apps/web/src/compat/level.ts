/**
 * Which builds can run side by side. A page asks the worker in charge for its level and
 * says a reload is needed (`UpdateSnackbar`) only when the worker's is higher than its
 * own; a deploy at the same level says nothing, and the next load, whenever it comes,
 * brings it.
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
 * (`contract.test.ts`) records the level beside the shapes it was decided for. That test
 * is what asks the question: it fails on a change to what two builds share, and says
 * which kind it is. See "Builds side by side" in AGENTS.md.
 */
export const COMPAT_LEVEL = 1;
