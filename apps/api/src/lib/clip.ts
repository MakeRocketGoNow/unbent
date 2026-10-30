import { clipPage, type Clip, type ClipImage } from '@unbent/clip';
import {
  InvalidFieldValue,
  MAX_BODY_BYTES,
  MAX_TITLE_LENGTH,
  inlineLinkSpans,
  normalizeContentType,
  relativeAttachmentPath,
  type Note,
  type NoteFieldsPatch,
} from '@unbent/shared';
import type { AttachmentsRepo } from './attachments-repo.js';
import { checkSourceUrl, fetchSource } from './fetch-attachment.js';
import { PlanRefused } from './free-plan.js';
import type { NotesRepo } from './notes-repo.js';
import { StorageFull } from './quota.js';
import { storeAttachment } from './store-attachment.js';
import { fetchWebImage } from './web-image.js';
import type { Env } from '../types.js';

/**
 * A web page kept as a note, fetched and read on the server: what `POST /api/clip` and
 * the `clip_web_page` tool both are.
 *
 * The page becomes Markdown in `@unbent/clip` (Reader View's article, its links made
 * absolute, a "Clipped from" line on top); this module is the part with a network and a
 * store around it. The clip lists the pictures it kept with the `files/<name>` path the
 * body already points at, so the note is written once, whole, and each picture is then
 * stored under exactly that name. A picture that could not be had is the one case that
 * writes the body twice; see `relink`.
 *
 * What it costs a Worker, counted against the Free plan's numbers, which a fork runs on
 * (AGENTS.md, "Subrequests are the budget inside one invocation"):
 *
 *   - Subrequests. Fifty an invocation, and every fetch, store call, R2 call and D1 query
 *     counts. Before the route runs: the session and the plan row, two D1 reads (one more
 *     store call for an account no plan holds, `refuseIfPastFree`). Then the page (one
 *     fetch, plus one per redirect), the note (one store call), and for each picture its
 *     fetch, `storeAttachment`'s `availableFilename` and `record` and the R2 put: four.
 *     With `CLIP_MAX_IMAGES` at ten that is 2 + 1 + 1 + 1 + 40 = 45, and one more for the
 *     body's repair when a picture failed, which leaves four for redirects. Twelve, the
 *     clip package's own default, would be 53 before a redirect, past the limit, which is
 *     why the server asks for fewer. Do not raise it without counting again.
 *   - CPU. Readability over a DOM is real work. Measured in Node with vitest on
 *     2026-10-30, warm, on invented article pages carrying the scripts, styles and
 *     navigation a real one does: a 200 KB page with a dozen paragraphs took 10 ms, a
 *     240 KB one with sixty (20 KB of Markdown) 23 ms, and a 330 KB one with two hundred
 *     (67 KB of Markdown) 63 ms. A cold isolate is slower still. That is past the Free
 *     plan's 10 ms an invocation for most pages, so on Free a clip of a long article
 *     will be ended for its CPU; unbent.app is on Workers Paid (thirty seconds), where it
 *     is nothing. Which is why the whole feature is behind `WEB_CLIP` (`webClipOf`): an
 *     operator says their plan can run it, and a fork that said nothing offers no clip
 *     its Worker would fail. The body's repair parses the Markdown once more, about as
 *     long again as the clip on the same page, and only when a picture failed.
 */

/** A page larger than this is not read. An article's HTML is a few hundred kilobytes; five megabytes is a page that is mostly something else. */
export const CLIP_MAX_PAGE_BYTES = 5 * 1024 * 1024;

/** The most pictures a server-side clip stores; the rest stay links to the site. See the budget above. */
export const CLIP_MAX_IMAGES = 10;

/**
 * Pictures fetched and stored at once. Enough that a clip of ten pictures is a few round
 * trips rather than ten, and few enough that the bytes in memory at once stay a fraction
 * of the isolate's 128 MB even at `MAX_WEB_IMAGE_BYTES` each, which no article's
 * pictures come near.
 */
const IMAGE_CONCURRENCY = 4;

export interface ClipInput {
  url: string;
  /** The note's title. Absent, the page's own. */
  title?: string | undefined;
  notebook?: string | null | undefined;
  tags?: string[] | undefined;
  fields?: NoteFieldsPatch | undefined;
  /** The note's id, when the caller chose one; see `clipRequestSchema`. */
  id?: string | undefined;
}

