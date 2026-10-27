import { isCurrencyField, isRatingField, isYearField, type FieldDef } from '@unbent/shared';

/**
 * The standing instructions Settings › AI assistants hands out: the text an assistant
 * reads at the start of every chat, in one version for each place it is pasted
 * (`claudeInstructions`, `claudeProjectInstructions`, `chatgptInstructions`), and the
 * parts they share.
 *
 * A connected assistant uses Unbent when it is told to, so the person ends every request
 * with "in Unbent". The text makes the explicit requests ("file this", "look up X in my
 * notes") mean Unbent without naming it, and changes nothing else: the assistant's own
 * memory stays what it was for what comes up in conversation, and Unbent is where the
 * person files things on purpose. It is never described as the assistant's memory, and
 * it does not ask the assistant to file anything unasked. A first draft invited that
 * ("you may offer to file"), and the maintainer did not want the assistant reaching for
 * Unbent over its memory.
 *
 * It is built from the account's own notebooks, as a plain inventory: each one's name,
 * its purpose in the person's words when it has one, and its fields with what each
 * takes. That gives the assistant the shape before its first call, which is the point
 * for a one-line entry typed on a phone. It says nothing about what a notebook is for
 * beyond the purpose: the first draft sorted notebooks into logs, records and reference
 * from their field shapes and told the assistant what to do with each, and that was the
 * maintainer's own notebooks generalized ("log this" for an account with no logs, "titled
 * with the dish" for a workouts log). What a notebook is for is its purpose, which the
 * person writes on the notebook, and the rules tell the assistant to read
 * `list_notebooks` first, so a notebook added after the copy is still found.
 *
 * Built from the instance's own URL, never unbent.app's, for the reason `mcpSetupPrompt`
 * gives: a self-hosted instance's text must not send the assistant to someone else's
 * server. The connector is named by that URL rather than by a name, because the person
 * chose the name when they added it and the URL is the one thing both sides know.
 */
export interface InstructionNotebook {
  name: string;
  purpose: string | null;
  /** Live notes, which orders the list so a cut keeps the notebooks in use. */
  count: number;
  fields: Array<Pick<FieldDef, 'name' | 'type' | 'options' | 'scale' | 'currency' | 'style'>>;
}

type Field = InstructionNotebook['fields'][number];

/**
 * The longest any of the texts may be. ChatGPT keeps 5,000 characters of custom
 * instructions on a paid plan (1,500 on the free one, which cannot connect a custom
 * server with writes anyway). Claude documents no limit, and the same budget is used
 * for it on purpose: the text rides on every chat, and an archive's two hundred
 * notebooks listed whole would bury the few sentences that say when to use Unbent.
 */
export const INSTRUCTIONS_LIMIT = 5000;

/** What a field takes, in a word or three, as the assistant should write it. */
function describeField(f: Field, options: boolean): string {
  if (isRatingField({ type: f.type, scale: f.scale ?? null })) {
    return `1 to ${f.scale!.max}${f.scale!.step < 1 ? ', halves allowed' : ''}`;
  }
  if (isCurrencyField({ type: f.type, scale: f.scale ?? null, currency: f.currency ?? null })) return f.currency!;
  if (isYearField(f)) return 'year';
  switch (f.type) {
    case 'checkbox':
      return 'yes or no';
    case 'url':
      return 'link';
    case 'select':
      return options && f.options.length > 0 ? `one of ${f.options.join(', ')}` : 'one of a list';
    case 'multiselect':
      return options && f.options.length > 0 ? `any of ${f.options.join(', ')}` : 'any of a list';
    default:
      return f.type;
  }
}

/**
 * How much of each notebook the list says. The text is cut to fit by stepping down
 * these, from the options of every select (`list_notebooks` has them, and the rules say
 * to call it) to the field lists, then the purposes, and only then by leaving notebooks
 * out, least used first.
 */
interface Detail {
  options: boolean;
  fields: boolean;
  purposes: boolean;
  /** How many notebooks to name; the rest are counted. */
  max: number;
}

function notebookLine(nb: InstructionNotebook, detail: Detail): string {
  // "- Receipts. Fields: …" or "- Receipts: Kept for returns. Fields: …", so a name
  // with no purpose is not followed by two colons in a row.
  const purpose = detail.purposes && nb.purpose ? nb.purpose.trim().replace(/\s+/g, ' ').replace(/(?<![.!?])$/, '.') : '';
  const head = purpose ? `- ${nb.name}: ${purpose}` : `- ${nb.name}`;
  if (!detail.fields || nb.fields.length === 0) return head;
  const fields = nb.fields.map((f) => `${f.name} (${describeField(f, detail.options)})`).join(', ');
  return `${purpose ? head : `${head}.`} Fields: ${fields}.`;
}

/** The notebooks, busiest first, at one level of detail. */
function inventory(notebooks: InstructionNotebook[], detail: Detail): string {
  if (notebooks.length === 0) {
    return 'I have no notebooks yet. File notes without a notebook, and ask me before creating one.';
  }
  const ordered = [...notebooks].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const lines = ordered.slice(0, detail.max).map((nb) => notebookLine(nb, detail));
  const left = notebooks.length - detail.max;
  if (left > 0) lines.push(`There ${left === 1 ? 'is 1 more notebook' : `are ${left} more notebooks`}; list_notebooks names every one.`);
  return ['My notebooks (list_notebooks has the current list):', ...lines].join('\n');
}

/** The requests that mean Unbent, said once so the three texts cannot drift apart on them. */
export const TRIGGERS = `These requests mean Unbent even when I do not name it:
- "file this", "save this to my notes", "log this", "add this to my [notebook]": add a note to the notebook it fits, or to none if nothing fits.
- "look up X in my notes", "what do my notes say about X", "check my notes": search Unbent (search_notes) before answering, and say so if nothing is there.`;

export const RULES = `When you write to it:
- Call list_notebooks first. It has each notebook's purpose, which says what belongs there, and each field's name and options. File by the purpose, and set fields by name in create_note.
- Leave out what I did not give rather than guessing, and use an option a field already has rather than inventing one.
- Read a note before changing it: what I set is mine.
- Do not create notebooks or fields unless I ask.
- Answer in a line or two, with the note's link from the tool's reply.`;

/**
 * Puts a text together from its own opening around the shared parts and the inventory,
 * at the most detail that fits `INSTRUCTIONS_LIMIT`.
 */
export function composeInstructions(opening: string, notebooks: InstructionNotebook[]): string {
  const build = (detail: Detail) => [opening, TRIGGERS, inventory(notebooks, detail), RULES].join('\n\n') + '\n';
  const all = notebooks.length;
  for (const detail of [
    { options: true, fields: true, purposes: true, max: all },
    { options: false, fields: true, purposes: true, max: all },
    { options: false, fields: false, purposes: true, max: all },
    { options: false, fields: false, purposes: false, max: all },
  ]) {
    const text = build(detail);
    if (text.length <= INSTRUCTIONS_LIMIT) return text;
  }
  // Leaving notebooks out, least used first. Linear, since a build is a few string joins
  // and even an archive has a few hundred notebooks at most.
  for (let max = all - 1; max > 0; max--) {
    const text = build({ options: false, fields: false, purposes: false, max });
    if (text.length <= INSTRUCTIONS_LIMIT) return text;
  }
  return build({ options: false, fields: false, purposes: false, max: 0 });
}
