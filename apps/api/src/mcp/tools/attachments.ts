import { z } from 'zod';
import { MAX_ATTACHMENT_BYTES, filenameSchema, normalizeContentType } from '@unbent/shared';
import type { McpServer } from '@modelcontextprotocol/server';
import type { AppLinks } from '../../lib/app-links.js';
import type { AttachmentsRepo } from '../../lib/attachments-repo.js';
import type { AttachmentRow, FileRead } from '../../store/attachments.js';
import {
  checkReferer,
  checkSourceUrl,
  chooseContentType,
  chooseFilename,
  fetchSource,
} from '../../lib/fetch-attachment.js';
import {
  DEFAULT_MAX_EDGE,
  downscale,
  LARGEST_MAX_EDGE,
  pictureSize,
  MAX_DOWNSCALE_INPUT_BYTES,
  SMALLEST_MAX_EDGE,
} from '../../lib/downscale.js';
import { canUseLlm, LLM_IMAGE_TYPES, readableByLlm, sniffMediaType, toBase64 } from '../../lib/llm.js';
import type { NotesRepo } from '../../lib/notes-repo.js';
import { openPdf, PdfError, type PdfPages } from '../../lib/pdf-pages.js';
import { withReaderSlot } from '../../lib/reader-gate.js';
import { storeAttachment } from '../../lib/store-attachment.js';
import { UPLOAD_GRANT_TTL_MS, type UploadGrantsRepo } from '../../lib/upload-grants.js';
import type { Env } from '../../types.js';
import { jsonResult, notFound, toolError } from './result.js';

/**
 * The most of a picture `get_attachment` hands over, as bytes. The model's platforms cap
 * an image by the length of its base64 (10 MiB on the Claude API, 5 MiB on Bedrock and
 * Vertex) and which one the assistant's client talks to is unknown here, so the lower
 * bound rules: three quarters of 5 MiB, less a little for the JSON around it. A copy
 * shrunk by the Images binding (lib/downscale.ts) comes nowhere near it; this is the
 * ceiling for every original sent as it is: on an instance without the binding, one already
 * within the edge, or one the binding could not shrink. The refusal names the size so the
 * person can attach a smaller copy.
 */
const MAX_MCP_IMAGE_BYTES = Math.floor((5 * 1024 * 1024 * 3) / 4) - 64 * 1024;

/**
 * The most of a scan's pages one `get_attachment` call hands over, and the most bytes of
 * picture between them. Five pages at the default edge come to about a megabyte as JPEGs and
 * a few thousand tokens each in the assistant's context; a document longer than that is read
 * a few pages a call, with `pages`, rather than in one answer some client refuses. The bytes
 * are held to what a single picture may be, since no client is known to take more in one
 * answer, which only matters where nothing shrinks the pages: an instance without the Images
 * binding sends a scan's pages as the scanner stored them. The first page always goes.
 *
 * Each call reads the whole file from R2 and parses it again for its few pages, so a long
 * scan read through costs its size once per call: a Worker keeps nothing between calls,
 * and a cache of parsed files would be one more thing in an isolate's 128 MB. Parsing is
 * the cheap part (lib/pdf-pages.ts measures it), and a scan worth reading page by page is
 * rarely more than a few calls of five.
 */
const PAGES_PER_CALL = 5;
const MAX_PDF_ANSWER_BYTES = MAX_MCP_IMAGE_BYTES;

/**
 * The most pictures one call decodes and sends. A page drawn in strips is several pictures,
 * each its own decode and its own transformation through the Images binding, which is
 * metered by the month; five pages of a dozen strips would be sixty of each in one call.
 * Checked before a page is decoded, so the page that would pass it is left whole for the
 * next call rather than decoded and dropped. The first page always goes.
 */
const MAX_PICTURES_PER_CALL = 12;

