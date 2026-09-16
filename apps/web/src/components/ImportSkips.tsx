import { Link } from '@tanstack/react-router';
import { groupByMatch, type SkipGroup, type SkipLog } from './import-skips.js';

/**
 * The notes an import skipped, each linked to the note it was matched to.
 *
 * A count alone raised a question nothing on screen could answer. Importing a notebook
 * into an empty one reported ten notes "already present", and they turned out to be
 * copies inside the file: the importer recognises a note by its title and text, so a
 * second note with both the same is matched to the first even when its tags or
 * attachments differ. Listing them with that reason, and a way to open the note that was
 * kept, turns the question into something the person can check.
 */
export function ImportSkips({ log }: { log: SkipLog }) {
  const total = log.duplicateCount + log.presentCount;
  if (total === 0) return null;

  return (
    <details className="import-skips">
      <summary className="small">
        {notes(total)} skipped
      </summary>

      {log.duplicateCount > 0 && (
        <div>
          <p className="small muted">
            {notes(log.duplicateCount)} had the same title and text as a note earlier in
            this file, so only that earlier note was imported. A copy&apos;s own
            tags and dates were not kept, and neither was an attachment with the same name
            as one of the earlier note&apos;s. Each link opens the note that was kept.
            {listedNote(log.duplicates.length, log.duplicateCount)}
          </p>
          <SkipList groups={groupByMatch(log.duplicates)} />
        </div>
      )}

      {log.presentCount > 0 && (
        <div>
          <p className="small muted">
            {notes(log.presentCount)} {log.presentCount === 1 ? 'was' : 'were'}{' '}
            already here before this import and {log.presentCount === 1 ? 'was' : 'were'}{' '}
            left as {log.presentCount === 1 ? 'it was' : 'they were'}, apart from any
            attachments an earlier run did not finish uploading.
            {listedNote(log.present.length, log.presentCount)}
          </p>
          <SkipList groups={groupByMatch(log.present)} />
        </div>
      )}
    </details>
  );
}

function notes(count: number): string {
  return `${count.toLocaleString()} note${count === 1 ? '' : 's'}`;
}

/** Says the list is partial, when it is. See `SKIP_LIST_LIMIT`. */
function listedNote(listed: number, count: number): string {
  return listed < count ? ` The first ${listed.toLocaleString()} are listed.` : '';
}

function SkipList({ groups }: { groups: SkipGroup[] }) {
  return (
    <ul className="small">
      {groups.map((group) => (
        <li key={group.noteId}>
          {/* A new tab, because leaving this page unmounts the panel. During a run that
              terminates the worker and ends the import; after one it throws the summary
              away before the rest of this list has been read. */}
          <Link
            to="/notes/$noteId"
            params={{ noteId: group.noteId }}
            target="_blank"
            rel="noopener"
            className="link"
          >
            {group.title}
          </Link>
          {group.copies > 1 && <span className="muted"> ×{group.copies}</span>}
        </li>
      ))}
    </ul>
  );
}