export interface ClipImages {
  stored: number;
  failed: Array<{ url: string; error: string }>;
}

/**
 * What became of a clip.
 *
 * No 402 among the failures: a note or a file the store refuses for the plan or for
 * room throws `PlanRefused` or `StorageFull`, as every other write does, and goes to the
 * handler that already answers those (`onAppError` over HTTP, `gatedRegistrar` for a
 * tool) with the code and the numbers the clients switch on. A picture the store refuses
 * after the note is made is not a failed clip: it is a picture in `failed`.
 */
export type ClipResult =
  | { ok: true; note: Note; existing: boolean; images: ClipImages }
  | { ok: false; status: 400 | 413 | 415 | 502; error: string; code: ClipErrorCode };

/**
 * What a client or an assistant can switch on. `HOST_REFUSED` above all: the page is
 * there, and only this server cannot have it, so whoever is asking can read it
 * themselves (the tool's description tells an assistant to).
 */
export type ClipErrorCode =
  | 'BAD_URL'
  | 'HOST_REFUSED'
  | 'HOST_ERROR'
  | 'UNREACHABLE'
  | 'NOT_A_PAGE'
  | 'TOO_LARGE'
  | 'INVALID_FIELD';

export interface ClipOptions {
  /** Local development only, keyed on `ALLOW_TEST_CREDENTIALS` by the caller, as the other fetchers are. */
  allowLoopback: boolean;
  /** The plan's storage in bytes, or null for no limit; see lib/quota.ts. */
  quota: number | null;
  /** `ATTACHMENT_FETCH_USER_AGENT`, when the deployment set one. */
  userAgent?: string | undefined;
  /**
   * Refuses an account past the free plan before anything is fetched
   * (`refuseIfPastFree`), by throwing `PlanRefused`. The note's create would refuse it in
   * the store anyway, but only after the page was fetched and read, which is the work a
   * read-only account should not be able to spend; `HELD_IN_STORE` lists the route on
   * that condition.
   */
  pastFree?: (() => Promise<unknown>) | undefined;
  /** An assistant's clip: the body's repair is kept in history as its write. */
  by?: 'assistant' | undefined;
}

export async function clipUrl(
  env: Pick<Env, 'BLOBS' | 'AI'>,
  ctx: { waitUntil(promise: Promise<unknown>): void },
  repos: { notes: NotesRepo; attachments: AttachmentsRepo },
  input: ClipInput,
  opts: ClipOptions,
): Promise<ClipResult> {
  // The address first, before anything else is spent on it: http(s) only, no
  // credentials, nothing on a loopback or private network. The same guard as every
  // fetch this server makes for a caller, and `fetchSource` repeats it at every redirect.
  const checked = checkSourceUrl(input.url, { allowLoopback: opts.allowLoopback });
  if ('error' in checked) return { ok: false, status: 400, code: 'BAD_URL', error: checked.error };
  await opts.pastFree?.();

  const page = await fetchPage(checked.url, opts);
  if (!page.ok) return page;

  let clip: Clip;
  try {
    clip = clipPage(page.html, page.url.href, { maxImages: CLIP_MAX_IMAGES });
  } catch (err) {
    // Readability on a page nobody tested it on; the address itself was checked above.
    console.error('clip: reading the page failed:', (err as Error).message);
    return { ok: false, status: 502, code: 'NOT_A_PAGE', error: `The page at ${page.url.host} could not be read.` };
  }
  if (clip.markdown.length > MAX_BODY_BYTES) {
    return {
      ok: false,
      status: 413,
      code: 'TOO_LARGE',
      error: `The article on that page is longer than a note can hold (${Math.round(MAX_BODY_BYTES / 1000)} KB of text).`,
    };
  }

  // A page's title can be a paragraph (some sites put their whole description in it);
  // the note's is cut to what a note may have rather than refusing the clip over it.
  const title = input.title ?? Array.from(clip.title).slice(0, MAX_TITLE_LENGTH).join('');

  // As `POST /notes` creates one: an id already held answers with the note that holds
  // it, so a replayed clip makes no second note. Its pictures are not fetched again:
  // the first request stored what it could, and a replay is the same request.
  let created: { note: Note; existing: boolean };
  try {
    created = await repos.notes.createOrFind({
      id: input.id ?? crypto.randomUUID(),
      title,
      body: clip.markdown,
      tags: input.tags ?? [],
      notebook: input.notebook,
      ...(input.fields ? { fields: input.fields } : {}),
    });
  } catch (err) {
    if (err instanceof InvalidFieldValue) {
      return { ok: false, status: 400, code: 'INVALID_FIELD', error: `${err.fieldName} ${err.message}` };
    }
    throw err;
  }
  if (created.existing) return { ok: true, note: created.note, existing: true, images: { stored: 0, failed: [] } };

  const note = created.note;
  const outcome = await storeImages(env, ctx, repos, note.id, clip.images, opts);
  const images = { stored: outcome.stored, failed: outcome.failed };
  if (outcome.relinks.size === 0) return { ok: true, note, existing: false, images };

  /*
     The one case with a second write. The body was written before the pictures were
     fetched, because a file needs its note to exist first, and it names every picture the
     clip kept as `files/<name>`. A picture that did not arrive would leave a link to a
     file that is not there: the note would show a broken image and the attachments panel
     would never list it. So those links are pointed back at the web, where the picture
     still is. It is a second write only on failure: on the usual path the body was
     already right, and writing it again would cost a store call, a feed row and a copy in
     the note's history for nothing.

     `ifUpdatedAt` because the note has been visible since its create: a person who
     opened it and typed in the seconds this took has the newer body, and theirs wins.
     Their draft then still has the broken links, and the editor's "Save web images" is
     not offered for them; that is the rarer failure, and better than overwriting them.
  */
  const body = relink(clip.markdown, clip.images, outcome.relinks);
  const updated = await repos.notes.update(note.id, {
    body,
    ifUpdatedAt: note.updatedAt,
    ...(opts.by ? { by: opts.by } : {}),
  });
  const final = updated && !('stale' in updated) ? updated : note;
  return { ok: true, note: final, existing: false, images };
}

