import { z } from 'zod';
import { dateOnlySchema } from './dates.js';
import { parseFieldFilter } from './fields.js';
import { MAX_FIELD_FILTERS, MAX_TAG_LENGTH, NOTE_SORTS, DEFAULT_NOTE_SORT, tagNameSchema } from './schemas.js';
import type { NoteSort } from './schemas.js';

/**
 * A saved view: a notebook's list the way someone left it, under a name.
 *
 * Everything that narrows or orders a notebook's list is already spelled out in the
 * page's address (its tags, its field filters, its sort, its date range, whether it is
 * drawn as a list, cards or a table). A view is that address with a name on it, kept in
 * the account so every device lists it under its notebook. It is a bookmark, never a
 * mode: opening one writes every filter back into the address, where the chips show
 * them and take them off as they always have, and the view's id rides beside them
 * (`?saved=`) so the heading knows what to call the place and whether the person has
 * wandered from it.
 *
 * Per notebook, because that is where the lists worth saving are: field filters and the
 * table exist only inside a notebook, and the overloading a view relieves (one Receipts
 * notebook doing personal, business and tax-year duty, told apart by its fields) happens
 * inside one. `notebookId` is still nullable in the store so a view over the whole
 * library can come later without a migration; nothing writes one yet.
 *
 * What is deliberately not in it: the search text (`q`). A search narrows whatever is on
 * screen, a view included, so typing one inside a view is not wandering from it, and a
 * view that was a search could not be drawn as a table or counted on the device. The
 * table's columns are not here either: every field is a column today, so there is
 * nothing to choose.
 */

/** How the list is drawn. The address calls this `view`; here it is the layout, since a view is the whole thing. */
export const VIEW_LAYOUTS = ['list', 'cards', 'table'] as const;
export type ViewLayout = (typeof VIEW_LAYOUTS)[number];

/** A view's name: a notebook's rules, since the two sit in the same column of the rail. */
export const viewNameSchema = z.string().trim().min(1).max(MAX_TAG_LENGTH);

/**
 * What a view keeps, as the server stores it and the feed carries it.
 *
 * Tags by name and fields in the address's own `<fieldId>:<op>[:<value>]` spelling, which
 * is what the list route reads and the API filters by; the store rewrites the tag names
 * on a rename so a view does not go on naming a tag that no longer exists. Strict, so a
 * key this build does not know is refused rather than stored and answered to every
 * device: an old page replaying a view cannot be made to carry what it cannot read.
 */
export const viewQuerySchema = z
  .object({
    tag: z.array(tagNameSchema).max(20).optional(),
    field: z
      .array(z.string().refine((raw) => parseFieldFilter(raw) !== null, 'Unreadable field filter'))
      .max(MAX_FIELD_FILTERS)
      .optional(),
    sort: z.enum(NOTE_SORTS).optional(),
    order: z.enum(['asc', 'desc']).optional(),
    sortField: z.string().uuid().optional(),
    from: dateOnlySchema.optional(),
    to: dateOnlySchema.optional(),
    layout: z.enum(VIEW_LAYOUTS).optional(),
  })
  .strict();

export type ViewQuery = z.infer<typeof viewQuerySchema>;

export const createViewSchema = z.object({
  notebookId: z.string().uuid(),
  name: viewNameSchema,
  query: viewQuerySchema,
});

/**
 * What a view's edit may change. `position` is its place among its notebook's views,
 * from zero; the store closes the gap it leaves and opens one where it lands.
 */
export const updateViewSchema = z
  .object({
    name: viewNameSchema.optional(),
    query: viewQuerySchema.optional(),
    position: z.number().int().nonnegative().optional(),
  })
  .refine((v) => v.name !== undefined || v.query !== undefined || v.position !== undefined, {
    message: 'Nothing to change: give a name, a query, or a position',
  });

/** A view as the API answers it and the device keeps it. */
export interface NotebookView {
  id: string;
  notebookId: string;
  name: string;
  /** Its place among the notebook's views, from zero. */
  position: number;
  query: ViewQuery;
  updatedAt: number;
}

/**
 * The address's filters, as the list route reads them. Named here rather than imported
 * from the web app so the server and the device agree on what a view is made of.
 */
export interface ListAddress {
  tag?: readonly string[] | undefined;
  field?: readonly string[] | undefined;
  sort?: NoteSort | undefined;
  order?: 'asc' | 'desc' | undefined;
  sortField?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  /** The layout, under the address's own name for it. */
  view?: ViewLayout | undefined;
}

const byTag = new Intl.Collator(undefined, { sensitivity: 'base' }).compare;

