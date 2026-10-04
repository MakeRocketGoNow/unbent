import { toFtsQuery, type SearchResult, type SearchResultRow } from '@unbent/shared';
import { lookups as buildLookups, matches, tagNames, toSummary, type ListFilter, type LocalNote, type Lookups, type Snapshot } from './derive.js';
import type { LocalAttachment } from './collections.js';
import { SHED, type Entry, type Kind, type SearchIndex } from './search-index.js';

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
  /**
   * Aborted when nobody is waiting for the answer any more: the term changed. The
   * engine's worker runs statements in the order they arrive, so an abandoned search
   * that carried on would be work queued in front of the one that replaced it.
   */
  signal?: AbortSignal | undefined;
}

/** `meta` key set once the index has been built from a whole library. */
export const BUILT = 'built';

export async function searchLocal(opts: LocalSearchOptions): Promise<LocalSearch> {
  const { index, snapshot } = opts;
  const limit = opts.limit ?? 50;
  const l = opts.lookups ?? buildLookups(snapshot);
  const filter: ListFilter = { ...opts.filter, trashed: false };
  /*
   * The server's search reads a date range against the day a note was created, whatever
   * the list is sorted by: "filed in 2023" is the question an archive is asked.
   */
  const inScope = (note: LocalNote) => matches(note, filter, { sort: 'created' }, l);

  const notes = new Map<string, LocalNote>();
  for (const n of snapshot.notes) notes.set(n.id, n);

  const fts = toFtsQuery(opts.query);
  if (!fts) return { results: [], coverage: await coverageOf(index, snapshot, notes, inScope) };

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
    opts.signal?.throwIfAborted();
    /*
     * The best matches first, a few pages of them, and wider only if that did not fill
     * the page: forty pages, then every match. Unfiltered, the first ask is nearly
     * always enough. A filter can be satisfied by the thousandth match, so it may need
     * them all — but asking for them all at once, as this did, sent every match in an
     * archive across the worker on each keystroke of a one-letter search in a notebook,
     * when the first few hundred usually hold a page of that notebook's. Each ask starts
     * from the top again; a note already taken is skipped. Tags are asked whole: there
     * are a few hundred, and one tag can stand for any number of notes.
     */
    const caps = kind === 'tag' ? [-1] : [limit * 4, limit * 40, -1];
    const before = chosen.size;
    for (const cap of caps) {
      opts.signal?.throwIfAborted();
      const candidates = await index.candidates(kind, fts, cap);
      for (const c of candidates) {
        for (const h of resolve(c.id)) offer({ ...h, tier: n, rank: c.rank, kind, entry: c.id });
        if (chosen.size - before >= limit) break;
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

  opts.signal?.throwIfAborted();
  const snippets = new Map<Kind, Map<string, string>>();
  for (const kind of new Set(page.map((h) => h.kind))) {
    snippets.set(kind, await index.snippets(kind, fts, [...new Set(page.filter((h) => h.kind === kind).map((h) => h.entry))]));
  }

  /*
   * Last, and not at all for a search nobody is waiting for: it sends the id of every
   * file with text in scope to the index to be counted, which on an archive is the
   * largest thing a search does.
   */
  opts.signal?.throwIfAborted();
  const coverage = await coverageOf(index, snapshot, notes, inScope);
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

/**
 * How much text the notes opened here may hold between them, in characters — for a
 * scan's text, about as many bytes. A count of notes does not bound this: one file's text
 * can be half a million characters, so five hundred notes of long manuals would be a
 * quarter of a gigabyte nobody chose. Kept notebooks are not counted: their size was
 * stated and agreed to when they were kept.
 */
export const RECENT_TEXT_LIMIT = 20 * 1024 * 1024;

/** A file's entry as the index holds it: how long its text is, and whether the text was let go for room. */
export interface HeldText {
  chars: number;
  shed: boolean;
}

/** Reads a file entry's stamp: the text's length, behind `SHED` when only the length is kept. Anything else is a length of nothing. */
export function heldText(stamp: string): HeldText {
  const shed = stamp.startsWith(SHED);
  const chars = Number(shed ? stamp.slice(SHED.length) : stamp);
  return { chars: Number.isFinite(chars) ? chars : 0, shed };
}

export const textStamp = (chars: number, shed = false) => `${shed ? SHED : ''}${chars}`;

export interface TextPlan {
  /** Files whose text should be here and is not: opened notes' first, newest first, then the smallest. */
  fetch: string[];
  /** Files indexed that no kept notebook or opened note has any more. */
  remove: string[];
  /** Files whose text is here and is over the limit for opened notes: the text goes, its length stays. */
  shed: Array<{ id: string; chars: number }>;
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
 *
 * The opened notes share `limit` characters, newest first: the walk stops at the first
 * note that would pass it, and that note's text and every older one's is let go. A
 * file's length is only known once its text has been fetched, so a file let go keeps an
 * entry that remembers the length (`SHED`). Without it the next plan would count the
 * file as nothing, want it again, fetch it, and let it go again, for ever. The newest
 * note is held whatever its size: someone who has just opened a manual should find it.
 */
export function textPlan(
  snapshot: TextSnapshot,
  kept: ReadonlySet<string>,
  opened: readonly string[],
  have: ReadonlyMap<string, HeldText>,
  limit = RECENT_TEXT_LIMIT,
): TextPlan {
  const keptNotes = new Set<string>();
  const live = new Set<string>();
  for (const n of snapshot.notes) {
    if (n.deletedAt !== undefined) continue;
    live.add(n.id);
    if (n.notebookId != null && kept.has(n.notebookId)) keptNotes.add(n.id);
  }
  const byNote = new Map<string, Array<{ id: string; size: number }>>();
  for (const a of snapshot.attachments) {
    if (!a.hasText || a.pending || !live.has(a.noteId)) continue;
    const list = byNote.get(a.noteId) ?? [];
    list.push({ id: a.id, size: a.size });
    byNote.set(a.noteId, list);
  }

  const wanted = new Set<string>();
  const plan: TextPlan = { fetch: [], remove: [], shed: [] };
  const missing = (id: string) => !have.has(id) || have.get(id)!.shed;

  // Opened notes first, newest first, while they fit.
  let total = 0;
  let full = false;
  for (const noteId of opened) {
    if (keptNotes.has(noteId)) continue;
    const files = byNote.get(noteId) ?? [];
    const chars = files.reduce((sum, f) => sum + (have.get(f.id)?.chars ?? 0), 0);
    if (!full && total > 0 && total + chars > limit) full = true;
    for (const f of files) {
      wanted.add(f.id);
      const held = have.get(f.id);
      if (full) {
        if (held && !held.shed) plan.shed.push({ id: f.id, chars: held.chars });
      } else if (missing(f.id)) {
        plan.fetch.push(f.id);
      }
    }
    if (!full) total += chars;
  }

  const fromKept: Array<{ id: string; size: number }> = [];
  for (const noteId of keptNotes) {
    for (const f of byNote.get(noteId) ?? []) {
      wanted.add(f.id);
      if (missing(f.id)) fromKept.push(f);
    }
  }
  fromKept.sort((a, b) => a.size - b.size);
  plan.fetch.push(...fromKept.map((f) => f.id));
  plan.remove = [...have.keys()].filter((id) => !wanted.has(id));
  return plan;
}