/**
 * The largest PDF whose pages `get_attachment` takes out. The whole file is held in the
 * isolate while its pictures are found, beside a page's pixels when one has to be turned
 * into a PNG; lib/pdf-pages.ts adds up what one call holds at the caps (`MAX_PIXEL_BYTES`),
 * and the read gate keeps more than two such calls from holding it at once. A scan of a few
 * dozen pages is a few megabytes, and the largest no-text PDF in a real archive was 8 MB;
 * past this it is a book.
 */
const MAX_PDF_READ_BYTES = 16 * 1024 * 1024;

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
 * for the assistant's own model to look at (since MAK-179 nothing on the instance reads
 * a picture except an Auto-fill press, so an assistant that wants to know what a photo
 * shows reads it itself, on its own bill, by the person's choice in connecting it) and
 * `set_attachment_text` records what it read, marked as the assistant's, so search and
 * the summaries have it until a press has the model read the file, where the instance
 * has one (see `writeAssistantText` in the store for what yields to it and what does not).
 * A scanned PDF with no text layer goes out the same way, as the pictures its pages are
 * (MAK-255, lib/pdf-pages.ts says how they are found without a renderer), since that is
 * the other kind of file nothing but a press would otherwise ever read.
 * The descriptions say which it is, since on an instance with no key the assistant's words
 * are the text the file will have and should be written as such.
 *
 * No tool takes the bytes as an argument, and not because one was forgotten. A tool call
 * is JSON the model writes, so the only way bytes could arrive through one is base64 in an
 * argument, and a model producing a scan that way is millions of characters of output,
 * past what any client will carry or any model will finish; even a phone screenshot is over
 * a million. Such a tool would advertise a capability that works only for files small
 * enough not to matter. It was proposed again (MAK-126) and declined for the same reason.
 *
 * What a model can hand over instead is a URL, in one of two directions. add_attachment
 * takes a URL the server fetches: what every system that holds files offers when read, a
 * signed download link. prepare_attachment_upload gives a URL the other way, for a file
 * that has no link because it is on the assistant's own disk, or that only a browser could
 * fetch: the assistant's shell, or a script in that browser's page, PUTs the bytes there
 * (routes/uploads.ts). Either way the bytes never pass through the model,
 * and they end in lib/store-attachment.ts, the same thing that happens to an upload from
 * the editor.
 */
