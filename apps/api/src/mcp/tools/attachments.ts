import { z } from 'zod';
import { MAX_ATTACHMENT_BYTES, filenameSchema } from '@unbent/shared';
import type { McpServer } from '@modelcontextprotocol/server';
import type { AttachmentsRepo } from '../../lib/attachments-repo.js';
import {
  checkSourceUrl,
  chooseContentType,
  chooseFilename,
  fetchSource,
} from '../../lib/fetch-attachment.js';
import type { NotesRepo } from '../../lib/notes-repo.js';
import { storeAttachment } from '../../lib/store-attachment.js';
import type { Env } from '../../types.js';
import { jsonResult, notFound, toolError } from './result.js';

/**
 * The tool that gives a note a file.
 *
 * There is no upload tool, and not because one was forgotten. A tool call is JSON the
 * model writes, so the only way bytes could arrive through one is base64 in an argument —
 * and a model producing a scan that way is millions of characters of output, past what
 * any client will carry or any model will finish. Such a tool would advertise a capability
 * that works only for files small enough not to matter. What a model can hand over is a
 * URL the server can fetch, which is what every system that holds files offers when read:
 * a signed download link. See lib/fetch-attachment.ts for the fetching and
 * lib/store-attachment.ts for what happens to the bytes, which is the same thing that
 * happens to an upload from the editor.
 */
export function registerAttachmentTools(
  server: McpServer,
  env: Pick<Env, 'BLOBS' | 'AI' | 'ALLOW_TEST_CREDENTIALS'>,
  ctx: { waitUntil(promise: Promise<unknown>): void },
  repos: { notes: NotesRepo; attachments: AttachmentsRepo },
): void {
  // Loopback is fetchable only where the web-image route allows it too: local development,
  // flagged the same way. Deployed, this is false, so neither server-side fetcher can be
  // pointed at the Worker's own network.
  const allowLoopback = env.ALLOW_TEST_CREDENTIALS === '1';
  server.registerTool(
    'add_attachment',
    {
      title: 'Attach a file from a URL',
      description:
        'Attach a file to a note. The server fetches the URL itself and stores what it ' +
        'gets, so the bytes never pass through the conversation: to bring a file over from ' +
        'another system, read that system for a download link — usually a signed URL that ' +
        'is valid for an hour or so — and pass it here. Only http and https can be fetched; ' +
        'a file: or other internal reference is not a download link. Give a filename when ' +
        'you know a better one than the URL offers, since download URLs often end in a ' +
        'generic name like upload.pdf. The result carries the filename the file was stored ' +
        'under (suffixed if the note already had one by that name), its relative path, and ' +
        'the exact Markdown that shows it in the note. By default that Markdown is appended ' +
        'to the end of the body; pass link false and place it yourself with edit_note when ' +
        'it belongs somewhere in particular. A PDF becomes searchable once its text is ' +
        'extracted, which happens in the background.',
      inputSchema: z.object({
        noteId: z.string().uuid(),
        url: z.string().min(1).max(8192).describe('An http or https URL the file can be fetched from.'),
        filename: filenameSchema
          .optional()
          .describe('What to call the file. Defaults to what the source names it.'),
        link: z
          .boolean()
          .default(true)
          .describe('Append the Markdown link to the end of the note body.'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ noteId, url: raw, filename, link }) => {
      // Ownership first, before a byte is fetched: nothing is downloaded for a caller who
      // has no note to put it on, and a note that is not theirs reads as missing.
      if (!(await repos.attachments.ownsNote(noteId))) return notFound('note', noteId);

      const checked = checkSourceUrl(raw, { allowLoopback });
      if ('error' in checked) return toolError(checked.error);

      const source = await fetchSource(checked.url, {
        maxBytes: MAX_ATTACHMENT_BYTES,
        allowLoopback,
      });
      if (!source.ok) return toolError(source.error);

      const name = chooseFilename({
        requested: filename,
        contentDisposition: source.contentDisposition,
        url: source.url,
        contentType: source.contentType,
      });
      const contentType = chooseContentType(source.contentType, name);

      try {
        const stored = await storeAttachment(env, ctx, repos, {
          noteId,
          filename: name,
          contentType,
          body: source.body,
          link,
        });
        return jsonResult({ noteId, ...stored, linked: link });
      } catch (err) {
        // A transfer that fails midway — the source sent fewer bytes than it declared, say
        // — is the model's to retry, not an exception to end the conversation on.
        return toolError(
          `Storing the file failed: ${err instanceof Error ? err.message : String(err)}. ` +
            'Nothing was attached; try again, or read the source for a fresh URL.',
        );
      }
    },
  );
}
