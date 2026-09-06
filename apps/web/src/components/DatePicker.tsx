import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { DATE_PRESETS, activePreset } from './date-presets.js';

interface DatePickerProps {
  from: string | undefined;
  to: string | undefined;
}

/**
 * The date range, as a page of choices.
 *
 * The presets and the two inputs used to sit inline on the sheet's root, where they were
 * the tallest thing on it — a wrapped row of five pills plus a labelled pair of date fields,
 * for a filter most visits never set. Behind a row that names the current range they cost
 * one line, which is what the tags already do beside them.
 *
 * Presets first, then "Any time", then the custom fields, which is Android's order and the
 * order of how often each is wanted. Every preset is open-ended — see `date-presets.ts` for
 * why that matters at midnight.
 *
 * The custom fields are revealed rather than always shown: they are two labelled inputs and
 * a calendar each, and the presets answer the question most of the time. They open already
 * expanded when a custom range is what is set, so the page always shows the state it is in.
 */
export function DatePicker({ from, to }: DatePickerProps) {
  const navigate = useNavigate();
  const active = activePreset(from, to);
  /** A range that is set but is not one of the presets is, by definition, a custom one. */
  const hasCustom = Boolean((from || to) && !active);
  const [showCustom, setShowCustom] = useState(hasCustom);

  const set = (next: { from?: string; to?: string }) =>
    void navigate({
      to: '/notes',
      search: (prev) => ({ ...prev, from: undefined, to: undefined, ...next }),
    });

  return (
    <div className="date-picker">
      {DATE_PRESETS.map((p) => {
        const on = p.key === active;
        return (
          <button
            key={p.key}
            type="button"
            className={on ? 'date-option current' : 'date-option'}
            aria-pressed={on}
            // Open-ended: the end is cleared as the start is set, or a stale `to` would
            // silently narrow the range the row names.
            onClick={() => set({ from: p.from() })}
          >
            {p.label}
          </button>
        );
      })}

      {/* Clearing both ends, named the way Android names it — "Clear" describes the
          gesture, "Any time" describes the result, and the result is what the other rows
          on this page are describing. */}
      <button
        type="button"
        className={!from && !to ? 'date-option current' : 'date-option'}
        aria-pressed={!from && !to}
        onClick={() => set({})}
      >
        Any time
      </button>

      <button
        type="button"
        className={hasCustom ? 'date-option current' : 'date-option'}
        aria-expanded={showCustom}
        onClick={() => setShowCustom((v) => !v)}
      >
        Custom…
      </button>

      {showCustom && (
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
        </div>
      )}
    </div>
  );
}
