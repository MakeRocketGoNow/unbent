import { createFileRoute, Outlet } from '@tanstack/react-router';
import { z } from 'zod';
import { NOTE_SORTS, UNFILED, dateOnlySchema, parseFieldFilter } from '@unbent/shared';
import { NotesLayout } from '../components/NotesLayout.js';
import { notesQuery, tagsQuery, notebooksQuery, trashCountQuery } from '../queries.js';

/**
 * Filters that scope the note list.
 *
 * These stay search params rather than path segments because they are filters, not
 * identity: a note keeps its id whichever notebook you were browsing. The names match the
 * API's own query parameters so they pass through to `notes-api.ts` untranslated.
 *
 * `catch` rather than a hard failure — a stale or hand-edited link should open the app
 * with the bad filter dropped, not show an error page. `UNFILED` is a sentinel meaning
 * "notes in no notebook" rather than a notebook name, so it is allowed through explicitly.
 */
const name = z.string().trim().min(1).max(100);

/**
 * The tag filter, which may name more than one.
 *
 * Read as either shape: a bare `?tag=Receipt` or a list. Both reach the app as an array, so
 * nothing downstream has to care which was written — several tags narrow conjunctively, and
 * a note must carry all of them. Accepting the bare form is what keeps older links, and
 * hand-typed ones, working unchanged.
 *
 * **What the URL actually looks like.** Not `?tag=a&tag=b`, which an earlier version of
 * this comment claimed. This router JSON-encodes an array search param, so the URL reads
 * `?tag=["a","b"]`, percent-escaped:
 *
 *     /notes?tag=%5B%22Receipt%22%5D
 *
 * That is ugly to paste, and writing a bare string for the single-tag case looks like an
 * easy fix — the router does serialize a lone string plainly, and the union above already
 * reads it back. It does not work, and it is worth knowing why before trying it again.
 * `validateSearch` runs on every navigation and this schema's `transform` coerces a string
 * into a one-element array; the router then serializes *that* result into the URL. So the
 * bare string is normalized away before it is ever written, and the JSON array comes back.
 * Verified against the router, not reasoned about.
 *
 * Making it stick would mean either dropping the coercion — which breaks the old links this
 * union exists to keep — or a custom `stringifySearch`/`parseSearch` pair on the router,
 * which would take ownership of encoding *every* search param in the app to improve how one
 * of them looks. Neither is worth it for an ugly but working link, so the JSON array stays.
 *
 * Not to be confused with the outbound API query, which is a separate serialization in
 * `notes-api.ts` and *does* repeat the param — `?tag=a&tag=b` — because that is what the
 * Worker reads. The two are different wires and are allowed to disagree.
 */
const tagFilter = z
  .union([name, z.array(name)])
  .optional()
  .catch(undefined)
  .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]))
  .pipe(z.array(name).max(20).optional());

/**
 * The tag selection as the URL should carry it: the list, or nothing at all.
 *
 * Dropping to `undefined` at zero is the whole job — it keeps a bare `?tag=` out of the URL
 * when the last tag is removed. It is a function rather than a line repeated at each call
 * site because two components write this filter, and a writer that forgot the empty case
 * would leave a dead parameter behind on a link.
 *
 * It deliberately does *not* write a bare string for a single tag; see the note on
 * `tagFilter` above for why that cannot work here.
 */
export function writeTagFilter(tags: string[]): string[] | undefined {
  return tags.length > 0 ? tags : undefined;
}

/**
 * The field filters, in the tag filter's shape: a bare string or a list, normalised to a
 * list, and carried as the `<fieldId>:<op>[:<value>]` strings the API reads. Kept as
 * strings rather than parsed: the URL is the one spelling the query key hashes, and the
 * API parses them itself. One that cannot be read is dropped here rather than sent, since
 * the API would refuse the whole request for it and a stale link should still open.
 */
const fieldFilter = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .catch(undefined)
  .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]))
  .pipe(
    z
      .array(z.string().refine((raw) => parseFieldFilter(raw) !== null))
      .max(10)
      .optional()
      .catch(undefined),
  );

/** The field selection as the URL should carry it — `writeTagFilter`'s rule, for fields. */
export function writeFieldFilter(fields: string[]): string[] | undefined {
  return fields.length > 0 ? fields : undefined;
}

