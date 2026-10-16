import type { LlmTokens } from '@unbent/shared';
import { z } from 'zod';

/**
 * The language model: what reads and writes, where Jev only judges.
 *
 * Two jobs, both things a model that chooses among options cannot do. Reading a file a
 * text layer cannot: a photograph, or a scan that was never OCR'd. Search and auto-fill
 * both read text, and until now the only text an attachment could have was its PDF text
 * layer; a photo of a receipt, a business card, a plate of food or a whiteboard had none.
 * For most photos, what the picture *is* matters more than the words on it: "a business
 * card" is what files it under Contacts, and no line on the card says so. So the model is
 * asked for one fixed shape (a name, a kind, a description, a verbatim transcription),
 * and the whole of it becomes the file's text (see `formatReading`), the same row search
 * indexes and auto-fill reads. Nothing downstream learns a new kind of text.
 *
 * And writing a note's title. Jev can only pick a line off the document, which gets
 * "Invoice #4471"; a model that writes gets "Acme Hardware Invoice, March 2026", which is
 * what a person filing it would have typed. See `title`, and lib/autofill.ts for how the
 * two are combined. The same goes for a text field's value, a few words copied out of a
 * line Jev could only take whole; see `textFields`.
 *
 * Behind a seam (`LanguageModel`) so the model can be swapped: the one implementation is
 * Claude over the Messages API, with the model id an environment variable, and another
 * provider (Workers AI, for a self-hoster who would rather keep images in place) is one
 * more implementation of the same interface. One `fetch` against one endpoint rather than
 * the SDK, as lib/jev.ts and lib/email.ts do, for the Worker's cold start. Reading runs
 * on the server because the bytes are already in R2; see lib/read-attachment.ts.
 */

export const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * The model's three jobs inside a press, each with a model of its own (MAK-182). They cost
 * very different amounts (a read is a whole photo or every page of a scan, a title a few
 * hundred tokens), and an operator may well want a careful reader and a cheap titler, so
 * each job has a variable (`ANTHROPIC_READ_MODEL`, `ANTHROPIC_TITLE_MODEL`,
 * `ANTHROPIC_FIELDS_MODEL`), falling back to `ANTHROPIC_MODEL` and then to the default,
 * so an instance that set the one variable keeps the behaviour it had. The usage counter
 * keys on the model each request named (`LlmUsage.model`), so a split is costed right.
 */
export type LlmJob = 'read' | 'title' | 'fields';

/**
 * The model every job asks when nothing names one: the current Haiku. The default was the
 * most capable current model, Opus 5 at $5 / $25 a million tokens, on the reasoning that a
 * wrong digit in a transcribed total is copied into a field with full confidence. Reading
 * a file is the one call whose cost grows with what people keep, so it was measured, twice
 * (2026-10-09, counts in MAK-182). First on clean generated receipts, which Opus 5, Sonnet
 * 5.5 and Haiku 5.5 all transcribed line for line. Then on 45 files chosen from a real
 * archive for being hard (faded receipts, business cards, handwritten forms, text-less
 * scans, a 22-page lease) against a blind answer key of 261 facts: Haiku 5.5 at low
 * effort read 240 of 243 right, Sonnet 5.5 236 of 236, Opus 5.5 235 of 236, and every
 * setting read every phone, email, merchant and total. The three Haiku misses were on one
 * handwritten form: a word and a date. The notebook Jev then chose from the reading moved
 * on one note in 44. A read costs about 0.1¢ on Haiku, 1.6¢ on Sonnet, 3.3¢ on Opus, and
 * Haiku was the fastest.
 *
 * So the stronger models buy handwriting and nothing else measurable, at sixteen to
 * thirty-three times the price, and Haiku is the default for every job. An operator whose
 * archive is handwriting sets `ANTHROPIC_READ_MODEL=claude-sonnet-5-5` and keeps the
 * title and the fields on Haiku, which they never leave: those two jobs copy words off a
 * reading already made. Haiku's price rises fivefold past a prompt of 100K tokens, which
 * only a scan of fifty-odd pages reaches.
 */
