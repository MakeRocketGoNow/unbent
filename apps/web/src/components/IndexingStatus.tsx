import { Link } from '@tanstack/react-router';
import { useIndexing } from '../index-files.js';

/**
 * What the indexing pass is doing, for the sidebar floor.
 *
 * Renders nothing unless there is something to say: a pass in progress, or a backlog the
 * pass on open left alone because it was more than it will download unasked. That second
 * case is a link, because the way to run the backlog is the Import panel's button and
 * this takes you there — navigation, so a link and not a button.
 *
 * Idle and finished are silent. A search that finds text inside a PDF is the evidence
 * that the pass worked; a line saying so would be noise on every open.
 */
export function IndexingStatus() {
  const indexing = useIndexing();

  if (indexing.status === 'running') {
    if (indexing.phase === 'images') {
      const i = indexing.images;
      return (
        <span className="sidebar-status">
          Reading images
          {i ? ` · ${i.read} read, ${i.remaining} left` : ''}
        </span>
      );
    }
    const p = indexing.progress;
    return (
      <span className="sidebar-status">
        Indexing PDFs
        {p?.total ? ` · ${p.done} of ${p.total}` : ''}
      </span>
    );
  }

  if (indexing.status === 'deferred') {
    return (
      <Link to="/settings/import" className="sidebar-status">
        {indexing.remaining} PDFs not yet searchable
      </Link>
    );
  }

  return null;
}
