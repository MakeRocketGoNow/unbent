import { describe, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { encodeFieldValue, isRatingField, type AutofillSuggestion, type FieldDef, type FieldValue } from '@unbent/shared';
import {
  autofill,
  dateCandidates,
  EXAMPLES_PER_OPTION,
  findEmails,
  findPhones,
  findUrls,
  MAX_STATE_CHARS,
  MAX_SUGGESTED_TAGS,
  MAX_TAGS_ASKED,
  numberCandidates,
  type AutofillInput,
} from '../src/lib/autofill.js';
import { jevFrom } from '../src/lib/jev.js';
import { ANTHROPIC_API_URL, LLM_MODEL_DEFAULT, llmFrom, type LlmEnv, type LlmUsage } from '../src/lib/llm.js';
import { PressUsage } from '../src/lib/llm-usage.js';
import { titleCase } from '../src/lib/title-case.js';

/**
 * Auto-fill's two shapes, measured against each other on a real sample (MAK-231).
 *
 * Arm `jev` is the press as it ships: Jev chooses the notebook, the tags and every
 * field in two rounds, and the language model writes the title and the text fields
 * beside it (lib/autofill.ts). Arm `onecall` is the alternative that would retire the
 * second vendor: one structured call to the language model that answers all of it at
 * once, with the archive's notebooks and tags in a cached prefix, and the code holding
 * the same line Jev's typed questions hold (a date is one the text writes, a select is
 * one of its options, a text value is something the note says). The question is whether
 * one call is as fast and as right as four, not which prompt is cleverer, so the two
 * arms get the same input and the same scorer.
 *
 * Not a test: nothing here asserts. It runs only when `AUTOFILL_EVAL_SAMPLE` names a
 * directory holding a sample pulled from a real account, which stays outside the
 * repository (the real corpus is private; see AGENTS.md), and it spends real money on
 * both APIs. What it prints is counts; what it writes beside the sample is the per-note
 * detail, for the person running it to read and then delete.
 *
 *   AUTOFILL_EVAL_SAMPLE=/path/to/sample pnpm --filter @unbent/api exec vitest run --project eval
 *
 * `AUTOFILL_EVAL_ARMS` picks arms (`jev`, `onecall`; both by default), and
 * `AUTOFILL_EVAL_LIMIT` caps the notes, for a dry run. The keys come from the
 * environment or from `apps/api/.dev.vars`.
 *
 * The sample directory holds what the MCP tools answer, saved as they answer it:
 *
 *   notebooks.json          list_notebooks
 *   tags.json               list_tags
 *   notes.json              [{ id, notebook, title, body, tags, fields, attachments: [{ filename, read, text }] }]
 *   notebook-examples.json  { [notebook name]: [{ id, title }] }   recent titles per notebook
 *   tag-examples.json       { [tag name]: [{ id, title }] }        recent titles per tag
 *
 * Each note is the question: it goes in with its notebook, tags and field values
 * removed, and with its title removed too when it has a file with text (a scan's title
 * is the model's to write; a link's title is its content), and the answers are scored
 * against what the owner filed. Sample notes are left out of every example list, since
 * a note's own title beside its notebook's name would be the answer.
 */

// --- The sample -------------------------------------------------------------------------

interface SampleNote {
  id: string;
  notebook: string | null;
  title: string;
  body: string;
  tags: string[];
  fields: Record<string, FieldValue | null>;
  attachments: Array<{ filename: string; read: string; text: string | null }>;
}

interface Notebook {
  id: string;
  name: string;
  purpose: string | null;
  fields: FieldDef[];
  examples: string[];
}

interface Sample {
  notes: SampleNote[];
  notebooks: Notebook[];
  tags: Array<{ name: string; examples: string[] }>;
}

function readJson<T>(dir: string, name: string): T {
  return JSON.parse(readFileSync(join(dir, name), 'utf8')) as T;
}

function loadSample(dir: string): Sample {
  const notes = readJson<SampleNote[]>(dir, 'notes.json');
  const sampled = new Set(notes.map((n) => n.id));
  const examplesOf = (rows: Array<{ id: string; title: string }> | undefined) =>
    (rows ?? [])
      .filter((r) => !sampled.has(r.id) && r.title.trim())
      .slice(0, EXAMPLES_PER_OPTION)
      .map((r) => r.title);

  const rawNotebooks = readJson<{
    notebooks: Array<{
      id: string;
      name: string;
      purpose?: string;
      fields: Array<{ id: string; name: string; type: FieldDef['type']; options: string[]; scale?: FieldDef['scale']; currency?: string }>;
    }>;
  }>(dir, 'notebooks.json').notebooks;
  const notebookExamples = readJson<Record<string, Array<{ id: string; title: string }>>>(dir, 'notebook-examples.json');
  const notebooks: Notebook[] = rawNotebooks.map((nb) => ({
    id: nb.id,
    name: nb.name,
    purpose: nb.purpose ?? null,
    fields: nb.fields.map((f, position) => ({
      id: f.id,
      notebookId: nb.id,
      name: f.name,
      type: f.type,
      options: f.options ?? [],
      scale: f.scale ?? null,
      currency: f.currency ?? null,
      position,
    })),
    examples: examplesOf(notebookExamples[nb.name]),
  }));

  const rawTags = readJson<{ tags: Array<{ name: string; count: number }> }>(dir, 'tags.json').tags;
  const tagExamples = readJson<Record<string, Array<{ id: string; title: string }>>>(dir, 'tag-examples.json');
  const tags = rawTags
    .filter((t) => t.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, MAX_TAGS_ASKED)
    .map((t) => ({ name: t.name, examples: examplesOf(tagExamples[t.name]) }));

  return { notes, notebooks, tags };
}

/** The note as the press would see it, less everything the owner filed. */
function inputFor(note: SampleNote, sample: Sample): { input: AutofillInput; titleScored: boolean } {
  const attachments = note.attachments.map((a) => ({
    filename: a.filename,
    // What the press would have: a file read is its text, a file read and empty is
    // nothing, and a file still pending is nothing too, since this harness cannot press.
    text: a.text ?? '',
    readBy: a.read === 'vision' ? ('vision' as const) : null,
  }));
  const titleScored = attachments.some((a) => a.text.trim().length > 0);
  return {
    input: {
      note: { title: titleScored ? '' : note.title, body: note.body, tags: [], notebookId: null },
      attachments,
      notebooks: sample.notebooks,
      tags: sample.tags,
    },
    titleScored,
  };
}

// --- Cost ---------------------------------------------------------------------------------

/** Dollars per million tokens for the default model (claude-haiku-5-5), 2026-10. */
const HAIKU = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 };
/** Jev bills input only; TypeSafe reports no counts, so the request's bytes stand in at four to a token. */
const JEV_PER_MILLION = 0.042;

