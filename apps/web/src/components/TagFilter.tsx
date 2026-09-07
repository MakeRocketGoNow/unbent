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
 * **Closed by default, at every width.** It used to open wherever the sidebar had room,
 * which was right when the body was a short wrap of pills. The picker is 210px — a find
 * field and six rows — and open by default on an 850px laptop it left the note list 127px
 * with one entry in it, on the screen whose entire job is listing notes. `never` is the
 * policy `Disclosure` documents for content that is unbounded or occasional, and this is
 * both: the tag list is as long as the archive is old, and most visits do not filter by tag.
 *
 * Deliberately not `wide` with a shorter cap instead. The cap that would fit here is about
 * three rows, which is too few to browse and too many to be a summary — the control would
 * be permanently open and permanently useless. Better to cost one tap and then be worth it.
 */
export function TagFilter({ tags, selected }: TagFilterProps) {
  if (tags.length === 0) return null;

  return (
    <Disclosure
      className="tag-filter-wrap"
      defaultOpen="never"
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
