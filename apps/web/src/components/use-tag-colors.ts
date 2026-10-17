import { useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { foldNoCase, leastUsedColor } from '@unbent/shared';
import { tagsQuery } from '../queries.js';

/** A chip's colour by its word: an index into the palette, or null for the neutral grey. */
export type TagColorOf = (name: string) => number | null;

/**
 * The colour each of the account's tags wears, by name, for every place a tag is drawn.
 *
 * The colour is the tag row's (`TagSummary.color`, from the tags query the editor's
 * completions already read), found without case, as the store finds a tag. A name the
 * list does not have is a tag that does not exist on the server yet: one just typed
 * into a note, whose save is still in the outbox. Rather than draw it grey until the
 * feed brings its row, which is a chip changing colour under the person a second after
 * they made it, the colour the server will give it is predicted here by the server's
 * own rule (`leastUsedColor`, deterministic ties) over the colours this tab can see,
 * each prediction counting toward the next, in the order the chips are asked for. The
 * prediction is right whenever no other new tag landed first; when it is wrong, the
 * row's colour wins the moment it arrives, which is the same correction the grey would
 * have needed.
 *
 * Predictions are kept across renders in a ref rather than recomputed, so a chip does
 * not change colour as its neighbours come and go; they are keyed on the folded name,
 * and a row arriving for that name supersedes them.
 */
export function useTagColors(): TagColorOf {
  const tags = useQuery(tagsQuery());
  const predicted = useRef(new Map<string, number>());
  return useMemo(() => {
    const known = new Map<string, number | null>();
    for (const t of tags.data ?? []) known.set(foldNoCase(t.name), t.color);
    return (name: string): number | null => {
      const key = foldNoCase(name);
      const held = known.get(key);
      if (held !== undefined) return held;
      // Nothing known yet at all (the list has not arrived): no prediction, since one
      // over an empty set is always red and would be wrong for every tag but the first.
      if (tags.data === undefined) return null;
      const guess = predicted.current.get(key);
      if (guess !== undefined) return guess;
      const next = leastUsedColor([...known.values(), ...predicted.current.values()]);
      predicted.current.set(key, next);
      return next;
    };
  }, [tags.data]);
}
