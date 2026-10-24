import type { ComponentType } from 'react';
import { CardsViewIcon, ListViewIcon, TableViewIcon } from './icons.js';
import { OverflowMenu, type OverflowItem } from './OverflowMenu.js';
import type { NotesViewMode } from '../useNotesLayout.js';

interface NotesViewMenuProps {
  /** The view in effect, not necessarily the stored choice; see `tableDisabledReason`. */
  value: NotesViewMode;
  onChange: (next: NotesViewMode) => void;
  /**
   * Why the table cannot be chosen here, when it cannot: outside a single notebook there
   * are no fields to make columns of, and a phone has no room for columns. Offered and
   * faded rather than left out, because a choice that only appears inside a notebook on a
   * desktop cannot be found from the place most people start. A sentence, since it is
   * shown under the item as it stands.
   */
  tableDisabledReason?: string | undefined;
}

const VIEWS: { mode: NotesViewMode; name: string; showing: string; Icon: ComponentType }[] = [
  { mode: 'list', name: 'List', showing: 'Showing as a list', Icon: ListViewIcon },
  { mode: 'cards', name: 'Cards', showing: 'Showing as cards', Icon: CardsViewIcon },
  { mode: 'table', name: 'Table', showing: 'Showing as a table', Icon: TableViewIcon },
];

/**
 * List, cards or table: how the notes under the header are drawn.
 *
 * One icon that opens a menu of the three. It was one button that flipped between list
 * and table, which suited two views: the icon was the view on screen and the name said
 * where a press went. With three, a button that cycled would send each press somewhere
 * the icon had not said, and someone on the list wanting the table would pass through
 * the cards to get there. A segmented control of three would say everything at once,
 * but the header has one slot for this beside the filter and the sort, in a 19rem column
 * and on a phone, and three icons there would push the title into an ellipsis to save
 * a tap on a choice made rarely.
 *
 * What the flip button's reasoning keeps: the icon is the view on screen, the way the
 * sort icon shows the current order rather than the next, and the name says it too
 * ("Showing as cards"), with the tip saying what a press does. The menu names each view
 * beside its icon, so the icons are learned here, and ticks the current one in the gutter
 * every choice menu here uses (`OverflowItem.selected`). The table, where it cannot be
 * chosen, says why under its name, visibly: a phone shows no tooltip, and the faded item
 * with no reason reads as broken. It sits with the filter and sort icons because it is,
 * like them, about what is on screen rather than about adding to it.
 */
export function NotesViewMenu({ value, onChange, tableDisabledReason }: NotesViewMenuProps) {
  const current = VIEWS.find((v) => v.mode === value) ?? VIEWS[0]!;
  const items: OverflowItem[] = VIEWS.map(({ mode, name, Icon }) => {
    const unavailable = mode === 'table' ? tableDisabledReason : undefined;
    return {
      label: (
        <span className="view-option">
          <Icon />
          <span>{name}</span>
          {unavailable !== undefined && <span className="overflow-item-note">{unavailable}</span>}
        </span>
      ),
      selected: mode === value,
      disabled: unavailable !== undefined,
      // Choosing the view already on screen closes the menu and pushes nothing: a history
      // entry that changes nothing is a Back press that seems to do nothing.
      onSelect: () => {
        if (mode !== value) onChange(mode);
      },
    };
  });
  return (
    <OverflowMenu
      label={current.showing}
      tip="Change view"
      trigger={<current.Icon />}
      items={items}
      className="view-menu"
    />
  );
}
