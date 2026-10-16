import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Which rows of a list are selected, for acting on several notes at once.
 *
 * Plain React state rather than the URL, unlike every filter: a selection is about the
 * rows on screen at this moment, not a place someone can be sent a link to, and a URL
 * naming forty ids would be a URL nobody could read. It is also deliberately not kept
 * across a change of scope — `resetKey` — because the rows it named are no longer the
 * rows on screen, and acting on notes you cannot see is the one thing a bulk action must
 * never do. For the same reason `ids` is the selection *as loaded*: an id the list no
 * longer holds (trashed from another tab, filtered out) is not counted and not acted on.
 *
 * The open note is a selection of one. Nothing says so while it is the only one — the
 * bar would be noise over every note anyone reads — but the first pick of another row
 * brings it along, and a Shift-click ranges from it: Cmd-clicking a second note when one
 * is open selects the two, as it does in Finder and Evernote, rather than leaving the one
 * on screen out of the selection it visibly started. Picking the open note itself just
 * selects it.
 *
 * The anchor is the last row picked on its own, and a range runs from it to the row
 * picked with Shift — Finder's rule again. When nothing has been picked yet the open note
 * stands in, so Shift-clicking a row three below the one you are reading selects the
 * four; a range that lands nowhere selects the one row. Ranges add to the selection
 * rather than replace it, as Gmail's do, since building up a selection is the common
 * case and a replaced one is a surprise.
 */
export interface Selection {
  /** The selected rows that the list currently holds, in the list's order. */
  ids: string[];
  /** Whether anything is selected — the list is in its selection mode. */
  active: boolean;
  has(id: string): boolean;
  /**
   * Toggles one row. With `range`, selects every row between the anchor and it instead,
   * and leaves the anchor where it was so a second Shift-click re-ranges from the same
   * place.
   */
  pick(id: string, opts?: { range?: boolean }): void;
  /** Selects every loaded row. What has not been loaded is not on screen, so not selected. */
  selectAll(): void;
  /**
   * Replaces the selection with these rows: what a drop on the list does with the notes
   * it just made, so the bar offers Move, Tag and Delete on them. Rows the list has not
   * loaded are kept and counted once it has — the rows arrive a render after the notes
   * are made — but, as ever, only the ones on screen are acted on.
   */
  select(ids: readonly string[]): void;
  clear(): void;
}

export function useSelection(
  /** The loaded rows' ids, in the order they are drawn. */
  order: string[],
  opts: {
    /** The row a range starts from before anything has been picked: the open note. */
    anchor?: string | undefined;
    /** Anything that changes which rows are on screen: the filter, the sort, the query. */
    resetKey: string;
  },
): Selection {
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const anchorRef = useRef<string | null>(null);
  const orderRef = useRef(order);
  orderRef.current = order;
  const defaultAnchor = opts.anchor;

  const { resetKey } = opts;
  useEffect(() => {
    setPicked(new Set());
    anchorRef.current = null;
    // The initial render must not clear what nothing has set; only a change of scope does.
  }, [resetKey]);

  const ids = useMemo(() => order.filter((id) => picked.has(id)), [order, picked]);

  const pick = useCallback(
    (id: string, pickOpts?: { range?: boolean }) => {
      const rows = orderRef.current;
      if (pickOpts?.range) {
        const from = rows.indexOf(anchorRef.current ?? defaultAnchor ?? '');
        const to = rows.indexOf(id);
        if (to === -1) return;
        const [lo, hi] = from === -1 ? [to, to] : [Math.min(from, to), Math.max(from, to)];
        setPicked((prev) => {
          const next = new Set(prev);
          for (const row of rows.slice(lo, hi + 1)) next.add(row);
          return next;
        });
        if (from === -1) anchorRef.current = id;
        return;
      }
      anchorRef.current = id;
      setPicked((prev) => {
        const next = new Set(prev);
        // The open note comes along on the first pick of another row — see above. Judged
        // on the rows on screen, since `prev` may still name rows that have left the list.
        const nothingYet = !rows.some((row) => prev.has(row));
        if (nothingYet && defaultAnchor && defaultAnchor !== id && rows.includes(defaultAnchor)) {
          next.add(defaultAnchor);
        }
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [defaultAnchor],
  );

  const selectAll = useCallback(() => setPicked(new Set(orderRef.current)), []);
  const select = useCallback((ids: readonly string[]) => {
    setPicked(new Set(ids));
    anchorRef.current = null;
  }, []);
  const clear = useCallback(() => {
    setPicked(new Set());
    anchorRef.current = null;
  }, []);

  return {
    ids,
    active: ids.length > 0,
    has: (id) => picked.has(id),
    pick,
    selectAll,
    select,
    clear,
  };
}
