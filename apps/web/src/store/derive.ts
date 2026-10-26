import {
  DEFAULT_NOTE_SORT,
  UNFILED,
  endOfDay,
  excerptMarkdown,
  foldNoCase,
  sameName,
  fieldRangeBound,
  fieldSortKey,
  fieldSortsNumerically,
  parseFieldFilter,
  startOfDay,
  type AttachmentInfo,
  type FeedAttachment,
  type FeedNote,
  type FeedNotebook,
  type FeedTag,
  type FeedView,
  type FieldDef,
  type Note,
  type NoteFieldValue,
  type NoteSort,
  type NoteSummary,
  type NotebookSummary,
  type NotebookView,
  splitExt,
} from '@unbent/shared';
import { filesOf } from './keep.js';

/**
 * The shapes the components read, derived from the rows the local library holds.
 *
 * The feed carries a note by its `tagIds` and `notebookId`, a notebook with its
 * definitions and a tag by its name, with no counts anywhere (see `packages/shared/src/
 * feed.ts` for why). Everything the server used to compute per request (the list row
 * with its excerpt and names, the sidebar's counts, a notebook's field definitions with
 * how many notes hold a value) is computed here from the collections, in the same
 * order and with the same comparisons the server's queries made, so a list looks the
 * same whether it came from the store or the Worker. Pure functions over plain arrays,
 * so a test can hold each rule without a database.
 */

/** The feed's note, with what an optimistic write may add; see `LocalNote` in collections.ts. */
export type LocalNote = FeedNote & { notebookName?: string | null; tagNames?: string[] };

export interface Snapshot {
  notes: Iterable<LocalNote>;
  notebooks: Iterable<FeedNotebook>;
  tags: Iterable<FeedTag>;
  attachments: Iterable<FeedAttachment>;
  /**
   * The saved views. Required, so every place that builds a snapshot says what it holds
   * of them rather than leaving them out by accident; one that has none passes `[]`.
   */
  views: Iterable<FeedView>;
}

/** The lookups every derivation shares, built once per read. */
export interface Lookups {
  notebooks: Map<string, FeedNotebook>;
  tags: Map<string, FeedTag>;
  /** Tags by their name folded as the store's NOCASE index folds it (`foldNoCase`). */
  tagsByName: Map<string, FeedTag>;
  /** Definitions held, by field id, for rendering a value from the definition rather than the carried name. */
  fieldDefs: Map<string, FieldDef>;
  /** Files by note, oldest first then by name, as the server lists them. */
  filesByNote: Map<string, FeedAttachment[]>;
}

export function lookups(s: Snapshot): Lookups {
  const notebooks = new Map<string, FeedNotebook>();
  const fieldDefs = new Map<string, FieldDef>();
  for (const nb of s.notebooks) {
    notebooks.set(nb.id, nb);
    for (const f of nb.fieldDefs) fieldDefs.set(f.id, f);
  }
  const tags = new Map<string, FeedTag>();
  const tagsByName = new Map<string, FeedTag>();
  for (const t of s.tags) {
    tags.set(t.id, t);
    tagsByName.set(foldNoCase(t.name), t);
  }
  const filesByNote = new Map<string, FeedAttachment[]>();
  for (const a of s.attachments) {
    const list = filesByNote.get(a.noteId) ?? [];
    list.push(a);
    filesByNote.set(a.noteId, list);
  }
  for (const list of filesByNote.values()) list.sort((a, b) => a.createdAt - b.createdAt || a.filename.localeCompare(b.filename));
  return { notebooks, tags, tagsByName, fieldDefs, filesByNote };
}

const byNameNoCase = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0);

// One fold for notebooks and tags alike; see `foldNoCase` in `@unbent/shared`, which says
// why it is ASCII only. The notebook name the components have always imported.
export const sameNotebookName = sameName;

/**
 * A note's tags as names, sorted as `get` returns them; a write made here names them
 * itself. A name it gave that the library already holds in another case shows as the
 * library has it, and one name given twice in two cases is one: what `setTags` will
 * make of it when the write reaches the server (MAK-127), so the note does not change
 * spelling under the person when the feed brings the row back.
 */
