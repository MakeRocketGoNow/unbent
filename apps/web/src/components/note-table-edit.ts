import type { InfiniteData } from '@tanstack/react-query';
import type { FieldDef, FieldValue, NoteFieldValue, NoteSummary } from '@unbent/shared';
import type { NotePage } from '../notes-api.js';

/**
 * A row with one field's value changed, as the API would report it back.
 *
 * What the table shows the instant a cell is edited, before the save lands. Built from
 * the definition so the row carries the same shape a listed value has; a note that ends
 * with no values loses the key altogether, the way the API omits it.
 */
export function patchNoteFields(
  note: NoteSummary,
  def: FieldDef,
  notebook: string,
  value: FieldValue | null,
): NoteSummary {
  const held = note.fields ?? [];
  const at = held.findIndex((f) => f.fieldId === def.id);
  let fields: NoteFieldValue[];
  if (value === null) {
    fields = held.filter((f) => f.fieldId !== def.id);
  } else {
    const next: NoteFieldValue = {
      fieldId: def.id,
      name: def.name,
      type: def.type,
      value,
      notebookId: def.notebookId,
      notebook,
    };
    fields = at === -1 ? [...held, next] : held.map((f, i) => (i === at ? next : f));
  }
  const { fields: _dropped, ...rest } = note;
  return fields.length > 0 ? { ...rest, fields } : rest;
}

/** The same page data with one note replaced, wherever it sits in the pages. */
export function patchNotePages(
  data: InfiniteData<NotePage> | undefined,
  noteId: string,
  patch: (note: NoteSummary) => NoteSummary,
): InfiniteData<NotePage> | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.map((n) => (n.id === noteId ? patch(n) : n)),
    })),
  };
}
