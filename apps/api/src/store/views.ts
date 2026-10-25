import { dropFieldFromQuery, renameOptionInQuery, renameTagInQuery, type NotebookView, type ViewQuery } from '@unbent/shared';
import type { Change, Feed } from './feed.js';
import { placeholders, runs } from './notes-shared.js';
import type { Sql } from './sql.js';

/** A row of `notebook_views` as the reads select it. */
interface ViewRow {
  id: string;
  /**
   * Nullable in the schema for the library views that may come later (0010), and never
   * null today: the route refuses one and nothing else writes a view. Typed as the
   * contract has it (`NotebookView.notebookId` is a string) rather than widened here,
   * so the day a library view is written the contract changes first and this with it.
   */
  notebook_id: string;
  name: string;
  position: number;
  query: string;
  updated_at: number;
}

const COLUMNS = `id, notebook_id, name, position, query, updated_at`;

function toView(row: ViewRow): NotebookView {
  return {
    id: row.id,
    notebookId: row.notebook_id,
    name: row.name,
    position: row.position,
    query: JSON.parse(row.query) as ViewQuery,
    updatedAt: row.updated_at,
  };
}

/** What a view's edit may change; see `updateViewSchema` in `@unbent/shared`. */
export interface ViewPatch {
  name?: string | undefined;
  query?: ViewQuery | undefined;
  position?: number | undefined;
}

/**
 * Saved views (schema 0010, MAK-249): a notebook's list the way someone left it, under a
 * name. What a view is and what it deliberately leaves out is in `views.ts` in
 * `@unbent/shared`; this is the store's half.
 *
 * A module of its own rather than more of `NotesStore`, which is a notes repository
 * that grew notebooks, tags and fields because each of those is joined into a note's
 * row. A view is joined into nothing: no note refers to one, and no read of notes reads
 * one. It shares the object's `Sql` and `Feed` the way `DeletedBlobs` shares the `Sql`,
 * so its writes commit in the same transactions and number in the same feed.
 *
 * Every public method that writes opens its own `tx()` and records inside it, after the
 * write, for the rows the write actually changed (`RETURNING`, or a comparison of the
 * query before and after), so a write that changed nothing moves no counter. A view is
 * one feed row carried whole (`FeedView`), and a move among a notebook's views changes
 * the position of each view it passes, each of which is its own row on every device, so
 * each is recorded.
 *
 * The cascades at the end (`renameTag`, `dropField`, `dropNotebook`) are what a tag's,
 * a field's or a notebook's management does to the views that name it, called by
 * `NotesStore` from inside the transaction of the write that renamed or deleted it, so
 * the view and the thing it names change together or not at all. They are private
 * helpers in the sense `Sql.tx` means and open no transaction of their own.
 *
 * A select option renamed reaches a view too (`renameOption`), since a filter on a select
 * compares against the option's text and the notes' values move with the rename; an
 * option removed does not, for the reason `renameOptionInQuery` gives.
 *
 * What does not reach a view: the purge's sweep of tags no note carries any more
 * (`sweepAfterPurge`). That is housekeeping, not anyone deciding the tag should go, and a
 * view that filters by a name nothing carries today shows the notes again the moment one
 * is tagged with it; taking the tag out of the query would quietly widen the view. A
 * field converted to another type keeps its filters too: the filter is still about that
 * field, and the list reads one that no longer fits the type as matching nothing.
 */
export class ViewsStore {
  constructor(
    private readonly sql: Sql,
    private readonly feed: Feed,
  ) {}

  /** Every view of the account, grouped by notebook in its order: what `GET /views` answers. */
  list(): NotebookView[] {
    return this.sql
      .exec<ViewRow>(`SELECT ${COLUMNS} FROM notebook_views ORDER BY notebook_id, position, name COLLATE NOCASE`)
      .map(toView);
  }

  /**
   * Views by id, for the feed, or every view when `ids` is null (the snapshot's first
   * page), the shape of `NotesStore.notebooksWhole`. By primary key in runs under the
   * bind cap; an id with no row (deleted by a later write than the page reaches) is left
   * out, and its tombstone is on the next page.
   */
  whole(ids: string[] | null): NotebookView[] {
    if (ids !== null && ids.length === 0) return [];
    const runsOf = ids === null ? [null] : runs([...new Set(ids)]);
    const out: NotebookView[] = [];
    for (const run of runsOf) {
      const where = run ? `WHERE id IN (${placeholders(1, run.length)})` : '';
      out.push(
        ...this.sql
          .exec<ViewRow>(`SELECT ${COLUMNS} FROM notebook_views ${where} ORDER BY notebook_id, position`, ...(run ?? []))
          .map(toView),
      );
    }
    return out;
  }