export const LLM_MODEL_DEFAULT = 'claude-haiku-5-5';

/**
 * The effort the read sends when `ANTHROPIC_READ_EFFORT` is unset and the read is on the
 * default model. Measured on the same 45 files: `low` tied `medium` and `high` on facts
 * (240/243 against 234/236 and 233/236), was the fastest (5.3 s median against 6.8 and
 * 7.4) and the cheapest, and was the only setting that finished the 22-page lease before
 * `MAX_TRANSCRIBED_WORDS` was lowered. Thinking harder about a transcription does not
 * change what is on the page.
 *
 * Sent only when the read is on `LLM_MODEL_DEFAULT`, whose parameters this file knows; a
 * model the operator named gets the plain request, since not every model takes the field.
 * The variable overrides that guard, and is what an operator sets beside a Sonnet read:
 * at its default effort Sonnet's thinking alone fills the output budget on a long scan.
 * Any value the API takes is passed through as named, like the model id; a value it does
 * not take is a 400 with the API's own words in it.
 */
export const LLM_READ_EFFORT_DEFAULT = 'low';

/**
 * The title and the fields always send a low effort on the default model, and no effort
 * on a named one, as the read does. Those two are small judgements (one line, a few
 * words copied off a line) and the thinking a capable model would spend on them is paid
 * for and waited on by the press. Not a variable: nothing was measured that would make
 * an operator want it, and the read's variable is enough to steer the one job that costs.
 */
const SMALL_JOB_EFFORT = 'low';

/** What each job sends: the model, and the effort when there is one. */
export interface JobSettings {
  model: string;
  effort?: string;
}

/**
 * Each job's model and effort from the variables, defaults applied; see `LlmJob` and
 * `LLM_READ_EFFORT_DEFAULT` for the rules. Exported so a test can pin what each request
 * names without a fetch, and so an operator's page could show it.
 */
export function jobSettings(env: LlmEnv): Record<LlmJob, JobSettings> {
  const named = (value: string | undefined) => value?.trim() || undefined;
  const shared = named(env.ANTHROPIC_MODEL) ?? LLM_MODEL_DEFAULT;
  const model = (own: string | undefined) => named(own) ?? shared;
  const guarded = (chosen: string, effort: string) => (chosen === LLM_MODEL_DEFAULT ? { effort } : {});

  const read = model(env.ANTHROPIC_READ_MODEL);
  const title = model(env.ANTHROPIC_TITLE_MODEL);
  const fields = model(env.ANTHROPIC_FIELDS_MODEL);
  const readEffort = named(env.ANTHROPIC_READ_EFFORT);
  return {
    read: { model: read, ...(readEffort ? { effort: readEffort } : guarded(read, LLM_READ_EFFORT_DEFAULT)) },
    title: { model: title, ...guarded(title, SMALL_JOB_EFFORT) },
    fields: { model: fields, ...guarded(fields, SMALL_JOB_EFFORT) },
  };
}

/** What the API takes as a picture. An animation loses all but its first frame, which is fine for filing. */
export const LLM_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/**
 * The API caps a base64 image at 10MB, which is about 7.5MB of file; a PDF at 32MB per
 * request and hundreds of pages. The PDF cap here is our own and lower: every page costs
 * a couple of thousand tokens, and a scan that long is a job to run on purpose, not a
 * side effect of an upload.
 */
export const MAX_LLM_IMAGE_BYTES = 7 * 1024 * 1024;
export const MAX_LLM_PDF_BYTES = 8 * 1024 * 1024;

/**
 * Room for a long transcription. A scan of many pages can run to thousands of words, and
 * on a model that thinks by default the thinking shares this budget with the answer.
 */
const MAX_OUTPUT_TOKENS = 16384;

