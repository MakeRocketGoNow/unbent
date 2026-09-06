import { useNavigate } from '@tanstack/react-router';
import { Button } from './Button';

interface DateRangeProps {
  from: string | undefined;
  to: string | undefined;
}

/**
 * The window of time the list is narrowed to.
 *
 * Two inputs rather than a single "period" control: an archive question is usually open at
 * one end ("anything before 2020"), which a preset list alone cannot express.
 *
 * Shown while searching too, unlike sort — a date range narrows which notes match, which is
 * a question worth asking of search results, where reordering by date would discard their
 * relevance ranking.
 *
 * The range applies to whichever column the sort uses, not a fixed one; `notes-repo.ts`
 * carries that rule, and it is why `NoteListItem` shows the date it is sorted by.
 */
export function DateRange({ from, to }: DateRangeProps) {
  const navigate = useNavigate();

  return (
    <div className="date-range">
      <label>
        <span className="small">From</span>
        <input
          type="date"
          value={from ?? ''}
          max={to ?? undefined}
          onChange={(e) =>
            void navigate({
              to: '/notes',
              search: (prev) => ({ ...prev, from: e.target.value || undefined }),
            })
          }
        />
      </label>
      <label>
        <span className="small">To</span>
        <input
          type="date"
          value={to ?? ''}
          min={from ?? undefined}
          onChange={(e) =>
            void navigate({
              to: '/notes',
              search: (prev) => ({ ...prev, to: e.target.value || undefined }),
            })
          }
        />
      </label>
      {(from || to) && (
        <Button
          variant="quiet"
          size="small"
          onClick={() =>
            void navigate({
              to: '/notes',
              search: (prev) => ({ ...prev, from: undefined, to: undefined }),
            })
          }
        >
          Clear
        </Button>
      )}
    </div>
  );
}
