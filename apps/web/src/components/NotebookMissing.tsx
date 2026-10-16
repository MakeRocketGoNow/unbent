import { Link } from '@tanstack/react-router';
import { UNFILED } from '@unbent/shared';
import type { NotebookData } from './NotebookNav.js';
import { EmptyState } from './EmptyState.js';
import { NotebookMissingIcon } from './icons.js';
import { rememberedSort } from '../notebook-sort.js';
import { sameNotebookName } from '../store/derive.js';

interface NotebookMissingProps {
  notebook: string | undefined;
  notebooks: { data: NotebookData | undefined; isSuccess: boolean };
  /** The notebook list is the whole account's (`useLibraryWhole`). */
  whole: boolean;
}

/**
 * Whether the URL names a notebook that does not exist.
 *
 * A notebook that no longer exists is syntactically valid, so `validateSearch` cannot
 * reject it: only the loaded list can. Never before the notebooks have loaded, since
 * until then every name is unknown, nor while the library is still arriving: a list read
 * from half a copy, or from one a `reset` has just emptied, lacks notebooks that exist,
 * and the state replaces the very list that is about to fill. Never for the inbox, which
 * is a filter rather than a notebook. Names compare as the list's filter and the server
 * compare them, without case (`sameNotebookName`): `?notebook=work` lists Work's notes,
 * so it must not also say there is no Work. The layout reads this too, to put the
 * state in the list's place and to withhold the header's count, which would otherwise
 * be "0 notes" of a notebook that does not exist.
 */
export function isNotebookMissing(
  notebook: string | undefined,
  notebooks: NotebookMissingProps['notebooks'],
  whole: boolean,
): boolean {
  return Boolean(
    notebook &&
      notebook !== UNFILED &&
      whole &&
      notebooks.isSuccess &&
      !notebooks.data?.notebooks.some((nb) => sameNotebookName(nb.name, notebook)),
  );
}

/**
 * The URL names a notebook that does not exist: a stale link, a bookmark, a notebook
 * renamed or deleted on another device.
 *
 * Saying so beats the silent desync, where the URL filtered by a notebook the navigation
 * did not mark and the empty list looked like a data problem. Drawn in the list column at
 * every width, in the list's place (not in the workspace pane, which can hold an open
 * note, `/notes/<id>?notebook=Gone`) and in the same shape as an empty account's state
 * (`EmptyState`), because it is the same kind of moment: nothing to list, and one obvious
 * way on.
 *
 * It used to be a red line under the header ("No notebook named …" and a bare link)
 * with "No notes in …" under it and "0 notes" above. Red was wrong: nothing here is the
 * person's fault or a failure to put right, and a warning colour for a link that went
 * stale reads as something broken. The same fact twice and a count of a notebook that
 * does not exist made it worse. Now there is one statement, no count, and no red.
 *
 * The way out is navigation, so it stays a real link (middle-click, new tab) drawn as
 * the outlined button at the large size: it is the only action, but leaving is not what
 * this view is for, so it is not filled. It goes to All notes in that place's remembered
 * order (`rememberedSort`), as every other way there does.
 *
 * The name is whatever the link said and has no length limit; the stack wraps it rather
 * than letting it widen the column (`.empty-state-lead`).
 */
export function NotebookMissing({ notebook, notebooks, whole }: NotebookMissingProps) {
  if (!isNotebookMissing(notebook, notebooks, whole)) return null;
  return (
    <EmptyState
      icon={<NotebookMissingIcon />}
      heading="Notebook not found"
      headingLevel="h3"
      lead={<>There is no notebook named “{notebook}”. It may have been renamed or deleted.</>}
      actions={
        <Link
          to="/notes"
          search={(prev) => ({ ...prev, notebook: undefined, ...rememberedSort(undefined) })}
          className="btn btn-secondary btn-large empty-state-action"
        >
          Show all notes
        </Link>
      }
    />
  );
}