/**
 * Where a transcription stops, in words, for a document longer than that: the model ends
 * with a line saying the rest was left out. The part a person files by (who it is from,
 * what it is, the dates and amounts) is nearly always on the first pages.
 *
 * It was ten thousand, which is about thirteen thousand tokens before the JSON around it,
 * and the thinking shares the same `MAX_OUTPUT_TOKENS`. So a long scan never finished: a
 * 22-page lease ran out of room on Haiku 5.5 at medium and high effort, on Sonnet 5.5 and
 * on Opus 5.5 (2026-10-09), after one to two minutes each. A read that runs out of room
 * throws and leaves the file pending, so every later press read the whole scan again and
 * paid for it again: about 46¢ a press on Opus. Four thousand words is about five and a
 * half thousand tokens, which leaves the thinking ten thousand: on the same lease, Haiku
 * 5.5 at medium (the model's own default, which the read sent before MAK-182) now
 * finishes in about half a minute, and Haiku at high and Opus 5.5 finish too.
 *
 * Sonnet 5.5 at its default effort still does not, at four thousand words or at three:
 * its thinking alone fills the budget, so no cap on the answer can fix it. Effort is what
 * does: `ANTHROPIC_READ_EFFORT=low` beside a Sonnet read; see `LLM_READ_EFFORT_DEFAULT`.
 * Lower than four thousand was tried and bought nothing but a shorter transcription.
 */
export const MAX_TRANSCRIBED_WORDS = 4000;

/**
 * The media type a file's bytes actually are, read from their first bytes, or null when
 * they are none of the types the model takes. The stored type is what the upload said,
 * and an upload can be wrong: Evernote's snapshots are PNGs that arrive as `image/jpeg`.
 * The API refuses an image whose bytes do not match the type it is sent as, so a file
 * stored under the wrong type failed on every press and could never be read (three of 45
 * pictures in a sample of the real corpus, 2026-10-09).
 */
export function sniffMediaType(bytes: ArrayBuffer): string | null {
  const b = new Uint8Array(bytes.slice(0, 12));
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (ascii(0, 4) === 'GIF8') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(0, 5) === '%PDF-') return 'application/pdf';
  return null;
}

/**
 * A title is a few dozen tokens, and this is far more than that on purpose: the default
 * model thinks before it answers, that thinking is counted against the same budget, and
 * a title that spent the whole of a small budget thinking would come back with no answer
 * at all, which reads as a decline, and falls back to Jev's pick without a word.
 */
const MAX_TITLE_TOKENS = 1024;

/** A long scan takes a while to read; this is for an outage, not a slow page. */
const TIMEOUT_MS = 120_000;
/**
 * A title is one line, and the press that asked for it is waiting. The call runs beside
 * both of Jev's rounds, but the press answers only once it has settled, so under the
 * reading's two minutes a stuck model held the notebook, tags and fields Jev had already
 * answered for as long (MAK-175). Giving up costs only the better title: Jev's pick of a
 * line stands. Per attempt, so with the one retry the worst case is twice this and the
 * pause.
 */
const TITLE_TIMEOUT_MS = 20_000;
/**
 * The text fields' call is as short. It starts only once Jev has chosen the notebook, so
 * unlike the title it overlaps one round rather than two, and the press waits for it.
 * Giving up costs only the written values, which leaves Jev's picks standing.
 */
const FIELDS_TIMEOUT_MS = 20_000;

/** Retried once, after a pause: the statuses the API documents as retryable. */
const RETRY_STATUSES = new Set([429, 500, 529]);
const RETRY_AFTER_MS = 2000;

export interface LlmEnv {
  /** `wrangler secret put ANTHROPIC_API_KEY`; in dev it comes from .dev.vars. */
  ANTHROPIC_API_KEY?: string;
  /** Where the requests go instead of Anthropic, for a stand-in during development. */
  ANTHROPIC_API_URL?: string;
  /** The model every job asks unless its own variable names one; see `LLM_MODEL_DEFAULT`. */
  ANTHROPIC_MODEL?: string;
  /** The model that reads a note's pictures and text-less scans; see `LlmJob`. */
  ANTHROPIC_READ_MODEL?: string;
  /** The model that writes the title. */
  ANTHROPIC_TITLE_MODEL?: string;
  /** The model that writes the text fields' values. */
  ANTHROPIC_FIELDS_MODEL?: string;
  /** The effort the read sends, whatever its model; see `LLM_READ_EFFORT_DEFAULT`. */
  ANTHROPIC_READ_EFFORT?: string;
}

