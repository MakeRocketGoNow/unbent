import type { ReactNode } from 'react';
import { TagInput } from './TagInput.js';
import { NotebookRowIcon, TagIcon, ChevronDownIcon } from './icons.js';

interface NotebookPickerProps {
  notebook: string | null;
  notebooks: Array<{ id: string; name: string }> | undefined;
  readOnly?: boolean;
  onChange: (notebook: string | null) => void;
  className: string;
  id?: string;
}

/**
 * The notebook picker: filing a note by picking from the notebooks that exist, rather than
 * retyping a name — which is how case-variant duplicates used to appear.
 *
 * Drawn as the property list's value: a chosen notebook is its name in ink, the way a
 * field's value is text, with the chevron `FilingRows` sets beside it saying it can be
 * changed; the Inbox is the absence of one, drawn like "Empty". It used to be a chip, the
 * same chip as a tag, which said "one of a set" about the one property that is a place.
 */
export function NotebookPicker({
  notebook,
  notebooks,
  readOnly = false,
  onChange,
  className,
  id,
}: NotebookPickerProps) {
  return (
    <select
      id={id}
      className={className}
      value={notebook ?? ''}
      aria-label="Notebook"
      disabled={readOnly}
      data-filled={notebook ? true : undefined}
      onChange={(e) => onChange(e.target.value || null)}
    >
      {/* No notebook. Shown as "Inbox" everywhere in the UI; see NotesLayout. */}
      <option value="">Inbox</option>
      {notebooks?.map((nb) => (
        <option key={nb.id} value={nb.name}>
          {nb.name}
        </option>
      ))}
    </select>
  );
}

interface FilingRowsProps {
  notebook: string | null;
  notebooks: Array<{ id: string; name: string }> | undefined;
  tags: string[];
  suggestions: string[];
  readOnly?: boolean;
  onNotebook: (notebook: string | null) => void;
  onTags: (tags: string[]) => void;
}

/**
 * The notebook and the tags as the first two rows of a note's property list.
 *
 * Where a phone's note is filed, stated the way Notion states a page's location and its
 * tags: two facts about the record, at the top, edited where they are read. Rows in the
 * list's own grid — the `lead` of `NoteFields` — so their labels share the fields' column
 * and the whole thing reads as one record rather than a row of chrome over a list.
 *
 * Drawn by the site's phone layout and by the Android app's embed alike, which is the
 * point of it being one component: the app used to draw these two natively above the
 * page and open a sheet for them, in a second font and rhythm from the fields the page
 * drew underneath. One list, one implementation, both platforms.
 */
export function FilingRows({
  notebook,
  notebooks,
  tags,
  suggestions,
  readOnly = false,
  onNotebook,
  onTags,
}: FilingRowsProps): ReactNode {
  return (
    <>
      <div className="note-field filing-prop">
        <span className="note-field-glyph" aria-hidden="true">
          <NotebookRowIcon />
        </span>
        <label className="note-field-label" htmlFor="filing-notebook">
          Notebook
        </label>
        {/*
            The picker with a chevron over its right padding. A notebook is a place the note
            can be moved to, and its name alone — drawn in ink like any value — gave no sign
            it opened anything. The glyph sits beside the select rather than in it: a select
            takes no pseudo-elements, and a background image cannot follow the theme's ink.
            It takes no pointer events, so the click lands on the select beneath.
        */}
        <span className="notebook-pick">
          <NotebookPicker
            id="filing-notebook"
            className="note-field-input"
            notebook={notebook}
            notebooks={notebooks}
            readOnly={readOnly}
            onChange={onNotebook}
          />
          <ChevronDownIcon />
        </span>
        <span className="note-field-side" />
      </div>
      <div className="note-field filing-prop">
        <span className="note-field-glyph" aria-hidden="true">
          <TagIcon />
        </span>
        <span className="note-field-label">Tags</span>
        <TagInput tags={tags} suggestions={suggestions} onChange={onTags} />
        <span className="note-field-side" />
      </div>
    </>
  );
}
