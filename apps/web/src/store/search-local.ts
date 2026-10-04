import { toFtsQuery, type SearchResult, type SearchResultRow } from '@unbent/shared';
import { lookups as buildLookups, matches, tagNames, toSummary, type ListFilter, type LocalNote, type Lookups, type Snapshot } from './derive.js';
import type { LocalAttachment } from './collections.js';
import type { Entry, Kind, SearchIndex } from './search-index.js';

/**
 * A search answered on the device: the server's `search`, with the library's rows doing
 * what its joins do.
 *
 * The index (`search-index.ts`) says which notes, tags, field values and files match and
 * how well. Everything else the server's query knows — which notes carry a tag, whether a
 * note is live, whether it is in the notebook being looked at — the library already
 * holds, whole and current, so it is asked here rather than copied into the index to go
 * stale. The outcome is the server's: one row per note, from the best tier it matched
 * in, ordered by tier, then relevance, then id.
 */

/** What a field value's entry is keyed by: the note, then the field. Neither id contains U+0001. */
const FIELD_SEP = '\u0001';
export const fieldEntryId = (noteId: string, fieldId: string) => `${noteId}${FIELD_SEP}${fieldId}`;
export const fieldEntryPrefix = (noteId: string) => `${noteId}${FIELD_SEP}`;

/**
 * A stamp for text: fifty-three bits of cyrb53. Not a digest — it has to tell an edited
 * note from the copy already indexed, across an archive, without reading the index's
 * text back. A collision costs one stale entry until that note next changes.
 */
