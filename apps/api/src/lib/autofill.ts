import {
  encodeFieldValue,
  isRatingField,
  type AutofillSuggestion,
  type FieldDef,
  type FieldValue,
} from '@unbent/shared';
import type { Jev, JevAnswer, JevChoiceQuestion, JevEntry, JevQuestion } from './jev.js';
import { isLlmAuthError, type LanguageModel, type NoteForTitle } from './llm.js';
import { titleCase } from './title-case.js';

/**
 * Filing a note from what it says: the title, the notebook, the tags and the fields, as
 * Jev judges them.
 *
 * The case this is for is a scan. A document goes through the scanner into the Inbox as
 * an untitled note holding one PDF, and filing it — naming it, choosing the notebook,
 * tagging it, copying the amount and the date into the fields — is the same minute of
 * work for every one of thirteen thousand. The text is already there; search extracted
 * it. This hands that text to a model that answers questions about it, and turns the
 * answers into a suggestion the editor applies.
 *
 * Jev chooses; it does not write. That fits the notebook, the tags and every field with
 * options exactly — each is a choice among things that already exist, and the model
 * cannot answer with a notebook that does not. For the rest, the code finds the
 * candidates and the model picks: every date in the text for a date field, every amount
 * for a number, the document's own lines for a text field. A value can still be wrong,
 * but it cannot be malformed, and it is always something the document says.
 *
 * The title is the exception, because a title is written, not found. A line picked off
 * the document gets "Invoice #4471"; the language model, where the instance has one,
 * gets "Acme Hardware Invoice, March 2026". Jev is still asked to pick a line — its
 * question rides in a request that is being made anyway — and its pick is what stands
 * where there is no language model, or when that model declines or fails.
 *
 * A text field's value is the same case at a smaller size: the vendor is a few words in
 * the middle of a letterhead's line, and only a model that writes can copy those words
 * out. That model writes the text fields too, and a value it writes is kept only when the
 * document contains it — so the promise above holds for every field. See
 * `textFieldValues`.
 *
 * Two round trips. The fields to fill are the chosen notebook's, and the choice has to
 * come back first; every question in a round shares one state, so each round is one
 * request. What goes to the API is the note's own content — title, body, the text of its
 * files — and the names of the notebooks, tags and fields, with a few titles from each
 * notebook and tag as examples of what belongs there. Nothing else in the archive.
 */

// --- Thresholds ------------------------------------------------------------------------
//
// From TypeSafe's own guidance: below 0.5 the model is saying it does not know, and
// 0.5–0.9 is "proceed, with confirmation". Everything here fills an empty slot in a draft
// the person is looking at, which is its own confirmation, so the floors sit in that band.
// A yes/no is held higher: many are asked at once and each is judged alone, so a low bar
// would tag a note with everything it faintly resembles.

/** The least confidence a choice — notebook, title, select, candidate — is applied at. */
export const MIN_CHOICE_CONFIDENCE = 0.5;
/** The least probability a yes/no — a tag, a multi-select option, a checkbox — is applied at. */
export const MIN_YES_PROBABILITY = 0.75;
/** However many tags pass, only the likeliest few are suggested. */
export const MAX_SUGGESTED_TAGS = 5;

// --- Budgets ---------------------------------------------------------------------------
//
// Jev reads about 32k tokens of state and, per question, its options. These keep a long
// scan and an archive with hundreds of tags inside that. Characters rather than tokens,
// because this code has no tokenizer, at roughly four characters to a token.

/** The most of the note's own text sent: the body first, then each file until it is spent. */
export const MAX_STATE_CHARS = 40_000;
/** The body's share of that, so one long body cannot crowd out the scan beside it. */
const MAX_BODY_CHARS = MAX_STATE_CHARS / 4;
/** The most tags asked about, most used first. A tag on two notes is a weak habit to learn. */
export const MAX_TAGS_ASKED = 150;
/** The most candidates a free-form field or the title chooses from; the API allows 255. */
export const MAX_CANDIDATES = 60;
/** Example titles per notebook and per tag, so a name like "Misc" has something behind it. */
export const EXAMPLES_PER_OPTION = 3;