type FetchedPage = { ok: true; html: string; url: URL } | Extract<ClipResult, { ok: false }>;

/**
 * The page's HTML as text, or why there is none.
 *
 * `fetchSource` is the fetch `add_attachment` makes, and the right one here: it dresses
 * the request as a browser's (a page is exactly what hosts hand only to browsers), it
 * follows redirects by hand so every hop is checked, and it has a timeout. Its messages
 * are written about files, so the refusals are worded again here for a page.
 */
async function fetchPage(url: URL, opts: ClipOptions): Promise<FetchedPage> {
  const source = await fetchSource(url, {
    maxBytes: CLIP_MAX_PAGE_BYTES,
    allowLoopback: opts.allowLoopback,
    ...(opts.userAgent ? { userAgent: opts.userAgent } : {}),
  });
  if (!source.ok) {
    if (source.tooLarge) {
      return {
        ok: false,
        status: 413,
        code: 'TOO_LARGE',
        error: `That page is over ${CLIP_MAX_PAGE_BYTES / 1024 / 1024} MB, more than a clip reads.`,
      };
    }
    if (source.status === 401 || source.status === 403 || source.status === 429) {
      return {
        ok: false,
        status: 502,
        code: 'HOST_REFUSED',
        error:
          `${url.host} answered ${source.status} and would not give this server the page. ` +
          'Some sites serve only browsers, and some pages need a sign-in.',
      };
    }
    if (source.status !== undefined) {
      return { ok: false, status: 502, code: 'HOST_ERROR', error: `${url.host} answered ${source.status}.` };
    }
    return { ok: false, status: 502, code: 'UNREACHABLE', error: source.error };
  }

  /*
     A page only. A PDF or a picture at the address is a file, and a file is attached to
     a note (an upload, `add_attachment`), where it is stored as itself and its text is
     read; clipping it would make a note of nothing. `application/xhtml+xml` is a page
     written as XML, and as rare as it is, it is still a page.
  */
  const type = normalizeContentType(source.contentType);
  if (type !== 'text/html' && type !== 'application/xhtml+xml') {
    if (source.body instanceof ReadableStream) await source.body.cancel().catch(() => {});
    return {
      ok: false,
      status: 415,
      code: 'NOT_A_PAGE',
      error:
        `That address is ${type ? `a ${type} file` : 'a file of no stated type'}, not a web page. ` +
        'Clipping is for web pages; a file such as a PDF or a picture is attached to a note ' +
        'instead (uploaded, or passed to add_attachment by an assistant).',
    };
  }

  let bytes: ArrayBuffer;
  try {
    bytes = await new Response(source.body).arrayBuffer();
  } catch (err) {
    return { ok: false, status: 502, code: 'UNREACHABLE', error: `Reading the page from ${url.host} failed: ${(err as Error).message}` };
  }
  return { ok: true, html: decodeHtml(bytes, source.contentType), url: source.url };
}

