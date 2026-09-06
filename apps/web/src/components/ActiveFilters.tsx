import { useNavigate } from '@tanstack/react-router';
import { UNFILED } from '@unbent/shared';
import { CloseIcon } from './icons.js';
import { rangeLabel } from './format-when.js';

interface ActiveFiltersProps {
  notebook: string | undefined;
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
 */
export function ActiveFilters({ notebook, tags, from, to }: ActiveFiltersProps) {
  const navigate = useNavigate();
  const range = rangeLabel(from, to);

  const drop = (search: Record<string, unknown>) =>
    void navigate({ to: '/notes', search: (prev) => ({ ...prev, ...search }) });

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
          onClick={() => {
            const next = tags.filter((t) => t !== name);
            drop({ tag: next.length ? next : undefined });
          }}
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