/** The choice that means none of the others. Never a candidate's key; see `choice`. */
const NONE = 'none';

export interface AutofillInput {
  note: {
    title: string;
    body: string;
    tags: string[];
    notebookId: string | null;
  };
  /**
   * The note's files with their extracted text: `null` while none has been recorded — the
   * scan is still being read — and `''` for a file that was read and held none, or is a
   * kind of file nothing here can read. `readBy` is `'vision'` when the language model
   * wrote the text, which then opens with a name for the file; see `nameFromReading`.
   */
  attachments: Array<{ filename: string; text: string | null; readBy?: 'vision' | null }>;
  notebooks: Array<{
    id: string;
    name: string;
    /** What belongs here, in the owner's words; steers the choice where the name misleads. */
    purpose: string | null;
    fields: FieldDef[];
    examples: string[];
  }>;
  /** Most used first; only the first `MAX_TAGS_ASKED` are asked about. */
  tags: Array<{ name: string; examples: string[] }>;
}

/**
 * The note has nothing for the model to read.
 *
 * Told apart from a note whose scan is still being read: right after an upload the text
 * may be seconds away, and "try again in a moment" is the right answer there, where
 * "there is nothing here" is the right answer to an empty note holding a photograph.
 */
export class NothingToRead extends Error {
  constructor(readonly pending: string[]) {
    super(
      pending.length > 0
        ? `Nothing to read yet: ${pending.length === 1 ? `${pending[0]} is` : `${pending.length} files are`} still being read. Try again in a moment.`
        : 'Nothing to read: the note is empty and its files have no text.',
    );
    this.name = 'NothingToRead';
  }
}

/** One option for the model to pick: the value it stands for, and how to describe it. */
export interface Option {
  key: string;
  value: FieldValue;
  description: JevEntry;
}

interface Corpus {
  /** The note as the language model is shown it for a title; `state` is the same, as Jev takes it. */
  note: NoteForTitle;
  /** What every question is asked about. */
  state: JevEntry;
  /** Every piece of text, for the pattern-found candidates. */
  text: string;
  /** The short lines of the content, in order, for the title and the text fields to choose from. */
  lines: Option[];
  read: string[];
  pending: string[];
}

/**
 * The note's text within budget: the body first, capped at its share, then each file in
 * turn until the budget is spent. A file still being read is noted rather than waited for;
 * a file read and found empty is simply not there.
 */
function gather(input: AutofillInput): Corpus {
  let budget = MAX_STATE_CHARS;
  const take = (text: string, max: number): string => {
    const taken = text.slice(0, Math.min(max, budget));
    budget -= taken.length;
    return taken;
  };

  const title = input.note.title.trim();
  const body = take(input.note.body, MAX_BODY_CHARS);
  const files: Array<{ filename: string; text: string }> = [];
  const pending: string[] = [];
  for (const file of input.attachments) {
    if (file.text === null) {
      pending.push(file.filename);
      continue;
    }
    const text = take(file.text.trim(), budget);
    if (!text) continue;
    files.push({ filename: file.filename, text });
  }

  if (!title && !body.trim() && files.length === 0) throw new NothingToRead(pending);

  const note: NoteForTitle = { title, body, attachments: files.map((f) => ({ filename: f.filename, text: f.text })) };
  return {
    note,
    state: { ...note },
    text: [title, body, ...files.map((f) => f.text)].join('\n'),
    lines: candidateLines([
      { text: `${title}\n${body}`, where: 'the note' },
      ...files.map((f) => ({ text: f.text, where: f.filename })),
    ]),
    read: files.map((f) => f.filename),
    pending,
  };
}

// --- Candidates ------------------------------------------------------------------------
//
// What the code finds for the model to choose from. Each finder answers with every match
// in the text, deduplicated and in order of appearance, described as it was written so
// the model can tell "3/4/26" from "March 4th, 2026" when the document has both.

/**
 * The lines of the content a title or a text value could be: short, containing words, and
 * not a bare link or picture. Markdown's leading marks are dropped so a heading reads as
 * its words. Each is described by where it sits, which is a hint the model can use — a
 * letterhead is near the top.
 */
