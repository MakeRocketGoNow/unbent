import { addressOfView, type NotebookView } from '@unbent/shared';

/**
 * The address a saved view opens at: its notebook, its own id, and every filter it keeps.
 *
 * Every filter param is written, the absent ones as `undefined`, rather than spread over
 * the current address. A view is a whole list, and a tag or a date range left over from
 * wherever the person was would open it already edited. The search text goes too: a view
 * does not keep one (see `views.ts`), and one carried in would narrow the view's list by
 * something that is not the view. The layout is the view's when it kept one; otherwise
 * it is left unsaid, and `NotesLayout` writes in the one last seen.
 */
export function viewSearch(notebook: string, view: Pick<NotebookView, 'id' | 'query'>) {
  const a = addressOfView(view.query);
  return {
    notebook,
    saved: view.id,
    tag: a.tag ? [...a.tag] : undefined,
    field: a.field ? [...a.field] : undefined,
    sort: a.sort,
    order: a.order,
    sortField: a.sortField,
    from: a.from,
    to: a.to,
    view: a.view,
    q: undefined,
    new: undefined,
  };
}