/** Whether this instance has a language model at all. The key alone decides. */
export function canUseLlm(env: LlmEnv): boolean {
  return Boolean(env.ANTHROPIC_API_KEY?.trim());
}

/** Whether a file is one the vision model would be handed: a picture or a PDF, under the caps. */
export function readableByLlm(contentType: string, size: number): boolean {
  if (LLM_IMAGE_TYPES.has(contentType)) return size <= MAX_LLM_IMAGE_BYTES;
  if (contentType === 'application/pdf') return size <= MAX_LLM_PDF_BYTES;
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

/** A note as the model is shown it for a title: what it says, and what its files say. */
export interface NoteForTitle {
  /** The title it has now, which the model is told to keep when it already fits. */
  title: string;
  body: string;
  attachments: Array<{ filename: string; text: string }>;
}

/**
 * What one request cost, as the API reports it in `usage`, and which model it was asked
 * of (MAK-180). Tokens, never dollars: the price of a token is the model's and changes,
 * so the counter keeps what was used and the model that used it, and anything that shows
 * a price converts at display.
 *
 * The four counts are the API's own split. All three kinds of input are billed, at
 * different rates (a cache read at a tenth, a cache write at a premium), which is why
 * they are kept apart rather than summed here.
 */
export type LlmUsage = LlmTokens;

/** A job's answer and what asking for it cost. */
export interface Metered<T> {
  value: T;
  usage: LlmUsage;
}

/**
 * What a caller asks of the model, so a test can hand in a stand-in and another model can
 * take its place.
 *
 * Every job answers with its usage beside its value, so the caller that records the value
 * records the cost in the same breath (a reading's tokens go into the transaction that
 * writes its text), and a stand-in reports usage the way the real model does, which is
 * what lets a test count a press. A callback handed to `llmFrom` was the alternative and
 * was not taken: it would count only what the one real implementation counted.
 */
export interface LanguageModel {
  /** Null when the model declined to read the file, which is recorded so it is not asked again. */
  read(file: { filename: string; contentType: string; bytes: ArrayBuffer }): Promise<Metered<FileReading | null>>;
  /** The title a careful person would give the note. Null when the model declined. */
  title(note: NoteForTitle): Promise<Metered<string | null>>;
  /**
   * The values of a notebook's text fields, as the note writes them: by each field's
   * `key`, `''` where the note does not say. Null when the model declined. Only text
   * fields: see `textFieldValues` in lib/autofill.ts for why the rest stay Jev's.
   */
  textFields(note: NoteForTitle, fields: Array<{ key: string; name: string }>): Promise<Metered<Record<string, string> | null>>;
}

/**
 * The API refused or failed. `status` is HTTP's, or 0 when no answer arrived at all.
 *
 * `usage` is set when the API answered and billed for it but the answer could not be
 * used: a reply cut off at the token budget, the dearest kind there is, since it spent
 * the whole budget. A caller that counts what a press cost counts this too (`PressUsage.failed`
 * in lib/llm-usage.ts); an error with no usage cost nothing.
 */
export class LlmError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly usage?: LlmUsage,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/**
 * Whether a failure is a standing misconfiguration rather than a passing outage: a key
 * the model rejected (401), or one not permitted to use the model or endpoint (403).
 *
 * The line matters because the two want opposite handling. A 401/403 fails every call
 * until an operator changes a secret, and the caller that swallows it (auto-fill, whose
 * title has a fallback) should say so where the operator can see it. A 429, a 5xx, a
 * timeout (`status` 0) or a refusal is a reason to fall back quietly and let the next
 * press succeed; surfacing those would cry wolf. Only the callers that swallow the error
 * consult this; a caller that already surfaces its `LlmError` needs no help telling them
 * apart.
 */
export function isLlmAuthError(err: unknown): boolean {
  return err instanceof LlmError && (err.status === 401 || err.status === 403);
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
 * the answer is parsed rather than validated, except that a refusal comes back as prose
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
  '- name: one short line a person would title the note with, the way a folder label',
  '  reads: what it is and who or what it is from or about, ending with the kind word',
  '  when that helps it read as one. Name the party the file is from or about, the one',
  '  whose document it is, not a middleman who only handled or printed it: not a payment',
  '  network or card brand on a receipt, not the concession operator behind a counter, not',
  '  the software that generated a form. When a file shows both a parent brand and the',
  '  specific place, shop or provider that served this one, name the specific one. The',
  '  kinds above are common but not the whole of it, so title from what this file is, not',
  '  a fixed list. For example "Sushi A Go Go receipt", "Jane Doe, Acme Plumbing',
  '  (business card)".',
  '- description: one or two sentences saying what it shows and the facts someone filing',
  '  it would want: the business or provider, the dish, the product, the vehicle, the',
  '  amounts, the dates, the people by role. Never identify a person from their face.',
  '- text: every piece of legible text, transcribed exactly as written and in reading',
  '  order, one line per line of the original, with no commentary. For a document of',
  '  several pages, every page in order. Empty when there is no text. If the text runs',
  `  past about ${MAX_TRANSCRIBED_WORDS.toLocaleString('en-US')} words, stop there and end with a line saying`,
  '  the rest was left out.',
].join('\n');

const TITLE_SYSTEM = [
  'You title notes in a personal archive: scans, photographs and notes someone kept. You',
  'are shown the note (the title it has now, its body, and the text of its files) and',
  'you answer with the title a careful person would give it: what it is and who or what it',
  'is from or about, the way a label on a folder reads. For example "Acme Hardware Invoice,',
  'March 2026", "Jane Doe, Acme Plumbing (Business Card)", "Sushi A Go Go Receipt", "Lasagna',
  'at Luigi\u2019s", "Roof Quote From Summit Roofing".',
  '',
  'Short, under about sixty characters, in title case, with no quotation marks and no full',
  'stop. Keep an acronym or a brand in its own capitals: "IRS", "LLC", "iPhone". Use only',
  'what the note says: never invent a name, a date or an amount. Name the party a file is',
  'from or about, not a middleman that only handled or printed it: a payment network, a',
  'concession operator, the parent brand over the specific place that served this one. If',
  'the title the note has now already names it well, answer with that title exactly as it',
  'is.',
].join('\n');

const TITLE_SCHEMA = {
  type: 'object',
  properties: { title: { type: 'string' } },
  required: ['title'],
  additionalProperties: false,
} as const;

const titled = z.object({ title: z.string() });

const FIELDS_SYSTEM = [
  'You fill in fields on notes in a personal archive: scans, photographs and notes someone',
  'kept. You are shown the note (its title, its body and the text of its files) and the',
  'names of some fields. For each field, answer with its value exactly as the note writes',
  'it: the value alone, without the label before it or the words around it. For a field',
  'named "Vendor" on a receipt that says "Thank you for shopping at Acme Hardware Store',
  '#12", the value is "Acme Hardware"; for "Order number" beside "Order #: 112-0042", it is',
  '"112-0042".',
  '',
  'Copy the value from the note; never write one it does not contain. Name the party a',
  'document is from, not a middleman that only handled it: a payment network, a card',
  'brand, the software that printed it. When the note does not say, or you are not sure',
  'which of several it means, answer with an empty string. An empty field is better than',
  'a wrong one.',
].join('\n');

/** Text field values are short; a model that answers with a paragraph is cut, then checked. */
const MAX_FIELD_CHARS = 200;

/**
 * A title's room, for the thinking that shares the budget, plus room for each value at
 * its longest. A business-card notebook has eight or ten text fields, and a budget sized
 * for one title would run out on it and leave every one of them to Jev.
 */
export function fieldTokens(count: number): number {
  return MAX_TITLE_TOKENS + count * Math.ceil(MAX_FIELD_CHARS / 2);
}

/** Titles have a length in the shared schema; a model that ignores "short" is cut, not refused. */
const MAX_TITLE_CHARS = 200;

/**
 * A count the API may leave out or send as null (the cache counts on a request that
 * touched no cache, or a stand-in that says nothing of usage) read as zero rather than
 * failing an answer whose text is fine. So is a count of any other shape (`catch`):
 * usage was never parsed before it was counted, and a reading must not be lost to it.
 */
const tokens = z.number().int().nonnegative().nullish().transform((n) => n ?? 0).catch(0);

const answer = z.object({
  stop_reason: z.string().nullable().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  usage: z
    .object({
      input_tokens: tokens,
      output_tokens: tokens,
      cache_read_input_tokens: tokens,
      cache_creation_input_tokens: tokens,
    })
    .nullish(),
});

/** Chunked, because `String.fromCharCode(...bytes)` overflows the call stack on a photo. Shared with MCP's `get_attachment`. */
export function toBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function llmFrom(env: LlmEnv, fetchImpl: typeof fetch = fetch): LanguageModel {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error('Refusing to build a vision client without a key');
  const url = env.ANTHROPIC_API_URL?.trim() || ANTHROPIC_API_URL;
  const jobs = jobSettings(env);

  async function post(body: string, timeout: number): Promise<Response> {
    try {
      return await fetchImpl(url, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey!,
          'anthropic-version': ANTHROPIC_VERSION,
          'Content-Type': 'application/json',
        },
        body,
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      throw new LlmError(0, `Could not reach the language model: ${(err as Error).message}`);
    }
  }

  /**
   * One request, answered with the text the model wrote, or null when it declined, and
   * what the request cost either way.
   *
   * A refusal carries its own stop reason, and a refusal under structured output can also
   * arrive as prose where the JSON should be; the callers' parse failures mean the same.
   * Both are "declined", and a file the model declines once it would decline again, so
   * the callers record that rather than retry it. A decline is still billed for the input
   * it read, so its usage comes back with it.
   *
   * Only the answer that was kept is counted. A retried 429 or 5xx is not billed, and an
   * error status carries no usage to count.
   */
  async function ask(job: LlmJob, body: string, timeout = TIMEOUT_MS): Promise<Metered<string | null>> {
    const { model } = jobs[job];
    let res = await post(body, timeout);
    if (RETRY_STATUSES.has(res.status)) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_AFTER_MS));
      res = await post(body, timeout);
    }
    if (!res.ok) {
      // The body says why (a bad key, a model this key cannot use, a file too large)
      // and the status alone does not. Truncated because this ends up in a log.
      const detail = (await res.text().catch(() => '')).trim().slice(0, 200);
      throw new LlmError(res.status, `The language model answered ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    const parsed = answer.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new LlmError(0, 'The language model answered with nothing this code can read');
    const used = parsed.data.usage;
    const usage: LlmUsage = {
      model,
      inputTokens: used?.input_tokens ?? 0,
      outputTokens: used?.output_tokens ?? 0,
      cacheReadTokens: used?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: used?.cache_creation_input_tokens ?? 0,
    };
    if (parsed.data.stop_reason === 'refusal') return { value: null, usage };
    // Cut off, not declined: the answer is missing or truncated. Recording that as a
    // decline would file a half-read scan as empty for good, so it is an error instead,
    // which leaves the file pending and the title to Jev's pick, and is logged either way.
    if (parsed.data.stop_reason === 'max_tokens') {
      throw new LlmError(0, 'The language model ran out of room before it finished answering', usage);
    }
    return { value: parsed.data.content.find((c) => c.type === 'text')?.text ?? null, usage };
  }

  return {
    async read(file) {
      const data = toBase64(file.bytes);
      // Sent as what the bytes are, not as what the upload called them; see `sniffMediaType`.
      const mediaType = sniffMediaType(file.bytes) ?? file.contentType;
      // A PDF is a document, a picture an image; the API reads each page of a document
      // as text and as an image, so a scan with no text layer reads the same as a photo.
      const source = { type: 'base64', media_type: mediaType, data };
      const block =
        mediaType === 'application/pdf'
          ? { type: 'document', source }
          : { type: 'image', source };

      const body = JSON.stringify({
        model: jobs.read.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: SYSTEM,
        // The file before the words about it, which is the order the docs recommend.
        messages: [
          {
            role: 'user',
            content: [block, { type: 'text', text: `Read this file, which is called "${file.filename}".` }],
          },
        ],
        output_config: {
          // An explicit effort, low by default: thinking harder about a transcription
          // does not change what is on the page, and the thinking shares the output
          // budget with a long one. See `LLM_READ_EFFORT_DEFAULT`.
          ...(jobs.read.effort ? { effort: jobs.read.effort } : {}),
          format: { type: 'json_schema', schema: READING_SCHEMA },
        },
      });

      const { value: text, usage } = await ask('read', body);
      if (!text) return { value: null, usage };
      try {
        const result = reading.safeParse(JSON.parse(text));
        return { value: result.success ? result.data : null, usage };
      } catch {
        return { value: null, usage };
      }
    },

    async title(note) {
      const body = JSON.stringify({
        model: jobs.title.model,
        max_tokens: MAX_TITLE_TOKENS,
        system: TITLE_SYSTEM,
        // The note as one JSON object, its parts labelled, the way the docs recommend
        // handing over structured state.
        messages: [{ role: 'user', content: JSON.stringify(note) }],
        output_config: {
          // A title is a small judgement, and the thinking a capable model would spend on
          // it is paid for and waited on. Low effort trims both, but only on the model
          // this file chose, whose parameters it knows; a model the operator named gets
          // the plain request, since not every model accepts the field. `jobSettings`
          // decides.
          ...(jobs.title.effort ? { effort: jobs.title.effort } : {}),
          format: { type: 'json_schema', schema: TITLE_SCHEMA },
        },
      });
      const { value: text, usage } = await ask('title', body, TITLE_TIMEOUT_MS);
      if (!text) return { value: null, usage };
      try {
        const result = titled.safeParse(JSON.parse(text));
        if (!result.success) return { value: null, usage };
        const title = result.data.title.trim().replace(/\s+/g, ' ').slice(0, MAX_TITLE_CHARS);
        return { value: title || null, usage };
      } catch {
        return { value: null, usage };
      }
    },

    async textFields(note, fields) {
      // Nothing asked, nothing sent, nothing spent.
      if (fields.length === 0) return { value: {}, usage: { model: jobs.fields.model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
      // One property per field, keyed by the caller's key rather than the field's name: a
      // name is the owner's to write, and a schema key has rules a name need not follow.
      // The name goes in each property's description, which the model reads.
      const schema = {
        type: 'object',
        properties: Object.fromEntries(
          fields.map((f) => [f.key, { type: 'string', description: `The value of the field "${f.name}"` }]),
        ),
        required: fields.map((f) => f.key),
        additionalProperties: false,
      };
      const body = JSON.stringify({
        model: jobs.fields.model,
        max_tokens: fieldTokens(fields.length),
        system: FIELDS_SYSTEM,
        messages: [
          {
            role: 'user',
            content: JSON.stringify({ note, fields: fields.map((f) => ({ key: f.key, field: f.name })) }),
          },
        ],
        output_config: {
          ...(jobs.fields.effort ? { effort: jobs.fields.effort } : {}),
          format: { type: 'json_schema', schema },
        },
      });
      const { value: text, usage } = await ask('fields', body, FIELDS_TIMEOUT_MS);
      if (!text) return { value: null, usage };
      try {
        const result = z.record(z.string(), z.string()).safeParse(JSON.parse(text));
        if (!result.success) return { value: null, usage };
        const out: Record<string, string> = {};
        for (const f of fields) {
          out[f.key] = (result.data[f.key] ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_FIELD_CHARS);
        }
        return { value: out, usage };
      } catch {
        return { value: null, usage };
      }
    },
  };
}
