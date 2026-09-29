import { useId, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { UNFILED } from '@unbent/shared';
import {
  NotesRowIcon,
  InboxRowIcon,
  NotebookGlyph,
  PlusRowIcon,
  TagIcon,
  TrashRowIcon,
  SettingsRowIcon,
} from './icons.js';
import type { TagCount } from './TagPicker.js';
import { usePersistentState } from '../usePersistentState.js';
import { rememberedSort } from '../notebook-sort.js';

/**
 * How many tags the section lists before offering the rest.
 *
 * An archive imported from Evernote can carry hundreds. The section is a list of places,
 * and the places anyone goes are the well-used ones, which is the order the API returns
 * them in; the rest are one row away rather than a scroll of the whole navigation.
 */
const TAG_CAP = 25;

/** What the navigation needs of the notebooks. Shaped by the API, narrowed to what is drawn. */
export interface NotebookData {
  notebooks: { id: string; name: string; count: number; emoji?: string | null }[];
  unfiled: number;
}

/**
 * Which screen the rows are drawn beside. The places at the top mark themselves only
 * over the notes; the destinations on the floor mark themselves when they are the screen.
 */
export type NavPlace = 'notes' | 'trash' | 'settings' | 'other';

interface NotebookNavProps {
  /** Defaults to the notes: the phone's drawer only exists over them. */
  place?: NavPlace | undefined;
  notebook: string | undefined;
  /** Selected tags, only to know whether "All notes" is the current scope. */
  selectedTags: string[];
  notebooks: { data: NotebookData | undefined };
  trashed: number;
  /** Every tag with its count, in the API's order: the most used first. */
  tags: TagCount[];
  /**
   * Called after a scope is picked. The phone's drawer closes itself here, because the
   * list behind it has changed; a surface that is always on screen passes nothing.
   */
  onNavigate?: (() => void) | undefined;
  /**
   * The labels are clipped from view — a desktop's rail drawn as a strip of icons. The
   * rows then carry their label as a tooltip too, since a glyph alone says less than a
   * word; the stylesheet does the clipping, this only adds the titles.
   */
  labelsHidden?: boolean | undefined;
  /** The last thing on the floor: the desktop rail puts the account here. */
  footer?: ReactNode;
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
  place = 'notes',
  notebook,
  selectedTags,
  notebooks,
  trashed,
  tags,
  onNavigate,
  labelsHidden = false,
  footer,
}: NotebookNavProps) {
  /*
   * Whether the tags are shown. Closed to begin with — the notebooks are the places most
   * people move between, and a long tag list under them would push the floor out of
   * sight — and remembered, since someone who works by tag opens it every time. Not
   * `Disclosure`, whose own comment rules out state that anything else depends on; this
   * is a button with `aria-expanded`, and the stylesheet draws it with the same chevron.
   */
  const [tagsOpen, setTagsOpen] = usePersistentState<boolean>('navTagsOpen', false);
  const [allTags, setAllTags] = useState(false);
  const tagsId = useId();

  /*
   * The places are links, like the destinations: each is a URL, and a link can be opened
   * in a new tab, middle-clicked and copied, which a button cannot. The search each one
   * writes is a function of the current one, so that what is kept is kept: the date range
   * is how you are looking, not what at, and it rides along.
   *
   * The sort does not, though it once did. Each place opens in the order it was last left
   * in (`rememberedSort`) — a notebook of receipts wants its newest first and one of
   * recipes wants A–Z, and the order that suited the place being left said nothing about
   * the one being entered. It is written into the link rather than filled in on arrival so
   * that the list is fetched once, in the right order, instead of in the old one first.
   *
   * Picking a scope clears the tags, the same rule the notebook select followed: tags
   * cross notebook boundaries, so carrying one into a new notebook routinely lands on an
   * empty list with no visible cause. Field filters go with them — a field belongs to the
   * notebook being left.
   */
  const scopeOf = (next: string | undefined) => (prev: Record<string, unknown>) => ({
    ...prev,
    notebook: next,
    tag: undefined,
    field: undefined,
    ...rememberedSort(next),
  });

  /*
   * A tag as a place: every note carrying it, across all notebooks — Evernote's tag view.
   * The notebook goes, and with it the field filter, which belongs to it; the order is
   * the one All notes remembers, since a tag place is the whole archive narrowed, and the
   * dates stay. Only ever one tag from here: narrowing to several is the
   * filter sheet's job, where a tag is a refinement of where you are rather than a place.
   * A search pick made from All notes with nothing else set lands on this same URL, so
   * the row marks it — see `ScopeMatches`.
   */
  const tagOf = (name: string) => (prev: Record<string, unknown>) => ({
    ...prev,
    tag: [name],
    notebook: undefined,
    field: undefined,
    ...rememberedSort(undefined),
  });

  /** A place was picked; a drawer closes behind it. */
  const picked = () => onNavigate?.();

  /*
   * All notes means no notebook *and* no tags — the unnarrowed list, not merely unfiled.
   * Every place is gated on being over the notes at all: on the trash or in settings the
   * URL still carries a notebook, and lighting its row there would say the trash is in it.
   */
  const here = place === 'notes';
  const allActive = here && !notebook && selectedTags.length === 0;
  const inboxActive = here && notebook === UNFILED;
  /** The one tag that is the place, when a tag is: no notebook, exactly one tag. */
  const tagPlace = here && !notebook && selectedTags.length === 1 ? selectedTags[0] : undefined;
  /*
   * The tags listed: the first `TAG_CAP` by use, or all of them once asked. The current
   * tag is always among them, past the cap or not — the same rule that keeps the Inbox on
   * screen while it is where you are — so the navigation never fails to say where you are.
   */
  const listedTags = allTags ? tags : tags.slice(0, TAG_CAP);
  const currentPastCap =
    tagPlace !== undefined && !listedTags.some((t) => t.name === tagPlace)
      ? tags.find((t) => t.name === tagPlace)
      : undefined;
  const shownTags = currentPastCap ? [...listedTags, currentPastCap] : listedTags;
  /** The tooltip a strip's row needs, and a full-width row does not. */
  const tip = (label: string) => (labelsHidden ? label : undefined);

  return (
    <>
      <nav className="drawer-list">
        <Link
          to="/notes"
          search={scopeOf(undefined)}
          className={allActive ? 'drawer-item current' : 'drawer-item'}
          aria-current={allActive ? 'true' : undefined}
          title={tip('All notes')}
          onClick={picked}
        >
          <NotesRowIcon />
          <span className="drawer-item-label">All notes</span>
        </Link>

        {/*
            "Inbox" is the label for having no notebook — the same bucket the API and the
            UNFILED sentinel call unfiled. Offered only when there is something in it, since
            otherwise it leads to a guaranteed empty list; it stays while it is the active
            scope so the navigation never fails to show where you are.
        */}
        {((notebooks.data?.unfiled ?? 0) > 0 || notebook === UNFILED) && (
          <Link
            to="/notes"
            search={scopeOf(UNFILED)}
            className={inboxActive ? 'drawer-item current' : 'drawer-item'}
            aria-current={inboxActive ? 'true' : undefined}
            title={tip('Inbox')}
            onClick={picked}
          >
            <InboxRowIcon />
            <span className="drawer-item-label">Inbox</span>
            <span className="tag-count">{notebooks.data?.unfiled ?? 0}</span>
          </Link>
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
          const on = here && notebook === nb.name;
          return (
            <Link
              key={nb.id}
              to="/notes"
              search={scopeOf(nb.name)}
              // `drawer-place-notebook` is how a strip knows to hide these: a notebook with
              // no emoji draws the same book as every other, so as icons alone they would be
              // a column of identical squares, and the strip is opened to tell them apart.
              className={on ? 'drawer-item drawer-place-notebook current' : 'drawer-item drawer-place-notebook'}
              aria-current={on ? 'true' : undefined}
              // A name can be longer than the column; the row ellipsises it and the
              // tooltip carries the rest, the way `.overflow-email` does for an address.
              title={nb.name}
              onClick={picked}
            >
              <NotebookGlyph emoji={nb.emoji} />
              <span className="drawer-item-label">{nb.name}</span>
              <span className="tag-count">{nb.count}</span>
            </Link>
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
          <span className="drawer-item-label">New notebook</span>
        </Link>

        {/*
            The tags, under the notebooks, as Evernote lists them. A section only when
            there are any: an empty "Tags" head would be a promise with nothing under it.
            Its head opens and closes the list, and carries the way to edit the tags the
            way the notebooks' head does.
        */}
        {tags.length > 0 && (
          <>
            <hr className="drawer-rule" />
            <div className="drawer-section">
              <button
                type="button"
                className="drawer-section-toggle"
                aria-expanded={tagsOpen}
                aria-controls={tagsId}
                onClick={() => setTagsOpen((open) => !open)}
              >
                Tags
              </button>
              <Link to="/settings/tags" className="drawer-section-action">
                Edit
              </Link>
            </div>
            {tagsOpen && (
              <div id={tagsId} className="drawer-tags">
                {shownTags.map((t) => {
                  const on = tagPlace === t.name;
                  return (
                    <Link
                      key={t.name}
                      to="/notes"
                      search={tagOf(t.name)}
                      className={on ? 'drawer-item current' : 'drawer-item'}
                      aria-current={on ? 'true' : undefined}
                      title={t.name}
                      onClick={picked}
                    >
                      <TagIcon />
                      <span className="drawer-item-label">{t.name}</span>
                      <span className="tag-count">{t.count}</span>
                    </Link>
                  );
                })}
                {!allTags && tags.length > TAG_CAP && (
                  <button
                    type="button"
                    className="drawer-item drawer-new"
                    onClick={() => setAllTags(true)}
                  >
                    <span className="drawer-item-label">Show all {tags.length} tags</span>
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </nav>

      {/*
          The floor: the destinations that are not places notes live. Each is a different
          view rather than a narrowing of this one. Both navigate away, so neither closes a
          drawer by hand.
      */}
      {/*
          Marked `current` by which screen this is beside, never by the router's own
          `active` class on the link: the router would light Trash from the moment the
          trash opened whatever the rest of the page said, and the phone's drawer, which
          only ever exists over the notes, marks neither. `aria-current="page"` rather than
          the places' `"true"`, because a destination is a page and a place is a scope.
      */}
      <div className="drawer-foot">
        <hr className="drawer-rule" />
        <Link
          to="/trash"
          className={place === 'trash' ? 'drawer-item current' : 'drawer-item'}
          aria-current={place === 'trash' ? 'page' : undefined}
          title={tip('Trash')}
        >
          <TrashRowIcon />
          <span className="drawer-item-label">Trash</span>
          {trashed > 0 && <span className="tag-count">{trashed}</span>}
        </Link>
        <Link
          to="/settings"
          className={place === 'settings' ? 'drawer-item current' : 'drawer-item'}
          aria-current={place === 'settings' ? 'page' : undefined}
          title={tip('Settings')}
        >
          <SettingsRowIcon />
          <span className="drawer-item-label">Settings</span>
        </Link>
        {footer}
      </div>
    </>
  );
}