  /**
   * Adds a view at the end of its notebook's. `missing` for a notebook that is not
   * there; `conflict` for a name another of the notebook's views has, without case.
   *
   * The unique constraint is the check (`ON CONFLICT DO NOTHING`, and nothing back from
   * `RETURNING` means the name was taken), so a create reads the notebook's row and the
   * maximum position and nothing else. The notebook is read first rather than left to
   * the foreign key, which would throw where the route wants an answer it can map.
   */
  create(notebookId: string, name: string, query: ViewQuery): NotebookView | 'conflict' | 'missing' {
    return this.sql.tx(() => {
      if (!this.sql.first(`SELECT 1 AS hit FROM notebooks WHERE id = ?1`, notebookId)) return 'missing';
      const now = Date.now();
      const [row] = this.sql.exec<ViewRow>(
        `INSERT INTO notebook_views (id, notebook_id, name, position, query, created_at, updated_at)
         VALUES (?1, ?2, ?3,
                 (SELECT COALESCE(MAX(position) + 1, 0) FROM notebook_views WHERE notebook_id = ?2),
                 ?4, ?5, ?5)
         ON CONFLICT DO NOTHING
         RETURNING ${COLUMNS}`,
        crypto.randomUUID(),
        notebookId,
        name.trim(),
        JSON.stringify(query),
        now,
      );
      if (!row) return 'conflict';
      this.feed.record([{ entity: 'view', id: row.id }]);
      return toView(row);
    });
  }

  /**
   * Renames a view, replaces its query, or moves it among its notebook's views; any
   * together. `missing` for an id that is not a view, `conflict` for a name another of
   * the notebook's views has, and nothing written for either.
   *
   * A name or query the same as the row's writes nothing and records nothing, as a
   * notebook renamed to its own name does. A taken name is caught by the constraint
   * (`UPDATE OR IGNORE`, and no row back), the way `create` catches it; the view's own
   * row cannot conflict with itself, so changing only a name's case is a rename.
   *
   * A move takes the view out of its notebook's order and puts it back at `position`,
   * clamped to the end, then writes the position of every view whose place changed:
   * the one moved and each it passed, and each of those is a feed row. The order is
   * read by position and rewritten from zero, so a notebook whose positions had a gap
   * (none should) comes out dense again rather than carrying the gap forward.
   */
  update(id: string, patch: ViewPatch): NotebookView | 'conflict' | 'missing' {
    return this.sql.tx(() => {
      const row = this.sql.first<ViewRow>(`SELECT ${COLUMNS} FROM notebook_views WHERE id = ?1`, id);
      if (!row) return 'missing';
      const now = Date.now();
      const changed: Change[] = [];

      const name = patch.name !== undefined ? patch.name.trim() : row.name;
      const query = patch.query !== undefined ? JSON.stringify(patch.query) : row.query;
      if (name !== row.name || query !== row.query) {
        const written = this.sql.exec<{ id: string }>(
          `UPDATE OR IGNORE notebook_views SET name = ?1, query = ?2, updated_at = ?3 WHERE id = ?4 RETURNING id`,
          name,
          query,
          now,
          id,
        );
        if (written.length === 0) return 'conflict';
        changed.push({ entity: 'view', id });
      }

      if (patch.position !== undefined) {
        const order = this.sql
          .exec<{ id: string; position: number }>(
            `SELECT id, position FROM notebook_views WHERE notebook_id = ?1 ORDER BY position, name COLLATE NOCASE`,
            row.notebook_id,
          );
        const was = new Map(order.map((v) => [v.id, v.position]));
        const ids = order.map((v) => v.id).filter((v) => v !== id);
        ids.splice(Math.min(patch.position, ids.length), 0, id);
        ids.forEach((viewId, position) => {
          if (was.get(viewId) === position) return;
          this.sql.exec(`UPDATE notebook_views SET position = ?1, updated_at = ?2 WHERE id = ?3`, position, now, viewId);
          changed.push({ entity: 'view', id: viewId });
        });
      }

      this.feed.record(changed, now);
      if (changed.length === 0) return toView(row);
      return toView(this.sql.first<ViewRow>(`SELECT ${COLUMNS} FROM notebook_views WHERE id = ?1`, id)!);
    });
  }

