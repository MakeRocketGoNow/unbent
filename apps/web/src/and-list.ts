/**
 * A few things as a person would say them: "a", "a and b", "a, b and c". No Oxford
 * comma, as the rest of the app's sentences have it. Empty for none; the caller says
 * "nothing" if that is what none means.
 *
 * One place, because three sentences had each grown their own copy of the slice and
 * join: what Auto-fill changed, what a version's row says changed, and what a restore
 * could not put back.
 */
export function andList(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]!}`;
}
