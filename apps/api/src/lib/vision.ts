import { z } from 'zod';

/**
 * Reading a file a text layer cannot: a photograph, or a scan that was never OCR'd.
 *
 * Search and auto-fill both read text, and until now the only text an attachment could
 * have was its PDF text layer. A photo of a receipt, a business card, a plate of food or a
 * whiteboard had none, and neither did a scan that skipped OCR. A vision model reads them
 * — and, for most photos, what it says the picture *is* matters more than the words on it:
 * "a business card" is what files it under Contacts, and no line on the card says so.
 *
 * So the model is asked for one fixed shape — a name, a kind, a description, and a verbatim
 * transcription — and the whole of it becomes the file's text (see `formatReading`), the
 * same row search indexes and auto-fill reads. Nothing downstream learns a new kind of
 * text; a photo simply has some now.
 *
 * On the server, because the bytes are already in R2 and every client benefits without
 * doing anything; see lib/read-attachment.ts for where it runs. Behind a seam
 * (`VisionModel`) so the model can be swapped: the one implementation here is Claude over
 * the Messages API, with the model id an environment variable, and a Workers AI reader
 * for a self-hoster who would rather keep images in place would implement the same
 * interface. One `fetch` against one endpoint rather than the SDK, as lib/jev.ts and
 * lib/email.ts do, for the Worker's cold start.
 */

export const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * The model asked when `VISION_MODEL` is unset. The most capable current one rather
 * than the cheapest, because a wrong digit in a transcribed total is copied into a field
 * with full confidence, and the reading of a file happens once; an operator who would
 * rather trade some accuracy for cost sets the variable.
 */
export const VISION_MODEL_DEFAULT = 'claude-opus-5';

/** What the API takes as a picture. An animation loses all but its first frame, which is fine for filing. */
export const VISION_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/**
 * The API caps a base64 image at 10MB, which is about 7.5MB of file; a PDF at 32MB per
 * request and hundreds of pages. The PDF cap here is our own and lower: every page costs
 * a couple of thousand tokens, and a scan that long is a job to run on purpose, not a
 * side effect of an upload.
 */
export const MAX_VISION_IMAGE_BYTES = 7 * 1024 * 1024;
export const MAX_VISION_PDF_BYTES = 8 * 1024 * 1024;

/** Room for a long transcription. A scan of many pages can run to thousands of words. */
const MAX_OUTPUT_TOKENS = 8192;

/** A long scan takes a while to read; this is for an outage, not a slow page. */
const TIMEOUT_MS = 120_000;

/** Retried once, after a pause: the statuses the API documents as retryable. */
const RETRY_STATUSES = new Set([429, 500, 529]);
const RETRY_AFTER_MS = 2000;

export interface VisionEnv {
  /** `wrangler secret put ANTHROPIC_API_KEY`; in dev it comes from .dev.vars. */
  ANTHROPIC_API_KEY?: string;
  /** Where the requests go instead of Anthropic, for a stand-in during development. */
  ANTHROPIC_API_URL?: string;
  /** The model asked; see `VISION_MODEL_DEFAULT`. */
  VISION_MODEL?: string;
}

/** Whether this instance can read images at all. The key alone decides. */
export function canReadImages(env: VisionEnv): boolean {
  return Boolean(env.ANTHROPIC_API_KEY?.trim());
}

/** Whether a file is one the vision model would be handed: a picture or a PDF, under the caps. */
export function readableByVision(contentType: string, size: number): boolean {
  if (VISION_IMAGE_TYPES.has(contentType)) return size <= MAX_VISION_IMAGE_BYTES;
  if (contentType === 'application/pdf') return size <= MAX_VISION_PDF_BYTES;
  return false;
}

/** What the model says about a file. Every part may be empty but the description. */
export interface FileReading {
  /** A short line a person would title the note with. */
  name: string;
  /** What the file is, in a few words: receipt, business card, photo of a meal. */
  kind: string;
  /** What it shows and the facts someone filing it would want. */
  description: string;
  /** Every piece of legible text, verbatim, in reading order. Empty when there is none. */
  text: string;
}

/** What a caller asks of the model, so a test can hand in a stand-in and another model can take its place. */
export interface VisionModel {
  /** Null when the model declined to read the file, which is recorded so it is not asked again. */
  read(file: { filename: string; contentType: string; bytes: ArrayBuffer }): Promise<FileReading | null>;
}

/** The API refused or failed. `status` is HTTP's, or 0 when no answer arrived at all. */
export class VisionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'VisionError';
  }
}

/**
 * The reading as one text, for the row every reader shares.
 *
 * The name first, on a line of its own, because auto-fill offers a file's lines as title
 * candidates and the name is the one line written to be a title. Then the kind and the
 * description together, which is the line search hits when someone types "business
 * card" or "lasagna". Then the transcription, which is what the candidate finders read
 * for dates, amounts and phone numbers, and where a search for a word on the page lands.
 */
