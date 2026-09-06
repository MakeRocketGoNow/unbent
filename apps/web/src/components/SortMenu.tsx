import { useNavigate } from '@tanstack/react-router';
import type { NoteSort } from '@unbent/shared';
import { OverflowMenu } from './OverflowMenu.js';
import { SortIcon } from './icons.js';
import { SORT_OPTIONS, sortKey, parseSortKey, sortLabel } from './sort-options.js';

interface SortMenuProps {
  sort: NoteSort | undefined;
  order: 'asc' | 'desc' | undefined;
}

/**
 * The phone's sort control.
 *
 * A menu of its own rather than a row inside the filter sheet. Sort is not a filter: every
 * filter changes which notes are on screen, and this only changes their order, so putting
 * it among them invites reading "Title A–Z" as something that narrows the list. The Android
 * app splits the two for the same reason — its sort lives under the overflow while the
 * filters live in the sheet — and the badge that says "a filter is on" would be lying if
 * choosing a sort could light it.
 *
 * The active option is ticked rather than named in the trigger. A trigger reading "Sort:
 * Recently updated" is the widest thing in a header row that already holds four controls,
 * and the answer is one tap away for the rare occasion it is wanted.
 */
export function SortMenu({ sort, order }: SortMenuProps) {
  const navigate = useNavigate();
  const current = sortKey(sort, order);

  return (
    <OverflowMenu
      // The current sort belongs in the accessible name: the trigger is an icon, and
      // "Sort notes" alone would make the one thing it is showing the one thing it does
      // not say.
      label={`Sort notes, currently ${sortLabel(sort, order)}`}
      className="overflow-sort"
      triggerClassName="icon-btn"
      trigger={<SortIcon />}
      items={SORT_OPTIONS.map((o) => ({
        label: o.label,
        selected: o.key === current,
        onSelect: () =>
          void navigate({
            to: '/notes',
            search: (prev) => ({ ...prev, ...parseSortKey(o.key) }),
          }),
      }))}
    />
  );
}