function llmCents(usage: LlmUsage[]): number {
  let dollars = 0;
  for (const u of usage) {
    dollars +=
      (u.inputTokens * HAIKU.input +
        u.outputTokens * HAIKU.output +
        u.cacheReadTokens * HAIKU.cacheRead +
        u.cacheWriteTokens * HAIKU.cacheWrite) /
      1e6;
  }
  return dollars * 100;
}

// --- Arm: Jev, as the press ships ----------------------------------------------------------

interface Run {
  suggestion: AutofillSuggestion;
  seconds: number;
  cents: number;
  usage: LlmUsage[];
  jevTokens: number;
}

type Env = LlmEnv & { TYPESAFE_API_KEY?: string; TYPESAFE_API_URL?: string };

async function runJev(env: Env, input: AutofillInput): Promise<Run> {
  let jevBytes = 0;
  const jev = jevFrom(env, (url, init) => {
    jevBytes += typeof init?.body === 'string' ? init.body.length : 0;
    return fetch(url, init);
  });
  const usage = new PressUsage();
  const llm = usage.metering(llmFrom(env));
  const started = performance.now();
  const suggestion = await autofill(jev, input, llm);
  await usage.settled();
  const seconds = (performance.now() - started) / 1000;
  const jevTokens = Math.round(jevBytes / 4);
  const used = usage.entries.map((e) => e as LlmUsage);
  return { suggestion, seconds, cents: llmCents(used) + (jevTokens * JEV_PER_MILLION) / 1e4, usage: used, jevTokens };
}

