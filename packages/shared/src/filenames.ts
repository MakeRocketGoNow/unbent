/**
 * Filename helpers shared by the two places that suffix a collision.
 *
 * The upload picks a free name within a note (`availableFilename` in the API) and the
 * ENEX importer picks the same names before it writes the markdown, so a link and the
 * file it points at agree. Both split the extension the same way, and they have to keep
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
