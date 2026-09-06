import { Link, useNavigate } from '@tanstack/react-router';
import { UNFILED, type NoteSort } from '@unbent/shared';
import * as api from '../notes-api.js';
import type { NoteFilter } from '../queries.js';
import { Button } from './Button';
import { Disclosure } from './Disclosure.js';
import { SORT_OPTIONS, sortKey, parseSortKey } from './sort-options.js';

/** What the notebook picker needs. Shaped by the API, narrowed to what is drawn. */
interface NotebookData {
  notebooks: { id: string; name: string; count: number }[];
  unfiled: number;
}

export interface FilterControlsProps {
  notebook: string | undefined;
  selectedTags: string[];
  from: string | undefined;
  to: string | undefined;
  sort: NoteSort | undefined;
  order: 'asc' | 'desc' | undefined;
  /** True while search results are on screen, which changes what is worth offering. */
  searching: boolean;
  /** Total matching notes, for the export link's label. Null while it is still unknown. */
  total: number | null;
  /** The active filter, for the export URL. Built by the caller, which also queries with it. */
  filter: NoteFilter;
  notebooks: { data: NotebookData | undefined; isSuccess: boolean };
  tags: { data: { name: string; count: number }[] | undefined };
  /**
   * Whether the sort control belongs in this stack.
   *
   * False on a phone, where sort has its own menu in the list header. It is not a filter —
   * it changes the order of the list, not which notes are in it — so a surface headed
   * "Filter notes" is the wrong home for it, and the Android app splits them the same way
   * for the same reason: among the filters, "Title A–Z" invites being read as something
   * that narrows.
   */
  showSort?: boolean;
  /**
   * How the tag list is presented.
   *
   * `disclosure` is the sidebar's collapsible row. `open` drops the `<details>` and draws
   * the pills directly, for the filter sheet — a surface the user opened to filter, where
   * one more thing to expand before anything can be picked is a tap that says nothing.
   */
  tagList?: 'disclosure' | 'open';
  /**
   * Extra class on the wrapper.
   *
   * The sidebar renders these as bare children of a flex column and wants no box of its
   * own; the sheet wants one, with its own rhythm.
   */
  className?: string;
}

/**
 * Everything that narrows the note list, plus the sort that orders it.
 *
 * Extracted from `NotesLayout` because two surfaces draw it now: the desktop sidebar, where
 * it is an always-visible stack, and the phone's filter sheet, where it is behind an icon.
 * Both render the same controls with the same handlers — the alternative was a phone copy of
 * six controls, and the notebook select alone carries three decisions (the desync warning,
 * the tag clear, the conditional Inbox option) that a copy would quietly lose.
 *
 * It navigates rather than calling back: the filters live in the URL, so a control's job is
 * finished when it has written one. That is also why this takes no state and holds none —
 * `Route.useSearch()` in the parent is the single source, and this is a projection of it.
 */
