import { useNavigate } from '@tanstack/react-router';
import { Disclosure } from './Disclosure.js';

export interface TagCount {
  name: string;
  count: number;
}

interface TagFilterProps {
  tags: TagCount[];
  selected: string[];
}

/**
 * The sidebar's tag filter: a disclosure whose summary states what it is hiding.
 *
 * A disclosure rather than a flat list. The tag list is as long as the user has tags, and
 * on a real archive that is hundreds — they filled the screen before a single note was
 * visible. Collapsed it costs one row; the summary carries the active tags so a filter can
 * never be applied invisibly.
 *
 * Open where the sidebar has room, closed on a phone — `defaultOpen="wide"` is that, and
 * `Disclosure` carries the remount that default needs to survive a viewport change.
 */
export function TagFilter({ tags, selected }: TagFilterProps) {
  const navigate = useNavigate();
  if (tags.length === 0) return null;

  return (
    <Disclosure
      className="tag-filter-wrap"
      defaultOpen="wide"
      summary={
        <>
          Tags
          {/* The active tag stays on the row while collapsed, so a filter is never
              applied invisibly; otherwise the count says what is hidden. */}
          {selected.length > 0 ? (
            // Every selected tag, not the first and a count: two tags ANDed are a
            // different question from either alone, and the collapsed row is the only
            // place a filter shows while the list is closed.
            selected.map((name) => (
              <span className="tag-filter-active" key={name}>
                {name}
              </span>
            ))
          ) : (
            <span className="tag-filter-summary-count">{tags.length}</span>
          )}
        </>
      }
    >
      <div className="tag-filter">
        {tags.map((t) => {
          const on = selected.includes(t.name);
          return (
            <button
              key={t.name}
              type="button"
              className={on ? 'tag-filter-item active' : 'tag-filter-item'}
              aria-pressed={on}
              onClick={() =>
                void navigate({
                  to: '/notes',
                  search: (prev) => {
                    /*
                     * Tags accumulate rather than replace: picking a second one narrows to
                     * notes carrying both. Dropping to undefined at zero keeps `?tag=` out
                     * of the URL when nothing is selected.
                     */
                    const next = on
                      ? selected.filter((name) => name !== t.name)
                      : [...selected, t.name];
                    return { ...prev, tag: next.length ? next : undefined };
                  },
                })
              }
            >
              {t.name}
              <span className="tag-count">{t.count}</span>
            </button>
          );
        })}
      </div>
    </Disclosure>
  );
}
