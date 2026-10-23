import type { FieldDef } from '@unbent/shared';
import type { SortTarget } from './sort-options.js';

/**
 * One column of the note table.
 *
 * A plain description rather than a render function: what the column is, what it sorts
 * by, and how its cells align. `NoteTable` draws it. Kept as data so that a table
 * library's column definitions could be built from it one to one if resizing, hiding or
 * reordering columns ever makes one worth adopting: the rendering would change, not this.
 */
export interface NoteColumn {
  id: string;
  kind: 'name' | 'field' | 'tags' | 'updated' | 'created';
  label: string;
  /** The field this column shows, for `kind: 'field'`. */
  def?: FieldDef;
  /** What clicking the header orders the list by. Absent for a column that cannot. */
  sortTarget?: SortTarget;
  /** Numbers end-aligned so their digits line up; a checkbox centred under its heading. */
  align: 'start' | 'end' | 'center';
}

/**
 * The columns for a notebook: its name first, then its fields in the order the notebook
 * keeps them, then the tags and the two dates. The name column is the one that stays put
 * when the rest scroll (see the stylesheet), which is why it is always first.
 */
export function noteColumns(defs: readonly FieldDef[]): NoteColumn[] {
  const fields = [...defs]
    .sort((a, b) => a.position - b.position)
    .map<NoteColumn>((def) => ({
      id: def.id,
      kind: 'field',
      label: def.name,
      def,
      sortTarget: { kind: 'field', fieldId: def.id },
      align: def.type === 'number' ? 'end' : def.type === 'checkbox' ? 'center' : 'start',
    }));
  return [
    { id: 'name', kind: 'name', label: 'Name', sortTarget: { kind: 'note', sort: 'title' }, align: 'start' },
    ...fields,
    { id: 'tags', kind: 'tags', label: 'Tags', align: 'start' },
    { id: 'updated', kind: 'updated', label: 'Updated', sortTarget: { kind: 'note', sort: 'updated' }, align: 'start' },
    { id: 'created', kind: 'created', label: 'Created', sortTarget: { kind: 'note', sort: 'created' }, align: 'start' },
  ];
}

/**
 * Whether a column gets a total in the table's footer: a number field that is a plain
 * number or an amount. Not a rating: the sum of a column of stars is a number nobody can
 * read anything from, and an average, which would mean something, is a different line.
 */
export function totalable(col: NoteColumn): col is NoteColumn & { def: FieldDef } {
  return col.kind === 'field' && col.def?.type === 'number' && !col.def.scale;
}