export function stampOf(...parts: string[]): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (const part of parts) {
    for (let i = 0; i < part.length; i += 1) {
      const ch = part.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    // A separator, so ('ab', 'c') and ('a', 'bc') differ.
    h1 = Math.imul(h1 ^ 0x1f, 2654435761);
    h2 = Math.imul(h2 ^ 0x1f, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * A field value as the server stores it for search (`note_fields.value_text`): the value
 * as text, a multi-select as its JSON array. The server's text is not on the feed's
 * rows, and spelling it the same way keeps a snippet the same with and without a
 * connection.
 */
export function fieldText(value: unknown): string {
  return Array.isArray(value) ? JSON.stringify(value) : String(value);
}

/** What a live note puts in the index: itself, and an entry per field value it holds. */
export function noteEntries(note: LocalNote): { note: Entry; fields: Entry[] } {
  return {
    note: { id: note.id, stamp: stampOf(note.title, note.body), columns: [note.title, note.body] },
    fields: (note.fields ?? []).map((v) => {
      const text = fieldText(v.value);
      return { id: fieldEntryId(note.id, v.fieldId), stamp: stampOf(text), columns: [text] };
    }),
  };
}

/**
 * Every tag name in the library, as entries. By name rather than id: a tag given to a
 * note here, with no connection, has no id until the server mints one, and it should
 * find its note meanwhile (`LocalNote.tagNames`).
 */
export function tagEntries(snapshot: Pick<Snapshot, 'notes' | 'tags'>): Entry[] {
  const names = new Set<string>();
  for (const t of snapshot.tags) names.add(t.name);
  for (const n of snapshot.notes) for (const name of n.tagNames ?? []) names.add(name);
  return [...names].map((name) => ({ id: name, stamp: '', columns: [name] }));
}

/** A file whose text could be searched: read by the server, and not one still waiting to upload. */
const searchable = (a: LocalAttachment) => a.hasText && !a.pending;

/** What a local search covered, for the line under its results. */
export interface LocalCoverage {
  /** Whether the index has been built once from a whole library; until then matches can be missing. */
  built: boolean;
  /** The files with text among the notes the search looked at, and how many of them are indexed here. */
  files: { searched: number; total: number };
}

export interface LocalSearch {
  results: Array<SearchResult | SearchResultRow>;
  coverage: LocalCoverage;
}

interface Hit {
  note: LocalNote;
  tier: number;
  rank: number;
  kind: Kind;
  /** The entry that matched, for its snippet. */
  entry: string;
  matched?: { file?: string; field?: string; tag?: string };
}

export interface LocalSearchOptions {
  index: SearchIndex;
  snapshot: Snapshot;
  lookups?: Lookups;
  query: string;
  filter?: ListFilter;
  limit?: number;
  /** Each match's list row as well, for a table; see `rows` on the server's search. */
  rows?: boolean;
}

/** `meta` key set once the index has been built from a whole library. */
export const BUILT = 'built';

export async function searchLocal(opts: LocalSearchOptions): Promise<LocalSearch> {
  const { index, snapshot } = opts;
  const limit = opts.limit ?? 50;
  const l = opts.lookups ?? buildLookups(snapshot);
  const filter: ListFilter = { ...opts.filter, trashed: false };
  const filtered = !!(filter.notebook || filter.tag?.length || filter.field?.length || filter.from || filter.to);
  /*
   * The server's search reads a date range against the day a note was created, whatever
   * the list is sorted by: "filed in 2023" is the question an archive is asked.
   */
  const inScope = (note: LocalNote) => matches(note, filter, { sort: 'created' }, l);

  const notes = new Map<string, LocalNote>();
  for (const n of snapshot.notes) notes.set(n.id, n);
  const coverage = await coverageOf(index, snapshot, notes, inScope);

  const fts = toFtsQuery(opts.query);
  if (!fts) return { results: [], coverage };

  const chosen = new Map<string, Hit>();
  const offer = (hit: Hit) => {
    if (chosen.has(hit.note.id) || !inScope(hit.note)) return;
    chosen.set(hit.note.id, hit);
  };
  /*
   * A tier is asked only while the tiers above it have not filled the page, as on the
   * server: nothing lower can outrank them. Within a tier the best matches come first,
   * so it stops once it has offered a page of its own.
   */
  const tier = async (kind: Kind, n: number, resolve: (entryId: string) => Array<Omit<Hit, 'tier' | 'rank' | 'kind' | 'entry'>>) => {
    if (chosen.size >= limit) return;
    /*
     * Unfiltered, the first matches are nearly all results, so a few pages are asked for;
     * a filter can be satisfied by the thousandth match, so then every match is. Asked
     * again in full if the short list ran out before the page filled (entries of notes
     * since trashed, or many matches inside one note).
     */
    const short = filtered || kind === 'tag' ? -1 : limit * 4;
    for (const cap of short === -1 ? [-1] : [short, -1]) {
      const candidates = await index.candidates(kind, fts, cap);
      const before = chosen.size;
      let offered = 0;
      for (const c of candidates) {
        for (const h of resolve(c.id)) {
          const size = chosen.size;
          offer({ ...h, tier: n, rank: c.rank, kind, entry: c.id });
          if (chosen.size > size) offered += 1;
        }
        if (offered >= limit) break;
      }
      if (cap === -1 || candidates.length < cap || chosen.size - before >= limit) break;
    }
  };

  await tier('note', 0, (id) => {
    const note = notes.get(id);
    return note ? [{ note }] : [];
  });

  let byTag: Map<string, LocalNote[]> | null = null;
  await tier('tag', 1, (name) => {
    if (!byTag) {
      byTag = new Map();
      for (const n of notes.values()) {
        for (const t of tagNames(n, l)) {
          const list = byTag.get(t) ?? [];
          list.push(n);
          byTag.set(t, list);
        }
      }
    }
    return (byTag.get(name) ?? []).map((note) => ({ note, matched: { tag: name } }));
  });

  await tier('field', 2, (id) => {
    const cut = id.indexOf(FIELD_SEP);
    const note = notes.get(id.slice(0, cut));
    const fieldId = id.slice(cut + 1);
    const held = note?.fields?.find((v) => v.fieldId === fieldId);
    if (!note || !held) return [];
    // The name from the definition held, as everywhere a value is drawn; see `fieldValues`.
    return [{ note, matched: { field: l.fieldDefs.get(fieldId)?.name ?? held.name } }];
  });

  let files: Map<string, LocalAttachment> | null = null;
  await tier('file', 3, (id) => {
    if (!files) {
      files = new Map();
      for (const a of snapshot.attachments) files.set(a.id, a);
    }
    const file = files.get(id);
    const note = file && notes.get(file.noteId);
    return file && note ? [{ note, matched: { file: file.filename } }] : [];
  });

  const page = [...chosen.values()]
    .sort((a, b) => a.tier - b.tier || a.rank - b.rank || (a.note.id < b.note.id ? -1 : a.note.id > b.note.id ? 1 : 0))
    .slice(0, limit);

  const snippets = new Map<Kind, Map<string, string>>();
  for (const kind of new Set(page.map((h) => h.kind))) {
    snippets.set(kind, await index.snippets(kind, fts, [...new Set(page.filter((h) => h.kind === kind).map((h) => h.entry))]));
  }

  return {
    coverage,
    results: page.map((h) => ({
      id: h.note.id,
      title: h.note.title,
      updatedAt: h.note.updatedAt,
      snippet: snippets.get(h.kind)?.get(h.entry) ?? '',
      ...(h.matched?.file ? { matchedFile: h.matched.file } : {}),
      ...(h.matched?.field ? { matchedField: h.matched.field } : {}),
      ...(h.matched?.tag ? { matchedTag: h.matched.tag } : {}),
      ...(opts.rows ? { note: toSummary(h.note, l) } : {}),
    })),
  };
}

/**
 * What the search could see: whether the index is whole, and of the files with text on
 * the notes in scope, how many are indexed here. The second is the honest part of an
 * offline search — a phrase from a scan in a notebook that is not kept offline finds
 * nothing, and the line under the results has to be able to say that is why.
 */
async function coverageOf(
  index: SearchIndex,
  snapshot: Snapshot,
  notes: Map<string, LocalNote>,
  inScope: (note: LocalNote) => boolean,
): Promise<LocalCoverage> {
  const scope = new Map<string, boolean>();
  const ids: string[] = [];
  for (const a of snapshot.attachments as Iterable<LocalAttachment>) {
    if (!searchable(a)) continue;
    let inside = scope.get(a.noteId);
    if (inside === undefined) {
      const note = notes.get(a.noteId);
      inside = !!note && inScope(note);
      scope.set(a.noteId, inside);
    }
    if (inside) ids.push(a.id);
  }
  const [built, searched] = await Promise.all([index.meta(BUILT), ids.length > 0 ? index.held('file', ids) : 0]);
  return { built: built === '1', files: { searched, total: ids.length } };
}

/** What `SearchSync` reads of the library to decide which files' text to hold. */
export interface TextSnapshot {
  notes: Iterable<Pick<LocalNote, 'id' | 'notebookId' | 'deletedAt'>>;
  attachments: Iterable<Pick<LocalAttachment, 'id' | 'noteId' | 'size' | 'hasText' | 'pending'>>;
}

export interface TextPlan {
  /** Files whose text should be here and is not: opened notes' first, then the smallest. */
  fetch: string[];
  /** Files indexed that no kept notebook or opened note has any more. */
  remove: string[];
}

/**
 * Which files' text this device should hold: those with text on a live note that is in a
 * notebook kept offline, or was opened here lately. A pure function of the library, the
 * two lists and what is indexed, in the shape of `keep.ts`'s `plan` and for its reason:
 * the cases are here, and a table can test them.
 *
 * Not every file's. Extracted text is the largest thing an account stores after the
 * files — tens of megabytes on an archive — and most of it is never searched from a
 * given phone; a kept notebook and an opened note are the two ways someone has already
 * said which documents they want with them.
 */
export function textPlan(snapshot: TextSnapshot, kept: ReadonlySet<string>, opened: ReadonlySet<string>, have: ReadonlySet<string>): TextPlan {
  const wantedNotes = new Set<string>();
  for (const n of snapshot.notes) {
    if (n.deletedAt !== undefined) continue;
    if (opened.has(n.id) || (n.notebookId != null && kept.has(n.notebookId))) wantedNotes.add(n.id);
  }
  const wanted = new Set<string>();
  const fetch: Array<{ id: string; recent: boolean; size: number }> = [];
  for (const a of snapshot.attachments) {
    if (!a.hasText || a.pending || !wantedNotes.has(a.noteId)) continue;
    wanted.add(a.id);
    if (!have.has(a.id)) fetch.push({ id: a.id, recent: opened.has(a.noteId), size: a.size });
  }
  fetch.sort((a, b) => Number(b.recent) - Number(a.recent) || a.size - b.size);
  return { fetch: fetch.map((f) => f.id), remove: [...have].filter((id) => !wanted.has(id)) };
}
