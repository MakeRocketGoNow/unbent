/**
 * One item of a Joplin export, as Joplin serialises it.
 *
 * A JEX holds every note, notebook, tag, tag assignment and attachment record as its own
 * `<id>.md` file, in the form Joplin also syncs: the title on the first line, a blank
 * line, the body, a blank line, then one `key: value` property per line, the last of them
 * `type_`. Notebooks, tags and resources have a title and no body.
 *
 * This is `BaseItem.unserialize` from Joplin's own source, read the same way: properties
 * are taken from the bottom up until the first blank line, so a body that happens to end
 * in something shaped like `key: value` is still body as long as a blank line follows it.
 * Property values escape their newlines as `\n`; the body does not.
 */

/** Joplin's `ModelType` numbers, the ones an export carries. */
export const JoplinType = {
  note: 1,
  folder: 2,
  resource: 4,
  tag: 5,
  noteTag: 6,
} as const;

export interface JoplinItem {
  type: number;
  title: string;
  /** Only a note has one. */
  body: string;
  props: Record<string, string>;
}

function unescape(value: string): string {
  return value.replace(/\\(\\)?([nr])/g, (whole, slash: string | undefined, c: string) =>
    slash ? `\\${c}` : c === 'n' ? '\n' : '\r',
  );
}

export function parseJoplinItem(content: string): JoplinItem {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const props: Record<string, string> = {};
  let body: string[] = [];

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!.trim();
    if (line === '') {
      body = lines.slice(0, i);
      break;
    }
    const colon = line.indexOf(':');
    if (colon < 0) throw new Error(`Not a Joplin item: "${line.slice(0, 40)}" is not a property.`);
    props[line.slice(0, colon).trim()] = unescape(line.slice(colon + 1).trim());
  }

  const type = Number(props.type_);
  if (!Number.isInteger(type) || type <= 0) throw new Error('Not a Joplin item: it has no type.');

  // The title and the blank line under it; whatever is left is the body.
  const title = body.length > 0 ? body[0]! : '';
  return {
    type,
    title,
    body: type === JoplinType.note ? body.slice(2).join('\n') : '',
    props,
  };
}

/**
 * A Joplin timestamp as milliseconds, or undefined for an empty or unreadable one.
 *
 * Joplin writes them as ISO 8601 in UTC with milliseconds (`2026-03-04T05:06:07.890Z`),
 * and an unset one as nothing at all.
 */
export function joplinTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}