// --- Arm: one call ------------------------------------------------------------------------

const ONE_CALL_SYSTEM = [
  'You file notes in a personal archive: scans, photographs, links and notes someone kept.',
  'You are shown the archive first (its notebooks, each with its purpose, its fields and a',
  'few titles already filed there; and its tags, each with a few titles that carry it), and',
  'then one note: its title if it has one, its body, the text of its files, and the dates,',
  'amounts, addresses and numbers found in that text.',
  '',
  'Answer in the shape you are given.',
  '',
  '- notebook: the one notebook this note belongs in. A notebook\'s purpose, when it has',
  '  one, is its owner\'s own statement of what belongs there and what does not, and it',
  '  decides: a note goes in a notebook only when it fits that purpose, even if the name',
  '  alone would seem to invite it. Answer "none" when no purpose plainly covers the note:',
  '  a note left unfiled is easily filed later, a note filed wrong is not easily found. A',
  '  notebook whose purpose is a catch-all for everything else is where unfiled notes',
  '  already go, so it is never a better answer than "none".',
  '- tags: the tags that plainly fit the content, likeliest first, at most five, and none',
  '  when none plainly does. A tag labels what a note is about or what kind of thing it is;',
  '  do not tag what merely could apply.',
  '- title: the title a careful person would give the note: what it is and who or what it',
  '  is from or about, the way a label on a folder reads. For example "Acme Hardware',
  '  Invoice, March 2026", "Jane Doe, Acme Plumbing (Business Card)", "Sushi A Go Go',
  '  Receipt", "Roof Quote From Summit Roofing". Short, under about sixty characters, in',
  '  title case, no quotation marks, no full stop; keep an acronym or a brand in its own',
  '  capitals. Use only what the note says: never invent a name, a date or an amount. Name',
  '  the party a file is from or about, not a middleman that only handled or printed it. If',
  '  the title the note has now already names it well, answer with that title exactly.',
  '- fields: values for the chosen notebook\'s fields, and only that notebook\'s, each named',
  '  as "Notebook / Field". Copy every value from the note; never write one it does not',
  '  contain, and leave a field out when the note does not say. A date is one of the dates',
  '  listed, as YYYY-MM-DD. An amount or a number is one of the numbers listed. An email,',
  '  a website or a phone is one of those listed. A select is one of its options, exactly,',
  '  and a multi-select one or more of them joined by "; ": choose the option a person',
  '  filing the note would, which the note need not spell out (a country from its city, a',
  '  region from its state, a kind of document from what it is), and leave it out only',
  '  when no option fits. A checkbox is "true" only',
  '  when the document itself says so, and is otherwise left out. A text field is the value',
  '  alone, without its label and without the words around it, exactly as the note writes',
  '  it: for "Vendor" on a receipt that says "Thank you for shopping at Acme Hardware Store',
  '  #12", "Acme Hardware". Never fill a rating: a document has no opinion to read.',
].join('\n');

/** The one shape the model fills in; the code then holds each value to its field's rule. */
function oneCallSchema(sample: Sample, fieldKeys: string[]) {
  return {
    type: 'object',
    properties: {
      notebook: { type: 'string', enum: [...sample.notebooks.map((nb) => nb.name), 'none'] },
      tags: { type: 'array', items: { type: 'string', enum: sample.tags.map((t) => t.name) } },
      title: { type: 'string' },
      fields: {
        type: 'array',
        items: {
          type: 'object',
          properties: { field: { type: 'string', enum: fieldKeys }, value: { type: 'string' } },
          required: ['field', 'value'],
          additionalProperties: false,
        },
      },
    },
    required: ['notebook', 'tags', 'title', 'fields'],
    additionalProperties: false,
  } as const;
}