/**
 * A view's query from an address, in one spelling.
 *
 * Tags and fields are sets (several narrow conjunctively, in any order) so they are
 * sorted; the defaults the address leaves out (`created`, `desc`) are left out here too,
 * and written explicitly are read as absent, so `sameViewQuery` compares what the list
 * shows and not how the address happened to spell it. `sortField` wins over `sort`
 * when both are given, as it does on the server, so a query never carries both.
 */
export function viewQueryOf(address: ListAddress): ViewQuery {
  const out: ViewQuery = {};
  const tags = [...(address.tag ?? [])].filter((t) => t.trim() !== '');
  if (tags.length > 0) out.tag = [...new Set(tags)].sort(byTag);
  const fields = [...(address.field ?? [])].filter((f) => parseFieldFilter(f) !== null);
  if (fields.length > 0) out.field = [...new Set(fields)].sort();
  if (address.sortField) out.sortField = address.sortField;
  else if (address.sort && address.sort !== DEFAULT_NOTE_SORT) out.sort = address.sort;
  if (address.order && address.order !== 'desc') out.order = address.order;
  if (address.from) out.from = address.from;
  if (address.to) out.to = address.to;
  if (address.view) out.layout = address.view;
  return out;
}

/**
 * The address a view opens at, before the notebook and the view's own id are added.
 * The inverse of `viewQueryOf`: the list route's own parameter names, the layout under
 * `view`, and nothing for what the view leaves at the default.
 */
export function addressOfView(query: ViewQuery): ListAddress {
  const out: ListAddress = {};
  if (query.tag && query.tag.length > 0) out.tag = [...query.tag];
  if (query.field && query.field.length > 0) out.field = [...query.field];
  if (query.sortField) out.sortField = query.sortField;
  else if (query.sort) out.sort = query.sort;
  if (query.order) out.order = query.order;
  if (query.from) out.from = query.from;
  if (query.to) out.to = query.to;
  if (query.layout) out.view = query.layout;
  return out;
}

/**
 * Whether two queries show the same list.
 *
 * Compared in the canonical spelling, so `{tag: ['b', 'a']}` is `{tag: ['a', 'b']}` and
 * an explicit default is no default. The layout is compared only when both sides name
 * one: an address has none for a moment on arrival, before the layout last seen is
 * written in, and a view opened then must not read as edited for that moment.
 */
export function sameViewQuery(a: ViewQuery, b: ViewQuery): boolean {
  const ca = viewQueryOf(addressOfView(a));
  const cb = viewQueryOf(addressOfView(b));
  if (ca.layout === undefined || cb.layout === undefined) {
    delete ca.layout;
    delete cb.layout;
  }
  return JSON.stringify(ordered(ca)) === JSON.stringify(ordered(cb));
}

/** The keys in one order, so `JSON.stringify` is a fair comparison. */
function ordered(query: ViewQuery): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(query).sort()) out[key] = (query as Record<string, unknown>)[key];
  return out;
}

/**
 * Whether an address narrows or orders a notebook's list at all: what decides whether
 * there is anything to save. The layout alone does not count: "Receipts as a table" with
 * nothing else is the notebook with the layout menu set, and the layout is remembered
 * per device already.
 */
export function narrowsList(address: ListAddress): boolean {
  const q = viewQueryOf(address);
  delete q.layout;
  return Object.keys(q).length > 0;
}

/**
 * The query with a renamed tag under its new name, or `null` when the view does not name
 * the old one: the store applies it to every view of the account on a tag rename and
 * records the ones it changed. A tag deleted is `to: null`, which drops it.
 */
export function renameTagInQuery(query: ViewQuery, from: string, to: string | null): ViewQuery | null {
  if (!query.tag) return null;
  const idx = query.tag.findIndex((t) => byTag(t, from) === 0);
  if (idx === -1) return null;
  const tags = query.tag.filter((_, i) => i !== idx);
  if (to !== null && !tags.some((t) => byTag(t, to) === 0)) tags.push(to);
  const out = { ...query };
  if (tags.length > 0) out.tag = tags.sort(byTag);
  else delete out.tag;
  return out;
}

/**
 * The query without any filter or sort on a deleted field, or `null` when it carries
 * none: the store applies it to the notebook's views when a field is deleted.
 */
export function dropFieldFromQuery(query: ViewQuery, fieldId: string): ViewQuery | null {
  const fields = (query.field ?? []).filter((raw) => parseFieldFilter(raw)?.fieldId !== fieldId);
  const sortsBy = query.sortField === fieldId;
  if (fields.length === (query.field ?? []).length && !sortsBy) return null;
  const out = { ...query };
  if (fields.length > 0) out.field = fields;
  else delete out.field;
  if (sortsBy) delete out.sortField;
  return out;
}