export function FilterControls({
  notebook,
  selectedTags,
  from,
  to,
  sort,
  order,
  searching,
  total,
  filter,
  notebooks,
  tags,
  showSort = true,
  tagList = 'disclosure',
  className,
}: FilterControlsProps) {
  const navigate = useNavigate();

  /**
   * The export link is the current filter, serialized. Because the filters already live in
   * the URL there is no separate state to keep in step — the link is the view.
   */
  const isFiltered = Boolean(notebook || selectedTags.length || from || to);

  const tagPills = (
    <div className="tag-filter">
      {tags.data?.map((t) => {
        const on = selectedTags.includes(t.name);
        return (
          <button
            key={t.name}
            type="button"
            className={on ? 'tag-filter-item active' : 'tag-filter-item'}
            aria-pressed={on}
            onClick={() =>
              void navigate({
                to: '/notes',
                search: (prev) => {
                  /*
                   * Tags accumulate rather than replace: picking a second one
                   * narrows to notes carrying both. Dropping to undefined at zero
                   * keeps `?tag=` out of the URL when nothing is selected.
                   */
                  const next = on
                    ? selectedTags.filter((name) => name !== t.name)
                    : [...selectedTags, t.name];
                  return { ...prev, tag: next.length ? next : undefined };
                },
              })
            }
          >
            {t.name}
            <span className="tag-count">{t.count}</span>
          </button>
        );
      })}
    </div>
  );

  return (
    <div className={className ? `filter-controls ${className}` : 'filter-controls'}>
      {/*
          A notebook that no longer exists is syntactically valid, so validateSearch
          cannot reject it — only the loaded list can. Saying so beats the old silent
          desync, where the URL filtered by a notebook while the picker read "All
          notebooks" and the empty list looked like a data problem.
      */}
      {!searching &&
        notebook &&
        notebook !== UNFILED &&
        notebooks.isSuccess &&
        !notebooks.data?.notebooks.some((nb) => nb.name === notebook) && (
          <p className="bad small">
            No notebook named “{notebook}”.{' '}
            <Link to="/notes" search={(prev) => ({ ...prev, notebook: undefined })}>
              Show all notes
            </Link>
          </p>
        )}

      {!searching && (notebooks.data?.notebooks.length ?? 0) > 0 && (
        <div
          className={`notebook-scope-wrap${(tags.data?.length ?? 0) === 0 ? ' filters-end' : ''}`}
        >
          <select
            className="notebook-scope"
            value={notebook ?? ''}
            // Clearing the tag matters: tags cross notebook boundaries, so keeping one
            // selected here routinely yields an empty list with no visible cause.
            onChange={(e) =>
              void navigate({
                to: '/notes',
                search: (prev) => ({
                  ...prev,
                  notebook: e.target.value || undefined,
                  tag: undefined,
                }),
              })
            }
            aria-label="Notebook"
          >
            <option value="">All notebooks</option>
            {notebooks.data?.notebooks.map((nb) => (
              <option key={nb.id} value={nb.name}>
                {nb.name} ({nb.count})
              </option>
            ))}
            {/*
                "Inbox" is the label for having no notebook — the same state the API and
                the UNFILED sentinel still call unfiled. One name for one bucket: notes
                arrive here from a phone share and from a deleted notebook alike, and both
                want the same triage. Renaming the sentinel would churn the API for a word.

                Offered only when there is something to see; with nothing unfiled the
                option leads to a guaranteed empty list. It stays rendered while it is the
                active filter so the select never falls back to showing "All notebooks"
                over a URL that says otherwise.
            */}
            {((notebooks.data?.unfiled ?? 0) > 0 || notebook === UNFILED) && (
              <option value={UNFILED}>Inbox ({notebooks.data?.unfiled ?? 0})</option>
            )}
          </select>
        </div>
      )}

      {/*
        * Sort is one control rather than a field plus a direction, because the useful
        * combinations are few and naming them ("Oldest first") is plainer than asking
        * someone to assemble "created" and "ascending" themselves.
        *
        * Hidden while searching: results come back ranked by relevance, and reordering
        * them by date would throw away the ranking that makes them worth showing.
        */}
      {showSort && !searching && (
        <div className="notebook-scope-wrap">
          <select
            className="notebook-scope"
            value={sortKey(sort, order)}
            onChange={(e) =>
              void navigate({
                to: '/notes',
                // The default stays out of the URL so a plain /notes link is clean.
                search: (prev) => ({ ...prev, ...parseSortKey(e.target.value) }),
              })
            }
            aria-label="Sort notes"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {/*
        * Shown while searching too: a date range narrows which notes match, which is a
        * question worth asking of search results, unlike sort which would discard their
        * relevance ranking.
        */}
      <div className="date-range">
        <label>
          <span className="small">From</span>
          <input
            type="date"
            value={from ?? ''}
            max={to ?? undefined}
            onChange={(e) =>
              void navigate({
                to: '/notes',
                search: (prev) => ({ ...prev, from: e.target.value || undefined }),
              })
            }
          />
        </label>
        <label>
          <span className="small">To</span>
          <input
            type="date"
            value={to ?? ''}
            min={from ?? undefined}
            onChange={(e) =>
              void navigate({
                to: '/notes',
                search: (prev) => ({ ...prev, to: e.target.value || undefined }),
              })
            }
          />
        </label>
        {(from || to) && (
          <Button
            variant="quiet"
            size="small"
            onClick={() =>
              void navigate({
                to: '/notes',
                search: (prev) => ({ ...prev, from: undefined, to: undefined }),
              })
            }
          >
            Clear
          </Button>
        )}
      </div>

      {/*
        * Export the current filter.
        *
        * Here rather than only in Settings because this is where the scope was chosen:
        * having filtered to a tag and a year, being sent to another page to describe the
        * same slice again is the failure mode. Shown only when a filter is active — with
        * none, this is the whole-library export, which has its own page and a warning
        * about size that belongs with it.
        *
        * An anchor, like the export page's: the archive is generated as it downloads, so
        * letting the browser consume the response is what keeps a corpus larger than the
        * Worker's memory from ever landing in a JS buffer.
        */}
      {!searching && isFiltered && (
        <a
          className="export-filtered small"
          href={api.exportUrl({ ...filter, sort: sort ?? 'updated' })}
          download
        >
          {total !== null ? `Export these ${total} notes` : 'Export these notes'}
        </a>
      )}

      {!searching &&
        (tags.data?.length ?? 0) > 0 &&
        (tagList === 'open' ? (
          /*
              Open, in the sheet.

              The disclosure below earns its collapse by sitting in a column the user did
              not open on purpose — it is in the way of the notes. A sheet is the opposite:
              it was opened to filter, and hiding the tags behind one more tap inside it
              spends the tap that the sheet already cost.
          */
          <div className="tag-filter-open">
            <span className="filter-section-label">Tags</span>
            {tagPills}
          </div>
        ) : (
          /*
              A disclosure rather than a flat list.

              The tag list is as long as the user has tags — this account has sixteen, and
              they filled most of a phone screen before a single note was visible. Collapsed
              it costs one row; the summary carries the active tag so a filter can never be
              applied invisibly.

              Open where the sidebar has room, closed on a phone — `defaultOpen="wide"` is
              that, and Disclosure carries the remount the default needs to survive a
              viewport change.
          */
          <Disclosure
            className="tag-filter-wrap"
            defaultOpen="wide"
            summary={
              <>
                Tags
                {/* The active tag stays on the row while collapsed, so a filter is never
                    applied invisibly; otherwise the count says what is hidden. */}
                {selectedTags.length > 0 ? (
                  // Every selected tag, not the first and a count: two tags ANDed are a
                  // different question from either alone, and the collapsed row is the only
                  // place a filter shows while the list is closed.
                  selectedTags.map((name) => (
                    <span className="tag-filter-active" key={name}>
                      {name}
                    </span>
                  ))
                ) : (
                  <span className="tag-filter-summary-count">{tags.data?.length}</span>
                )}
              </>
            }
          >
            {tagPills}
          </Disclosure>
        ))}
    </div>
  );
}
