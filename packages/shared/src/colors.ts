import { z } from 'zod';

/**
 * The colour a tag or a select option wears, as an index into the palette.
 *
 * Notion's model: a colour is given when the word is made, kept with it, and
 * can be changed afterwards from the tag's row or the option's chip; nobody is asked to
 * pick one. The palette is the stylesheet's ten tints (`--tint-0` to `--tint-9`: nine
 * hues and a grey) and the Android app's copy of them, and an index rather than a hex
 * value is what crosses the wire, so each platform draws its own version of "green" on
 * its own ground and a theme can change a hue without touching a row.
 *
 * Until 2026-10-17 the colour was a hash of the word itself (FNV-1a folded onto six hues),
 * which needed no storage and gave the same word the same tint everywhere. It went for
 * three reasons. Six hues over dozens of tags collide constantly, and a hash cannot be
 * asked to spread them out. Nothing could mean anything: "Yes" could not be green and
 * "No" red, since the word alone decided. And the head and the list disagreed, with
 * chips in the head and plain accent-green text in the list, because a hash the list
 * rows would have to run too was one more thing to keep in step across platforms.
 */
export const TAG_COLOR_COUNT = 10;

/** The palette's names, in index order, for a swatch's label and a definitions file. */
export const TAG_COLOR_NAMES = [
  'Red',
  'Orange',
  'Yellow',
  'Green',
  'Teal',
  'Blue',
  'Purple',
  'Pink',
  'Brown',
  'Grey',
] as const;

export type TagColorName = (typeof TAG_COLOR_NAMES)[number];

export const tagColorSchema = z.number().int().min(0).max(TAG_COLOR_COUNT - 1);

/**
 * The colour to give the next member of a set: the one fewest of its siblings wear, and
 * the lowest index among those tied.
 *
 * Least-used rather than random, so a set grows through the whole palette before any
 * colour repeats: ten tags are ten colours, and the eleventh is the first repeat. Random
 * would repeat on the second or third as often as not, which is the collision the hash
 * was replaced for. Deterministic ties, so a client that holds the set can predict what
 * the server will give a word it has just typed and draw it that way at once; the
 * prediction is right whenever no other new sibling lands first.
 *
 * `null` and `undefined` are siblings with no colour yet (a row from before the colours
 * existed, read before its migration has run) and are not counted.
 */
export function leastUsedColor(used: Iterable<number | null | undefined>): number {
  const counts = new Array<number>(TAG_COLOR_COUNT).fill(0);
  for (const c of used) {
    if (c !== null && c !== undefined && c >= 0 && c < TAG_COLOR_COUNT) counts[c] = counts[c]! + 1;
  }
  let best = 0;
  for (let i = 1; i < TAG_COLOR_COUNT; i++) if (counts[i]! < counts[best]!) best = i;
  return best;
}

/**
 * The colours of a select's options after its list has been rewritten.
 *
 * The options are a plain list of words (the shape every filter, value and export has
 * always worked on), so their colours live beside the list keyed by the word. Any write
 * of the list comes through here with the colours it held before: an option that still
 * stands keeps its colour, one that went takes its colour with it, and one that is new
 * is given the least-used colour among the ones already decided, in list order, so a
 * list written whole (the editor's shape) assigns the way one option at a time would.
 *
 * `wanted` is what the caller asks for by name on top of that: a recolour from the
 * field's settings, or a definitions file's colours on import. It wins over the kept
 * colour, and only for options the list actually holds.
 */
export function assignOptionColors(
  options: readonly string[],
  prior: Readonly<Record<string, number>> | null | undefined,
  wanted?: Readonly<Record<string, number>> | null,
): Record<string, number> {
  const out: Record<string, number> = {};
  const pending: string[] = [];
  for (const option of options) {
    const asked = wanted?.[option];
    const kept = prior?.[option];
    if (asked !== undefined && tagColorSchema.safeParse(asked).success) out[option] = asked;
    else if (kept !== undefined && tagColorSchema.safeParse(kept).success) out[option] = kept;
    else pending.push(option);
  }
  for (const option of pending) out[option] = leastUsedColor(Object.values(out));
  // In list order, so the stored JSON reads as the list does.
  const ordered: Record<string, number> = {};
  for (const option of options) ordered[option] = out[option]!;
  return ordered;
}

/**
 * A colour as a definitions file names it: `green`, which a person can read and write,
 * rather than `3`. The index is accepted too, so a file written by hand with the number
 * from the API still reads.
 */
export function colorName(index: number): string {
  return (TAG_COLOR_NAMES[index] ?? TAG_COLOR_NAMES[TAG_COLOR_COUNT - 1]!).toLowerCase();
}

export function parseColorName(value: string | number): number | undefined {
  if (typeof value === 'number') return tagColorSchema.safeParse(value).success ? value : undefined;
  const i = TAG_COLOR_NAMES.findIndex((n) => n.toLowerCase() === value.trim().toLowerCase());
  return i === -1 ? undefined : i;
}
