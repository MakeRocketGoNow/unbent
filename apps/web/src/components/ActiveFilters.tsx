import { useNavigate } from '@tanstack/react-router';
import { UNFILED } from '@unbent/shared';
import { CloseIcon } from './icons.js';
import { rangeLabel } from './format-when.js';
import { writeTagFilter } from '../routes/notes.js';

interface ActiveFiltersProps {
  /**
   * The notebook, when this strip is the only thing reporting it.
   *
   * Omitted under the list header, where the heading already names the notebook — a chip
   * there repeated the title word for word on the line directly below it, and spent a whole
   * row of a phone screen doing it. Passed in the filter sheet, which claims to show
   * everything that is applied and so has to show this too; Android's sheet carries the
   * notebook chip for exactly that reason, while its app bar title does the naming.
   */
  notebook?: string | undefined;
  tags: string[];
  from: string | undefined;
  to: string | undefined;
}

/**
 * What is narrowing the list, as chips that remove themselves.
 *
 * On a phone the controls are behind an icon, so without this the only sign that a list is
 * filtered would be a dot on that icon — enough to say *that* something is filtering, and
 * nothing about *what*. A count of 12 with no explanation is how an archive comes to look
 * like it has lost notes.
 *
 * Every chip carries its own ×, which is where this goes further than the Android app's
 * title: that names the filters but cannot remove them, so taking one off means remembering
 * which surface set it. Here the thing that says a filter is on is the thing that takes it
 * off.
 *
 * The order matches the sheet and the Android app: notebook, then tags in their selected
 * order, then the range. It is the order the controls appear in, so the eye moving between
 * the chips and the sheet is not re-sorting them.
 *
 * Renders nothing at all when it has nothing to report, so a caller can mount it without
 * first working out whether this particular combination leaves anything to say — which the
 * header does, now that the notebook alone is not enough to fill it.
 */
export function ActiveFilters({ notebook, tags, from, to }: ActiveFiltersProps) {
  const navigate = useNavigate();
  const range = rangeLabel(from, to);

  const drop = (search: Record<string, unknown>) =>
    void navigate({ to: '/notes', search: (prev) => ({ ...prev, ...search }) });

  // An empty strip is a gap above the notes with nothing in it.
  if (!notebook && tags.length === 0 && !range) return null;

  return (
    <div className="filter-chips">
      {notebook && (
        <button
          type="button"
          className="filter-chip"
          // The notebook's own name, not "Notebook: X" — a chip has room for one of them,
          // and the value is the half that says what is on screen.
          aria-label={`Remove notebook filter: ${notebook === UNFILED ? 'Inbox' : notebook}`}
          /*
           * Drops the tags with it, the same rule the notebook select follows: tags cross
           * notebook boundaries, so leaving one selected here routinely yields an empty list
           * with no visible cause.
           */
          onClick={() => drop({ notebook: undefined, tag: undefined })}
        >
          {notebook === UNFILED ? 'Inbox' : notebook}
          <CloseIcon />
        </button>
      )}

      {tags.map((name) => (
        <button
          key={name}
          type="button"
          className="filter-chip"
          aria-label={`Remove tag filter: ${name}`}
          onClick={() => drop({ tag: writeTagFilter(tags.filter((t) => t !== name)) })}
        >
          #{name}
          <CloseIcon />
        </button>
      ))}

      {range && (
        <button
          type="button"
          className="filter-chip"
          // One chip for the range rather than one per end: "since March" and "until June"
          // are one question, and removing half of it is not something anyone asks for.
          aria-label={`Remove date filter: ${range}`}
          onClick={() => drop({ from: undefined, to: undefined })}
        >
          {range}
          <CloseIcon />
        </button>
      )}
    </div>
  );
}