export function tagNames(note: LocalNote, l: Lookups): string[] {
  let names: string[];
  if (note.tagNames) {
    const seen = new Map<string, string>();
    for (const name of note.tagNames) {
      const key = foldNoCase(name);
      if (!seen.has(key)) seen.set(key, l.tagsByName.get(key)?.name ?? name);
    }
    names = [...seen.values()];
  } else {
    names = note.tagIds.map((id) => l.tags.get(id)?.name).filter((n): n is string => n !== undefined);
  }
  return names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** A note's notebook's name: what a write made here said, else the notebook the id names. */
export function notebookName(note: LocalNote, l: Lookups): string | null {
  if (note.notebookName !== undefined) return note.notebookName;
  return note.notebookId ? (l.notebooks.get(note.notebookId)?.name ?? null) : null;
}

/**
 * A note's values, rendered from the definitions held: a field renamed records its
 * notebook, not every note that holds a value, so the carried name can be stale. The
 * carried shape stands for a definition the client does not hold (a deleted
 * notebook's tombstone), which is the one case it is current (see `FeedNote`).
 */
export function fieldValues(note: FeedNote, l: Lookups): NoteFieldValue[] {
  return (note.fields ?? []).map((v) => {
    const def = l.fieldDefs.get(v.fieldId);
    if (!def) return v;
    return {
      ...v,
      name: def.name,
      type: def.type,
      scale: def.scale,
      currency: def.currency,
      notebookId: def.notebookId,
      notebook: l.notebooks.get(def.notebookId)?.name ?? v.notebook,
    };
  });
}

/** The whole note, as `GET /notes/:id` returns it. */
export function toNote(note: LocalNote, l: Lookups): Note {
  const { tagIds: _tagIds, files: _files, fields: _fields, tagNames: _tagNames, notebookName: _notebookName, ...rest } = note;
  const fields = fieldValues(note, l);
  return {
    ...rest,
    tags: tagNames(note, l),
    notebook: notebookName(note, l),
    ...(fields.length > 0 ? { fields } : {}),
  };
}

const excerpts = new WeakMap<object, string>();

/**
 * A row's excerpt, computed once per row object. Parsing the markdown is the one costly
 * step of a list row, about a millisecond a note, so a 13K-note library summarised whole
 * was twelve seconds (measured, review of #232), and a row the feed has not replaced is
 * the same object, so the excerpt of an unchanged note is never computed twice.
 */
export function excerptOf(note: LocalNote): string {
  let excerpt = excerpts.get(note);
  if (excerpt === undefined) {
    excerpt = excerptMarkdown(note.body);
    excerpts.set(note, excerpt);
  }
  return excerpt;
}

/** The list row, as `GET /notes` returns it. */
export function toSummary(note: LocalNote, l: Lookups): NoteSummary {
  const { body: _body, ...whole } = toNote(note, l);
  const attachments = (l.filesByNote.get(note.id) ?? []).map((f) => ({ filename: f.filename, contentType: f.contentType }));
  return {
    ...whole,
    ...(attachments.length > 0 ? { attachments } : {}),
    excerpt: excerptOf(note),
  };
}

/**
 * How many files a notebook's live notes hold, and their size together: what keeping the
 * notebook on this device would cost, said before it is confirmed. The same rule the
 * keeper fetches by (`filesOf` in `keep.ts`), so the number stated is the number fetched.
 */
export function notebookFiles(s: Pick<Snapshot, 'notes' | 'attachments'>, notebookId: string): { files: number; bytes: number } {
  const files = filesOf(s, new Set([notebookId]));
  return { files: files.length, bytes: files.reduce((sum, f) => sum + f.size, 0) };
}

/** A file as the attachments panel lists it: the server's shape, and whether it is still waiting to upload from this device. */
export type LocalAttachmentInfo = AttachmentInfo & { pending?: true };

export function toAttachmentInfo(f: FeedAttachment & { pending?: true }): LocalAttachmentInfo {
  return { filename: f.filename, contentType: f.contentType, size: f.size, ...(f.pending ? { pending: true as const } : {}) };
}

/**
 * The name a file added here will have: its own, or suffixed `-2`, `-3`, … when the note
 * already holds one by that name: the server's rule (`availableFilename` in the store),
 * applied to the files this device knows of, so the link written into the note now is the
 * one the upload will make true. The server still decides; see `uploadFile` in
 * `actions.ts` for the case where it decides otherwise.
 */
export function availableFilename(taken: Iterable<string>, desired: string): string {
  const names = new Set(taken);
  if (!names.has(desired)) return desired;
  const [stem, ext] = splitExt(desired);
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${stem}-${n}${ext}`;
    if (!names.has(candidate)) return candidate;
  }
  return `${stem}-${crypto.randomUUID().slice(0, 8)}${ext}`;
}

export interface ListFilter {
  notebook?: string | undefined;
  tag?: string[] | undefined;
  field?: string[] | undefined;
  from?: string | undefined;
  to?: string | undefined;
  trashed?: boolean | undefined;
}

export interface ListOrdering {
  sort?: NoteSort | undefined;
  order?: 'asc' | 'desc' | undefined;
  sortField?: string | undefined;
}

/** The date a row shows under a sort, which is the date a range filters; see `SORTS` on the server. */
function dateOf(note: LocalNote, sort: NoteSort, byField: boolean, trashed: boolean): number {
  if (trashed) return note.deletedAt ?? note.updatedAt;
  if (byField || sort === 'title' || sort === 'updated') return note.updatedAt;
  return note.createdAt;
}

/**
 * Whether a note is in a list: the server's `liveCondition` and `filterConditions`,
 * one predicate. The notebook by name case-insensitively, tags ANDed by name, each
 * field filter against the value held, the date range inclusive on the sort's date.
 */
export function matches(note: LocalNote, filter: ListFilter, ordering: ListOrdering, l: Lookups): boolean {
  const trashed = !!filter.trashed;
  if (trashed ? note.deletedAt === undefined : note.deletedAt !== undefined) return false;
  const sort = ordering.sort ?? DEFAULT_NOTE_SORT;
  const date = dateOf(note, sort, !!ordering.sortField, trashed);
  if (filter.from && date < startOfDay(filter.from)) return false;
  if (filter.to && date > endOfDay(filter.to)) return false;
  const name = notebookName(note, l);
  if (filter.notebook === UNFILED) {
    if (name) return false;
  } else if (filter.notebook) {
    if (!name || !sameNotebookName(name, filter.notebook)) return false;
  }
  if (filter.tag && filter.tag.length > 0) {
    // Without case, as the server's filter has it: `?tag=receipts` lists Receipts' notes.
    const names = new Set(tagNames(note, l).map(foldNoCase));
    for (const t of filter.tag) if (!names.has(foldNoCase(t))) return false;
  }
  for (const raw of filter.field ?? []) {
    const f = parseFieldFilter(raw);
    if (!f) return false;
    const held = (note.fields ?? []).find((v) => v.fieldId === f.fieldId);
    switch (f.op) {
      case 'set':
        if (!held) return false;
        break;
      case 'empty':
        if (held) return false;
        break;
      case 'eq':
      case 'ne': {
        // A note with no value is not equal to anything, so `ne` holds for it.
        const v = held?.value;
        const ok =
          v === undefined ? false : Array.isArray(v) ? v.includes(f.value ?? '') : String(v) === (f.value ?? '');
        if (ok !== (f.op === 'eq')) return false;
        break;
      }
      case 'gte':
      case 'lte': {
        if (!held) return false;
        const bound = fieldRangeBound(f.op, f.value ?? '');
        const num = numericShadow(held);
        if (bound === null || num === null) return false;
        if (f.op === 'gte' ? num < bound : num > bound) return false;
        break;
      }
    }
  }
  return true;
}

/** The numeric shadow a value row carries on the server: a number, a date's epoch, a checkbox's 0/1. */
function numericShadow(v: NoteFieldValue): number | null {
  if (typeof v.value === 'number') return v.value;
  if (typeof v.value === 'boolean') return v.value ? 1 : 0;
  if (v.type === 'date' && typeof v.value === 'string') {
    const t = startOfDay(v.value);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/** The comparator a list is ordered by: the server's ORDER BY, ties settled by id. */
export function comparator(ordering: ListOrdering, trashed: boolean, sortField: FieldDef | null, l: Lookups) {
  const sort = ordering.sort ?? DEFAULT_NOTE_SORT;
  const descending = trashed || (ordering.order ?? 'desc') === 'desc';
  const dir = descending ? -1 : 1;
  return (a: LocalNote, b: LocalNote): number => {
    let c: number;
    if (trashed) {
      c = (a.deletedAt ?? 0) - (b.deletedAt ?? 0);
    } else if (sortField) {
      // Notes holding a value first, in value order; then the valueless, by id, whichever
      // direction: the two runs the server's page is made of.
      const ka = fieldSortKey(sortField, fieldValues(a, l));
      const kb = fieldSortKey(sortField, fieldValues(b, l));
      const va = ka !== '';
      const vb = kb !== '';
      if (va !== vb) return va ? -1 : 1;
      if (!va) return dir * (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      c = fieldSortsNumerically(sortField.type) ? Number(ka) - Number(kb) : byNameNoCase(String(ka), String(kb));
    } else if (sort === 'title') {
      c = byNameNoCase(a.title, b.title);
    } else if (sort === 'updated') {
      c = a.updatedAt - b.updatedAt;
    } else {
      c = a.createdAt - b.createdAt;
    }
    if (c !== 0) return dir * c;
    return dir * (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  };
}

/**
 * A list, filtered and ordered: the rows, whole, which the caller pages and then
 * summarises (`summaries`). The rows, not the summaries, because summarising is the
 * costly step and a page is fifty of thousands.
 */
export function list(s: Snapshot, filter: ListFilter, ordering: ListOrdering, l = lookups(s)): LocalNote[] {
  const sortField = ordering.sortField && !filter.trashed ? (l.fieldDefs.get(ordering.sortField) ?? null) : null;
  const rows: LocalNote[] = [];
  for (const n of s.notes) if (matches(n, filter, ordering, l)) rows.push(n);
  rows.sort(comparator(ordering, !!filter.trashed, sortField, l));
  return rows;
}

/** One page of a list as `GET /notes` returns it: the rows from `from`, `n` of them, summarised. */
export function summaries(rows: LocalNote[], from: number, n: number, l: Lookups): NoteSummary[] {
  return rows.slice(from, from + n).map((row) => toSummary(row, l));
}

/** How many notes match; the exact count, always. */
export function count(s: Snapshot, filter: ListFilter, l = lookups(s)): number {
  let n = 0;
  for (const note of s.notes) if (matches(note, filter, {}, l)) n += 1;
  return n;
}

/**
 * What each of the named fields adds up to over the rows, for the table's totals.
 *
 * A field no row holds a value for is left out rather than answered as 0, so a column of
 * blanks gets a blank total, not a "$0.00" that reads as a fact about the notes. A value
 * that is not a finite number (a stored string a conversion could not parse) is skipped,
 * as the cell draws it as text. Takes list rows or library rows: both carry `fields` with
 * the id and the value, which is all a sum needs.
 */
export function fieldSums(
  rows: Iterable<{ fields?: ReadonlyArray<{ fieldId: string; value: unknown }> | null | undefined }>,
  fieldIds: ReadonlySet<string>,
): Map<string, number> {
  const sums = new Map<string, number>();
  if (fieldIds.size === 0) return sums;
  for (const row of rows) {
    for (const f of row.fields ?? []) {
      if (!fieldIds.has(f.fieldId)) continue;
      const n = typeof f.value === 'number' ? f.value : typeof f.value === 'string' && f.value.trim() !== '' ? Number(f.value) : NaN;
      if (Number.isFinite(n)) sums.set(f.fieldId, (sums.get(f.fieldId) ?? 0) + n);
    }
  }
  return sums;
}

/** `GET /tags`: tags with a live note, most-used first then by name, each with its colour. */
export function tagSummaries(s: Snapshot): Array<{ id: string; name: string; count: number; color: number | null }> {
  const counts = new Map<string, number>();
  const byName = new Map<string, string>();
  for (const t of s.tags) byName.set(foldNoCase(t.name), t.id);
  for (const n of s.notes) {
    if (n.deletedAt !== undefined) continue;
    const ids = n.tagNames
      ? [...new Set(n.tagNames.map((name) => byName.get(foldNoCase(name))).filter((id): id is string => !!id))]
      : n.tagIds;
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const out: Array<{ id: string; name: string; count: number; color: number | null }> = [];
  for (const t of s.tags) {
    const c = counts.get(t.id) ?? 0;
    if (c > 0) out.push({ id: t.id, name: t.name, count: c, color: t.color ?? null });
  }
  return out.sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** `GET /notebooks`: every notebook with its live count and how many fields it defines, by name; and the unfiled count. */
export function notebookList(s: Snapshot): { notebooks: NotebookSummary[]; unfiled: number } {
  const counts = new Map<string, number>();
  let unfiled = 0;
  const byName = new Map<string, string>();
  for (const nb of s.notebooks) byName.set(foldNoCase(nb.name), nb.id);
  for (const n of s.notes) {
    if (n.deletedAt !== undefined) continue;
    const id = n.notebookName !== undefined ? (n.notebookName ? byName.get(foldNoCase(n.notebookName)) : undefined) : n.notebookId;
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    else unfiled += 1;
  }
  const notebooks: NotebookSummary[] = [];
  for (const nb of s.notebooks) {
    notebooks.push({ id: nb.id, name: nb.name, purpose: nb.purpose, emoji: nb.emoji, count: counts.get(nb.id) ?? 0, fields: nb.fieldDefs.length });
  }
  return { notebooks: notebooks.sort((a, b) => byNameNoCase(a.name, b.name)), unfiled };
}

/**
 * `GET /views`: every saved view of the account, in the order the server answers them:
 * by notebook, then by place within it, with the name to break a tie two devices could
 * leave for a moment (a reorder on one meeting a create on the other before the feed has
 * brought either back).
 *
 * Only the views whose notebook the snapshot holds. A notebook deleted tombstones its
 * views in the same feed page, so this is never wrong for long; but a page applied a
 * collection at a time, or a client tab whose holder is mid-page, can hold a view a
 * moment past its notebook, and a view listed under a notebook the rail no longer draws
 * would open an address that answers "not found".
 *
 * Takes the two collections alone rather than a whole `Snapshot`, so the views query can
 * read them straight from the library (`viewsQuery`).
 */
export function viewList(s: Pick<Snapshot, 'notebooks' | 'views'>): NotebookView[] {
  const notebooks = new Set<string>();
  for (const nb of s.notebooks) notebooks.add(nb.id);
  const out: NotebookView[] = [];
  for (const v of s.views) if (notebooks.has(v.notebookId)) out.push(v);
  return out.sort((a, b) => (a.notebookId < b.notebookId ? -1 : a.notebookId > b.notebookId ? 1 : 0) || a.position - b.position || byNameNoCase(a.name, b.name));
}

/**
 * A notebook's definitions, with how many notes hold a value for each when asked. The
 * count includes trashed notes, as the server's does (`listFields` counts every
 * `note_fields` row of the definition; a trashed note keeps its values until purged): the
 * number names what a deletion of the definition would discard, and the trash's values
 * go with it.
 */
export function notebookFields(s: Snapshot, notebookId: string, counts: boolean): FieldDef[] | null {
  let found: FeedNotebook | null = null;
  for (const nb of s.notebooks) if (nb.id === notebookId) found = nb;
  if (!found) return null;
  if (!counts) return found.fieldDefs;
  const held = new Map<string, number>();
  for (const n of s.notes) for (const v of n.fields ?? []) held.set(v.fieldId, (held.get(v.fieldId) ?? 0) + 1);
  return found.fieldDefs.map((f) => ({ ...f, valueCount: held.get(f.id) ?? 0 }));
}