export function candidateLines(sources: Array<{ text: string; where: string }>): Option[] {
  const out: Option[] = [];
  const seen = new Set<string>();
  for (const { text, where } of sources) {
    text.split('\n').forEach((raw, i) => {
      if (out.length >= MAX_CANDIDATES) return;
      const line = raw
        .replace(/^[\s#>*+|-]+/, '')
        .replace(/[\s|*_]+$/, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (line.length < 3 || line.length > 80) return;
      if (!/\p{L}{2}/u.test(line)) return;
      if (/^!?\[[^\]]*\]\([^)]*\)$/.test(line)) return;
      const key = line.toLowerCase();
      if (key === NONE || seen.has(key)) return;
      seen.add(key);
      out.push({ key: line, value: line, description: `Line ${i + 1} of ${where}` });
    });
  }
  return out;
}

/**
 * The lines, each followed by what comes after its label, for a text field to choose from.
 *
 * A text field's value is usually half a line: "Order number: 112-0042" holds the order
 * number, but the line is not it, and a field filled with the whole line is one the
 * person has to clean up. So a line written as a label and a value offers the value too.
 * Short labels only — a colon forty characters in is a sentence, not a label.
 *
 * Where the instance has a language model, it writes these values instead; this is what
 * an instance without one gets, and what stands when that model fails.
 */
export function labelledValues(lines: Option[]): Option[] {
  const out: Option[] = [];
  const seen = new Set<string>();
  const add = (option: Option) => {
    const key = option.key.toLowerCase();
    // Twice the lines' cap, still well inside the API's 255: `candidateLines` stops at
    // `MAX_CANDIDATES`, and a value offered beside each must never push a line out.
    if (out.length >= 2 * MAX_CANDIDATES || seen.has(key) || key === NONE) return;
    seen.add(key);
    out.push(option);
  };
  for (const line of lines) {
    add(line);
    // A space after the colon, so a link is not split at "https:".
    const m = /^([^:]{1,40}):\s+(.+)$/.exec(line.key);
    if (m && /\p{L}/u.test(m[1]!)) {
      const value = m[2]!.trim();
      add({ key: value, value, description: `After "${m[1]!.trim()}:" in ${String(line.description)}` });
    }
  }
  return out;
}

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];
/** `jan(?:uary)?|feb(?:ruary)?|…` — the abbreviation, with the rest of the name optional. */
const MONTH_NAME = MONTHS.map((m) => `${m.slice(0, 3)}(?:${m.slice(3)})?`).join('|');

function monthNumber(name: string): number {
  return MONTHS.findIndex((m) => m.startsWith(name.slice(0, 3).toLowerCase())) + 1;
}

/** `YYYY-MM-DD` when the parts make a real date in a plausible century, else null. */
function isoDate(year: number, month: number, day: number): string | null {
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * Every date the text writes, in the four ways American documents write them: ISO,
 * numeric with slashes or dots, and the month by name on either side of the day. Numeric
 * dates are read month-first, as the archive's documents write them; a first number past
 * twelve can only be a day, so `25/3/2026` still reads.
 */
export function findDates(text: string): Option[] {
  const found = new Map<string, string>();
  const add = (iso: string | null, raw: string) => {
    if (iso && !found.has(iso)) found.set(iso, raw.trim());
  };
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    add(isoDate(Number(m[1]), Number(m[2]), Number(m[3])), m[0]);
  }
  for (const m of text.matchAll(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/g)) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    let year = Number(m[3]);
    if (m[3]!.length === 2) year += year < 70 ? 2000 : 1900;
    const [month, day] = a > 12 ? [b, a] : [a, b];
    add(isoDate(year, month, day), m[0]);
  }
  const monthFirst = new RegExp(`\\b(${MONTH_NAME})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi');
  for (const m of text.matchAll(monthFirst)) {
    add(isoDate(Number(m[3]), monthNumber(m[1]!), Number(m[2])), m[0]);
  }
  const dayFirst = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAME})\\.?,?\\s+(\\d{4})\\b`, 'gi');
  for (const m of text.matchAll(dayFirst)) {
    add(isoDate(Number(m[3]), monthNumber(m[2]!), Number(m[1])), m[0]);
  }
  return [...found]
    .slice(0, MAX_CANDIDATES)
    .map(([iso, raw]) => ({ key: iso, value: iso, description: `As written: ${raw}` }));
}