export function registerAttachmentTools(
  server: Pick<McpServer, 'registerTool'>,
  env: Pick<
    Env,
    | 'APP_URL'
    | 'BLOBS'
    | 'AI'
    | 'IMAGES'
    | 'ALLOW_TEST_CREDENTIALS'
    | 'ANTHROPIC_API_KEY'
    | 'ATTACHMENT_FETCH_USER_AGENT'
  >,
  ctx: { waitUntil(promise: Promise<unknown>): void },
  repos: { notes: NotesRepo; attachments: AttachmentsRepo; uploads: UploadGrantsRepo },
  links: AppLinks,
  /** The plan's storage in bytes when a file is about to be stored, or null for no limit; see lib/quota.ts. */
  quota: () => Promise<number | null>,
  /**
   * Refuses an account past the free plan before a file is fetched or a link is minted
   * (`refuseIfPastFree`), by throwing the `PlanRefused` the gate answers as a tool error.
   */
  pastFree: () => Promise<unknown> = async () => {},
): void {
  // Loopback is fetchable only where the web-image route allows it too: local development,
  // flagged the same way. Deployed, this is false, so neither server-side fetcher can be
  // pointed at the Worker's own network.
  const allowLoopback = env.ALLOW_TEST_CREDENTIALS === '1';
  // Whether a press will ever have the model read what an assistant writes here.
  const vision = canUseLlm(env);
  // Whether `get_attachment` can shrink a picture before handing it over.
  const shrinks = Boolean(env.IMAGES);

  /**
   * A scanned PDF's pages, as `get_attachment` hands them over: the pictures lib/pdf-pages.ts
   * finds in the file, each made small enough to send the way a picture is, a few pages a
   * call. Each page's images follow a line naming the page, so a page in several strips
   * reads as one page, and the answer's last block says which pages went, which did not and
   * why, and what to ask for next.
   *
   * A PDF whose words are already here is refused before its bytes are fetched: a text
   * layer, or the instance's model's reading of the scan. Either is in get_attachment_text,
   * free and whole, where pictures of the pages would cost the assistant thousands of tokens
   * a page to read again, and set_attachment_text would refuse what it read. The one
   * exception is a text layer with pages asked for by number: a typed cover sheet in front
   * of scanned pages gives the whole file a layer, and the refusal says to ask for the
   * pages it leaves out; those are sent, with nothing to record. Everything else
   * is opened, a PDF nothing has read yet included, since its pages are worth reading
   * whatever its layer turns out to hold; the answer says that what is read cannot be
   * recorded until the layer has been (`unread`), rather than send the assistant to a
   * refusal at the end of the document.
   */
  const scanPages = async (row: AttachmentRow & { read: FileRead; unread: boolean }, edge: number, asked: string | undefined) => {
    if (row.read === 'text' && asked === undefined) {
      return toolError(
        'This PDF has a text layer, and get_attachment_text has its text; its pages are not sent as pictures. ' +
          'If some pages are scans the layer leaves out, ask for those with pages.',
      );
    }
    if (row.read === 'vision') {
      return toolError(
        "The instance's vision model has read this PDF, and get_attachment_text has its reading; its pages are not sent as pictures.",
      );
    }
    const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;
    // Only where a press would: the model takes a PDF up to `MAX_LLM_PDF_BYTES`, and a
    // larger one is skipped by every press, so naming the button would send the person to it
    // for nothing.
    const autofill = vision && readableByLlm(row.content_type, row.size) ? ' An Auto-fill press on the note reads it on the instance.' : '';
    if (row.size > MAX_PDF_READ_BYTES) {
      return toolError(`This PDF is ${mb(row.size)}, over the ${mb(MAX_PDF_READ_BYTES)} this tool opens.${autofill}`);
    }
    // The file and a page's pixels are held from here to the answer, so the work takes a
    // turn at the read gate with every other whole-file read on this isolate: an assistant
    // asking for several scans at once, or reading beside an import, is how a run of them
    // would otherwise stack in its 128 MB.
    return withReaderSlot(async () => {
      const object = await env.BLOBS.get(row.r2_key);
      if (!object) return toolError('The bytes of this file could not be found; try again later.');
      let pdf: PdfPages;
      try {
        pdf = await openPdf(new Uint8Array(await object.arrayBuffer()));
      } catch (err) {
        if (!(err instanceof PdfError)) throw err;
        return toolError(`This file could not be read as a PDF.${autofill}`);
      }
      if (pdf.encrypted) {
        return toolError(`This PDF is encrypted, so the pictures in it cannot be taken out here.${autofill}`);
      }
      const total = pdf.pages.length;
      if (!total) return toolError(`No pages could be found in this PDF.${autofill}`);

      const [first, last] = (asked ?? `1-${PAGES_PER_CALL}`).split('-').map((n) => Number(n.trim()));
      const from = first!;
      if (from < 1 || from > total) return toolError(`This PDF has ${total} page${total === 1 ? '' : 's'}; ask for pages from 1 to ${total}.`);
      if (last !== undefined && last < from) return toolError('The range is backwards: ask for the lower page first, like "2-4".');
      const to = Math.min(last ?? from, total, from + PAGES_PER_CALL - 1);

      const content: Array<{ type: 'image'; data: string; mimeType: string } | { type: 'text'; text: string }> = [];
      const sent: Array<Record<string, unknown>> = [];
      const notSent: Array<{ page: number; reason: string }> = [];
      let bytes = 0;
      let pictures = 0;
      let through = from - 1;
      for (let page = from; page <= to; page++) {
        const { images, hasText, rotate } = pdf.pages[page - 1]!;
        if (!images.length) {
          notSent.push({
            page,
            reason: hasText
              ? 'it is text, not a picture; get_attachment_text has the text layer'
              : 'it has no picture on it to send: it is drawn as shapes, which this tool cannot turn into one',
          });
          through = page;
          continue;
        }
        // A page goes whole or not at all, so the next call starts on a page boundary. It is
        // left for the next call before any work when it would pass the cap on pictures, or,
        // where nothing can shrink it, the bytes it would be sent at.
        if (sent.length && pictures + images.length > MAX_PICTURES_PER_CALL) break;
        if (sent.length && !env.IMAGES && bytes + images.reduce((n, i) => n + i.stored, 0) > MAX_PDF_ANSWER_BYTES) break;
        pictures += images.length;
        const ready: Array<{ data: Uint8Array; mimeType: string; sent: Record<string, unknown> }> = [];
        const failed: string[] = [];
        for (const image of images) {
          const pic = await pdf.picture(image);
          if (!pic.ok) {
            failed.push(pic.reason);
            continue;
          }
          const out = await pagePicture(pic, edge);
          if ('reason' in out) failed.push(out.reason);
          else ready.push(out);
        }
        const size = ready.reduce((n, r) => n + r.data.byteLength, 0);
        if (sent.length && bytes + size > MAX_PDF_ANSWER_BYTES) break;
        through = page;
        bytes += size;
        if (failed.length) {
          notSent.push({
            page,
            reason:
              (images.length > 1 ? `${failed.length} of its ${images.length} pictures could not be sent: ` : 'its picture could not be sent: ') +
              [...new Set(failed)].join('; '),
          });
        }
        if (!ready.length) continue;
        content.push({ type: 'text', text: `Page ${page} of ${total}` + (rotate ? ` (shown turned ${rotate}° clockwise)` : '') });
        for (const r of ready) {
          content.push({ type: 'image', data: toBase64(r.data), mimeType: r.mimeType });
          sent.push({ page, ...(rotate ? { turned: rotate } : {}), ...r.sent });
        }
      }

      if (!sent.length) {
        return toolError(
          `Nothing on page${from === through ? ` ${from}` : `s ${from} to ${through}`} could be sent: ` +
            notSent.map((n) => `page ${n.page}: ${n.reason}`).join('. ') +
            '.' +
            (through < total ? ` Pages ${through + 1} to ${total} may still be readable.` : '') +
            autofill,
        );
      }
      // What becomes of what the assistant reads: recorded, or not, and why not.
      const recordable = row.read !== 'text' && !row.unread;
      const record =
        row.read === 'text'
          ? 'Its text layer is in get_attachment_text, and set_attachment_text does not replace it: what you read of these pages is for you to use.'
          : row.unread
            ? 'Its text layer has not been read yet, and set_attachment_text takes nothing for it until it has been; ' +
              'get_attachment_text says when, and if the layer comes back empty, record what you read then.'
            : 'Record what you read with set_attachment_text under this filename, so it is searchable and the next session has it.';
      const next =
        (through < total
          ? `Pages ${through + 1} to ${total} were not sent; ask for pages "${through + 1}-${Math.min(through + PAGES_PER_CALL, total)}" next` +
            (recordable ? ', and read them all before recording, since set_attachment_text takes the text of the whole file. ' : '. ')
          : 'That was the last page. ') +
        (through < total && recordable ? '' : `${record} `) +
        (sent.some((s) => s.turned)
          ? 'A page marked "turned" is shown rotated in the PDF; its picture is sent as scanned, so its text may run sideways. '
          : '') +
        (sent.some((s) => s.downscaled) && edge < LARGEST_MAX_EDGE
          ? `If small print is not legible, ask again with maxEdge ${LARGEST_MAX_EDGE}.`
          : '');
      content.push({
        type: 'text',
        text: JSON.stringify(
          { filename: row.filename, contentType: row.content_type, size: row.size, pages: total, sent, notSent, next: next.trim() },
          null,
          2,
        ),
      });
      return { content };
    });
  };

  /**
   * One picture taken out of a PDF, made ready to send as `get_attachment` sends a picture:
   * shrunk to the edge where the instance can and it is larger, otherwise as it is when it is
   * small enough. Its size is known from the PDF, so nothing is read from its header.
   */
  const pagePicture = async (
    pic: { bytes: Uint8Array; contentType: 'image/jpeg' | 'image/png'; width: number; height: number },
    edge: number,
  ): Promise<{ data: Uint8Array; mimeType: string; sent: Record<string, unknown> } | { reason: string }> => {
    const size = pic.bytes.byteLength;
    const within = pic.width <= edge && pic.height <= edge;
    if (env.IMAGES && (!within || size > MAX_MCP_IMAGE_BYTES) && size <= MAX_DOWNSCALE_INPUT_BYTES) {
      try {
        const small = await downscale(env.IMAGES, new Response(pic.bytes).body!, edge);
        if (small.bytes.byteLength <= MAX_MCP_IMAGE_BYTES) {
          return {
            data: new Uint8Array(small.bytes),
            mimeType: small.contentType,
            sent: { contentType: small.contentType, width: small.width, height: small.height, bytes: small.bytes.byteLength, maxEdge: edge, downscaled: true },
          };
        }
      } catch (err) {
        console.warn(`[mcp] get_attachment could not shrink a PDF page of ${size} bytes`, err);
      }
    }
    if (size <= MAX_MCP_IMAGE_BYTES) {
      return {
        data: pic.bytes,
        mimeType: pic.contentType,
        sent: { contentType: pic.contentType, width: pic.width, height: pic.height, bytes: size, downscaled: false },
      };
    }
    const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return { reason: `it is ${mb(size)}, over the ${mb(MAX_MCP_IMAGE_BYTES)} this tool sends, and could not be shrunk here` };
  };

  server.registerTool(
    'get_attachment',
    {
      title: 'See a picture or a scan',
      description:
        'The picture itself, returned as an image for you to read: a JPEG, PNG, GIF or WebP ' +
        (shrinks
          ? `attachment, no larger than ${DEFAULT_MAX_EDGE} px on its longest side (the size your model reads ` +
            `at; a larger picture is sent as a JPEG copy) unless you ask for up to ${LARGEST_MAX_EDGE} with maxEdge. `
          : 'attachment under about 3.7 MB. ') +
        'For a picture that get_attachment_text, get_note or a ' +
        'summary reports as "pending": nothing on this instance reads a picture on its own' +
        (vision
          ? '; an Auto-fill press by the person does, and so can you. '
          : '; this instance has no vision model, so you are the only reader it has. ') +
        'Read it, then record what you read with set_attachment_text under the same filename, so search, the ' +
        'summaries and the next session have it without looking again. The bytes come to ' +
        'you and to no model the instance runs. A scanned PDF with no text layer comes as ' +
        `its pages, one image each, up to ${PAGES_PER_CALL} a call (ask for more with pages): the ` +
        'pictures the scanner stored, taken out of the file, so a page the PDF shows turned is ' +
        'sent as scanned and the answer says how it is turned. Read every page before you ' +
        'record, since set_attachment_text takes the whole file. A PDF with a text layer, or one ' +
        "the instance's model has read, is not returned: get_attachment_text has its text. Ask " +
        'for pages by number only for scanned pages a layer leaves out, like those behind a typed cover sheet.',
      inputSchema: z.object({
        noteId: z.string().uuid(),
        filename: z.string().min(1).describe('As listed by get_note.'),
        maxEdge: z
          .number()
          .int()
          .min(SMALLEST_MAX_EDGE)
          .max(LARGEST_MAX_EDGE)
          .optional()
          .describe(
            `The longest side to send, in pixels; ${DEFAULT_MAX_EDGE} when not given. Ask for ${LARGEST_MAX_EDGE} ` +
              'when small print was not legible at the default. Ignored where the instance cannot shrink a picture.',
          ),
        pages: z
          .string()
          .regex(/^\s*\d+\s*(-\s*\d+\s*)?$/, 'a page or a range, like "3" or "6-10"')
          .optional()
          .describe(
            `For a scanned PDF: the page or range of pages to send, like "3" or "6-10", counting from 1. ` +
              `The first ${PAGES_PER_CALL} when not given, and at most ${PAGES_PER_CALL} a call; the answer says what to ask for next.`,
          ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ noteId, filename, maxEdge, pages }) => {
      // Scoped to the caller's store, so another person's note reads as missing; and
      // never from the trash, like every other read of a file that is not a page load.
      // With how its text came to be, in the same call, which a scan's pages are decided by.
      const row = await repos.attachments.resolveWithRead(noteId, filename, vision);
      if (!row) return notFound('attachment', `${filename} on note ${noteId}`);
      if (row.content_type === 'application/pdf') return scanPages(row, maxEdge ?? DEFAULT_MAX_EDGE, pages);
      if (!LLM_IMAGE_TYPES.has(row.content_type)) {
        return toolError(
          `Only a picture or a scanned PDF is returned; this file is ${row.content_type}. Nothing on this instance reads it.`,
        );
      }
      const missing = () => toolError('The bytes of this file could not be found; try again later.');
      const answer = (data: string, mimeType: string, sent: Record<string, unknown>, next: string) => ({
        content: [
          { type: 'image' as const, data, mimeType },
          {
            type: 'text' as const,
            text: JSON.stringify(
              { filename: row.filename, contentType: row.content_type, size: row.size, sent, next },
              null,
              2,
            ),
          },
        ],
      });
      const record =
        'Record what you read with set_attachment_text under this filename, so it is searchable and the ' +
        'next session has it.';

      const edge = maxEdge ?? DEFAULT_MAX_EDGE;
      const original = (bytes: ArrayBuffer) => {
        // Sent as what the bytes are, not as what the upload called them; see
        // `sniffMediaType`. A PNG stored as `image/jpeg` (Evernote's snapshots are) is
        // refused by the model's API under the wrong type, and the refusal can stay in the
        // assistant's conversation. Bytes that are none of the four (a HEIC a client called
        // a JPEG, a truncated upload) are refused here for the same reason rather than sent
        // under a type they are not. A shrunk copy never had this problem: it is a JPEG.
        const mimeType = sniffMediaType(bytes);
        if (!mimeType || !LLM_IMAGE_TYPES.has(mimeType)) {
          return toolError(
            `This file is stored as ${row.content_type}, but its bytes are not a JPEG, PNG, GIF or WebP, ` +
              'so it cannot be returned. The person could attach it again as one of those.',
          );
        }
        const size = pictureSize(bytes);
        return answer(
          toBase64(bytes),
          mimeType,
          {
            contentType: mimeType,
            width: size?.width ?? null,
            height: size?.height ?? null,
            bytes: row.size,
            downscaled: false,
          },
          record,
        );
      };

      // A picture small enough to send as it is goes as it is when its header says it is
      // already within the edge: shrinking would only re-encode it, spending a
      // transformation and softening its text with JPEG's ringing for nothing. A GIF's or a
      // WebP's size is not read, so those go through the binding where there is one.
      let bytes: ArrayBuffer | null = null;
      if (row.size <= MAX_MCP_IMAGE_BYTES) {
        const object = await env.BLOBS.get(row.r2_key);
        if (!object) return missing();
        bytes = await object.arrayBuffer();
        const size = pictureSize(bytes);
        if (!env.IMAGES || (size && size.width <= edge && size.height <= edge)) return original(bytes);
      }

      // Anything else is shrunk where the instance can: the model would shrink it to this
      // edge anyway, so the rest is bytes in transit and in the assistant's context for
      // nothing. A failure falls through to the original, which is still sent when it is
      // small enough.
      //
      // Why it was not shrunk, for the refusal: the binding refused it (a file that is not
      // a picture after all, the free plan's month used up), or the JPEG it made was still
      // over the cap, which a smaller edge would cure where waiting would not.
      let shrinkFailed: 'refused' | 'too large' | null = null;
      if (env.IMAGES && row.size <= MAX_DOWNSCALE_INPUT_BYTES) {
        // The bytes already read, or a stream straight from R2 for a picture too large to
        // send, which the isolate then never holds whole.
        let body: ReadableStream<Uint8Array>;
        if (bytes) body = new Response(bytes).body!;
        else {
          const object = await env.BLOBS.get(row.r2_key);
          if (!object) return missing();
          body = object.body;
        }
        try {
          const small = await downscale(env.IMAGES, body, edge);
          // Never past the cap the original is held to, though at these edges a JPEG
          // comes to a few hundred kilobytes and never near it.
          if (small.bytes.byteLength <= MAX_MCP_IMAGE_BYTES) {
            return answer(
              toBase64(small.bytes),
              small.contentType,
              {
                contentType: small.contentType,
                width: small.width,
                height: small.height,
                bytes: small.bytes.byteLength,
                maxEdge: edge,
                downscaled: true,
              },
              `This is a JPEG copy no larger than ${edge} px on its longest side; the file itself is unchanged. ` +
                record +
                (edge < LARGEST_MAX_EDGE
                  ? ` If small print is not legible, ask again with maxEdge ${LARGEST_MAX_EDGE}.`
                  : ''),
            );
          }
          shrinkFailed = 'too large';
        } catch (err) {
          console.warn(`[mcp] get_attachment could not shrink ${row.content_type} of ${row.size} bytes`, err);
          shrinkFailed = 'refused';
        }
      }

      if (bytes) return original(bytes);

      const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;
      // Says what would get it read, which depends on why it could not be shrunk.
      const why = !env.IMAGES
        ? 'This instance has no Images binding to shrink it with.'
        : shrinkFailed === 'too large'
          ? `Shrunk to ${edge} px it was still larger than that` +
            (edge > SMALLEST_MAX_EDGE ? '; ask again with a smaller maxEdge.' : '.')
          : shrinkFailed === 'refused'
            ? 'Shrinking it failed on this instance.'
            : `It is also over the ${mb(MAX_DOWNSCALE_INPUT_BYTES)} this instance can shrink.`;
      return toolError(
        `This picture is ${mb(row.size)}, over the ${mb(MAX_MCP_IMAGE_BYTES)} this tool returns as it is. ${why} ` +
          (vision && readableByLlm(row.content_type, row.size)
            ? 'An Auto-fill press on the note reads it on the instance.'
            : 'The person could attach a smaller copy of it for you to read.'),
      );
    },
  );

  server.registerTool(
    'set_attachment_text',
    {
      title: 'Record what you read off a file',
      description:
        "Record the text of a file you have read yourself, usually a picture or a scan's pages " +
        'from get_attachment, so search, the summaries on get_note and list_notes, and ' +
        'get_attachment_text have it. Write what the file says, not what you make of it: ' +
        'a short first line naming it, a line saying what it is and shows (who it is from, ' +
        'the amounts, the dates), a blank line, then every legible word transcribed in ' +
        'reading order; for a scan of several pages, every page in order, in one call. Allowed ' +
        'where the file has no text, an empty row (a scanned PDF whose layer was read and was empty), or text you ' +
        "recorded before, which you may revise; refused over a PDF's own text layer or what " +
        "the instance's vision model read, since neither is yours to replace. What you " +
        'record is marked as yours (read "assistant")' +
        (vision
          ? ', and for a picture or a scan the next time the person presses Auto-fill on the ' +
            'note the instance has its model read the file itself and replaces it, so write ' +
            'it for search in the meantime, not as the last word. If the model declines the ' +
            'file, your words stay and it is offered again on later presses. For any other ' +
            'kind of file what you record stands.'
          : '. This instance has no vision model, so what you record is the text the file ' +
            'will have: write it as carefully as the file deserves.'),
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
          case 'unread':
            return toolError(
              "This PDF's text layer has not been read yet. It is read for free; once it has been, get_attachment_text " +
                'has it, and if the layer is empty (a scan), what you read can be recorded here then.',
            );
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
        // The stored name, which a loose match may not have been asked with.
        filename: result.filename,
        read: 'assistant',
        chars: trimmed.length,
        note: vision
          ? 'Recorded. The next Auto-fill press on this note has the model read the file itself and replaces this.'
          : 'Recorded. This instance has no vision model, so this is the text the file has.',
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
        'another system, read that system for a download link (usually a signed URL that ' +
        'is valid for an hour or so) and pass it here. Only http and https can be fetched; ' +
        'a file: or other internal reference is not a download link. For a picture or file ' +
        'found on a web page, pass that page as referer: the request is made as a browser on ' +
        'that page would make it, which some hosts require. Give a filename when ' +
        'you know a better one than the URL offers, since download URLs often end in a ' +
        'generic name like upload.pdf. The result carries the filename the file was stored ' +
        'under (suffixed if the note already had one by that name), its relative path, and ' +
        'the exact Markdown that shows it in the note. By default that Markdown is appended ' +
        'to the end of the body; pass link false and place it yourself with edit_note when ' +
        'it belongs somewhere in particular. A PDF becomes searchable once its text is ' +
        'extracted, which happens in the background. For a file with no URL (one on your ' +
        'own disk or in your sandbox), use prepare_attachment_upload instead. If the host ' +
        'refuses this server (401, 403 or 429), fetch the file yourself (in a browser tab ' +
        "with the file's own URL open, or with your own tools) and send the bytes with " +
        'prepare_attachment_upload, whose URL accepts a PUT from any origin. The answer ' +
        'also carries url, the note in Unbent: give it to the person as a link.',
      inputSchema: z.object({
        noteId: z.string().uuid(),
        url: z.string().min(1).max(8192).describe('An http or https URL the file can be fetched from.'),
        referer: z
          .string()
          .min(1)
          .max(8192)
          .optional()
          .describe(
            "The address of the page the file was found on, such as a product page. Without it no page is named.",
          ),
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
    async ({ noteId, url: raw, referer: rawReferer, filename, link }) => {
      // Ownership first, before a byte is fetched: nothing is downloaded for a caller who
      // has no note to put it on, and a note that is not theirs reads as missing.
      if (!(await repos.attachments.ownsNote(noteId))) return notFound('note', noteId);

      const checked = checkSourceUrl(raw, { allowLoopback });
      if ('error' in checked) return toolError(checked.error);
      await pastFree();
      const referer = rawReferer === undefined ? undefined : checkReferer(rawReferer);
      if (referer && 'error' in referer) return toolError(referer.error);

      const source = await fetchSource(checked.url, {
        maxBytes: MAX_ATTACHMENT_BYTES,
        allowLoopback,
        ...(referer ? { referer: referer.url } : {}),
        ...(env.ATTACHMENT_FETCH_USER_AGENT ? { userAgent: env.ATTACHMENT_FETCH_USER_AGENT } : {}),
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
          quota: await quota(),
        });
        return jsonResult({ noteId, url: links.note(noteId), ...stored, linked: link });
      } catch (err) {
        // A transfer that fails midway (the source sent fewer bytes than it declared, say)
        // is the model's to retry, not an exception to end the conversation on.
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
        'the sandbox where you run commands, such as a screenshot the person gave you, or ' +
        "bytes you fetched in a browser tab when add_attachment was refused by the file's " +
        'host. Returns a one-time upload URL. Send the raw bytes to it with an HTTP PUT, for ' +
        'example curl -T "photo.png" "<uploadUrl>", or from a script in a browser, ' +
        "fetch(uploadUrl, { method: 'PUT', body: blob }). The URL accepts requests from " +
        'any origin and needs no cookies or other credentials. In a browser, run it with ' +
        "the file's own URL open in the tab, where no page's scripts can see the upload URL " +
        '(trackers on a shop page can record requests, and claim the URL first); run it on ' +
        'the page the file came from only if the file will not open on its own. The reply ' +
        'to that request is the same ' +
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
      await pastFree();

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