export function formatReading(reading: FileReading): string {
  const kind = reading.kind.trim();
  const description = reading.description.trim();
  const about = kind ? `${kind.charAt(0).toUpperCase()}${kind.slice(1)}: ${description}` : description;
  return [reading.name.trim(), about, '', reading.text.trim()].join('\n').trim();
}

/**
 * The shape the model fills in. Constrained decoding on the API's side guarantees it, so
 * the answer is parsed rather than validated — except that a refusal comes back as prose
 * in place of JSON, which is what the parse failure below means.
 */
const READING_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    kind: { type: 'string' },
    description: { type: 'string' },
    text: { type: 'string' },
  },
  required: ['name', 'kind', 'description', 'text'],
  additionalProperties: false,
} as const;

const reading = z.object({
  name: z.string(),
  kind: z.string(),
  description: z.string(),
  text: z.string(),
});

const SYSTEM = [
  'You read files for a personal notes archive so they can be searched and filed. The',
  'file is a photograph, a screenshot or a scanned document that someone kept: a receipt,',
  'a business card, a meal, a product, a whiteboard, a letter, a form, a label.',
  '',
  'Answer in the shape you are given.',
  '- kind: what the file is, in a few plain words, such as "receipt", "business card",',
  '  "photo of a meal", "whiteboard", "product box", "letter", "screenshot".',
  '- name: one short line a person would title the note with, naming what it is and who',
  '  or what it is from or about — a letterhead, a business, a dish, a subject.',
  '- description: one or two sentences saying what it shows and the facts someone filing',
  '  it would want: the business, the dish, the product, the amounts, the dates, the',
  '  people by role. Never identify a person from their face.',
  '- text: every piece of legible text, transcribed exactly as written and in reading',
  '  order, one line per line of the original, with no commentary. For a document of',
  '  several pages, every page in order. Empty when there is no text.',
].join('\n');

const answer = z.object({
  stop_reason: z.string().nullable().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
});

/** Chunked, because `String.fromCharCode(...bytes)` overflows the call stack on a photo. */
function toBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function visionFrom(env: VisionEnv, fetchImpl: typeof fetch = fetch): VisionModel {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error('Refusing to build a vision client without a key');
  const url = env.ANTHROPIC_API_URL?.trim() || ANTHROPIC_API_URL;
  const model = env.VISION_MODEL?.trim() || VISION_MODEL_DEFAULT;

  async function post(body: string): Promise<Response> {
    try {
      return await fetchImpl(url, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey!,
          'anthropic-version': ANTHROPIC_VERSION,
          'Content-Type': 'application/json',
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new VisionError(0, `Could not reach the vision model: ${(err as Error).message}`);
    }
  }

  return {
    async read(file) {
      const data = toBase64(file.bytes);
      // A PDF is a document, a picture an image; the API reads each page of a document
      // as text and as an image, so a scan with no text layer reads the same as a photo.
      const source = { type: 'base64', media_type: file.contentType, data };
      const block =
        file.contentType === 'application/pdf'
          ? { type: 'document', source }
          : { type: 'image', source };

      const body = JSON.stringify({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: SYSTEM,
        // The file before the words about it, which is the order the docs recommend.
        messages: [
          {
            role: 'user',
            content: [block, { type: 'text', text: `Read this file, which is called "${file.filename}".` }],
          },
        ],
        output_config: { format: { type: 'json_schema', schema: READING_SCHEMA } },
      });

      let res = await post(body);
      if (RETRY_STATUSES.has(res.status)) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_AFTER_MS));
        res = await post(body);
      }
      if (!res.ok) {
        // The body says why — a bad key, a model this key cannot use, a file too large —
        // and the status alone does not. Truncated because this ends up in a log.
        const detail = (await res.text().catch(() => '')).trim().slice(0, 200);
        throw new VisionError(res.status, `The vision model answered ${res.status}${detail ? `: ${detail}` : ''}`);
      }

      const parsed = answer.safeParse(await res.json().catch(() => null));
      if (!parsed.success) throw new VisionError(0, 'The vision model answered with nothing this code can read');
      // A refusal carries its own stop reason, and a refusal under structured output can
      // also arrive as prose where the JSON should be. Both mean the model declined, and
      // a file it declines once it would decline again — recorded, not retried.
      if (parsed.data.stop_reason === 'refusal') return null;
      const text = parsed.data.content.find((c) => c.type === 'text')?.text;
      if (!text) return null;
      try {
        const result = reading.safeParse(JSON.parse(text));
        return result.success ? result.data : null;
      } catch {
        return null;
      }
    },
  };
}
