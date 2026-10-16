/**
 * One page of a Notion export, read from its markdown.
 *
 * Notion writes a page as its title as an H1, then (for a row of a database) one
 * `Property: value` line per property that has a value, a blank line, and the body.
 * A page that is not a row has no property block. The block's keys are the database's
 * columns, so the caller says which names to expect; a line under a property that is
 * not itself a known property continues the one above, which is how a text property
 * holding several paragraphs arrives. A key the columns do not name (a formula or a
 * rollup, which the CSV leaves out) is dropped rather than glued onto its neighbour.
 */

export interface NotionPage {
  /** The H1, whole: the filename truncates long titles, the heading does not. */
  title: string;
  /** Property values by Notion's own column name, in page order. */
  props: Array<[string, string]>;
  body: string;
}

/** What a property line looks like, whether or not the key is known: capitalised, short, then a colon. */
const LOOKS_LIKE_KEY = /^[A-Z][^:\n]{0,60}: /;

/**
 * The known property a line starts, if any: the longest known name the line opens with,
 * followed by a colon. Matched against the names rather than cut at the first colon,
 * because a name can hold one: Notion writes a property that shares a built-in's name
 * as `userDefined:URL`, and cutting at its first colon would leave every such line
 * looking like the continuation of whatever came before it.
 */
function knownKey(line: string, names: readonly string[]): [string, string] | null {
  for (const name of names) {
    if (line.startsWith(`${name}:`)) {
      const rest = line.slice(name.length + 1);
      if (rest === '' || rest.startsWith(' ')) return [name, rest.trimStart()];
    }
  }
  return null;
}

export function parseNotionPage(markdown: string, known: ReadonlySet<string>): NotionPage {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  // Longest first, so "Date Added" is tried before "Date".
  const names = [...known].sort((a, b) => b.length - a.length);
  let at = 0;
  let title = '';
  if (lines[0]?.startsWith('# ')) {
    title = lines[0].slice(2).trim();
    at = 1;
  }
  while (at < lines.length && lines[at]!.trim() === '') at += 1;

  const props: Array<[string, string]> = [];
  if (known.size > 0) {
    let inBlock = false;
    while (at < lines.length) {
      const line = lines[at]!;
      if (line.trim() === '') {
        if (inBlock) at += 1;
        break;
      }
      const found = knownKey(line, names);
      if (found) {
        props.push(found);
        inBlock = true;
      } else if (inBlock && !LOOKS_LIKE_KEY.test(line)) {
        const last = props[props.length - 1]!;
        last[1] = `${last[1]}\n${line}`;
      } else if (inBlock) {
        // A key the columns do not name: dropped, but still part of the block.
      } else {
        break;
      }
      at += 1;
    }
  }
  while (at < lines.length && lines[at]!.trim() === '') at += 1;

  return { title, props, body: lines.slice(at).join('\n').trimEnd() };
}

/** Where a relative destination in a page's body points, as the caller resolves it. */
export type NotionLinkTarget =
  | { kind: 'file'; name: string }
  | { kind: 'page'; href: string }
  | { kind: 'database' };

export interface RewriteContext {
  /** A path relative to the page's own directory, already decoded. */
  resolve: (path: string) => NotionLinkTarget | null;
  /** A Notion page id (32 hex digits) from a notion.so link, to its href here, if it was imported. */
  page: (id: string) => string | null;
}

/** A markdown link or image: `[text](dest)`, the destination allowing one level of parentheses. */
const LINK_RE = /(!?)\[([^\]\n]*)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g;
const NOTION_URL_RE = /^https?:\/\/(?:www\.)?notion\.(?:so|site)\/(?:[^/?#]*?-)?([0-9a-f]{32})(?:[?#].*)?$/i;

/** A `files/` destination in the spelling the app's own writer uses for that name. */
function fileDestination(name: string): string {
  return /[\s()]/.test(name) ? `<files/${name}>` : `files/${name}`;
}

/**
 * A body with Notion's links pointed at what they mean here.
 *
 * Relative links are how Notion refers to its own: an attachment sits in a folder named
 * for the page, a sub-page is a markdown file beside it, a database is its CSV. Each
 * becomes what the app expects: a `files/` link, a link to the imported note, or the
 * database's name as plain text, whether or not the CSV made it into the export. An
 * absolute notion.so link to a page that was imported
 * becomes a link to it too; one to anything else is left as it was, since it still
 * opens in Notion. Notion also writes a file's name on the line after its link as a
 * caption, which is dropped where it would say the name twice, and wraps callouts in
 * `<aside>`, which the preview would strip to bare text and which reads as a quote.
 */
export function rewriteNotionBody(body: string, ctx: RewriteContext): string {
  let out = body.replace(LINK_RE, (whole, bang: string, text: string, rawDest: string) => {
    const dest = rawDest.startsWith('<') && rawDest.endsWith('>') ? rawDest.slice(1, -1) : rawDest;
    const notion = NOTION_URL_RE.exec(dest);
    if (notion) {
      const href = ctx.page(notion[1]!.toLowerCase());
      return href ? `[${text}](${href})` : whole;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(dest) || dest.startsWith('#') || dest.startsWith('/')) return whole;
    let path: string;
    try {
      path = decodeURIComponent(dest);
    } catch {
      return whole;
    }
    // A database the export left out (a linked view, an empty one) is still a
    // database: its name as text, the same as one that is here.
    const target = ctx.resolve(path) ?? (/\.csv$/i.test(path) ? { kind: 'database' as const } : null);
    if (!target) return whole;
    switch (target.kind) {
      case 'file':
        return `${bang}[${text}](${fileDestination(target.name)})`;
      case 'page':
        return `[${text}](${target.href})`;
      case 'database':
        return text;
    }
  });

  out = dropCaptions(out);
  out = calloutsToQuotes(out);
  return out;
}

/** Removes a line that repeats, as a caption, the name of the file linked just above it. */
function dropCaptions(body: string): string {
  const lines = body.split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    kept.push(line);
    const link = /^!?\[([^\]]+)\]\((?:<files\/[^>]+>|files\/[^)\s]+)\)\s*$/.exec(line);
    if (link && lines[i + 1]?.trim() === link[1]!.trim()) i += 1;
  }
  return kept.join('\n');
}

/**
 * `<aside>` blocks as blockquotes: the icon Notion puts first (an emoji on its own line,
 * or an `<img>` of one of its stock icons) leads the first line, and the icon images are
 * dropped since they are decoration the preview cannot draw meaningfully anyway.
 */
function calloutsToQuotes(body: string): string {
  return body.replace(/<aside>\n?([\s\S]*?)<\/aside>/g, (_, inner: string) => {
    const lines = inner
      .split('\n')
      .filter((l) => !/^\s*<img\b/i.test(l))
      .map((l) => l.trimEnd());
    while (lines.length > 0 && lines[0]!.trim() === '') lines.shift();
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
    // Notion writes the emoji icon as the first line and a blank under it: join it to the text.
    if (lines.length >= 2 && lines[0]!.trim().length <= 4 && lines[1]!.trim() === '') {
      const icon = lines.shift()!.trim();
      lines.shift();
      if (lines.length > 0) lines[0] = `${icon} ${lines[0]!.trimStart()}`;
    }
    return lines.map((l) => (l.trim() === '' ? '>' : `> ${l}`)).join('\n');
  });
}
