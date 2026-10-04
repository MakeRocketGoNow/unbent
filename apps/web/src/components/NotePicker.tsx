import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { recentNotes, search } from '../queries.js';
import { Button } from './Button';
import { formatWhen } from './format-when.js';

export interface PickedNote {
  id: string;
  title: string;
  updatedAt: number;
}

interface NotePickerProps {
  /** Accessible name for the region, and its heading: "Copy to note", "Move to note". */
  label: string;
  /** The note the picker is opened from, which is never a sensible answer. */
  excludeId: string;
  busy?: boolean;
  onPick: (note: PickedNote) => void;
  onCancel: () => void;
}

/** How many notes the list shows: enough to pick from, few enough to read at a glance. */
const LIMIT = 8;

/**
 * Choose another note, by search or from the recent ones.
 *
 * Inline, in the row that opened it, like `Confirm` — the file being sent is right there,
 * and a modal would cover it. It opens on the most recently edited notes rather than
 * empty, because the note a file is going to is very often the one that was open a moment
 * ago; the field takes focus at once, since on a desktop typing a title is the fastest
 * way to any other note. Matching is the app's own search, so a note is found by anything
 * search finds it by — a tag, a field, a word in a scanned PDF — not only by its title.
 *
 * The rows are buttons, not links: choosing one sends the file and stays here. Escape
 * cancels, the way it does in `Confirm`.
 */
export function NotePicker({ label, excludeId, busy = false, onPick, onCancel }: NotePickerProps) {
  const [query, setQuery] = useState('');
  const [needle, setNeedle] = useState('');

  // A short debounce: search usually hits the server, and a title is typed faster than it answers.
  // Any letter searches, one included — see `searchQuery` for why that is no longer held back.
  useEffect(() => {
    const t = setTimeout(() => setNeedle(query.trim()), 200);
    return () => clearTimeout(t);
  }, [query]);

  const { data: notes = [], isLoading, error } = useQuery({
    queryKey: ['note-picker', needle],
    /*
     * Both through the same doors the note list uses, so the picker works where the list
     * does: the recent notes from the local library, and the search from the server or,
     * with no connection, the device's index. It called the API for both, and so failed
     * offline with an error where the sidebar beside it went on working. No line about
     * what an offline search covered: the picker shows titles to choose from, not a
     * claim that nothing else matches.
     */
    queryFn: async ({ signal }): Promise<PickedNote[]> => {
      const rows = needle === '' ? await recentNotes(LIMIT + 1) : (await search(needle, {}, false, signal)).results;
      return rows.map((n) => ({ id: n.id, title: n.title, updatedAt: n.updatedAt }));
    },
  });
  const candidates = notes.filter((n) => n.id !== excludeId).slice(0, LIMIT);

  return (
    <div
      className="note-picker"
      role="group"
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel();
      }}
    >
      <div className="note-picker-head">
        <span className="note-picker-label">{label}</span>
        <Button variant="quiet" size="small" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>

      <input
        className="search-field"
        type="search"
        value={query}
        placeholder="Find a note…"
        aria-label="Find a note"
        autoFocus
        disabled={busy}
        onChange={(e) => setQuery(e.target.value)}
      />

      {error ? (
        <p className="bad small note-picker-empty">Couldn’t load notes. {(error as Error).message}</p>
      ) : candidates.length === 0 ? (
        <p className="muted small note-picker-empty">
          {isLoading ? 'Looking…' : needle === '' ? 'No other notes yet.' : 'No notes match.'}
        </p>
      ) : (
        <ul className="note-picker-list">
          {candidates.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                className="note-picker-item"
                disabled={busy}
                onClick={() => onPick(n)}
              >
                <span className="note-picker-title">{n.title || 'Untitled'}</span>
                {/* Two notes can share a title; when each was last touched tells them apart. */}
                <span className="muted small">{formatWhen(n.updatedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
