import type { SearchResult } from '@unbent/shared';

interface SearchResultsProps {
  results: SearchResult[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

/**
 * Renders a snippet with the FTS5 match markers turned into highlights.
 *
 * The server emits `<<` and `>>` rather than HTML so the snippet is never interpolated as
 * markup — the note body is user content, and a snippet carrying real tags would be an
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

export function SearchResults({ results, selectedId, onSelect }: SearchResultsProps) {
  if (results.length === 0) {
    return <li className="muted small empty">No matches.</li>;
  }

  return (
    <>
      {results.map((r) => (
        <li key={r.id}>
          <button
            type="button"
            className={r.id === selectedId ? 'note-item active' : 'note-item'}
            onClick={() => onSelect(r.id)}
          >
            <span className="note-title">{r.title || 'Untitled'}</span>
            <Snippet text={r.snippet} />
          </button>
        </li>
      ))}
    </>
  );
}
