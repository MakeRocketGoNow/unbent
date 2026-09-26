import { Link } from '@tanstack/react-router';
import { UNFILED } from '@unbent/shared';
import type { NotebookData } from './NotebookNav.js';
import { rememberedSort } from '../notebook-sort.js';

interface NotebookMissingProps {
  notebook: string | undefined;
  notebooks: { data: NotebookData | undefined; isSuccess: boolean };
}

/**
 * The URL names a notebook that does not exist.
 *
 * A notebook that no longer exists is syntactically valid, so `validateSearch` cannot
 * reject it — only the loaded list can. Saying so beats the silent desync, where the URL
 * filtered by a notebook the navigation did not mark and the empty list looked like a
 * data problem. Drawn under the list header at every width: a stale link opens the same
 * way on a phone. Nothing until the notebooks have loaded, since until then every name
 * is unknown.
 */
export function NotebookMissing({ notebook, notebooks }: NotebookMissingProps) {
  if (
    !notebook ||
    notebook === UNFILED ||
    !notebooks.isSuccess ||
    notebooks.data?.notebooks.some((nb) => nb.name === notebook)
  ) {
    return null;
  }
  return (
    <p className="bad small">
      No notebook named “{notebook}”.{' '}
      <Link to="/notes" search={(prev) => ({ ...prev, notebook: undefined, ...rememberedSort(undefined) })}>
        Show all notes
      </Link>
    </p>
  );
}
