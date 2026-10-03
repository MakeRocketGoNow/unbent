/**
 * Which commit this page was built from, written in by `vite.config.ts` at build time.
 *
 * The page's own build rather than the server's, and deliberately: the service worker
 * keeps the built app on the device and waits for a change of section before it loads a
 * new deploy (`sw-register.ts`), so for a while after a merge the Worker answering is newer
 * than the page on screen. "Is my fix live here?" is a question about the page, and only
 * the bundle can answer it. The Worker and the page ship from one build, so once the page
 * has caught up the two are the same commit.
 *
 * `index.html` carries the same commit in `<meta name="unbent-commit">`, so what a deploy
 * is serving can be read without signing in — `curl -s https://unbent.app | grep commit`.
 */
export interface BuildInfo {
  /** The full SHA. */
  commit: string;
  /**
   * When the commit was made, as ISO 8601, or null when the build could not read it — a
   * preview, which is built from the PR's merge commit but names the PR's head, which a
   * shallow checkout does not have.
   */
  date: string | null;
  /** The commit on GitHub, or null for a build made outside CI, whose commit may not be pushed. */
  url: string | null;
  /** Built from a working tree with changes not yet committed: only ever a local build. */
  dirty: boolean;
}

declare const __UNBENT_BUILD__: BuildInfo | null | undefined;

/**
 * Null under vitest, whose config does not run the define, and for a build made where git
 * could not be read — a tarball with no `.git`.
 */
export const buildInfo: BuildInfo | null =
  typeof __UNBENT_BUILD__ === 'undefined' ? null : __UNBENT_BUILD__;

/**
 * "Version 3d544d9 · 3 Oct", for the account menu.
 *
 * Seven characters because that is what GitHub and `git log --oneline` show, so the line
 * can be matched against either by eye. The date because a short SHA alone says nothing
 * about how old a build is, and "is this the deploy from this morning" is most of what
 * people look here to answer; the year only when it is not this one.
 */
export function buildLabel(info: BuildInfo, now: Date = new Date()): string {
  const parts = [`Version ${info.commit.slice(0, 7)}${info.dirty ? ' + changes' : ''}`];
  if (info.date) {
    const date = new Date(info.date);
    parts.push(
      date.toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
      }),
    );
  }
  return parts.join(' · ');
}

/** The tooltip: the whole SHA, which is what a search or `git show` wants, and the time. */
export function buildTitle(info: BuildInfo): string {
  const lines = [`Commit ${info.commit}`];
  if (info.date) lines.push(new Date(info.date).toLocaleString());
  if (info.dirty) lines.push('Built with uncommitted changes');
  return lines.join('\n');
}
