import { useMemo } from 'react';
import { Link } from '@tanstack/react-router';
import { snippetParts, type SearchResult } from '@unbent/shared';

interface SearchResultsProps {
  results: SearchResult[];
}

/**
 * Renders a snippet with the FTS5 match markers turned into highlights.
 *
 * The server emits `<<` and `>>` rather than HTML so the snippet is never interpolated as
 * markup: the note body is user content, and a snippet carrying real tags would be an
 * injection route straight into the results list.
 *
 * A body's snippet is cut from markdown, and is read as the words it shows
 * (`snippetParts`), the way the list's excerpt is. A file's is cut from its extracted
 * text, which is markdown when the server read it and plain when the browser's PDF reader
 * did; plain text read as markdown loses little (an `<Acme Ltd>` in angle brackets reads
 * as a tag and goes), so it is read the same way. A tag's or a field's is the name or
 * value itself, where a leading `#` or a `*` is the text and not a mark, so it is shown as
 * it came.
 */
function Snippet({ text, markdown }: { text: string; markdown: boolean }) {
  const parts = useMemo(() => (markdown ? snippetParts(text) : markedParts(text)), [text, markdown]);
  return (
    <span className="note-excerpt">
      {parts.map((part, i) => (part.hit ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>))}
    </span>
  );
}

function markedParts(text: string) {
  return text
    .split(/(<<[^>]*>>)/g)
    .filter(Boolean)
    .map((part) =>
      part.startsWith('<<') && part.endsWith('>>') ? { text: part.slice(2, -2), hit: true } : { text: part, hit: false },
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
            <Snippet text={r.snippet} markdown={!r.matchedTag && !r.matchedField} />
          </Link>
        </li>
      ))}
    </>
  );
}
