import { useNavigate } from '@tanstack/react-router';
import { TagIcon, NotebookRowIcon } from './icons.js';
import { writeTagFilter } from '../routes/notes.js';
import type { TagCount } from './TagPicker.js';
import type { NotebookData } from './NotebookSelect.js';

/** How many of each are offered. Enough to disambiguate, few enough to stay above the notes. */
const MAX_TAGS = 5;
const MAX_NOTEBOOKS = 3;

interface ScopeMatchesProps {
  /** The search term as it was sent — the debounced one, so these arrive with the results. */
  query: string;
  tags: TagCount[];
  notebooks: NotebookData | undefined;
  selectedTags: string[];
  notebook: string | undefined;
  /**
   * Called after a pick has been written to the URL. The phone closes its search field
   * with this, since the query it was showing is gone; the desktop's field simply empties.
   */
  onPick: () => void;
}

/**
 * Tags and notebooks whose names match the search, offered above the notes that do.
 *
 * Typing the name of a tag into the search box used to find nothing unless the word also
 * appeared in a note's text — the search index covers titles, bodies, field values and
 * attachment text, and a tag is none of those. Evernote answers the same keystrokes two
 * ways, and this is the first: the tag itself, as a thing to pick, at the top of the
 * results. Picking it applies the filter and clears the search, which is what it means to
 * have found what you were looking for. (The second — notes that carry the tag matching as
 * notes — is the API's, and comes back with the results below.)
 *
 * Computed here rather than asked of the server: every tag and every notebook is already
 * in hand for the picker and the select, and a substring match over a few hundred names
 * is nothing. Substring rather than prefix for the reason the tag picker's find field is:
 * people remember a word from the middle of a name as readily as its first letter.
 *
 * The rows are buttons, not links. Picking one applies a filter, which is an action; a
 * link here would promise a page to open in a new tab. They are rows of the note list
 * rather than a menu under the field, and the arrow keys reach them from the field the
 * way they reach the notes — see `useListKeys`. A combobox was tried in between: a menu
 * of tags over a list of notes answered the same keystrokes in two places, and a palette
 * that held the notes too would have drawn the results twice. One list, captioned.
 *
 * The captions are what say these are not a glitch. A row that looks like a note but
 * carries a tag icon reads as a note with something wrong with it; "Tags and notebooks"
 * over the picks and "Notes" over the results is what Apple Notes' "Suggested" does, and
 * costs one line each only while there is something to caption.
 *
 * Selected tags and the current notebook are left out — offering a filter that is already
 * on would be a control that does nothing. Tags keep the API's order, by count, so the
 * likeliest pick is first. Notebooks come after tags: a tag is added to the scope and a
 * notebook replaces it (clearing the tags and field filters, the rule the select and the
 * drawer follow), and the smaller step is offered first.
 *
 * Renders nothing for an empty needle, so the caller mounts it whenever results are shown.
 */
/** What the search would offer as picks — exported so the caller can caption the notes below. */
export function scopeMatches(
  query: string,
  tags: TagCount[],
  notebooks: NotebookData | undefined,
  selectedTags: string[],
  notebook: string | undefined,
): { tags: TagCount[]; notebooks: NotebookData['notebooks'] } {
  const needle = query.trim().toLowerCase();
  if (needle === '') return { tags: [], notebooks: [] };
  const matches = (name: string) => name.toLowerCase().includes(needle);
  return {
    tags: tags.filter((t) => !selectedTags.includes(t.name) && matches(t.name)).slice(0, MAX_TAGS),
    notebooks: (notebooks?.notebooks ?? [])
      .filter((nb) => nb.name !== notebook && matches(nb.name))
      .slice(0, MAX_NOTEBOOKS),
  };
}

export function ScopeMatches({
  query,
  tags,
  notebooks,
  selectedTags,
  notebook,
  onPick,
}: ScopeMatchesProps) {
  const navigate = useNavigate();
  const { tags: tagHits, notebooks: notebookHits } = scopeMatches(
    query,
    tags,
    notebooks,
    selectedTags,
    notebook,
  );
  if (tagHits.length === 0 && notebookHits.length === 0) return null;

  const pick = (search: Record<string, unknown>) => {
    void navigate({ to: '/notes', search: (prev) => ({ ...prev, ...search, q: undefined }) });
    onPick();
  };

  return (
    <>
      <li className="list-caption">Tags and notebooks</li>
      {tagHits.map((t) => (
        <li key={`tag:${t.name}`} className="scope-match">
          <button
            type="button"
            className="scope-match-btn"
            aria-label={`Filter by tag: ${t.name}`}
            onClick={() => pick({ tag: writeTagFilter([...selectedTags, t.name]) })}
          >
            <span className="scope-match-icon">
              <TagIcon />
            </span>
            <span className="scope-match-name">{t.name}</span>
            <span className="tag-count">{t.count}</span>
          </button>
        </li>
      ))}
      {notebookHits.map((nb) => (
        <li key={`notebook:${nb.name}`} className="scope-match">
          <button
            type="button"
            className="scope-match-btn"
            aria-label={`Show notebook: ${nb.name}`}
            onClick={() => pick({ notebook: nb.name, tag: undefined, field: undefined })}
          >
            <span className="scope-match-icon">
              <NotebookRowIcon />
            </span>
            <span className="scope-match-name">{nb.name}</span>
            <span className="tag-count">{nb.count}</span>
          </button>
        </li>
      ))}
    </>
  );
}
