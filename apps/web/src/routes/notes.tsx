import { createFileRoute, Outlet } from '@tanstack/react-router';
import { z } from 'zod';
import { NOTE_SORTS, UNFILED, dateOnlySchema } from '@unbent/shared';
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

const filters = z.object({
  notebook: z.union([z.literal(UNFILED), name]).optional().catch(undefined),
  tag: name.optional().catch(undefined),
  q: z.string().max(500).optional().catch(undefined),
  /**
   * Ordering, left undefined at the default so a plain `/notes` URL stays clean and the
   * API's own default is the single source of truth for what "no sort" means.
   */
  sort: z.enum(NOTE_SORTS).optional().catch(undefined),
  order: z.enum(['asc', 'desc']).optional().catch(undefined),
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
    sort: search.sort,
    order: search.order,
    from: search.from,
    to: search.to,
  }),
  loader: ({ context: { queryClient }, deps }) => {
    const filter = {
      ...(deps.notebook ? { notebook: deps.notebook } : {}),
      ...(deps.tag ? { tag: deps.tag } : {}),
      ...(deps.from ? { from: deps.from } : {}),
      ...(deps.to ? { to: deps.to } : {}),
    };
    const ordering = {
      ...(deps.sort ? { sort: deps.sort } : {}),
      ...(deps.order ? { order: deps.order } : {}),
    };
    // Warmed, not awaited except for the list: the sidebar's tag and notebook counts can
    // arrive a moment later without holding up the notes themselves.
    void queryClient.ensureQueryData(tagsQuery());
    void queryClient.ensureQueryData(notebooksQuery());
    void queryClient.ensureQueryData(trashCountQuery());
    return queryClient.ensureInfiniteQueryData(notesQuery(filter, ordering));
  },
  component: () => (
    <NotesLayout>
      <Outlet />
    </NotesLayout>
  ),
});
