import { useNavigate } from '@tanstack/react-router';
import { Button } from './Button';
import { DATE_PRESETS, activePreset } from './date-presets.js';

interface DateRangeProps {
  from: string | undefined;
  to: string | undefined;
}

/**
 * The window of time the list is narrowed to.
 *
 * Presets first, then the inputs. The presets answer the question that actually gets asked —
 * "the last 30 days" on a corpus of receipts — in one tap; the inputs stay because an
 * archive question is often open at one end ("anything before 2020"), which no preset list
 * can express. Android orders them the same way, with its Clear standing in for "Any time"
 * and the inputs for its "Custom…".
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

  const active = activePreset(from, to);

  return (
    <>
      <div className="pill-row date-presets">
        {DATE_PRESETS.map((p) => {
          const on = p.key === active;
          return (
            <button
              key={p.key}
              type="button"
              className={on ? 'pill active' : 'pill'}
              aria-pressed={on}
              onClick={() =>
                void navigate({
                  to: '/notes',
                  search: (prev) => ({
                    ...prev,
                    /*
                     * Pressing the active preset turns it off, which is what a pressed
                     * control promises. Otherwise the end is cleared as the start is set:
                     * every preset is open-ended, and a stale `to` left behind would
                     * silently narrow the range the pill names.
                     */
                    from: on ? undefined : p.from(),
                    to: undefined,
                  }),
                })
              }
            >
              {p.label}
            </button>
          );
        })}
      </div>

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
    </>
  );
}