/**
 * The page's bytes as text, in the encoding the page is in.
 *
 * The header's `charset` first, then a `<meta charset>` (or the older `http-equiv` form)
 * in the first kilobyte, which is where a browser looks and where pages that predate
 * UTF-8 declare theirs, then UTF-8. A label the runtime's `TextDecoder` does not know
 * falls back to UTF-8 rather than failing the clip: a page in a rare encoding loses its
 * accents, not the article.
 */
export function decodeHtml(bytes: ArrayBuffer, contentType: string | null): string {
  const declared = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType ?? '')?.[1];
  // Read byte for byte, which is all a declaration in ASCII needs, without asking the
  // runtime for a decoder it may not have: workerd's has fewer labels than a browser's.
  const head = String.fromCharCode(...new Uint8Array(bytes, 0, Math.min(1024, bytes.byteLength)));
  const meta = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1];
  for (const label of [declared, meta]) {
    if (!label) continue;
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      // Not a label this runtime decodes; try the next.
    }
  }
  return new TextDecoder('utf-8').decode(bytes);
}

interface StoredImages extends ClipImages {
  /** By the clip's filename: the destination its links should have instead, as a URL. */
  relinks: Map<string, string>;
}

/**
 * Fetches each picture and stores it under the name the clip gave it, a few at a time.
 *
 * The note is brand new and the clip chose its names to be distinct, so each is stored
 * as asked. `storeAttachment` would still suffix one that collided (it asks the store
 * for a free name), and then the body's link is pointed at the name it got rather than
 * the one the clip wrote.
 *
 * The first refusal for room (`StorageFull`, or the free plan's `PlanRefused`) stops
 * the fetching: every picture after it would be refused for the same reason, and each
 * would be a fetch and an R2 put spent to learn it. The ones not yet fetched are failed
 * with that reason, so the answer says why.
 */