/**
 * Every number the text writes that could be an amount: digits with optional thousands
 * separators and fraction, an optional sign, an optional currency mark. Anything glued
 * to a slash, dash, colon or letter is left alone — that is a date, a time, an id or a
 * phone number — and so is a run of more than nine digits, which is an account number.
 * Amounts with a mark or a fraction come first, so that they are what survives the cap;
 * the order is lost once they are keys of the criteria object, and does not matter there.
 */
export function findNumbers(text: string): Option[] {
  const amounts: Option[] = [];
  const plain: Option[] = [];
  const seen = new Set<string>();
  const re = /(?<![\w./:-])(?:[$€£]\s?)?-?\d[\d,]*(?:\.\d+)?(?![\w/:-])/g;
  for (const m of text.matchAll(re)) {
    const raw = m[0].trim();
    const marked = /^[$€£]/.test(raw);
    const digits = raw.replace(/^[$€£]\s?/, '').replace(/,/g, '');
    if (!/^-?\d+(\.\d+)?$/.test(digits)) continue;
    if (digits.replace(/^-/, '').split('.')[0]!.length > 9) continue;
    const value = Number(digits);
    if (!Number.isFinite(value)) continue;
    const key = String(value);
    if (seen.has(key)) continue;
    seen.add(key);
    const option: Option = { key, value, description: `As written: ${raw}` };
    (marked || digits.includes('.') ? amounts : plain).push(option);
  }
  return [...amounts, ...plain].slice(0, MAX_CANDIDATES);
}

export function findEmails(text: string): Option[] {
  const seen = new Set<string>();
  const out: Option[] = [];
  for (const m of text.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)) {
    const key = m[0].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key: m[0], value: m[0], description: 'An address in the text' });
  }
  return out.slice(0, MAX_CANDIDATES);
}

