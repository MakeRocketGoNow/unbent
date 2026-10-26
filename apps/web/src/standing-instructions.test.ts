import { describe, expect, it } from 'vitest';
import { claudeInstructions } from './claude-instructions.js';
import { claudeProjectInstructions } from './claude-project-instructions.js';
import { chatgptInstructions } from './chatgpt-instructions.js';
import { INSTRUCTIONS_LIMIT, type InstructionNotebook } from './standing-instructions.js';

/**
 * An invented library in the shapes of the seed's notebooks (`packages/seed`): a log
 * with a whole-star rating, a list with a half-step rating, receipts with money and a
 * select, and reference notebooks with no fields.
 */
const field = (name: string, type: InstructionNotebook['fields'][number]['type'], rest: Partial<InstructionNotebook['fields'][number]> = {}) => ({
  name,
  type,
  options: [],
  scale: null,
  currency: null,
  ...rest,
});

const LIBRARY: InstructionNotebook[] = [
  { name: 'Recipes', purpose: null, count: 12, fields: [] },
  { name: 'Projects', purpose: 'Plans and the research behind them', count: 4, fields: [] },
  {
    name: 'Restaurants',
    purpose: 'Meals out: where, what, and whether it was worth going back for.',
    count: 30,
    fields: [
      field('Restaurant', 'text'),
      field('Date', 'date'),
      field('Rating', 'number', { scale: { max: 5, step: 1 } }),
      field('Would Get Again', 'select', { options: ['Yes', 'Maybe', 'No'] }),
    ],
  },
  {
    name: 'Watch List',
    purpose: null,
    count: 20,
    fields: [field('URL', 'url'), field('Rating', 'number', { scale: { max: 5, step: 0.5 } })],
  },
  {
    name: 'Receipts',
    purpose: null,
    count: 50,
    fields: [
      field('Vendor', 'text'),
      field('Amount', 'number', { currency: 'USD' }),
      field('Reimbursed', 'checkbox'),
      field('Category', 'multiselect', { options: ['Groceries', 'Hardware'] }),
    ],
  },
];
const RECEIPTS = LIBRARY.find((nb) => nb.name === 'Receipts')!;

const URL = 'https://notes.example.com/api/mcp';
const GENERATORS = [
  ['claudeInstructions', claudeInstructions],
  ['claudeProjectInstructions', claudeProjectInstructions],
  ['chatgptInstructions', chatgptInstructions],
] as const;

describe.each(GENERATORS)('%s', (_, generate) => {
  const text = generate(URL, LIBRARY);

  it('names the instance it was built for, never unbent.app', () => {
    expect(text).toContain(URL);
    expect(text).not.toContain('unbent.app');
  });

  it('makes Unbent the destination for the explicit requests', () => {
    expect(text).toContain('even when I do not name it');
    for (const trigger of ['"file this"', '"log this"', '"look up X in my notes"', '"check my notes"']) {
      expect(text).toContain(trigger);
    }
  });

  it('sends the assistant to list_notebooks and the purposes before writing', () => {
    expect(text).toContain('Call list_notebooks first.');
    expect(text).toContain("each notebook's purpose");
  });

  it("leaves the assistant's memory alone and never calls Unbent memory", () => {
    expect(text).not.toMatch(/rather than (your|ChatGPT's|Claude's) memory/);
    expect(text).not.toMatch(/Unbent is (your|my) memory/i);
    expect(text).not.toContain('offer to');
  });

  it('reads sensibly for an account with no notebooks', () => {
    const empty = generate(URL, []);
    expect(empty).toContain('I have no notebooks yet');
    expect(empty).not.toContain('My notebooks');
    expect(empty).not.toMatch(/\n\n\n/);
  });

  it('carries no em-dash', () => {
    expect(text).not.toContain('—');
  });
});

it("the account-wide texts leave the assistant's memory as it was", () => {
  expect(claudeInstructions(URL, LIBRARY)).toContain('Keep using your own memory as you do now');
  expect(chatgptInstructions(URL, LIBRARY)).toContain('Keep using your own memory as you do now');
});

