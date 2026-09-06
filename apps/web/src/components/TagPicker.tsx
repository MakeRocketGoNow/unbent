import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { CloseIcon } from './icons.js';

export interface TagCount {
  name: string;
  count: number;
}

interface TagPickerProps {
  /** Every tag, in the API's order — by count, descending. See the note below on order. */
  tags: TagCount[];
  selected: string[];
}

/**
 * Choose tags to filter by, at any archive size.
 *
 * This replaces a flat wall of pills. That was fine at sixteen tags and impossible at the
 * real number: `listTags` in the API sorts by count precisely because this account has 326,
 * and the sidebar's disclosure opens by default on a desktop — so it drew all 326 before the
 * first note. A wrapped pill field has no answer to that; it just gets taller.
 *
 * Three things fix it, and they are the shape the Android app already settled on:
 *
 * **Selected tags come out of the list and sit on top**, as removable chips. What is
 * filtering the list is the thing most worth seeing, and leaving the selection scattered
 * through a long list means hunting for it to undo it.
 *
 * **A find field**, matching a case-insensitive substring rather than a prefix — people
 * remember a word from the middle of "Payment Confirmation" as readily as its first letter.
 * The query is local state, not URL state: it is a way of looking for a control, not a
 * filter on the notes, and putting it in the URL would make a shared link carry someone's
 * half-typed search. It deliberately survives a pick, so choosing one of the tags matching
 * "rec" leaves the others on screen — selecting several related tags is the common case.
 *
 * **Full-width rows with counts, in count order, in a capped scroll box.** Rows rather than
 * pills because a name plus a count is two pieces of information, and a wrapped pill line
 * gives neither a stable place to be; the cap is what keeps the picker from being the whole
 * screen again.
 *
 * Not auto-focused, which is also Android's choice. The most-used tags are already on screen
 * when it opens, and raising the keyboard would cover them to help with a search the user
 * may not need.
 */
export function TagPicker({ tags, selected }: TagPickerProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');

  const needle = query.trim().toLowerCase();
  /*
   * Selected tags are excluded rather than marked: they are already on screen as chips
   * above, and a list that showed them again would offer two controls for one tag that
   * disagree about what a press does.
   *
   * The API's order is kept rather than re-sorted alphabetically. Alphabetical puts the
   * deadest tags first — `notes-repo.ts` records that reasoning for the same reason.
   */
  const candidates = tags
    .filter((t) => !selected.includes(t.name))
    .filter((t) => needle === '' || t.name.toLowerCase().includes(needle));

  /** Tags accumulate rather than replace: two selected narrows to notes carrying both. */
  const setTags = (next: string[]) =>
    void navigate({
      to: '/notes',
      // Dropping to undefined at zero keeps `?tag=` out of the URL when nothing is selected.
      search: (prev) => ({ ...prev, tag: next.length ? next : undefined }),
    });

  return (
    <div className="tag-picker">
      {selected.length > 0 && (
        <div className="filter-chips tag-picker-selected">
          {selected.map((name) => (
            <button
              key={name}
              type="button"
              className="filter-chip"
              aria-label={`Remove tag filter: ${name}`}
              onClick={() => setTags(selected.filter((t) => t !== name))}
            >
              {name}
              <CloseIcon />
            </button>
          ))}
        </div>
      )}

      <input
        className="search-field"
        type="search"
        value={query}
        placeholder="Find tags…"
        aria-label="Find tags"
        onChange={(e) => setQuery(e.target.value)}
      />

      {candidates.length === 0 ? (
        /*
         * Two messages, because they are two different situations and one of them is not a
         * failure: having chosen every tag you have is a finished job, and saying "No tags
         * match" there would read as something having gone wrong.
         */
        <p className="tag-picker-empty muted small">
          {needle === '' ? 'Every tag is chosen.' : 'No tags match.'}
        </p>
      ) : (
        <ul className="tag-picker-list">
          {candidates.map((t) => (
            <li key={t.name}>
              {/* Adding is the only thing a row does — removing happens on the chip above —
                  so there is no pressed state to announce. */}
              <button
                type="button"
                className="tag-picker-item"
                onClick={() => setTags([...selected, t.name])}
              >
                <span className="tag-picker-name">{t.name}</span>
                <span className="tag-count">{t.count}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