/** Addresses with a scheme, and bare `www.` ones given https, since that is what the field takes. */
export function findUrls(text: string): Option[] {
  const seen = new Set<string>();
  const out: Option[] = [];
  const add = (raw: string, url: string) => {
    const key = url.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ key: url, value: url, description: `As written: ${raw}` });
  };
  const trim = (s: string) => s.replace(/[.,;:!?)\]]+$/, '');
  for (const m of text.matchAll(/\bhttps?:\/\/[^\s<>()"']+/gi)) add(trim(m[0]), trim(m[0]));
  for (const m of text.matchAll(/(?<![/\w])www\.[^\s<>()"']+/gi)) add(trim(m[0]), `https://${trim(m[0])}`);
  return out.slice(0, MAX_CANDIDATES);
}

/** North American numbers, with or without the country code and however punctuated. */
export function findPhones(text: string): Option[] {
  const seen = new Set<string>();
  const out: Option[] = [];
  for (const m of text.matchAll(/(?<!\d)(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g)) {
    const raw = m[0].trim();
    const key = raw.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key: raw, value: raw, description: 'A number in the text' });
  }
  return out.slice(0, MAX_CANDIDATES);
}

// --- Questions and answers --------------------------------------------------------------

/**
 * A choice among options, plus "none". The map is what turns the answer's key back into
 * a value; `none` is never in it, so choosing it reads as no answer. A candidate whose
 * key collides with an earlier one is dropped rather than overwritten.
 */
function choice(
  instructions: JevEntry,
  options: Option[],
  none: string,
): { question: JevChoiceQuestion; values: Map<string, FieldValue> } {
  const criteria: Record<string, JevEntry> = {};
  const values = new Map<string, FieldValue>();
  for (const option of options) {
    if (option.key === NONE || values.has(option.key)) continue;
    criteria[option.key] = option.description;
    values.set(option.key, option.value);
  }
  criteria[NONE] = none;
  return { question: { type: 'choice', instructions, criteria }, values };
}

/** The value a choice answer stands for, when it is confident and is not "none". */
function chosen(
  answer: JevAnswer | undefined,
  values: Map<string, FieldValue>,
): { value: FieldValue; confidence: number } | null {
  if (!answer || answer.type !== 'choice') return null;
  if (answer.confidence < MIN_CHOICE_CONFIDENCE) return null;
  const value = values.get(answer.choice);
  // `none`, or a key the API did not get from us.
  if (value === undefined) return null;
  return { value, confidence: answer.confidence };
}

/** A yes/no answer's probability, when it clears the floor. */
function yes(answer: JevAnswer | undefined): number | null {
  if (!answer || answer.type !== 'noul' || answer.noul < MIN_YES_PROBABILITY) return null;
  return answer.noul;
}

/**
 * The first round: the title, the notebook, and one yes/no per tag.
 *
 * Tags the note already carries are not asked about — they are not suggestions — and
 * neither are tags past the cap, which are the least used. The examples ride in each
 * question's criteria, where TypeSafe's guidance puts them.
 */
function firstRound(input: AutofillInput, corpus: Corpus) {
  const questions: Record<string, JevQuestion> = {};

  const title =
    corpus.lines.length === 0
      ? null
      : choice(
          {
            question: 'Which of these lines would best serve as the title of this note?',
            guidance:
              'A title says what the document is and who it is from or about, the way a person ' +
              'filing it would label it: a letterhead, a form name, a subject line, a heading. ' +
              'Prefer a specific line over a generic one, and a line that names the document ' +
              'over one that merely appears in it.',
          },
          corpus.lines,
          'No line would make a good title',
        );
  if (title) questions['title'] = title.question;

  const notebook =
    input.notebooks.length === 0
      ? null
      : choice(
          {
            question: 'Which notebook does this note belong in?',
            guidance:
              'Each notebook holds one kind of document. A notebook\'s purpose, when it has ' +
              'one, is its owner\'s own statement of what belongs there and what does not, and ' +
              'it decides the question — a note goes in a notebook only when it fits that ' +
              'purpose, even if the name alone would seem to invite it. Its fields say what is ' +
              'recorded about each note, and its examples are titles of notes already filed ' +
              'there. Choose "No notebook fits this note" when none of the purposes plainly ' +
              'covers this note; a note left unfiled is easily filed later, but a note filed ' +
              'into the wrong notebook is not easily found again.',
          },
          input.notebooks.map((nb) => ({
            key: nb.name,
            value: nb.id,
            description: {
              what: `The notebook "${nb.name}"`,
              ...(nb.purpose ? { purpose: nb.purpose } : {}),
              ...(nb.fields.length > 0 ? { fields: nb.fields.map((f) => f.name) } : {}),
              ...(nb.examples.length > 0 ? { examples: nb.examples } : {}),
            },
          })),
          'No notebook fits this note',
        );
  if (notebook) questions['notebook'] = notebook.question;

  const has = new Set(input.note.tags.map((t) => t.toLowerCase()));
  const tags = input.tags.filter((t) => !has.has(t.name.toLowerCase())).slice(0, MAX_TAGS_ASKED);
  tags.forEach((tag, i) => {
    questions[`tag_${i}`] = {
      type: 'noul',
      instructions: {
        question: `Does the tag "${tag.name}" apply to this note?`,
        guidance:
          'Tags label what a note is about or what kind of thing it is. Say yes only when the ' +
          'tag plainly fits the content, not when it merely could.',
      },
      ...(tag.examples.length > 0
        ? {
            criteria: {
              true: {
                what: `This note belongs with the notes tagged "${tag.name}"`,
                examples: tag.examples,
              },
            },
          }
        : {}),
    };
  });

  return { questions, title, notebook, tags };
}

type FieldSuggestion = AutofillSuggestion['fields'][number];

/** One field's questions, and how to read its answer out of the round. */
interface Ask {
  questions: Record<string, JevQuestion>;
  read(answers: Record<string, JevAnswer>): FieldSuggestion | null;
}

/**
 * The second round: a question per field of the notebook the note is going in, shaped by
 * the field's type. A select is a choice among its options; a checkbox and each option of
 * a multi-select are a yes/no; everything else is a choice among what the finders turned
 * up, and a field with nothing found is not asked about. A rating is never asked: it is an
 * opinion, and a document has none to read.
 */
function fieldAsks(fields: FieldDef[], corpus: Corpus): Ask[] {
  const asks: Ask[] = [];
  fields.forEach((def, i) => {
    const id = `field_${i}`;
    const label = `"${def.name}"`;

    /**
     * Read back under the definition before it is offered. A candidate the pattern found
     * is still a string a `number` may not hold, an option can be retired between the
     * question and the answer, and this is the same check the write would make — so a
     * suggestion that survives it is one the note can store.
     */
    const suggest = (value: FieldValue, confidence: number): FieldSuggestion | null => {
      const encoded = encodeFieldValue(def, value);
      if (encoded === null || encoded === 'clear') return null;
      return { field: def, value, confidence };
    };

    const single = (instructions: JevEntry, options: Option[], none: string) => {
      if (options.length === 0) return;
      const { question, values } = choice(instructions, options, none);
      asks.push({
        questions: { [id]: question },
        read: (answers) => {
          const picked = chosen(answers[id], values);
          return picked ? suggest(picked.value, picked.confidence) : null;
        },
      });
    };

    const notSaid = 'None of these, or the document does not say';

    switch (def.type) {
      case 'number':
        if (isRatingField(def)) return;
        single(
          {
            question: `Which of these numbers is the ${label} of this note?`,
            guidance: `These are every number the text writes, each shown as written. ${
              def.currency ? 'The field is an amount of money.' : ''
            }`.trim(),
          },
          findNumbers(corpus.text),
          notSaid,
        );
        return;
      case 'date':
        single(
          {
            question: `Which of these dates is the ${label} of this note?`,
            guidance: 'These are every date the text writes, each shown as written.',
          },
          findDates(corpus.text),
          notSaid,
        );
        return;
      case 'email':
        single({ question: `Which of these is the ${label} of this note?` }, findEmails(corpus.text), notSaid);
        return;
      case 'url':
        single({ question: `Which of these is the ${label} of this note?` }, findUrls(corpus.text), notSaid);
        return;
      case 'phone':
        single({ question: `Which of these is the ${label} of this note?` }, findPhones(corpus.text), notSaid);
        return;
      case 'text':
        single(
          {
            question: `Which of these lines is the ${label} of this note?`,
            guidance:
              'Choose the line that is the value itself — not a label for it, and not a ' +
              'sentence that mentions it.',
          },
          labelledValues(corpus.lines),
          'No line is this value, or the document does not say',
        );
        return;
      case 'select':
        single(
          { question: `Which option of the field ${label} fits this note?` },
          def.options.map((o) => ({ key: o, value: o, description: `The option "${o}"` })),
          'None of the options, or the document does not say',
        );
        return;
      case 'checkbox':
        asks.push({
          questions: {
            [id]: {
              type: 'noul',
              instructions: {
                question: `Should the checkbox ${label} be ticked for this note?`,
                guidance: 'Only if the document itself says so.',
              },
            },
          },
          read: (answers) => {
            const p = yes(answers[id]);
            return p === null ? null : suggest(true, p);
          },
        });
        return;
      case 'multiselect': {
        const questions: Record<string, JevQuestion> = {};
        def.options.forEach((option, j) => {
          questions[`${id}_${j}`] = {
            type: 'noul',
            instructions: {
              question: `Does the option "${option}" of the field ${label} apply to this note?`,
              guidance: 'Only if the document itself says so.',
            },
          };
        });
        asks.push({
          questions,
          read: (answers) => {
            const picked: string[] = [];
            let least = 1;
            def.options.forEach((option, j) => {
              const p = yes(answers[`${id}_${j}`]);
              if (p === null) return;
              picked.push(option);
              least = Math.min(least, p);
            });
            // The confidence of a list is that of its least certain member.
            return picked.length > 0 ? suggest(picked, least) : null;
          },
        });
        return;
      }
    }
  });
  return asks;
}

/** For finding a value in the text: case and runs of whitespace are not a difference. */
const comparable = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * The text fields' values as the language model writes them, where the instance has one.
 *
 * Jev chooses among the document's lines, so a text field could only ever be filled with
 * a whole line: "Thank you for shopping at Acme Rentals Store #4471, 100 Example Rd" for
 * a Vendor, "Order number: 112-0042" for an order number. `labelledValues` rescues the
 * second; nothing a finder can do rescues the first, because the value is a few words in
 * the middle of a sentence. A model that writes can copy those few words out.
 *
 * A model that writes can also write something the document never says, which is the
 * thing this file was built to rule out. So a value is kept only when the document
 * contains it, ignoring case and spacing; anything else is dropped and Jev's pick stands
 * for that field. That keeps the promise at the top of this file — a value is always
 * something the document says — while letting the value be the part of a line that is
 * the answer.
 *
 * Only text fields. A date, an amount, an address or an option is already a value Jev
 * picks from candidates that are exactly that, and a model writing them would be one more
 * way to get a digit wrong. Map from field id to value; a field the model left empty, or
 * answered with something not in the document, is not in it. A failure is logged and
 * answered with nothing, so every field falls back to Jev's pick.
 */
async function textFieldValues(
  llm: Pick<LanguageModel, 'textFields'>,
  corpus: Corpus,
  fields: FieldDef[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const asked = fields.filter((f) => f.type === 'text');
  if (asked.length === 0) return found;
  let answer: Record<string, string> | null;
  try {
    answer = await llm.textFields(
      corpus.note,
      asked.map((f, i) => ({ key: `field_${i}`, name: f.name })),
    );
  } catch (err) {
    console.error('autofill fields:', (err as Error).message);
    return found;
  }
  if (!answer) return found;
  const document = comparable(corpus.text);
  asked.forEach((f, i) => {
    const value = answer[`field_${i}`] ?? '';
    if (!value) return;
    // Whole words: "Rent" is in "Acme Rentals", and is not something the document says.
    const escaped = comparable(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const whole = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u');
    if (whole.test(document)) found.set(f.id, value);
  });
  return found;
}

/**
 * The name the language model already wrote for a note that is one picture and nothing
 * else — the most common capture, a photo shared from a phone.
 *
 * The reader's text opens with a name for the file, written from the same pixels a title
 * call would send back, so for an untitled note whose only content is that one reading
 * the call is a second request for an answer already on hand. Only that case: a body,
 * a second file or a title of the person's own is context the reader never saw, and
 * the title call is what weighs it.
 */
function nameFromReading(input: AutofillInput): string | null {
  if (input.note.title.trim() || input.note.body.trim()) return null;
  const read = input.attachments.filter((a) => a.text?.trim());
  if (read.length !== 1 || read[0]!.readBy !== 'vision') return null;
  return read[0]!.text!.split('\n')[0]?.trim() || null;
}

/**
 * Asks, and answers with what cleared the floors. Throws `NothingToRead` before asking
 * anything when the note is empty; a Jev failure surfaces as the client's own error.
 *
 * `llm` is the language model, when the instance has one, asked for the title and for the
 * text fields' values. The title call is started before Jev's first round and collected
 * after the second, so the seconds it takes overlap both rounds rather than delaying the
 * fields. The text fields' call can start only once the first round has chosen the
 * notebook, so it runs alongside the second and the press waits for both; its timeout is
 * shorter for that reason (see `textFields` in lib/llm.ts). Neither failure is the
 * suggestion's: each part has Jev's pick to fall back on, so the error is logged and the
 * pick stands.
 *
 * `operator` is whether the caller runs this instance. It changes nothing about the
 * suggestion except one thing only they can act on: a title model that fails on auth is a
 * secret they have to replace, and left silent it looks like the model merely having no
 * better title (see `titleModel` on the suggestion). The signal is set only for them, so
 * a note filed on a misconfigured instance reads the same for everyone else as it did
 * before — Jev's picked title, no error — while the person who can fix it is told.
 *
 * Only the title call reports this. The text fields' call uses the same key and fails
 * the same way, so in nearly every press the title has already said it. The exception
 * is a lone picture, whose title comes from its reading with no call made (see
 * `nameFromReading`). Accepted: a picture's reading needs the same key, so a rejected key
 * shows on the next upload, and adding a second flag for this one case was not worth it.
 */
export async function autofill(
  jev: Jev,
  input: AutofillInput,
  llm?: Pick<LanguageModel, 'title' | 'textFields'>,
  operator = false,
): Promise<AutofillSuggestion> {
  const corpus = gather(input);
  const first = firstRound(input, corpus);

  // Set where the title call failed on a standing misconfiguration the operator must fix;
  // `isLlmAuthError` draws the line, and only the operator is ever told (see below).
  let titleAuthFailed = false;
  const named = nameFromReading(input);
  const writing =
    llm && !named
      ? llm.title(corpus.note).catch((err: unknown) => {
          if (isLlmAuthError(err)) {
            titleAuthFailed = true;
            console.error('autofill title: LLM auth/config failure —', (err as Error).message);
          } else {
            console.error('autofill title:', (err as Error).message);
          }
          return null;
        })
      : null;

  const answers = await jev.ask(corpus.state, first.questions);

  const suggestion: AutofillSuggestion = {
    tags: [],
    fields: [],
    read: { attachments: corpus.read, pending: corpus.pending },
  };

  const notebook = first.notebook && chosen(answers['notebook'], first.notebook.values);
  if (notebook) {
    const found = input.notebooks.find((nb) => nb.id === notebook.value)!;
    suggestion.notebook = { id: found.id, name: found.name, confidence: notebook.confidence };
  }

  suggestion.tags = first.tags
    .map((tag, i) => ({ name: tag.name, confidence: yes(answers[`tag_${i}`]) }))
    .filter((t): t is { name: string; confidence: number } => t.confidence !== null)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_SUGGESTED_TAGS);

  /*
     The fields are the target notebook's: the one just chosen, or the note's own when the
     model had no opinion. A note the model would move out of its notebook gets the new
     notebook's fields, and the client applies the two together or not at all.
  */
  const targetId = suggestion.notebook?.id ?? input.note.notebookId;
  const target = input.notebooks.find((nb) => nb.id === targetId);
  if (target && target.fields.length > 0) {
    const asks = fieldAsks(target.fields, corpus);
    const questions = Object.assign({}, ...asks.map((ask) => ask.questions)) as Record<string, JevQuestion>;
    // Jev is still asked the text fields, in the round it makes anyway: its pick is what
    // stands wherever the model's value does not. The two requests overlap. Either may
    // have nothing to do — a document whose lines are all too long to offer leaves Jev
    // no question for a text field, and that is when the model's value is worth most.
    const [second, writtenFields] = await Promise.all([
      Object.keys(questions).length > 0 ? jev.ask(corpus.state, questions) : {},
      llm ? textFieldValues(llm, corpus, target.fields) : new Map<string, string>(),
    ]);
    for (const ask of asks) {
      const found = ask.read(second);
      if (found) suggestion.fields.push(found);
    }
    // A written value replaces Jev's line, or fills a field Jev found no line for. No
    // confidence on it, as on a written title: see `AutofillSuggestion`.
    for (const def of target.fields) {
      const value = writtenFields.get(def.id);
      if (!value || encodeFieldValue(def, value) === null) continue;
      const entry = { field: def, value };
      const i = suggestion.fields.findIndex((f) => f.field.id === def.id);
      if (i >= 0) suggestion.fields[i] = entry;
      else suggestion.fields.push(entry);
    }
    // In the notebook's order, which is the order the fields are drawn and asked in.
    const order = new Map(target.fields.map((f, i) => [f.id, i]));
    suggestion.fields.sort((a, b) => order.get(a.field.id)! - order.get(b.field.id)!);
  }

  // Whichever wrote it, the title is offered in title case: a scan's line arrives in the
  // case it was printed in, and a prompt asks the model for title case without promising it.
  const written = named ?? (writing ? await writing : null);
  if (written) suggestion.title = { value: titleCase(written) };
  else {
    const title = first.title && chosen(answers['title'], first.title.values);
    if (title) suggestion.title = { value: titleCase(String(title.value)), confidence: title.confidence };
  }

  // Only the operator, and only when the model's own title never came — a suggestion that
  // still got its title has nothing to report. `await writing` above has already resolved,
  // so `titleAuthFailed` is settled by here.
  if (operator && titleAuthFailed && !written) suggestion.titleModel = 'auth-failed';

  return suggestion;
}
