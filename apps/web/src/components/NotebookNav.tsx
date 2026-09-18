import { Link, useNavigate } from '@tanstack/react-router';
import { UNFILED } from '@unbent/shared';
import {
  NotesRowIcon,
  InboxRowIcon,
  NotebookRowIcon,
  PlusRowIcon,
  TrashRowIcon,
  SettingsRowIcon,
} from './icons.js';

/** What the navigation needs of the notebooks. Shaped by the API, narrowed to what is drawn. */
export interface NotebookData {
  notebooks: { id: string; name: string; count: number }[];
  unfiled: number;
}

interface NotebookNavProps {
  notebook: string | undefined;
  /** Selected tags, only to know whether "All notes" is the current scope. */
  selectedTags: string[];
  notebooks: { data: NotebookData | undefined };
  trashed: number;
  /**
   * Called after a scope is picked. The phone's drawer closes itself here, because the
   * list behind it has changed; a surface that is always on screen passes nothing.
   */
  onNavigate?: (() => void) | undefined;
}

/**
 * Where the notes are: the rows of places, and the floor of destinations.
 *
 * A notebook is a place you go, not a filter you apply. The app has said so all along in
 * the one rule the picker carries — choosing a notebook clears the tags, because the two
 * are different kinds of question — and Evernote, Apple Notes and the Android app all draw
 * it as navigation. On the web it had become a `<select>` two taps inside a sheet headed
 * "Filter notes", which is the weakest reading of it available.
 *
 * The shape of it is Keep's: a glyph on every row, the places at the top under a section
 * head that carries the way to edit them, and on the floor the things that are not
 * places — Trash, then Settings — as plain rows. Settings used to be behind the avatar,
 * which on a phone was the one screen with no topbar to show the avatar on; a row on the
 * floor is one tap from the ☰ and is where every drawer people arrive from puts it. Sign
 * out stays behind the avatar on purpose: it is rare and disruptive, and a row for it on
 * this floor would sit a thumb's width under Settings in a list of places to go.
 *
 * The rows alone, with no surface of their own: the phone's `NotebookDrawer` puts them in
 * a sheet from the side, and a desktop can put them somewhere permanent. Nothing here
 * knows which.
 */
export function NotebookNav({
  notebook,
  selectedTags,
  notebooks,
  trashed,
  onNavigate,
}: NotebookNavProps) {
  const navigate = useNavigate();

  /*
   * Picking a scope clears the tags, the same rule the notebook select follows: tags cross
   * notebook boundaries, so carrying one into a new notebook routinely lands on an empty
   * list with no visible cause. Field filters go with them — a field belongs to the
   * notebook being left, as does a sort by one of its fields. The named sort and the date
   * range are kept: they are how you are looking, not what at.
   */
  const scope = (next: string | undefined) => {
    void navigate({
      to: '/notes',
      search: (prev) => ({
        ...prev,
        notebook: next,
        tag: undefined,
        field: undefined,
        sortField: undefined,
      }),
    });
    onNavigate?.();
  };

  /** All notes means no notebook *and* no tags — the unnarrowed list, not merely unfiled. */
  const allActive = !notebook && selectedTags.length === 0;

  return (
    <>
      <nav className="drawer-list">
        <button
          type="button"
          className={allActive ? 'drawer-item current' : 'drawer-item'}
          aria-current={allActive ? 'true' : undefined}
          onClick={() => scope(undefined)}
        >
          <NotesRowIcon />
          All notes
        </button>

        {/*
            "Inbox" is the label for having no notebook — the same bucket the API and the
            UNFILED sentinel call unfiled. Offered only when there is something in it, since
            otherwise it leads to a guaranteed empty list; it stays while it is the active
            scope so the navigation never fails to show where you are.
        */}
        {((notebooks.data?.unfiled ?? 0) > 0 || notebook === UNFILED) && (
          <button
            type="button"
            className={notebook === UNFILED ? 'drawer-item current' : 'drawer-item'}
            aria-current={notebook === UNFILED ? 'true' : undefined}
            onClick={() => scope(UNFILED)}
          >
            <InboxRowIcon />
            Inbox
            <span className="tag-count">{notebooks.data?.unfiled ?? 0}</span>
          </button>
        )}

        <hr className="drawer-rule" />

        {/*
            The section's name, and the way to change what is in it.

            Keep heads its labels the same way — a muted word on the left, Edit on the
            right — and the reason is that the rows below are places to go, so anything that
            changes them has to live outside the rows or every row would need two targets.
            Edit is a `Link` to the notebooks page, which navigates away. Shown even with no
            notebooks: the way to make the first one is the row at the end of this section.
        */}
        <div className="drawer-section">
          <span className="drawer-section-label">Notebooks</span>
          <Link to="/settings/notebooks" className="drawer-section-action">
            Edit
          </Link>
        </div>

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
              <NotebookRowIcon />
              <span className="drawer-item-label">{nb.name}</span>
              <span className="tag-count">{nb.count}</span>
            </button>
          );
        })}

        {/*
            Making another notebook, as the last row of the notebooks rather than a control
            on the floor: it is about the list above it, and Keep ends its labels the same
            way. It navigates away, which is why it never calls `onNavigate`: a drawer is
            unmounted by the route change and has nothing left to close.
        */}
        <Link to="/settings/notebooks" className="drawer-item drawer-new">
          <PlusRowIcon />
          New notebook
        </Link>
      </nav>

      {/*
          The floor: the destinations that are not places notes live.

          Both are `Link`s rather than scope buttons because each is a different view rather
          than a narrowing of this one — and a link can be middle-clicked and copied, which
          a button cannot. Both navigate away, so neither closes a drawer by hand.
      */}
      <div className="drawer-foot">
        <hr className="drawer-rule" />
        <Link to="/trash" className="drawer-item">
          <TrashRowIcon />
          Trash
          {trashed > 0 && <span className="tag-count">{trashed}</span>}
        </Link>
        <Link to="/settings" className="drawer-item">
          <SettingsRowIcon />
          Settings
        </Link>
      </div>
    </>
  );
}
