import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { normalizeContentType, type NoteSort, type NoteSummary } from '@unbent/shared';
import { formatWhen } from './format-when.js';
import { NoteFieldsLine } from './NoteFieldsLine.js';
import { AttachmentKindIcon } from './icons.js';
import { NoteCheck, type RowSelection } from './NoteListItem.js';
import { useNotePress } from './use-note-press.js';
import { COVER_PARAM } from '../sw/routes.js';

/** What a card's cover shows; see `coverOf`. */
export type Cover =
  | { kind: 'image'; filename: string }
  | { kind: 'file'; contentType: string }
  | { kind: 'none' };

/**
 * The picture at the top of a card.
 *
 * The note's first image, not its first file: a receipt scanned to PDF and then
 * photographed is the photo, which is the one thing on the card that can be recognised
 * at a glance. `attachments` is oldest first, so "first" is the one the note was made
 * for among its pictures. When there is no image the first file's kind stands in for it
 * (a PDF's page, a recording), drawn as its glyph: there is no thumbnail of a PDF to
 * show, and a first page rendered in the browser for every receipt in a notebook of
 * hundreds is a pipeline of its own, not a detail of this view. A note with no files has
 * no cover at all.
 *
 * Decided from the declared type, which is unverified: it chooses what to try drawing,
 * and an image that does not draw falls back to its glyph (see `NoteCard`).
 */
export function coverOf(note: Pick<NoteSummary, 'attachments'>): Cover {
  const files = note.attachments ?? [];
  const image = files.find((f) => normalizeContentType(f.contentType).startsWith('image/'));
  if (image) return { kind: 'image', filename: image.filename };
  const first = files[0];
  return first ? { kind: 'file', contentType: first.contentType } : { kind: 'none' };
}

/**
 * A cover's address: the file's own, marked as a cover so the service worker draws it
 * from what the device already holds and never keeps it as a file someone opened
 * (`COVER_PARAM`). The whole original, for now: there is no thumbnail of a file to ask
 * for, so a gallery of phone photos downloads each in full, once, and the browser's own
 * cache (the server sends them `immutable`) is what spares the second scroll.
 */
function fileSrc(noteId: string, filename: string): string {
  return `/api/notes/${encodeURIComponent(noteId)}/files/${encodeURIComponent(filename)}?${COVER_PARAM}=1`;
}

interface NoteCardProps {
  note: NoteSummary;
  /** The sort the list is using, so the card shows the date that ordering is based on. */
  sort?: NoteSort;
  /** As on `NoteListItem`: whether the note replaces the cards when it opens. */
  replacedByNote?: boolean;
  selection?: RowSelection | undefined;
  /**
   * Why a search matched, when the card is a search result whose own face cannot show
   * it: "in Scan.pdf". Shown in the date's place, since a match is in order of relevance
   * and its date is not what put it there.
   */
  hint?: string | undefined;
}

/**
 * One note in the cards view: its picture, its title, its fields.
 *
 * The same note the list row is, drawn for a notebook whose notes are recognised by what
 * they look like (photos, business cards, receipts, a wall of milestones) rather than by
 * what they say. So the cover is the card's content, and the row's excerpt, file line and
 * tags are not under it: a gallery of text is worse than the list it replaced, and every
 * line under a cover is one card fewer on the screen. What stays is what tells one record
 * from the next once the picture has been seen: the title, the fields line (the row's own,
 * `NoteFieldsLine`), and the date the list is ordered by.
 *
 * Everything else is the row's, on purpose and by construction. A real `Link`, so
 * middle-click and copy-link-address work. Selected by the row's rules through the same
 * handlers (`useNotePress`, explained on `NoteListItem`), with the row's checkbox while the
 * list is in its selection mode, laid over the cover's corner here since the title has no
 * room to give up. The classes are the row's too (`note-item`, `note-entry`), which is
 * what the arrow keys, the open note's tint, the selection ring and the list's motion all
 * find a row by; `.note-card` reshapes it.
 */
export function NoteCard({ note, sort, replacedByNote = false, selection, hint }: NoteCardProps) {
  const when = sort === 'created' ? note.createdAt : note.updatedAt;
  const title = note.title || 'Untitled';
  const cover = coverOf(note);
  const press = useNotePress(selection);

  /*
     An image that will not draw: a type the browser cannot decode (HEIC from an
     iPhone, outside Safari), or bytes this device does not hold while offline. Its glyph
     takes the cover rather than the browser's broken-image box. Remembered by address,
     so a card whose cover changes tries the new one.
  */
  const src = cover.kind === 'image' ? fileSrc(note.id, cover.filename) : null;
  const [failed, setFailed] = useState<string | null>(null);
  const drawImage = src !== null && failed !== src;

  const linkClass = ['note-item', 'note-card', selection?.selected && 'selected'].filter(Boolean).join(' ');

  return (
    <li
      // What the list's motion follows a card by (`list-motion.ts`), as it does a row.
      data-note-id={note.id}
      className={selection?.selected ? 'note-entry note-card-entry selected' : 'note-entry note-card-entry'}
    >
      <Link
        to="/notes/$noteId"
        params={{ noteId: note.id }}
        search={(prev) => prev}
        className={linkClass}
        activeProps={{ className: `${linkClass} active` }}
        aria-selected={selection ? selection.selected : undefined}
        {...(replacedByNote ? {} : { 'data-keep-focus': '' })}
        {...press}
      >
        {/*
          A fixed shape whatever is in it, so the cards line up in rows and a portrait
          receipt sits beside a landscape photo without either deciding the row's height.
          Cropped to fill (`object-fit: cover`) from the top, where a receipt has its
          merchant and a portrait its face. Lazy, since a notebook can be hundreds of
          cards and only a screenful is seen; `alt` is empty because the title under it
          already names the card, and a filename read out first would be noise.
        */}
        {/* An image that would not draw is drawn as a file is, glyph and all. */}
        <span
          className={`note-card-cover ${drawImage ? 'image' : cover.kind === 'none' ? 'none' : 'file'}`}
          aria-hidden="true"
        >
          {drawImage ? (
            <img
              src={src}
              alt=""
              loading="lazy"
              decoding="async"
              draggable={false}
              onError={() => setFailed(src)}
            />
          ) : cover.kind === 'none' ? (
            /*
              A note with no files has nothing to picture, and an empty box on every text
              note made a notebook of them a wall of grey. Its own words go there instead,
              dimmed and cut to the cover's height: the note's face, the way a card in
              Keep is its text. Still nothing for a note with no prose either, which is
              rare enough that an empty cover is honest about it.
            */
            note.excerpt ? <span className="note-card-excerpt">{note.excerpt}</span> : null
          ) : (
            <AttachmentKindIcon contentType={cover.kind === 'image' ? 'image/*' : cover.contentType} />
          )}
        </span>
        <span className="note-card-body">
          <span className="note-title" title={title}>
            {title}
          </span>
          <span className="note-meta" title={hint}>
            {hint ?? formatWhen(when)}
          </span>
          <NoteFieldsLine fields={note.fields} />
        </span>
      </Link>
      {selection?.active && <NoteCheck title={title} selection={selection} />}
    </li>
  );
}
