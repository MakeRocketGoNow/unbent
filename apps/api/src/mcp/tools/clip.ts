import { z } from 'zod';
import { MAX_TITLE_LENGTH, type NoteFieldsPatch } from '@unbent/shared';
import type { McpServer } from '@modelcontextprotocol/server';
import type { AppLinks } from '../../lib/app-links.js';
import type { AttachmentsRepo } from '../../lib/attachments-repo.js';
import { CLIP_MAX_IMAGES, clipUrl } from '../../lib/clip.js';
import { webClipOf } from '../../lib/instance.js';
import type { NotesRepo } from '../../lib/notes-repo.js';
import type { Env } from '../../types.js';
import { SHARE_NOTE_LINK, jsonResult, noteRef, toolError } from './result.js';
import { fieldsSchema, normalizeNotebook, notebookSchema, resolveFieldNames, tagsSchema } from './write.js';

/**
 * `clip_web_page`: a web page kept as a note, fetched by the server. The same function
 * as `POST /api/clip` (`lib/clip.ts`), so a page an assistant clips is the note a phone's
 * share would have made of it.
 *
 * An assistant could already do this the long way: read the page with its own tools,
 * write the Markdown into `create_note`, then `add_attachment` each picture. That is the
 * article passing through the model twice, as input and again as output, and a call per
 * picture; for a long article it is most of a context window spent copying. Here the
 * model sends an address and gets back a link. The long way stays the answer for a page
 * this server cannot have (a host that refuses servers, a page behind a sign-in or
 * drawn by script), and the description and the refusal both say so, since the
 * assistant's own browsing often can.
 *
 * Inputs are `create_note`'s, less the body: the notebook by name and the fields by
 * name, resolved the same way, so nothing about filing a clip has to be learned twice.
 *
 * Registered only where the operator switched the clipper on (`WEB_CLIP`, `webClipOf`),
 * as the route answers only there: a tool in the list that failed every call would send
 * an assistant down the long way after a wasted turn, where no tool sends it there at
 * once. Decided here rather than by the caller so the decision is the function's own and
 * a test can see it.
 */
/**
 * The reading speed a clip's reading time is worked out at: a common figure for adults
 * reading prose on a screen. Stated here so every assistant filling a reading-time field
 * uses the same one, rather than each picking its own and two notes clipped a day apart
 * disagreeing about the same length.
 */
export const READING_WORDS_PER_MINUTE = 230;

/**
 * Minutes to read `words`, rounded, and never 0 for an article with any words in it: a
 * field that says a short page takes no time to read is wrong, where one minute is only
 * generous. 0 is kept for a clip with no text at all, which is the case to notice.
 */
export function readingTimeMinutes(words: number): number {
  return words > 0 ? Math.max(1, Math.round(words / READING_WORDS_PER_MINUTE)) : 0;
}

export function registerClipTool(
  server: Pick<McpServer, 'registerTool'>,
  env: Pick<Env, 'BLOBS' | 'AI' | 'ALLOW_TEST_CREDENTIALS' | 'ATTACHMENT_FETCH_USER_AGENT' | 'WEB_CLIP'>,
  ctx: { waitUntil(promise: Promise<unknown>): void },
  repos: { notes: NotesRepo; attachments: AttachmentsRepo },
  links: AppLinks,
  /** The plan's storage in bytes, or null for no limit; see lib/quota.ts. */
  quota: () => Promise<number | null>,
  /** Refuses an account past the free plan before the page is fetched (`refuseIfPastFree`). */
  pastFree: () => Promise<unknown> = async () => {},
): void {
  if (!webClipOf(env)) return;
  // As add_attachment's: loopback only in local development, where the test suite's
  // page server is.
  const allowLoopback = env.ALLOW_TEST_CREDENTIALS === '1';

  server.registerTool(
    'clip_web_page',
    {
      title: 'Clip a web page into a note',
      description:
        'Keep a web page as a note. The server fetches the page itself and keeps the ' +
        'article as Markdown, the way a browser\'s reader view shows it: the navigation, ' +
        'sidebars, adverts and footer are dropped, links stay links, and the note opens with ' +
        'a "Clipped from" line linking the page. Its pictures (up to ' +
        `${CLIP_MAX_IMAGES}) are fetched and attached to the note, so they stay when the ` +
        'site changes; any past that, or any that could not be fetched, stay as links to the ' +
        'site. The page never passes through the conversation, so prefer this to reading a ' +
        'page and writing it out with create_note. The title defaults to the article\'s ' +
        'headline. The answer carries the note\'s url and images: how many pictures were ' +
        'stored and which failed, with why. It also carries wordCount, the words of the ' +
        'article itself (not the "Clipped from" line, links\' addresses or pictures), and ' +
        `readingTimeMinutes, that count at ${READING_WORDS_PER_MINUTE} words a minute; use ` +
        'them for a field such as a reading time, since the article is not in the ' +
        'conversation to count. A count of a few dozen words is a page that did not give ' +
        'its text up.' +
        SHARE_NOTE_LINK +
        ' If the site refuses this server (401, 403 or 429), or the page needs a sign-in ' +
        'or JavaScript to show its text (the note comes back nearly empty, with a low ' +
        'wordCount), read the page ' +
        'yourself and write the note with create_note, with a "Clipped from" link to the ' +
        'page. A file at a URL, such as a PDF or a picture, is not a page: attach it to a ' +
        'note with add_attachment instead.',
      inputSchema: z.object({
        url: z.string().min(1).max(8192).describe('The http or https address of the page.'),
        title: z
          .string()
          .max(MAX_TITLE_LENGTH)
          .optional()
          .describe("The note's title. Defaults to the article's own headline."),
        tags: tagsSchema.default([]),
        notebook: notebookSchema.optional(),
        fields: fieldsSchema.optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ url, title, tags, notebook, fields }) => {
      const target = normalizeNotebook(notebook);
      let patch: NoteFieldsPatch | undefined;
      if (fields && Object.keys(fields).length > 0) {
        // Before the page is fetched, as create_note resolves them before writing: a
        // misremembered field name is cheaper to hear about than a page fetched for
        // nothing. One notebook, so `notebookByName` and not the whole account's.
        const defs = target ? ((await repos.notes.notebookByName(target))?.fields ?? []) : [];
        const resolved = resolveFieldNames(fields, defs, [], target ?? null);
        if ('error' in resolved) return toolError(resolved.error);
        patch = resolved.patch;
      }

      const result = await clipUrl(
        env,
        ctx,
        repos,
        { url, title, tags, notebook: target, fields: patch },
        {
          allowLoopback,
          quota: await quota(),
          userAgent: env.ATTACHMENT_FETCH_USER_AGENT,
          pastFree,
          // Kept in history as the assistant's, should the body need its repair; see
          // `NotesStore.update` for why an assistant's writes say so.
          by: 'assistant',
        },
      );
      if (!result.ok) {
        // A page this server cannot have may still be one the assistant can: its own
        // browsing is often let in where a server is not.
        const yourself =
          result.code === 'HOST_REFUSED' || result.code === 'HOST_ERROR' || result.code === 'TOO_LARGE'
            ? ' Read the page yourself (in a browser, or with your own tools) and write the note ' +
              'with create_note, with a "Clipped from" link to the page.'
            : '';
        return toolError(`${result.error}${yourself}`);
      }
      return jsonResult({
        ...noteRef(result.note, links),
        images: result.images,
        wordCount: result.wordCount,
        readingTimeMinutes: readingTimeMinutes(result.wordCount),
      });
    },
  );
}
