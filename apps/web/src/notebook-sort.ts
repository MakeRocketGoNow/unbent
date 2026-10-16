import { NOTE_SORTS, type NoteSort } from '@unbent/shared';

/**
 * The sort each place was last left in, remembered on this device.
 *
 * A notebook of receipts wants its newest first and a notebook of recipes wants A–Z, and
 * re-picking that every visit is the chore this saves. The sort used to ride along from
 * one notebook to the next, which was only ever right by coincidence: the order that suits
 * the place being left says nothing about the one being entered.
 *
 * In localStorage rather than the database. It is a preference about how one device looks
 * at a list, not something about the notes, and keeping it on the server would cost a D1
 * write on every sort change and a read on every visit for something nobody would miss on
 * a second device. `usePersistentState` is not used because this is read from plain link
 * builders and a route effect, not held as one component's state; it shares the prefix.
 *
 * Keyed by the notebook's name, because the URL carries the name: the id is not known
 * until the notebooks load, and a link has to be built before then. A rename therefore
 * starts the notebook over at the default, which is a lost preference, not a wrong one.
 * All notes and the tag places have no notebook and share the empty key: they are the
 * whole archive, narrowed or not, and a field sort cannot apply there anyway.
 */
const KEY = 'unbent.notebookSorts';

/** A place's ordering as the URL spells it: absent keys are the defaults. */
export interface Ordering {
  sort?: NoteSort | undefined;
  order?: 'asc' | 'desc' | undefined;
  sortField?: string | undefined;
}

type Stored = Record<string, Ordering>;

function scopeKey(notebook: string | undefined): string {
  return notebook ?? '';
}

/** Keeps only what could have been written: a hand-edited or outdated value is ignored. */
function clean(raw: unknown): Ordering | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { sort, order, sortField } = raw as Record<string, unknown>;
  const out: Ordering = {};
  if (typeof sort === 'string' && (NOTE_SORTS as readonly string[]).includes(sort)) {
    out.sort = sort as NoteSort;
  }
  if (order === 'asc' || order === 'desc') out.order = order;
  if (typeof sortField === 'string' && sortField !== '') out.sortField = sortField;
  return out;
}

function read(): Stored {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw === null ? {} : JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Stored)
      : {};
  } catch {
    // Disabled storage or a half-written value: nothing is remembered, which is the default.
    return {};
  }
}

function write(stored: Stored) {
  try {
    localStorage.setItem(KEY, JSON.stringify(stored));
  } catch {
    // Quota or private browsing. The sort still applies; it just is not kept.
  }
}

/**
 * The ordering to open a place in, every key present so that spreading it over the
 * current search replaces the ordering being left rather than inheriting part of it.
 */
export function rememberedSort(notebook: string | undefined): {
  sort: NoteSort | undefined;
  order: 'asc' | 'desc' | undefined;
  sortField: string | undefined;
} {
  const found = clean(read()[scopeKey(notebook)]) ?? {};
  return {
    sort: found.sort,
    order: found.order,
    // A field belongs to a notebook; outside one there is nothing for it to name.
    sortField: notebook === undefined ? undefined : found.sortField,
  };
}

/** Whether a place has anything remembered: the defaults are not written down. */
export function hasRememberedSort(notebook: string | undefined): boolean {
  const o = rememberedSort(notebook);
  return o.sort !== undefined || o.order !== undefined || o.sortField !== undefined;
}

/**
 * Records a sort someone chose, in the URL's spelling. Choosing the default forgets the
 * place instead, so the map only ever holds places that differ from it.
 */
export function rememberSort(notebook: string | undefined, ordering: Ordering) {
  const stored = read();
  const key = scopeKey(notebook);
  const kept = clean(ordering) ?? {};
  if (Object.keys(kept).length === 0) delete stored[key];
  else stored[key] = kept;
  write(stored);
}

/**
 * Forgets a place's sort once its field no longer resolves: the field was deleted, or
 * the notebook renamed onto one without it. The whole entry goes, not just the field: the
 * direction was chosen for that field, and left on its own it would pair with the default
 * sort as "oldest updated", which is not an order the app offers.
 */
export function forgetSortField(notebook: string | undefined) {
  const stored = read();
  const key = scopeKey(notebook);
  if (clean(stored[key])?.sortField === undefined) return;
  delete stored[key];
  write(stored);
}
