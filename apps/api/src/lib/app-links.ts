/**
 * Links into the web app, for answers read by someone other than the web app itself: an
 * assistant over MCP, which has a note's id and no way to know where that note opens.
 *
 * Built on `APP_URL`, the origin the person reaches this instance on, and never on a
 * second setting of its own. `withAppUrl` has already settled it before any route runs
 * (the configured value, or the origin the request arrived on), so a hosted instance, a
 * self-hosted fork on its own domain and a worktree's dev server each link to themselves
 * with nothing to configure. A separate base URL for links would be one more value that
 * could disagree with the origin sign-in trusts, and the link would then open a page that
 * cannot sign in.
 *
 * The paths are the web app's routes, which nothing here can import:
 *
 *   /notes/$noteId          apps/web/src/routes/notes.$noteId.tsx
 *   /trash/$noteId          apps/web/src/routes/trash.$noteId.tsx
 *   /notes?notebook=<name>  the `notebook` filter in apps/web/src/routes/notes.tsx
 *
 * A trashed note gets the trash's address because `/notes/$noteId` is the live list's; a
 * trashed note opened there is not the note the link promised. A notebook has no page of
 * its own: browsing one is a filter on the list, by name, so its link is that filter and
 * stops matching if the notebook is renamed. Change a route and change it here.
 */
export interface AppLinks {
  note(id: string, opts?: { trashed?: boolean }): string;
  notebook(name: string): string;
}

/**
 * Throws on an `APP_URL` that is not an absolute URL, rather than answering with links
 * that go nowhere: a malformed value already breaks sign-in on the same instance, and
 * failing here says so by name where a broken link would only say it to the person who
 * clicked it.
 */
export function appLinks(appUrl: string): AppLinks {
  let base: URL;
  try {
    base = new URL(appUrl);
  } catch {
    throw new Error(`APP_URL is not an absolute URL (${JSON.stringify(appUrl)}), so no link into the app can be built.`);
  }
  // Root-relative paths resolve against the origin, so a trailing slash or a path on the
  // setting cannot double up or misplace a segment. The app is always served at the root.
  const at = (path: string) => new URL(path, base.origin).toString();
  return {
    note: (id, opts) => at(`/${opts?.trashed ? 'trash' : 'notes'}/${encodeURIComponent(id)}`),
    notebook: (name) => at(`/notes?${new URLSearchParams({ notebook: searchValue(name) })}`),
  };
}

/**
 * A string search param as the web app's router writes it, so that it reads it back as the
 * same string. TanStack Router JSON-parses every value it finds, which turns a notebook
 * called `2024` into a number and `true` into a boolean, and the notes route's schema then
 * drops the filter as invalid, opening the whole list instead. The router's own
 * `stringifySearch` quotes exactly the strings that would parse, and this does the same:
 * `Watch Later` goes out bare, `2024` as `"2024"`.
 */
function searchValue(value: string): string {
  try {
    JSON.parse(value);
    return JSON.stringify(value);
  } catch {
    return value;
  }
}
