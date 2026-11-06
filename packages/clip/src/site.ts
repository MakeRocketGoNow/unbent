/**
 * What a clip says about the site it came from: its name, and a title without that name
 * tacked on.
 *
 * Pure functions on strings and URLs, kept apart from `extract.ts` so the clip can use
 * them without importing it: `extract.ts` carries linkedom and Readability, and a caller
 * that only clips a fragment (`clipFragment`) should be able to bundle the package
 * without either. The package is marked `sideEffects: false` for the same reason.
 */

/**
 * The title without the site's name tacked on before or after it: `Caring for your anvil
 * | Acme Workshop` is `Caring for your anvil`.
 *
 * Readability trims these itself, but not from a title of four words or fewer, where it
 * cannot tell a site name from half the headline. Here the site name is known, so only
 * an exact match is taken, and only beside a separator; a title that is nothing but the
 * site's name is left whole. The note's source line names the site, so it is not lost.
 */
export function withoutSiteName(title: string, siteName: string | null): string {
  if (!siteName) return title;
  const name = siteName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A bar with or without spaces; a hyphen, en dash, em dash, middle dot or double angle
  // quote only with spaces both sides, so `Acme-Tools` is never split; a colon with a
  // space after it.
  const separator = '(?:\\s*\\|\\s*|\\s+[-\u2013\u2014\u00b7\u00bb]\\s+|:\\s+)';
  const trimmed = title
    .replace(new RegExp(`${separator}${name}$`, 'i'), '')
    .replace(new RegExp(`^${name}${separator}`, 'i'), '')
    .trim();
  return trimmed || title;
}

/** The URL's host without a leading `www.`, the way a person would name the site. */
export function hostName(url: URL): string {
  return url.hostname.replace(/^www\./i, '');
}

/** Trimmed, with runs of whitespace made one space; null when nothing is left. */
export function clean(value: string | null | undefined): string | null {
  const text = value?.replace(/\s+/g, ' ').trim();
  return text ? text : null;
}
