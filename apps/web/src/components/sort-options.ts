import type { NoteSort } from '@unbent/shared';

/**
 * The sort orders the list offers, named.
 *
 * Sort is one choice rather than a field plus a direction, because the useful combinations
 * are few and naming them ("Oldest first") is plainer than asking someone to assemble
 * "created" and "ascending" themselves. `created:asc` and `updated:asc` would both be
 * offerable and neither is a question anyone asks.
 *
 * They live here rather than inline in the sidebar because two controls now render them —
 * the desktop `<select>` and the phone's sort menu — and a list duplicated in two places is
 * a list that drifts. The key is the `<select>` value's shape, which is what makes it the
 * one spelling both controls can use as a React key and an equality test.
 */
export interface SortOption {
  /** `${sort}:${order}` — the composite the desktop select stores as its value. */
  key: string;
  label: string;
  sort: NoteSort;
  order: 'asc' | 'desc';
}

export const SORT_OPTIONS: SortOption[] = [
  { key: 'updated:desc', label: 'Recently updated', sort: 'updated', order: 'desc' },
  { key: 'created:desc', label: 'Newest first', sort: 'created', order: 'desc' },
  { key: 'created:asc', label: 'Oldest first', sort: 'created', order: 'asc' },
  { key: 'title:asc', label: 'Title A–Z', sort: 'title', order: 'asc' },
  { key: 'title:desc', label: 'Title Z–A', sort: 'title', order: 'desc' },
];

/** The default, spelled once. Absent from the URL means this. */
export const DEFAULT_SORT: NoteSort = 'updated';
export const DEFAULT_ORDER: 'asc' | 'desc' = 'desc';

/** The URL's sort as a key, filling in the default the URL leaves out. */
export function sortKey(sort: NoteSort | undefined, order: 'asc' | 'desc' | undefined): string {
  return `${sort ?? DEFAULT_SORT}:${order ?? DEFAULT_ORDER}`;
}

/**
 * A key as the search params to write.
 *
 * The default comes back as `undefined` rather than as itself, so a plain `/notes` link
 * stays clean — picking "Recently updated" removes the parameters instead of spelling out
 * what absence already means.
 */
export function parseSortKey(key: string): {
  sort: NoteSort | undefined;
  order: 'asc' | 'desc' | undefined;
} {
  const [sort, order] = key.split(':') as [NoteSort, 'asc' | 'desc'];
  return {
    sort: sort === DEFAULT_SORT ? undefined : sort,
    order: order === DEFAULT_ORDER ? undefined : order,
  };
}

/**
 * What the current sort is called, for a control that shows its value rather than a list.
 *
 * A sort by a custom field has no named option — the table's column headers are how it is
 * chosen — so it is named from the field, with the direction spelled out, rather than
 * falling back to "Recently updated" over a list that is ordered by something else.
 */
export function sortLabel(
  sort: NoteSort | undefined,
  order: 'asc' | 'desc' | undefined,
  fieldName?: string,
): string {
  if (fieldName !== undefined) {
    return `${fieldName} ${(order ?? DEFAULT_ORDER) === 'asc' ? 'ascending' : 'descending'}`;
  }
  const key = sortKey(sort, order);
  return SORT_OPTIONS.find((o) => o.key === key)?.label ?? SORT_OPTIONS[0]!.label;
}

// --- Sorting from a column header ---------------------------------------------------

/** What a table column orders by: one of the named note sorts, or a custom field. */
export type SortTarget = { kind: 'note'; sort: NoteSort } | { kind: 'field'; fieldId: string };

/** The URL's ordering as the table reads it. `sortField` outranks `sort` when both are set. */
export interface SortSearch {
  sort?: NoteSort | undefined;
  order?: 'asc' | 'desc' | undefined;
  sortField?: string | undefined;
}

/** The direction a column is currently sorted in, or null when it is not the sort. */
export function columnSortState(target: SortTarget, search: SortSearch): 'asc' | 'desc' | null {
  const order = search.order ?? DEFAULT_ORDER;
  if (target.kind === 'field') return search.sortField === target.fieldId ? order : null;
  if (search.sortField) return null;
  return (search.sort ?? DEFAULT_SORT) === target.sort ? order : null;
}

/**
 * The search params a click on a column header writes.
 *
 * A first click sorts the way that column is usually wanted — names and field values
 * A–Z or low to high, dates newest first — and a click on the column already in charge
 * flips it. There is no third state: the list always has *some* order, and a header that
 * cycled to "none" would silently put "Recently updated" back under a column that no
 * longer said so. The two kinds of sort are exclusive on the wire, so choosing one
 * clears the other, and the defaults are dropped the way `parseSortKey` drops them.
 */
export function nextColumnSort(
  target: SortTarget,
  search: SortSearch,
): {
  sort: NoteSort | undefined;
  order: 'asc' | 'desc' | undefined;
  sortField: string | undefined;
} {
  const current = columnSortState(target, search);
  const first = target.kind === 'note' && target.sort !== 'title' ? 'desc' : 'asc';
  const order = current ? (current === 'asc' ? 'desc' : 'asc') : first;
  if (target.kind === 'field') {
    return {
      sort: undefined,
      order: order === DEFAULT_ORDER ? undefined : order,
      sortField: target.fieldId,
    };
  }
  return { ...parseSortKey(`${target.sort}:${order}`), sortField: undefined };
}
