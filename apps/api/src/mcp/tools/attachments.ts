import { z } from 'zod';
import { MAX_ATTACHMENT_BYTES, filenameSchema, normalizeContentType } from '@unbent/shared';
import type { McpServer } from '@modelcontextprotocol/server';
import type { AppLinks } from '../../lib/app-links.js';
import type { AttachmentsRepo } from '../../lib/attachments-repo.js';
import {
  checkSourceUrl,
  chooseContentType,
  chooseFilename,
  fetchSource,
} from '../../lib/fetch-attachment.js';
import { LLM_IMAGE_TYPES, toBase64 } from '../../lib/llm.js';
import type { NotesRepo } from '../../lib/notes-repo.js';
import { storeAttachment } from '../../lib/store-attachment.js';
import { UPLOAD_GRANT_TTL_MS, type UploadGrantsRepo } from '../../lib/upload-grants.js';
import type { Env } from '../../types.js';
import { jsonResult, notFound, toolError } from './result.js';

/**
 * The most of a picture `get_attachment` hands over. Base64 inflates it by a third, and
 * the result rides in the assistant's context beside everything else it holds, so this
 * sits under the model's own cap (`MAX_LLM_IMAGE_BYTES`): a phone photo fits, a scan at
 * print resolution does not, and the refusal names the size so the person can resize it.
 */
const MAX_MCP_IMAGE_BYTES = 4 * 1024 * 1024;

/**
 * The most text `set_attachment_text` takes. A transcription of a stack of pages is tens
 * of thousands of characters; anything past this is not a reading of one file. Well under
 * the route's own cap on a stored text.
 */
const MAX_ASSISTANT_TEXT_CHARS = 100_000;

/**
 * The tools that give a note a file, and the two that let an assistant read one.
 *
 * Bytes flow out here and never in. `get_attachment` returns a picture as an image block
 * for the assistant's own model to look at — since MAK-179 nothing on the instance reads
 * a picture except an Auto-fill press, so an assistant that wants to know what a photo
 * shows reads it itself, on its own bill, by the person's choice in connecting it — and
 * `set_attachment_text` records what it read, marked as the assistant's, so search and
 * the summaries have it until a press has the model read the file (see
 * `writeAssistantText` in the store for what yields to it and what does not).
 *
 * No tool takes the bytes as an argument, and not because one was forgotten. A tool call
 * is JSON the model writes, so the only way bytes could arrive through one is base64 in an
 * argument — and a model producing a scan that way is millions of characters of output,
 * past what any client will carry or any model will finish; even a phone screenshot is over
 * a million. Such a tool would advertise a capability that works only for files small
 * enough not to matter. It was proposed again (MAK-126) and declined for the same reason.
 *
 * What a model can hand over instead is a URL, in one of two directions. add_attachment
 * takes a URL the server fetches: what every system that holds files offers when read, a
 * signed download link. prepare_attachment_upload gives a URL the other way, for a file
 * that has no link because it is on the assistant's own disk: the assistant's shell PUTs
 * the bytes there (routes/uploads.ts). Either way the bytes never pass through the model,
 * and they end in lib/store-attachment.ts, the same thing that happens to an upload from
 * the editor.
 */
