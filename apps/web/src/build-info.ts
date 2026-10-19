/**
 * Which commit this page was built from, written in by `vite.config.ts` at build time.
 *
 * The page's own build rather than the server's, and deliberately: a page in use keeps
 * running the build it loaded until it is reloaded (`sw-register.ts`), so for a while
 * after a merge the Worker answering is newer than the page on screen. "Is my fix live
 * here?" is a question about the page, and only the bundle can answer it. The Worker and
 * the page ship from one build, so once the page has been reloaded the two are the same
 * commit.
 *
 * Shown in two places. Settings › About is its home on every instance. On dev and
 * previews the account menu's instance line carries the short form as well, since that is
 * where a commit gets checked many times a day, right after a push. `index.html` carries
 * the full SHA in `<meta name="unbent-commit">`, so what a deploy is serving can be read
 * without signing in: `curl -s https://unbent.app | grep unbent-commit`.
 */
export interface BuildInfo {
  /** The full SHA. */
  commit: string;
  /**
   * When the commit was made, as ISO 8601, or null when the build could not read it: a
   * preview, which is built from the PR's merge commit but names the PR's head, which a
   * shallow checkout does not have.
   */
  date: string | null;
  /** The commit on GitHub, or null for a build made outside CI, whose commit may not be pushed. */
  url: string | null;
  /** The repository CI built from, for the source link; null outside CI, as `url` is. */
  repo: string | null;
  /** Built from a working tree with changes not yet committed: only ever a local build. */
  dirty: boolean;
}

declare const __UNBENT_BUILD__: BuildInfo | null | undefined;

/**
 * Null under vitest, whose config does not run the define, and for a build made where git
 * could not be read: a tarball with no `.git`.
 */
export const buildInfo: BuildInfo | null =
  typeof __UNBENT_BUILD__ === 'undefined' ? null : __UNBENT_BUILD__;

/**
 * Seven characters, because that is what GitHub and `git log --oneline` show, so the two
 * can be matched by eye.
 */
export function shortCommit(info: BuildInfo): string {
  return info.commit.slice(0, 7);
}

/**
 * "Oct 3, 2026, 2:20 PM" in the reader's own locale and time zone, or null when the build
 * could not read the date.
 *
 * A short SHA alone says nothing about how old a build is, and "is this the deploy from
 * this morning" is most of what people look it up to answer. The day is not enough for
 * that: several merges land in one day, and the time is what tells the latest from the one
 * before it.
 */
export function commitDate(info: BuildInfo): string | null {
  if (!info.date) return null;
  return new Date(info.date).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** "github.com/owner/repo", for the source link's text: the address without its scheme. */
export function repoName(info: BuildInfo): string | null {
  return info.repo ? info.repo.replace(/^https?:\/\//, '') : null;
}

/**
 * Where to send feedback: the repository's issue forms, a bug report and a feature request
 * (`.github/ISSUE_TEMPLATE/`). Null where the build has no repository, as for the source
 * link.
 *
 * The repository CI built from rather than a setting, for the reason the source link is: a
 * fork's instance sends its people to the fork, whose operator is the one who can fix what
 * they report, and unbent.app needs nothing configured. A build made outside CI has no
 * repository to name, so it offers no feedback link, which on a local build is no loss.
 */
export function feedbackUrl(info: BuildInfo): string | null {
  return info.repo ? `${info.repo}/issues/new/choose` : null;
}

/**
 * The bug report form itself, with the version filled in: the one fact every report needs
 * and that nobody knows where to find. GitHub fills a form's field from the query parameter
 * named for its `id`, so `version` here and in `bug.yml` must stay the same word.
 */
export function bugReportUrl(info: BuildInfo): string | null {
  // Written out rather than built, since `url-boundary.test.ts` keeps query building to
  // the router: a short commit is hex and needs no encoding.
  return info.repo ? `${info.repo}/issues/new?template=bug.yml&version=${shortCommit(info)}` : null;
}

/** The feature request form. */
export function featureRequestUrl(info: BuildInfo): string | null {
  return info.repo ? `${info.repo}/issues/new?template=feature.yml` : null;
}
