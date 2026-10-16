import { Link } from '@tanstack/react-router';
import type { SearchResult } from '@unbent/shared';

interface SearchResultsProps {
  results: SearchResult[];
}

/**
 * Renders a snippet with the FTS5 match markers turned into highlights.
 *
 * The server emits `<<` and `>>` rather than HTML so the snippet is never interpolated as
 * markup: the note body is user content, and a snippet carrying real tags would be an
 * injection route straight into the results list.
 */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(<<[^>]*>>)/g);
  return (
    <span className="note-excerpt">
      {parts.map((part, i) =>
        part.startsWith('<<') && part.endsWith('>>') ? (
          <mark key={i}>{part.slice(2, -2)}</mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </span>
  );
}

export function SearchResults({ results }: SearchResultsProps) {
  if (results.length === 0) {
    return <li className="muted small empty">No matches.</li>;
  }

  return (
    <>
      {results.map((r) => (
        <li key={r.id}>
          <Link
            to="/notes/$noteId"
            params={{ noteId: r.id }}
            // Keeps the query in the URL, so going Back returns to these results rather
            // than to an unsearched list.
            search={(prev) => prev}
            className="note-item"
            activeProps={{ className: 'note-item active' }}
          >
            <span className="note-title">{r.title || 'Untitled'}</span>
            {/* Naming the file makes an otherwise puzzling hit explicable: the note body
                may not contain the search term at all. */}
            {r.matchedFile && <span className="matched-file">in {r.matchedFile}</span>}
            {/* Same reason, same treatment: the term was in a field's value. */}
            {r.matchedField && <span className="matched-file">in {r.matchedField}</span>}
            {/* And in a tag, where the snippet is the tag's name and would otherwise read
                as a body that happens to contain it. */}
            {r.matchedTag && <span className="matched-file">tagged {r.matchedTag}</span>}
            <Snippet text={r.snippet} />
          </Link>
        </li>
      ))}
    </>
  );
}
