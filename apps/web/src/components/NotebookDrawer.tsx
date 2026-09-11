import { Link, useNavigate } from '@tanstack/react-router';
import { UNFILED } from '@unbent/shared';
import { Sheet } from './Sheet.js';
import { AccountMenu } from './AccountMenu.js';
import type { NotebookData } from './NotebookSelect.js';

interface NotebookDrawerProps {
  open: boolean;
  onClose: () => void;
  notebook: string | undefined;
  /** Selected tags, only to know whether "All notes" is the current scope. */
  selectedTags: string[];
  notebooks: { data: NotebookData | undefined };
  trashed: number;
  email: string;
  onSignOut: () => void;
}

/**
 * Where the notes are, on a phone.
 *
 * A notebook is a place you go, not a filter you apply. The app has said so all along in
 * the one rule the picker carries — choosing a notebook clears the tags, because the two
 * are different kinds of question — and Evernote, Apple Notes and the Android app all draw
 * it as navigation. On the web it had become a `<select>` two taps inside a sheet headed
 * "Filter notes", which is the weakest reading of it available.
 *
 * So the notebooks, the trash and the account come out of the filter sheet and out of the
 * topbar, into the surface every one of those apps puts them in. That is what lets the note
 * list keep a single row of chrome: it has a heading naming the notebook, and everything
 * that heading refers to is one tap behind the ☰ beside it.
 *
 * Desktop keeps the select. The sidebar is always on screen there, so a drawer would be
 * hiding something that costs nothing to show.
 *
 * The shape of it is Keep's: the places at the top, and on the floor the things that are
 * not places — Trash, then Settings — as plain rows, with the account up in the head beside
 * the wordmark. Settings used to be behind the avatar, which on a phone was the one screen
 * with no topbar to show the avatar on; a row on the floor is one tap from the ☰ and is
 * where every drawer people arrive from puts it. Sign out stays behind the avatar on
 * purpose: it is rare and disruptive, and a row for it on this floor would sit a thumb's
 * width under Settings in a list of places to go.
 */
export function NotebookDrawer({
  open,
  onClose,
  notebook,
  selectedTags,
  notebooks,
  trashed,
  email,
  onSignOut,
}: NotebookDrawerProps) {
  const navigate = useNavigate();

  /*
   * Picking a scope clears the tags, the same rule the notebook select follows: tags cross
   * notebook boundaries, so carrying one into a new notebook routinely lands on an empty
   * list with no visible cause. Sort and the date range are kept — they are how you are
   * looking, not what at.
   */
  const scope = (next: string | undefined) => {
    void navigate({
      to: '/notes',
      search: (prev) => ({ ...prev, notebook: next, tag: undefined }),
    });
    onClose();
  };

  /** All notes means no notebook *and* no tags — the unnarrowed list, not merely unfiled. */
  const allActive = !notebook && selectedTags.length === 0;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Unbent"
      side="start"
      // The account, in the head beside the wordmark — where Keep's avatar sits relative to
      // its drawer, and out of the way of the rows that navigate.
      headAction={<AccountMenu email={email} onSignOut={onSignOut} />}
    >
      <nav className="drawer-list">
        <button
          type="button"
          className={allActive ? 'drawer-item current' : 'drawer-item'}
          aria-current={allActive ? 'true' : undefined}
          onClick={() => scope(undefined)}
        >
          All notes
        </button>

        {/*
            "Inbox" is the label for having no notebook — the same bucket the API and the
            UNFILED sentinel call unfiled. Offered only when there is something in it, since
            otherwise it leads to a guaranteed empty list; it stays while it is the active
            scope so the drawer never fails to show where you are.
        */}
        {((notebooks.data?.unfiled ?? 0) > 0 || notebook === UNFILED) && (
          <button
            type="button"
            className={notebook === UNFILED ? 'drawer-item current' : 'drawer-item'}
            aria-current={notebook === UNFILED ? 'true' : undefined}
            onClick={() => scope(UNFILED)}
          >
            Inbox
            <span className="tag-count">{notebooks.data?.unfiled ?? 0}</span>
          </button>
        )}

        {(notebooks.data?.notebooks.length ?? 0) > 0 && <hr className="drawer-rule" />}

        {notebooks.data?.notebooks.map((nb) => {
          const on = notebook === nb.name;
          return (
            <button
              key={nb.id}
              type="button"
              className={on ? 'drawer-item current' : 'drawer-item'}
              aria-current={on ? 'true' : undefined}
              onClick={() => scope(nb.name)}
            >
              <span className="drawer-item-label">{nb.name}</span>
              <span className="tag-count">{nb.count}</span>
            </button>
          );
        })}

        {/*
            Making another notebook, as the last row of the notebooks rather than a control
            on the floor: it is about the list above it, and Keep ends its labels the same
            way. It navigates away, which unmounts the drawer, so it never closes it by hand.
        */}
        <Link to="/settings/notebooks" className="drawer-item drawer-new">
          New notebook
        </Link>
      </nav>

      {/*
          The floor: the destinations that are not places notes live.

          Both are `Link`s rather than scope buttons because each is a different view rather
          than a narrowing of this one — and a link can be middle-clicked and copied, which
          a button cannot. Both navigate away, which unmounts the drawer, so neither needs
          to close it by hand.
      */}
      <div className="drawer-foot">
        <hr className="drawer-rule" />
        <Link to="/trash" className="drawer-item">
          Trash
          {trashed > 0 && <span className="tag-count">{trashed}</span>}
        </Link>
        <Link to="/settings" className="drawer-item">
          Settings
        </Link>
      </div>
    </Sheet>
  );
}
