import { z } from 'zod';

/**
 * The cursor a list hands back for its next page: the sort key *and* the id of the last
 * row.
 *
 * Comparing the sort key alone is only safe when it is unique. Titles are not: an
 * archive is full of notes called "Receipt", and a strict `<` on the key would step
 * over every row sharing the boundary value. Carrying the id makes the comparison a
 * lexicographic one on `(key, id)`, which is exactly the order the rows came back in.
 *
 * Inside, the id follows the key after a unit separator (U+001F), which cannot occur in a
 * uuid, so a title holding one still round-trips: only the final segment is the id. That
 * inside is what the cursor *was*, verbatim, until MAK-217, and a control character in an
 * answer is one a model has to reproduce exactly. One wrote it back as the six characters
 * `\u001f`, which nothing refused, and the list answered with its first page again, as
 * if that were the next one. So the cursor goes out as base64url of that string (plain,
 * printable, and safe in a query string) and one that does not decode is refused
 * (`cursorSchema`) rather than read as "start from the top".
 *
 * A cursor in the old form still decodes, for a client that held one across the deploy.
 * There is no harm in keeping that: an old cursor carries the separator, and nothing a
 * base64url string can contain is one.
 *
 * Here rather than beside the store's sorts so the request schemas can refuse a bad one
 * at the edge, with a 400 or a tool error, before the store is asked anything.
 */
const SEP = '\u001F';

export function encodeCursor(key: string | number, id: string): string {
  return toBase64Url(`${key}${SEP}${id}`);
}

export function decodeCursor(cursor: string): { key: string; id: string } | null {
  const inner = cursor.includes(SEP) ? cursor : fromBase64Url(cursor);
  if (inner === null) return null;
  const at = inner.lastIndexOf(SEP);
  // An id is never empty; a key may be (a field sort's marker for a note with no value).
  if (at === -1 || at === inner.length - 1) return null;
  return { key: inner.slice(0, at), id: inner.slice(at + 1) };
}

/*
 * base64url by hand, over the UTF-8 that `encodeURIComponent` spells out: this package
 * runs in the Worker, the browser and Node and assumes none of their globals, so
 * `btoa` and `TextDecoder` are not there to lean on.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function utf8(text: string): number[] {
  const bytes: number[] = [];
  const escaped = encodeURIComponent(text);
  for (let i = 0; i < escaped.length; i++) {
    if (escaped[i] === '%') {
      bytes.push(parseInt(escaped.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(escaped.charCodeAt(i));
    }
  }
  return bytes;
}

function toBase64Url(text: string): string {
  const bytes = utf8(text);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = i + 2 < bytes.length ? 4 : i + 1 < bytes.length ? 3 : 2;
    for (let c = 0; c < chars; c++) out += ALPHABET[(n >> (18 - 6 * c)) & 63];
  }
  return out;
}

function fromBase64Url(text: string): string | null {
  // A length of 1 mod 4 is not something an encoder writes.
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) return null;
  let escaped = '';
  for (let i = 0; i < text.length; i += 4) {
    const group = text.slice(i, i + 4);
    let n = 0;
    for (let c = 0; c < 4; c++) n = (n << 6) | (c < group.length ? ALPHABET.indexOf(group[c]!) : 0);
    for (let b = 0; b < group.length - 1; b++) {
      escaped += '%' + ((n >> (16 - 8 * b)) & 255).toString(16).padStart(2, '0');
    }
  }
  try {
    // Throws on bytes that are not UTF-8, which is a cursor nobody here wrote.
    return decodeURIComponent(escaped);
  } catch {
    return null;
  }
}

/** A cursor as a request carries one: refused, by name, unless it decodes. */
export const cursorSchema = z
  .string()
  .refine((c) => decodeCursor(c) !== null, {
    message:
      'Not a cursor from a previous page. Pass back the cursor exactly as it was given, or ' +
      'leave it out to start from the first page.',
  });