const fieldKey = (nb: Notebook, f: FieldDef) => `${nb.name} / ${f.name}`;

/** The archive as the model is shown it, the same for every note, so it is cached. */
function archiveBlock(sample: Sample): string {
  return JSON.stringify({
    notebooks: sample.notebooks.map((nb) => ({
      name: nb.name,
      ...(nb.purpose ? { purpose: nb.purpose } : {}),
      fields: nb.fields
        .filter((f) => !isRatingField(f))
        .map((f) => ({
          field: fieldKey(nb, f),
          type: f.type,
          ...(f.options.length > 0 ? { options: f.options } : {}),
          ...(f.currency ? { currency: f.currency } : {}),
        })),
      ...(nb.examples.length > 0 ? { examples: nb.examples } : {}),
    })),
    tags: sample.tags.map((t) => ({ name: t.name, ...(t.examples.length > 0 ? { examples: t.examples } : {}) })),
  });
}

/** The note's text within the press's budget: body first, then each file until it is spent. */
function gather(input: AutofillInput): { note: { title: string; body: string; files: Array<{ filename: string; text: string }> }; text: string } {
  let budget = MAX_STATE_CHARS;
  const take = (text: string, max: number) => {
    const taken = text.slice(0, Math.min(max, budget));
    budget -= taken.length;
    return taken;
  };
  const title = input.note.title.trim();
  const body = take(input.note.body, MAX_STATE_CHARS / 4);
  const files: Array<{ filename: string; text: string }> = [];
  for (const file of input.attachments) {
    const text = take((file.text ?? '').trim(), budget);
    if (text) files.push({ filename: file.filename, text });
  }
  return { note: { title, body, files }, text: [title, body, ...files.map((f) => f.text)].join('\n') };
}

const comparable = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();
const digits = (text: string) => text.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');

/**
 * A written value held to the rule Jev's candidates held it to, under the field's type.
 * Null is "not something the note says", and the field is left empty.
 */
