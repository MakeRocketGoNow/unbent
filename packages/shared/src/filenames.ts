/**
 * Filename helpers shared by the places that suffix a collision.
 *
 * The upload picks a free name within a note (`availableFilename` in the API), and the
 * importers and the web clipper pick the same names before they write the markdown, so a
 * link and the file it points at agree. Both split the extension the same way, and they have to keep
 * agreeing: a name the importer writes is the name the upload is asked for. Kept here so
 * a change to how an extension is found (multi-dot names, say) is one edit rather than
 * two that can drift apart.
 */

/** Splits `name.ext` so a collision can be suffixed as `name-2.ext`. */
export function splitExt(filename: string): [string, string] {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0) return [filename, ''];
  return [filename.slice(0, dot), filename.slice(dot)];
}

/**
 * `name.ext`, else `name-2.ext`, `name-3.ext` and on: the first not in `taken`.
 *
 * The same scheme as `availableFilename` in the API. Lives here rather than in the
 * importer that first needed it so the web clipper (`@unbent/clip`, which the importer
 * itself depends on) can name its pictures the way an upload would.
 */
export function nextAvailableFilename(desired: string, taken: Set<string>): string {
  if (!taken.has(desired)) return desired;
  const [stem, ext] = splitExt(desired);
  for (let n = 2; n < Number.MAX_SAFE_INTEGER; n += 1) {
    const candidate = `${stem}-${n}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${stem}-${taken.size}${ext}`;
}
