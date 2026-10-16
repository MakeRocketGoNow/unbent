import { useState } from 'react';
import { Sheet } from './Sheet.js';
import { InboxRowIcon, NotebookGlyph, PlusRowIcon } from './icons.js';
import type { NotebookData } from './NotebookNav.js';

interface MoveSheetProps {
  open: boolean;
  onClose: () => void;
  /** How many notes are going, for the title. */
  count: number;
  notebooks: NotebookData | undefined;
  busy: boolean;
  /** The destination: a notebook's name, or null for none. A new name makes the notebook. */
  onPick: (notebook: string | null) => void;
}

/**
 * Where to file the selection: the notebooks, and the Inbox, as rows to pick one of.
 *
 * A sheet rather than a menu hanging off the bar, because a menu has no answer to an
 * archive's notebook count (the real one has dozens), and the bar it would hang from is
 * at the foot of the screen, where a menu opens off the bottom. The sheet is the surface
 * the filters already use: a panel beside the list on a desktop, from the floor on a
 * phone, with the find field and the capped list the tag picker settled on for the same
 * reason at the same scale.
 *
 * The rows are the drawer's rows (the same glyphs, the same pill, the counts at the end),
 * since they are the same places, drawn as somewhere to send notes rather than somewhere
 * to go. Picking one files the notes and closes; nothing here needs a Done.
 *
 * A name that matches no notebook is offered as a new one, with the name in the row so
 * it is clear what is being made. The API creates a notebook on demand for a single
 * note's filing and does the same here; this row only makes that visible instead of
 * leaving the field a dead end when the notebook does not exist yet.
 */
export function MoveSheet({ open, onClose, count, notebooks, busy, onPick }: MoveSheetProps) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const rows = notebooks?.notebooks ?? [];
  const matching = rows.filter((nb) => needle === '' || nb.name.toLowerCase().includes(needle));
  const typed = query.trim();
  const isNew = typed !== '' && !rows.some((nb) => nb.name.toLowerCase() === typed.toLowerCase());
  const showInbox = needle === '' || 'inbox'.includes(needle);

  const close = () => {
    setQuery('');
    onClose();
  };
  const pick = (notebook: string | null) => {
    setQuery('');
    onPick(notebook);
  };

  return (
    <Sheet open={open} onClose={close} title={`Move ${count} ${count === 1 ? 'note' : 'notes'} to`}>
      <div className="move-picker">
        <input
          className="search-field"
          type="search"
          value={query}
          placeholder="Find or name a notebook…"
          aria-label="Find or name a notebook"
          disabled={busy}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Enter on a typed name files the notes there, new notebook or not.
            if (e.key === 'Enter' && typed !== '') {
              e.preventDefault();
              pick(matching.find((nb) => nb.name.toLowerCase() === typed.toLowerCase())?.name ?? typed);
            }
          }}
        />
        <ul className="move-picker-list">
          {showInbox && (
            <li>
              <button type="button" className="drawer-item" disabled={busy} onClick={() => pick(null)}>
                <InboxRowIcon />
                <span className="drawer-item-label">Inbox</span>
                {notebooks && <span className="tag-count">{notebooks.unfiled}</span>}
              </button>
            </li>
          )}
          {matching.map((nb) => (
            <li key={nb.id}>
              <button
                type="button"
                className="drawer-item"
                disabled={busy}
                onClick={() => pick(nb.name)}
              >
                <NotebookGlyph emoji={nb.emoji} />
                <span className="drawer-item-label">{nb.name}</span>
                <span className="tag-count">{nb.count}</span>
              </button>
            </li>
          ))}
          {isNew && (
            <li>
              <button
                type="button"
                className="drawer-item drawer-new"
                disabled={busy}
                onClick={() => pick(typed)}
              >
                <PlusRowIcon />
                <span className="drawer-item-label">New notebook “{typed}”</span>
              </button>
            </li>
          )}
        </ul>
      </div>
    </Sheet>
  );
}