it('only the project text reads a bare line as a note to file', () => {
  expect(claudeProjectInstructions(URL, LIBRARY)).toContain('A bare line with no verb is a note to file');
  expect(claudeInstructions(URL, LIBRARY)).not.toContain('bare line');
  expect(chatgptInstructions(URL, LIBRARY)).not.toContain('bare line');
});

describe('the inventory', () => {
  const text = claudeInstructions(URL, LIBRARY);
  const line = (name: string) => text.split('\n').find((l) => l.startsWith(`- ${name}`));

  it('lists every notebook, busiest first, and says where the current list is', () => {
    expect(text).toContain('My notebooks (list_notebooks has the current list):');
    const order = ['Receipts', 'Restaurants', 'Watch List', 'Recipes', 'Projects'].map((n) => text.indexOf(`- ${n}`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('gives a purpose verbatim, with a full stop, and the fields with what each takes', () => {
    expect(line('Restaurants')).toBe(
      '- Restaurants: Meals out: where, what, and whether it was worth going back for. Fields: Restaurant (text), Date (date), Rating (1 to 5), Would Get Again (one of Yes, Maybe, No).',
    );
    expect(line('Projects')).toBe('- Projects: Plans and the research behind them.');
  });

  it('names money, half-step ratings, checkboxes and multi-selects', () => {
    expect(line('Receipts')).toBe(
      '- Receipts. Fields: Vendor (text), Amount (USD), Reimbursed (yes or no), Category (any of Groceries, Hardware).',
    );
    expect(line('Watch List')).toBe('- Watch List. Fields: URL (link), Rating (1 to 5, halves allowed).');
  });

  it('sorts no notebook into a kind and assigns it no verb', () => {
    expect(text).not.toMatch(/\b(Logs|Reference|records)\b/);
    expect(line('Recipes')).toBe('- Recipes');
  });
});

describe('the length', () => {
  /** An archive's worth of invented notebooks, each with a long purpose and fields. */
  const archive: InstructionNotebook[] = Array.from({ length: 300 }, (_, i) => ({
    name: `Notebook ${i + 1} ${'with a long name '.repeat(i % 4)}`.trim(),
    purpose: 'A purpose long enough to matter when there are hundreds of them. '.repeat(2),
    count: 300 - i,
    fields: i % 3 === 0 ? [] : RECEIPTS.fields,
  }));

  it.each(GENERATORS)('keeps %s within the limit, naming the busiest notebooks first', (_, generate) => {
    const text = generate(URL, archive);
    expect(text.length).toBeLessThanOrEqual(INSTRUCTIONS_LIMIT);
    expect(text).toContain('- Notebook 1\n');
    expect(text).toMatch(/There are \d+ more notebooks; list_notebooks names every one\./);
    // The rules survive the cut: they are what the list is for.
    expect(text).toContain('Call list_notebooks first');
  });

  it('drops options, then field lists, then purposes, and only then notebooks', () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ ...RECEIPTS, purpose: 'Kept for returns and warranties.', name: `Receipts ${i + 1}` }));
    const seen = { optionsOnly: false, fieldsOnly: false };
    for (let n = 20; n <= 80; n++) {
      const text = claudeInstructions(URL, many(n));
      expect(text.length).toBeLessThanOrEqual(INSTRUCTIONS_LIMIT);
      const options = text.includes('any of Groceries');
      const fields = text.includes('Fields: Vendor');
      const purposes = text.includes('Kept for returns');
      const cut = text.includes('more notebooks');
      // Each level goes only once the one before it has gone.
      if (options) expect(fields).toBe(true);
      if (fields) expect(purposes).toBe(true);
      if (cut) expect(purposes).toBe(false);
      if (!options && fields) seen.optionsOnly = true;
      if (!fields && purposes) seen.fieldsOnly = true;
    }
    expect(seen).toEqual({ optionsOnly: true, fieldsOnly: true });
  });
});
