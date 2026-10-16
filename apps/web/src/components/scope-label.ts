import { UNFILED } from '@unbent/shared';

/**
 * Where the list is, in a word: what heads the note list, and what the navigation marks.
 *
 * The notebook names itself; "Inbox" is what the `UNFILED` sentinel is called everywhere
 * the user can see it; "All notes" is the unnarrowed list. Each matches a row of the
 * drawer and the rail, so the heading and the place you picked it from agree.
 *
 * A single tag with no notebook is a place too (the rail's tag rows go there), so it is
 * the heading then, the way a notebook is. Two tags are not: the rail marks no row for
 * them, the heading falls back to "All notes", and the chips under it say the rest. That
 * a second tag changes the heading is the price of the rule being the rail's rule.
 */
export function scopeLabel(notebook: string | undefined, tags: readonly string[]): string {
  if (notebook === UNFILED) return 'Inbox';
  if (notebook) return notebook;
  return tagPlace(notebook, tags) ?? 'All notes';
}

/** The tag that is the place, when one is: no notebook, exactly one tag. */
export function tagPlace(notebook: string | undefined, tags: readonly string[]): string | undefined {
  return !notebook && tags.length === 1 ? tags[0] : undefined;
}