async function storeImages(
  env: Pick<Env, 'BLOBS' | 'AI'>,
  ctx: { waitUntil(promise: Promise<unknown>): void },
  repos: { notes: NotesRepo; attachments: AttachmentsRepo },
  noteId: string,
  images: ClipImage[],
  opts: ClipOptions,
): Promise<StoredImages> {
  const failed: Array<{ index: number; url: string; error: string }> = [];
  const relinks = new Map<string, string>();
  let stored = 0;
  let refusal: string | null = null;
  let next = 0;

  const fail = (index: number, image: ClipImage, error: string) => {
    failed.push({ index, url: image.url, error });
    relinks.set(image.filename, image.url);
  };

  const worker = async () => {
    while (next < images.length) {
      const index = next++;
      const image = images[index]!;
      if (refusal) {
        fail(index, image, refusal);
        continue;
      }
      const fetched = await fetchWebImage(image.url, { allowLoopback: opts.allowLoopback });
      if (!fetched.ok) {
        fail(index, image, fetched.error);
        continue;
      }
      // Refused while this one was on its way: not worth an R2 put to be refused again.
      if (refusal) {
        fail(index, image, refusal);
        continue;
      }
      try {
        const file = await storeAttachment(env, ctx, repos, {
          noteId,
          filename: image.filename,
          contentType: fetched.contentType,
          body: fetched.bytes,
          link: false,
          quota: opts.quota,
        });
        stored += 1;
        if (file.filename !== image.filename) relinks.set(image.filename, file.path);
      } catch (err) {
        if (err instanceof StorageFull || err instanceof PlanRefused) {
          refusal ??= err.message;
          fail(index, image, err.message);
          continue;
        }
        fail(index, image, `Storing it failed: ${(err as Error).message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(IMAGE_CONCURRENCY, images.length) }, worker));

  failed.sort((a, b) => a.index - b.index);
  return { stored, failed: failed.map(({ url, error }) => ({ url, error })), relinks };
}

/**
 * The clip's body with the links to each picture in `relinks` pointed at its new
 * destination: the web address of one that failed, or the stored name of one that was
 * renamed.
 *
 * By the parser, not a pattern over the body. `inlineLinkSpans` finds each picture whose
 * destination reads as exactly the clip's `files/<name>`, so a code block quoting such
 * a link, or a sentence that mentions the path, is left alone; then only the destination
 * inside that span is replaced, so the alt text and any title stay as the clip wrote
 * them. The spliced link is read back through the same parser before it is kept, and a
 * picture whose splice does not read back as intended is written whole instead, from the
 * clip's own alt text. Spans are replaced from the end so the earlier ones' offsets hold.
 */
export function relink(markdown: string, images: ClipImage[], relinks: Map<string, string>): string {
  const byPath = new Map(images.filter((i) => relinks.has(i.filename)).map((i) => [i.path, i]));
  if (byPath.size === 0) return markdown;
  const spans = inlineLinkSpans(markdown)
    .filter((l) => l.image && byPath.has(l.url))
    .sort((a, b) => b.from - a.from);

  let out = markdown;
  for (const span of spans) {
    const image = byPath.get(span.url)!;
    const target = relinks.get(image.filename)!;
    const destination = target.startsWith('files/')
      ? relativeAttachmentPath(target.slice('files/'.length))
      : webDestination(target);
    const text = out.slice(span.from, span.to);
    const spliced = spliceDestination(text, destination);
    const replacement =
      spliced !== null && readsAs(spliced, target) ? spliced : `![${escapeLabel(image.alt)}](${destination})`;
    out = out.slice(0, span.from) + replacement + out.slice(span.to);
  }
  return out;
}

/**
 * A web address as a link destination: in angle brackets when it holds a parenthesis,
 * and with an ampersand that would read as a character reference escaped, as
 * `relativeAttachmentPath` writes a file's; see `attachmentDestination` in
 * `@unbent/shared` for why each. A URL's `href` holds no space, angle bracket or
 * backslash, so nothing else needs it.
 */
function webDestination(url: string): string {
  const escaped = url.replace(/&(?=#\d+;|#x[0-9a-f]+;|[a-z][a-z0-9]*;)/gi, '\\&');
  return /[()]/.test(url) ? `<${escaped}>` : escaped;
}

function escapeLabel(label: string): string {
  return label.replace(/[[\]\\]/g, '\\$&');
}

/** Whether `text` is one picture, the whole of it, whose destination reads as `url`. */
function readsAs(text: string, url: string): boolean {
  const links = inlineLinkSpans(text);
  const first = links[0];
  return links.length >= 1 && first!.image && first!.from === 0 && first!.to === text.length && first!.url === url;
}

/**
 * `text`, one inline image as the parser found it, with its destination replaced, or null
 * when the destination cannot be found in it. The label ends at the first `]` outside a
 * nested pair and not escaped; the destination is the bracketed `<…>` or the bare run
 * after the `(` that follows it, as CommonMark reads one. `readsAs` checks the answer, so
 * a case this reads wrongly is caught there rather than written.
 */
function spliceDestination(text: string, destination: string): string | null {
  let i = 2;
  let depth = 0;
  for (; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\') i += 1;
    else if (ch === '[') depth += 1;
    else if (ch === ']') {
      if (depth === 0) break;
      depth -= 1;
    }
  }
  if (text[i + 1] !== '(') return null;
  let start = i + 2;
  while (start < text.length && /[ \t\n]/.test(text[start]!)) start += 1;

  let end = start;
  if (text[start] === '<') {
    end += 1;
    while (end < text.length && text[end] !== '>') end += text[end] === '\\' ? 2 : 1;
    if (text[end] !== '>') return null;
    end += 1;
  } else {
    let parens = 0;
    while (end < text.length) {
      const ch = text[end]!;
      if (ch === '\\') {
        end += 2;
        continue;
      }
      if (/\s/.test(ch)) break;
      if (ch === '(') parens += 1;
      else if (ch === ')') {
        if (parens === 0) break;
        parens -= 1;
      }
      end += 1;
    }
  }
  if (end === start) return null;
  return text.slice(0, start) + destination + text.slice(end);
}
