import { Disclosure } from './Disclosure.js';
import { TagPicker, type TagCount } from './TagPicker.js';

export type { TagCount };

interface TagFilterProps {
  tags: TagCount[];
  selected: string[];
}

/**
 * The sidebar's tag filter: a disclosure whose summary states what it is hiding.
 *
 * A disclosure rather than an always-open panel. Even bounded by its own scroll box, the
 * picker is a find field and a list of rows, and that is more than a column of notes wants
 * to give up when nobody asked to filter. Collapsed it costs one row; the summary carries
 * the active tags so a filter can never be applied invisibly.
 *
 * Open where the sidebar has room, closed on a phone — `defaultOpen="wide"` is that, and
 * `Disclosure` carries the remount that default needs to survive a viewport change.
 */
export function TagFilter({ tags, selected }: TagFilterProps) {
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
      <TagPicker tags={tags} selected={selected} />
    </Disclosure>
  );
}