function admit(def: FieldDef, raw: string, text: string): FieldValue | null {
  const value = raw.trim();
  if (!value) return null;
  switch (def.type) {
    case 'date':
      return dateCandidates(text).some((c) => c.key === value) ? value : null;
    case 'number': {
      if (isRatingField(def)) return null;
      const n = Number(value.replace(/[$,\s]/g, ''));
      if (!Number.isFinite(n)) return null;
      return numberCandidates(text).some((c) => c.value === n) ? n : null;
    }
    case 'email':
      return findEmails(text).find((c) => c.key.toLowerCase() === value.toLowerCase())?.value ?? null;
    case 'url':
      return findUrls(text).find((c) => c.key.toLowerCase() === value.toLowerCase())?.value ?? null;
    case 'phone':
      return findPhones(text).find((c) => digits(c.key) === digits(value))?.value ?? null;
    case 'select':
      return def.options.find((o) => o.toLowerCase() === value.toLowerCase()) ?? null;
    case 'multiselect': {
      const picked = value
        .split(/\s*;\s*/)
        .map((v) => def.options.find((o) => o.toLowerCase() === v.toLowerCase()))
        .filter((o): o is string => Boolean(o));
      return picked.length > 0 ? [...new Set(picked)] : null;
    }
    case 'checkbox':
      return value.toLowerCase() === 'true' ? true : null;
    case 'text': {
      if (!/[\p{L}\p{N}]/u.test(value)) return null;
      const escaped = comparable(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const whole = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u');
      return whole.test(comparable(text)) ? value : null;
    }
  }
}

async function runOneCall(env: Env, sample: Sample, input: AutofillInput): Promise<Run> {
  const keyed = new Map<string, { nb: Notebook; def: FieldDef }>();
  for (const nb of sample.notebooks) for (const f of nb.fields) if (!isRatingField(f)) keyed.set(fieldKey(nb, f), { nb, def: f });
  const schema = oneCallSchema(sample, [...keyed.keys()]);
  const corpus = gather(input);
  const payload = {
    note: corpus.note,
    found: {
      dates: dateCandidates(corpus.text).map((c) => ({ date: c.key, asWritten: String(c.description).replace(/^As written: /, '') })),
      numbers: numberCandidates(corpus.text).map((c) => ({ number: c.key, asWritten: String(c.description).replace(/^As written: /, '') })),
      emails: findEmails(corpus.text).map((c) => c.key),
      websites: findUrls(corpus.text).map((c) => c.key),
      phones: findPhones(corpus.text).map((c) => c.key),
    },
  };
  const body = JSON.stringify({
    model: env.ANTHROPIC_MODEL?.trim() || LLM_MODEL_DEFAULT,
    max_tokens: 2048,
    system: [
      { type: 'text', text: ONE_CALL_SYSTEM },
      { type: 'text', text: archiveBlock(sample), cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: JSON.stringify(payload) }],
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
  });

  const started = performance.now();
  const res = await fetch(env.ANTHROPIC_API_URL?.trim() || ANTHROPIC_API_URL, {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY!, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(120_000),
  });
  const seconds = (performance.now() - started) / 1000;
  if (!res.ok) throw new Error(`one call answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const answer = (await res.json()) as {
    stop_reason: string;
    content: Array<{ type: string; text?: string }>;
    usage: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  };
  const usage: LlmUsage = {
    model: LLM_MODEL_DEFAULT,
    inputTokens: answer.usage.input_tokens ?? 0,
    outputTokens: answer.usage.output_tokens ?? 0,
    cacheReadTokens: answer.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: answer.usage.cache_creation_input_tokens ?? 0,
  };
  const suggestion: AutofillSuggestion = { tags: [], fields: [], read: { attachments: [], pending: [] } };
  const text = answer.content.find((c) => c.type === 'text')?.text;
  if (answer.stop_reason !== 'refusal' && text) {
    const out = JSON.parse(text) as { notebook: string; tags: string[]; title: string; fields: Array<{ field: string; value: string }> };
    const target = sample.notebooks.find((nb) => nb.name === out.notebook);
    if (target) suggestion.notebook = { id: target.id, name: target.name, confidence: 1 };
    const known = new Set(sample.tags.map((t) => t.name));
    suggestion.tags = [...new Set(out.tags.filter((t) => known.has(t)))].slice(0, MAX_SUGGESTED_TAGS).map((name) => ({ name, confidence: 1 }));
    const title = out.title.trim().replace(/\s+/g, ' ').slice(0, 200);
    if (title) suggestion.title = { value: titleCase(title) };
    if (target) {
      const seen = new Set<string>();
      for (const { field, value } of out.fields) {
        const hit = keyed.get(field);
        if (!hit || hit.nb.id !== target.id || seen.has(hit.def.id)) continue;
        const admitted = admit(hit.def, value, corpus.text);
        if (admitted === null) continue;
        const encoded = encodeFieldValue(hit.def, admitted);
        if (encoded === null || encoded === 'clear') continue;
        seen.add(hit.def.id);
        suggestion.fields.push({ field: hit.def, value: admitted });
      }
    }
  }
  return { suggestion, seconds, cents: llmCents([usage]), usage: [usage], jevTokens: 0 };
}

// --- Scoring --------------------------------------------------------------------------------

interface Score {
  notebook: 'right' | 'wrong' | 'none';
  tags: { matching: number; extra: number; missed: number };
  /** Counted only when the notebook was right; otherwise every expected value is missed. */
  fields: { expected: number; right: number; wrong: number; missed: number; extra: number };
  title: { scored: boolean; exact: boolean; close: boolean } | null;
}

function same(def: FieldDef, got: FieldValue, want: FieldValue): boolean {
  switch (def.type) {
    case 'number':
      return Number(got) === Number(want);
    case 'checkbox':
      return Boolean(got) === Boolean(want);
    case 'multiselect': {
      const a = new Set((Array.isArray(got) ? got : [String(got)]).map((v) => v.toLowerCase()));
      const b = new Set((Array.isArray(want) ? want : [String(want)]).map((v) => v.toLowerCase()));
      return a.size === b.size && [...a].every((v) => b.has(v));
    }
    case 'phone':
      return digits(String(got)) === digits(String(want));
    default:
      return comparable(String(got)) === comparable(String(want));
  }
}

function score(note: SampleNote, sample: Sample, suggestion: AutofillSuggestion, titleScored: boolean): Score {
  const notebook: Score['notebook'] = !suggestion.notebook ? 'none' : suggestion.notebook.name === note.notebook ? 'right' : 'wrong';

  const want = new Set(note.tags.map((t) => t.toLowerCase()));
  const got = new Set(suggestion.tags.map((t) => t.name.toLowerCase()));
  const tags = {
    matching: [...got].filter((t) => want.has(t)).length,
    extra: [...got].filter((t) => !want.has(t)).length,
    missed: [...want].filter((t) => !got.has(t)).length,
  };

  const owned = sample.notebooks.find((nb) => nb.name === note.notebook);
  const expected = owned
    ? owned.fields.filter((f) => {
        const v = note.fields[f.name];
        return v !== null && v !== undefined && v !== '' && v !== false && !(Array.isArray(v) && v.length === 0) && !isRatingField(f);
      })
    : [];
  const fields = { expected: expected.length, right: 0, wrong: 0, missed: 0, extra: 0 };
  if (notebook === 'right' && owned) {
    const by = new Map(suggestion.fields.map((f) => [f.field.id, f.value]));
    for (const f of expected) {
      const v = by.get(f.id);
      if (v === undefined) fields.missed++;
      else if (same(f, v, note.fields[f.name]!)) fields.right++;
      else fields.wrong++;
    }
    const expectedIds = new Set(expected.map((f) => f.id));
    fields.extra = suggestion.fields.filter((f) => !expectedIds.has(f.field.id)).length;
  } else {
    fields.missed = expected.length;
  }

  let title: Score['title'] = null;
  if (titleScored) {
    const a = comparable(suggestion.title?.value ?? '');
    const b = comparable(note.title);
    title = { scored: true, exact: a === b && a !== '', close: a !== '' && b !== '' && (a.includes(b) || b.includes(a)) };
  }
  return { notebook, tags, fields, title };
}

// --- Running -------------------------------------------------------------------------------

function loadEnv(): Env {
  const env: Record<string, string> = {};
  try {
    for (const line of readFileSync(join(process.cwd(), '.dev.vars'), 'utf8').split('\n')) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (m) env[m[1]!] = m[2]!.replace(/^"|"$/g, '');
    }
  } catch {
    // No .dev.vars: the environment alone.
  }
  return { ...env, ...process.env } as Env;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

type Arm = 'jev' | 'onecall';

const SAMPLE = process.env['AUTOFILL_EVAL_SAMPLE'];

describe('Auto-fill arms', () => {
  it.skipIf(!SAMPLE)(
    'Jev against one call',
    { timeout: 60 * 60_000 },
    async () => {
      const dir = SAMPLE!;
      const env = loadEnv();
      const sample = loadSample(dir);
      const limit = Number(process.env['AUTOFILL_EVAL_LIMIT'] ?? sample.notes.length);
      const arms = (process.env['AUTOFILL_EVAL_ARMS'] ?? 'jev,onecall').split(',').map((a) => a.trim() as Arm);
      const notes = sample.notes.slice(0, limit);
      mkdirSync(join(dir, 'results'), { recursive: true });

      for (const arm of arms) {
        const runs: Array<{ id: string; score: Score; seconds: number; cents: number; usage: LlmUsage[]; jevTokens: number }> = [];
        const detail: unknown[] = [];
        let failed = 0;
        for (const note of notes) {
          const { input, titleScored } = inputFor(note, sample);
          try {
            const run = arm === 'jev' ? await runJev(env, input) : await runOneCall(env, sample, input);
            const s = score(note, sample, run.suggestion, titleScored);
            runs.push({ id: note.id, score: s, seconds: run.seconds, cents: run.cents, usage: run.usage, jevTokens: run.jevTokens });
            detail.push({
              id: note.id,
              want: { notebook: note.notebook, tags: note.tags, fields: note.fields, title: titleScored ? note.title : undefined },
              got: {
                notebook: run.suggestion.notebook?.name ?? null,
                tags: run.suggestion.tags.map((t) => t.name),
                fields: Object.fromEntries(run.suggestion.fields.map((f) => [f.field.name, f.value])),
                title: run.suggestion.title?.value,
              },
              score: s,
              seconds: run.seconds,
              cents: run.cents,
            });
            process.stdout.write(`${arm} ${runs.length}/${notes.length} ${run.seconds.toFixed(1)}s nb=${s.notebook}\n`);
          } catch (err) {
            failed++;
            detail.push({ id: note.id, error: (err as Error).message });
            process.stdout.write(`${arm} ${note.id} failed: ${(err as Error).message}\n`);
          }
        }
        // Per-note detail is private (it holds the sample's content) and stays beside the sample.
        writeFileSync(join(dir, 'results', `${arm}.json`), JSON.stringify(detail, null, 2));

        const n = runs.length;
        const sum = (f: (r: (typeof runs)[number]) => number) => runs.reduce((a, r) => a + f(r), 0);
        const titled = runs.filter((r) => r.score.title);
        const nbRight = runs.filter((r) => r.score.notebook === 'right');
        const tokens = (k: keyof LlmUsage) => sum((r) => r.usage.reduce((a, u) => a + Number(u[k]), 0));
        const lines = [
          `== ${arm}: ${n} notes scored, ${failed} failed ==`,
          `notebook right / wrong / none: ${nbRight.length} / ${sum((r) => (r.score.notebook === 'wrong' ? 1 : 0))} / ${sum((r) => (r.score.notebook === 'none' ? 1 : 0))}`,
          `tags matching / extra / missed: ${sum((r) => r.score.tags.matching)} / ${sum((r) => r.score.tags.extra)} / ${sum((r) => r.score.tags.missed)}`,
          `fields, notebook right (${nbRight.length} notes): expected ${nbRight.reduce((a, r) => a + r.score.fields.expected, 0)}, right / wrong / missed: ${nbRight.reduce((a, r) => a + r.score.fields.right, 0)} / ${nbRight.reduce((a, r) => a + r.score.fields.wrong, 0)} / ${nbRight.reduce((a, r) => a + r.score.fields.missed, 0)}, extra ${nbRight.reduce((a, r) => a + r.score.fields.extra, 0)}`,
          `fields, all notes: expected ${sum((r) => r.score.fields.expected)}, right ${sum((r) => r.score.fields.right)}`,
          `title (${titled.length} scored): exact ${titled.filter((r) => r.score.title!.exact).length}, close ${titled.filter((r) => r.score.title!.close).length}`,
          `seconds per press: median ${median(runs.map((r) => r.seconds)).toFixed(2)}, mean ${mean(runs.map((r) => r.seconds)).toFixed(2)}, max ${Math.max(...runs.map((r) => r.seconds)).toFixed(2)}`,
          `cents per press: mean ${mean(runs.map((r) => r.cents)).toFixed(3)}`,
          `model tokens per press: in ${Math.round(tokens('inputTokens') / n)}, cache read ${Math.round(tokens('cacheReadTokens') / n)}, cache write ${Math.round(tokens('cacheWriteTokens') / n)}, out ${Math.round(tokens('outputTokens') / n)}; jev est. in ${Math.round(sum((r) => r.jevTokens) / n)}`,
        ];
        process.stdout.write(`${lines.join('\n')}\n\n`);
        writeFileSync(join(dir, 'results', `${arm}.summary.txt`), `${lines.join('\n')}\n`);
      }
    },
  );
});
