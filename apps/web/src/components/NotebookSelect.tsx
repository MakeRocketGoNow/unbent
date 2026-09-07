import { Link, useNavigate } from '@tanstack/react-router';
import { UNFILED } from '@unbent/shared';

/** What the picker needs. Shaped by the API, narrowed to what is drawn. */
export interface NotebookData {
  notebooks: { id: string; name: string; count: number }[];
  unfiled: number;
}

interface NotebookSelectProps {
  notebook: string | undefined;
  notebooks: { data: NotebookData | undefined; isSuccess: boolean };
  /** Whether a rule belongs under it — true when it is the last control before the list. */
  endsFilters?: boolean;
}

/**
 * Which notebook the list is scoped to.
 *
 * Three decisions live in here, which is why it is a component rather than a `<select>`
 * written wherever one is needed: the desync warning above it, clearing the tag on change,
 * and when the Inbox option is worth offering at all. Each is explained where it happens.
 *
 * Desktop only, now. On a phone the notebook is picked from the drawer — it is a place you
 * go rather than a filter you apply, which is what the tag-clearing rule below has been
 * saying all along.
 */
export function NotebookSelect({ notebook, notebooks, endsFilters }: NotebookSelectProps) {
  const navigate = useNavigate();
  if ((notebooks.data?.notebooks.length ?? 0) === 0) return null;

  return (
    <>
      {/*
          A notebook that no longer exists is syntactically valid, so validateSearch
          cannot reject it — only the loaded list can. Saying so beats the old silent
          desync, where the URL filtered by a notebook while the picker read "All
          notebooks" and the empty list looked like a data problem.
      */}
      {notebook &&
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

      <div className={`notebook-scope-wrap${endsFilters ? ' filters-end' : ''}`}>
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
    </>
  );
}
