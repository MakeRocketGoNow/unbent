/** How many soft tints the stylesheet defines: `--tint-0` through `--tint-5`. */
export const TINT_COUNT = 6;

/**
 * A stable tint for a tag or a select option, from its name alone.
 *
 * Notion gives every option a colour and stores it; here nothing is stored, and the
 * colour is a pure function of the word, so "Spicy" is the same tint on every note, in
 * both themes, and on every platform that runs this hash. FNV-1a over the code units,
 * folded to the palette's size — chosen for being short enough to reimplement natively
 * (the Android app draws tags on its own list rows) and even enough that six words land
 * on six tints more often than not. Case and edge spaces are ignored so "mtb" and "MTB",
 * which the tag editor treats as one tag, cannot come out two colours.
 */
export function tintIndex(name: string): number {
  const key = name.trim().toLowerCase();
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % TINT_COUNT;
}