  /**
   * Deletes a view, and closes the gap it leaves so its notebook's positions stay dense:
   * every view after it moves up one, and each is a feed row, as a move's are. False for
   * an id that is not a view.
   */
  delete(id: string): boolean {
    return this.sql.tx(() => {
      const [gone] = this.sql.exec<{ notebook_id: string; position: number }>(
        `DELETE FROM notebook_views WHERE id = ?1 RETURNING notebook_id, position`,
        id,
      );
      if (!gone) return false;
      const now = Date.now();
      const shifted = this.sql.exec<{ id: string }>(
        `UPDATE notebook_views SET position = position - 1, updated_at = ?1
          WHERE notebook_id = ?2 AND position > ?3 RETURNING id`,
        now,
        gone.notebook_id,
        gone.position,
      );
      this.feed.record(
        [{ entity: 'view', id, deleted: true }, ...shifted.map((r) => ({ entity: 'view' as const, id: r.id }))],
        now,
      );
      return true;
    });
  }

  // --- Cascades: run inside the caller's transaction ------------------------------------

  /**
   * Respells a renamed tag in every view that names it, or takes a deleted one out
   * (`to: null`), with `renameTagInQuery`, the same rule the device would apply. A merge
   * is a rename to the surviving tag's name, which the helper does not add twice.
   *
   * Every view of the account is read, since a tag is the account's and not a
   * notebook's: a handful of rows, and the rewrite is in JavaScript because the rules for
   * a query are the shared helpers' and SQL would be a second copy of them.
   */
  renameTag(from: string, to: string | null): void {
    this.rewrite((query) => renameTagInQuery(query, from, to));
  }

  /**
   * Takes a deleted field's filters and its sort out of every view, with
   * `dropFieldFromQuery`. Every view rather than the field's notebook's alone: a field's
   * id is unique across the account, so the others are untouched by the helper anyway,
   * and reading them costs the handful of rows `renameTag` reads.
   */
  dropField(fieldId: string): void {
    this.rewrite((query) => dropFieldFromQuery(query, fieldId));
  }

  /**
   * Respells a renamed option in every filter on its field, with `renameOptionInQuery`,
   * for `editFieldOptions`, which moves the notes' values in the same transaction. Every
   * view, as `dropField` reads every view: the field id is the account's.
   */
  renameOption(fieldId: string, from: string, to: string): void {
    this.rewrite((query) => renameOptionInQuery(query, fieldId, from, to));
  }

  /**
   * Deletes a notebook's views and answers their tombstones, for the notebook's delete to
   * record beside its own. The foreign key's cascade would take the rows by itself, but
   * a cascade tells nobody what it removed, and every device holding the views has to be
   * told; deleting them by hand here, before the notebook's row goes, is the one
   * statement that does both, the way `deleteField` deletes the values the cascade would
   * also take. The caller records, so the notebook's write keeps its rows in the order it
   * chooses.
   */
  dropNotebook(notebookId: string): Change[] {
    return this.sql
      .exec<{ id: string }>(`DELETE FROM notebook_views WHERE notebook_id = ?1 RETURNING id`, notebookId)
      .map((r) => ({ entity: 'view', id: r.id, deleted: true }));
  }

  /** Applies `fn` to every view's query, writes back and records the ones it changed. */
  private rewrite(fn: (query: ViewQuery) => ViewQuery | null): void {
    const now = Date.now();
    const changed: Change[] = [];
    for (const row of this.sql.exec<{ id: string; query: string }>(`SELECT id, query FROM notebook_views`)) {
      const next = fn(JSON.parse(row.query) as ViewQuery);
      if (next === null) continue;
      const text = JSON.stringify(next);
      if (text === row.query) continue;
      this.sql.exec(`UPDATE notebook_views SET query = ?1, updated_at = ?2 WHERE id = ?3`, text, now, row.id);
      changed.push({ entity: 'view', id: row.id });
    }
    this.feed.record(changed, now);
  }
}