export const filters = z.object({
  notebook: z.union([z.literal(UNFILED), name]).optional().catch(undefined),
  tag: tagFilter,
  field: fieldFilter,
  q: z.string().max(500).optional().catch(undefined),
  /**
   * Ordering, left undefined at the default so a plain `/notes` URL stays clean and the
   * API's own default is the single source of truth for what "no sort" means.
   */
  sort: z.enum(NOTE_SORTS).optional().catch(undefined),
  order: z.enum(['asc', 'desc']).optional().catch(undefined),
  /**
   * A custom field to order by instead of `sort`, by id — what the table view's field
   * columns write. Only its shape is checked here; whether it is one of this user's
   * fields is only known once the notebook's definitions load, and `NotesLayout` drops a
   * stale one then, the way `NotebookSelect` reports a notebook that no longer exists.
   */
  sortField: z.string().uuid().optional().catch(undefined),
  /**
   * How the list is drawn: the sidebar of entries, or the table of a notebook's fields.
   *
   * In the URL for the reason the sort is: it is how you are looking, and "Coupons as a
   * table, by expiry" is a thing worth bookmarking — a sidebar width is not, which is why
   * that one lives in storage alone. Absent means "this device's usual view", which
   * `useNotesView` supplies, so a plain `/notes` link opens the way you last left it.
   * Not among the loader's dependencies: it changes what is drawn, never what is fetched.
   * Where a table cannot be drawn — a phone, outside a notebook, over search results —
   * it is ignored rather than stripped, so the link still means it on a screen that can.
   */
  view: z.enum(['list', 'table']).optional().catch(undefined),
  /** Inclusive `YYYY-MM-DD` bounds, filtering the column the sort uses. */
  from: dateOnlySchema.optional().catch(undefined),
  to: dateOnlySchema.optional().catch(undefined),
});

export const Route = createFileRoute('/notes')({
  validateSearch: filters,
  // Only the filters affect the list; `q` drives search, which is debounced in the
  // component and must not refetch the list on every keystroke.
  loaderDeps: ({ search }) => ({
    notebook: search.notebook,
    tag: search.tag,
    field: search.field,
    sort: search.sort,
    order: search.order,
    sortField: search.sortField,
    from: search.from,
    to: search.to,
  }),
  loader: ({ context: { queryClient }, deps }) => {
    const filter = {
      ...(deps.notebook ? { notebook: deps.notebook } : {}),
      ...(deps.tag?.length ? { tag: deps.tag } : {}),
      ...(deps.field?.length ? { field: deps.field } : {}),
      ...(deps.from ? { from: deps.from } : {}),
      ...(deps.to ? { to: deps.to } : {}),
    };
    const ordering = {
      ...(deps.sort ? { sort: deps.sort } : {}),
      ...(deps.order ? { order: deps.order } : {}),
      ...(deps.sortField ? { sortField: deps.sortField } : {}),
    };
    /*
     * Warmed, none of it awaited — the list included.
     *
     * The list used to be returned, which held the navigation until the rows arrived.
     * That is the router's contract: nothing about the URL changes until the loader
     * resolves, so for however long the request took, the drawer had closed and the
     * heading still named the old notebook, the old notes still under it, with nothing
     * on screen to say a tap had landed. On a phone across a network that was a full
     * second of the app appearing to ignore its own drawer.
     *
     * Started here and left to run, the request is the same one the component's
     * `useInfiniteQuery` would make — React Query dedupes on the key — but the URL
     * commits immediately, the heading names the new place on the next frame, and the
     * list says it is loading (see `placeholderData` on `notesQuery`, and `aria-busy` in
     * `NotesLayout`) rather than the app saying nothing. A hover preload still warms the
     * cache through this same call.
     */
    void queryClient.ensureQueryData(tagsQuery());
    void queryClient.ensureQueryData(notebooksQuery());
    void queryClient.ensureQueryData(trashCountQuery());
    void queryClient.ensureInfiniteQueryData(notesQuery(filter, ordering));
  },
  component: () => (
    <NotesLayout>
      <Outlet />
    </NotesLayout>
  ),
});
