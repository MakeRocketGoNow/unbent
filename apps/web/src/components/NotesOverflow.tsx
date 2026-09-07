import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { OverflowMenu } from './OverflowMenu.js';
import { Sheet } from './Sheet.js';
import { Button } from './Button';
import type { NoteSort } from '@unbent/shared';
import { SORT_OPTIONS, sortKey, parseSortKey, sortLabel } from './sort-options.js';

interface NotesOverflowProps {
  sort: NoteSort | undefined;
  order: 'asc' | 'desc' | undefined;
  /** Hidden while searching, where results are ranked by relevance rather than sorted. */
  showSort: boolean;
}

/**
 * The note list's ⋯ menu: how the list is ordered, and the way out to Settings.
 *
 * Sort had its own icon here, which left Settings with nowhere to be: the topbar carried it
 * behind the avatar, and the topbar is hidden over the phone's list. A view with no route
 * to Settings is a worse problem than a sort that costs one extra tap, and the Android app
 * had already settled this shape — sort and Settings under one ⋯, a divider between them.
 *
 * Sort stays out of the filter sheet for the reason it always did: every filter changes
 * which notes are on screen and this only changes their order, so among the filters
 * "Title A–Z" invites being read as something that narrows.
 *
 * The current sort is named in the menu row rather than shown as a tick beside five
 * options, which is what Android does and is the better read here: one line says what the
 * order *is* without the menu having to be opened twice.
 */
export function NotesOverflow({ sort, order, showSort }: NotesOverflowProps) {
  const navigate = useNavigate();
  const [picking, setPicking] = useState(false);
  const current = sortKey(sort, order);

  return (
    <>
      <OverflowMenu
        label="More"
        className="overflow-notes"
        triggerClassName="icon-btn"
        items={[
          ...(showSort
            ? [
                {
                  label: `Sort: ${sortLabel(sort, order)}`,
                  onSelect: () => setPicking(true),
                },
              ]
            : []),
          { label: 'Settings', to: '/settings' },
        ]}
      />

      {/*
          The orders themselves, as a sheet rather than a submenu.

          A nested menu shows the current choice only after a second tap, and these labels
          are longer than a menu row wants to be. Android reaches for a dialog here for the
          same reasons; this app's equivalent surface is the sheet it already has.
      */}
      <Sheet open={picking} onClose={() => setPicking(false)} title="Sort notes">
        <div className="sort-options">
          {SORT_OPTIONS.map((o) => {
            const on = o.key === current;
            return (
              <button
                key={o.key}
                type="button"
                className={on ? 'sort-option current' : 'sort-option'}
                aria-pressed={on}
                onClick={() => {
                  void navigate({
                    to: '/notes',
                    search: (prev) => ({ ...prev, ...parseSortKey(o.key) }),
                  });
                  setPicking(false);
                }}
              >
                {o.label}
              </button>
            );
          })}
        </div>
        <div className="sheet-foot">
          <Button variant="quiet" onClick={() => setPicking(false)}>
            Done
          </Button>
        </div>
      </Sheet>
    </>
  );
}