export function registerAttachmentTools(
  server: McpServer,
  env: Pick<Env, 'APP_URL' | 'BLOBS' | 'AI' | 'ALLOW_TEST_CREDENTIALS'>,
  ctx: { waitUntil(promise: Promise<unknown>): void },
  repos: { notes: NotesRepo; attachments: AttachmentsRepo; uploads: UploadGrantsRepo },
  links: AppLinks,
): void {
  // Loopback is fetchable only where the web-image route allows it too: local development,
  // flagged the same way. Deployed, this is false, so neither server-side fetcher can be
  // pointed at the Worker's own network.
  const allowLoopback = env.ALLOW_TEST_CREDENTIALS === '1';

  server.registerTool(
    'get_attachment',
    {
      title: 'See a picture',
      description:
        'The picture itself, returned as an image for you to read: a JPEG, PNG, GIF or WebP ' +
        'attachment under 4 MB. For a picture that get_attachment_text, get_note or a ' +
        'summary reports as "pending": nothing on this instance reads a picture on its own ' +
        '— an Auto-fill press by the person does, and so can you. Read it, then record what ' +
        'you read with set_attachment_text, so search, the summaries and the next session ' +
        'have it without looking again. The bytes come to you and to no model the instance ' +
        "runs. PDFs are not returned: a PDF's text layer is read for free on upload and " +
        'get_attachment_text has it, and a scan with no layer waits for an Auto-fill press.',
      inputSchema: z.object({
        noteId: z.string().uuid(),
        filename: z.string().min(1).describe('As listed by get_note.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ noteId, filename }) => {
      // Scoped to the caller's store, so another person's note reads as missing; and
      // never from the trash, like every other read of a file that is not a page load.
      const row = await repos.attachments.resolve(noteId, filename);
      if (!row) return notFound('attachment', `${filename} on note ${noteId}`);
      if (!LLM_IMAGE_TYPES.has(row.content_type)) {
        return toolError(
          `Only a picture is returned (JPEG, PNG, GIF or WebP); this file is ${row.content_type}. ` +
            (row.content_type === 'application/pdf'
              ? "A PDF's text layer is in get_attachment_text; a scan with no layer waits for an Auto-fill press."
              : 'Nothing on this instance reads it.'),
        );
      }
      if (row.size > MAX_MCP_IMAGE_BYTES) {
        const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;
        return toolError(
          `This picture is ${mb(row.size)}, over the ${mb(MAX_MCP_IMAGE_BYTES)} this tool returns. ` +
            'A smaller copy of it, attached beside it, could be read.',
        );
      }
      const object = await env.BLOBS.get(row.r2_key);
      if (!object) return toolError('The bytes of this file could not be found; try again later.');
      const data = toBase64(await object.arrayBuffer());
      return {
        content: [
          { type: 'image' as const, data, mimeType: row.content_type },
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                filename: row.filename,
                contentType: row.content_type,
                size: row.size,
                next: 'Record what you read with set_attachment_text, so it is searchable and the next session has it.',
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'set_attachment_text',
    {
      title: 'Record what you read off a file',
      description:
        'Record the text of a file you have read yourself, usually a picture from ' +
        'get_attachment, so search, the summaries on get_note and list_notes, and ' +
        'get_attachment_text have it. Write what the file says, not what you make of it: ' +
        'a short first line naming it, a line saying what it is and shows (who it is from, ' +
        'the amounts, the dates), a blank line, then every legible word transcribed in ' +
        'reading order. Allowed where the file has no text, an empty row, or text you ' +
        "recorded before, which you may revise; refused over a PDF's own text layer or what " +
        "the instance's vision model read, since neither is yours to replace. What you " +
        'record is marked as yours (read "assistant"), and the next time the person presses ' +
        'Auto-fill on the note the instance has its model read the file itself and replaces ' +
        'it — so write it for search in the meantime, not as the last word.',
      inputSchema: z.object({
        noteId: z.string().uuid(),
        filename: z.string().min(1).describe('As listed by get_note.'),
        text: z
          .string()
          .min(1)
          .max(MAX_ASSISTANT_TEXT_CHARS)
          .describe('What the file says: a name line, a line on what it is, a blank line, then the transcription.'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ noteId, filename, text }) => {
      const trimmed = text.trim();
      if (!trimmed) return toolError('Nothing to record: the text is blank.');
      const result = await repos.attachments.writeAssistantText(noteId, filename, trimmed);
      if (!result.ok) {
        switch (result.reason) {
          case 'missing':
            return notFound('attachment', `${filename} on note ${noteId}`);
          case 'layer':
            return toolError(
              'This PDF has its own text layer, which is not yours to replace; get_attachment_text has it.',
            );
          default:
            return toolError(
              "The instance's vision model has read this file, and its reading is not yours to replace; " +
                'get_attachment_text has it.',
            );
        }
      }
      return jsonResult({
        filename,
        read: 'assistant',
        chars: trimmed.length,
        note: 'Recorded. The next Auto-fill press on this note has the model read the file itself and replaces this.',
      });
    },
  );

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
        'extracted, which happens in the background. For a file with no URL — one on your ' +
        'own disk or in your sandbox — use prepare_attachment_upload instead. The answer ' +
        'also carries url, the note in Unbent: give it to the person as a link.',
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
        return jsonResult({ noteId, url: links.note(noteId), ...stored, linked: link });
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

  /*
     The other direction: a file the assistant holds, with no URL to give. The tool mints
     a one-time link and the assistant's own shell sends the bytes to it; the tool itself
     never sees them. The link is built on APP_URL, the origin the person reaches this
     instance on, rather than the Worker's own address, which in development is a
     different port and in production is not a public name at all.
  */
  server.registerTool(
    'prepare_attachment_upload',
    {
      title: 'Upload a file from your own machine',
      description:
        'Attach a file that you hold rather than one at a URL: a file on the machine or in ' +
        'the sandbox where you run commands, such as a screenshot the person gave you. ' +
        'Returns a one-time upload URL. Send the raw bytes to it with an HTTP PUT, for ' +
        'example curl -T "photo.png" "<uploadUrl>"; the reply to that request is the same ' +
        'JSON add_attachment returns, with the note\'s url to give the person, the filename the file was stored under ' +
        '(suffixed if the note already had one by that name) and the Markdown that shows ' +
        `it. The URL works once, for this note, for ${UPLOAD_GRANT_TTL_MS / 60_000} ` +
        `minutes, for a file up to ${Math.floor(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB; ` +
        'if it fails or runs out, ask for another. Your environment must be able to reach ' +
        'this server over HTTPS, so a sandbox with restricted network access needs its ' +
        'domain allowed. The file type is taken from contentType, else from the ' +
        "filename's extension. By default the Markdown is appended to the note; pass link " +
        'false and place it yourself with edit_note. This tool cannot help with a file ' +
        'you have only seen in the conversation and cannot read from disk.',
      inputSchema: z.object({
        noteId: z.string().uuid(),
        filename: filenameSchema.describe('What to call the file, with its extension.'),
        contentType: z
          .string()
          .max(255)
          .optional()
          .describe('A MIME type such as image/png. Defaults to what the extension says.'),
        link: z
          .boolean()
          .default(true)
          .describe('Append the Markdown link to the end of the note body.'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ noteId, filename, contentType, link }) => {
      if (!(await repos.attachments.ownsNote(noteId))) return notFound('note', noteId);

      const { token, expiresAt } = await repos.uploads.create({
        noteId,
        filename,
        contentType: normalizeContentType(contentType) || null,
        link,
      });
      const uploadUrl = `${env.APP_URL}/api/uploads/${token}`;
      return jsonResult({
        uploadUrl,
        method: 'PUT',
        expiresAt: new Date(expiresAt).toISOString(),
        maxBytes: MAX_ATTACHMENT_BYTES,
        example: `curl -T <path to the file> "${uploadUrl}"`,
      });
    },
  );
}
