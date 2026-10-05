import { describe, expect, it, vi } from 'vitest';
import type { FieldDef } from '@unbent/shared';
import {
  MAX_SUGGESTED_TAGS,
  NothingToRead,
  autofill,
  candidateLines,
  findDates,
  findEmails,
  findNumbers,
  findPhones,
  findUrls,
  labelledValues,
  type AutofillInput,
} from './autofill.js';
import type { Jev, JevAnswer, JevChoiceQuestion, JevEntry, JevQuestion } from './jev.js';
import { LlmError } from './llm.js';

/**
 * A Jev that records what it was asked and answers from a script keyed by question id.
 * Anything unscripted is answered as unsure — a choice of "none", a no — so a test only
 * has to say what it is about.
 */
function fake(script: Record<string, JevAnswer> = {}) {
  const calls: Array<{ state: JevEntry; questions: Record<string, JevQuestion> }> = [];
  const jev: Jev = {
    async ask(state, questions) {
      calls.push({ state, questions });
      return Object.fromEntries(
        Object.entries(questions).map(([id, q]) => [
          id,
          script[id] ??
            (q.type === 'choice'
              ? { type: 'choice', choice: 'none', probabilities: {}, confidence: 0.9 }
              : { type: 'noul', noul: 0.1 }),
        ]),
      );
    },
  };
  return { jev, calls };
}

const choice = (choice: string, confidence = 0.9): JevAnswer => ({
  type: 'choice',
  choice,
  probabilities: {},
  confidence,
});
const noul = (noul: number): JevAnswer => ({ type: 'noul', noul });
/** A language model whose title is what a test is about, and which leaves the text fields to Jev. */
const noFields = async () => ({});

function field(over: Partial<FieldDef> & Pick<FieldDef, 'id' | 'name' | 'type'>): FieldDef {
  return { notebookId: 'nb-coupons', options: [], scale: null, currency: null, position: 0, ...over };
}

const receipt = [
  'ACME HARDWARE',
  '123 Main St, Springfield',
  'Invoice #4471',
  'Date: 03/04/2026',
  'Due: March 18, 2026',
  'Contact billing@acme.example',
  'Subtotal $1,234.56',
  'Tax 98.76',
  'Total $1,333.32',
  'Call (612) 555-0148 or visit www.acme.example/pay',
].join('\n');

const coupons: AutofillInput['notebooks'][number] = {
  id: 'nb-coupons',
  name: 'Coupons',
  purpose: null,
  fields: [],
  examples: ['Target 20% off', 'Free coffee card'],
};
const receipts: AutofillInput['notebooks'][number] = {
  id: 'nb-receipts',
  name: 'Receipts',
  purpose: 'Receipts and invoices for things already bought.',
  fields: [
    field({ id: 'f-vendor', name: 'Vendor', type: 'text', notebookId: 'nb-receipts' }),
    field({ id: 'f-total', name: 'Total', type: 'number', currency: 'USD', notebookId: 'nb-receipts' }),
    field({ id: 'f-date', name: 'Invoice date', type: 'date', notebookId: 'nb-receipts' }),
    field({ id: 'f-kind', name: 'Kind', type: 'select', options: ['Hardware', 'Grocery'], notebookId: 'nb-receipts' }),
    field({ id: 'f-paid', name: 'Paid', type: 'checkbox', notebookId: 'nb-receipts' }),
    field({ id: 'f-via', name: 'Paid via', type: 'multiselect', options: ['Card', 'Cash', 'Check'], notebookId: 'nb-receipts' }),
    field({ id: 'f-stars', name: 'Rating', type: 'number', scale: { max: 5, step: 1 }, notebookId: 'nb-receipts' }),
    field({ id: 'f-mail', name: 'Contact', type: 'email', notebookId: 'nb-receipts' }),
  ],
  examples: ['Plumber, June'],
};

function input(over: Partial<AutofillInput> = {}): AutofillInput {
  return {
    note: { title: '', body: '', tags: [], notebookId: null },
    attachments: [{ filename: 'scan.pdf', text: receipt }],
    notebooks: [coupons, receipts],
    tags: [
      { name: 'home', examples: ['Roof quote'] },
      { name: 'taxes', examples: [] },
      { name: 'car', examples: [] },
    ],
    ...over,
  };
}

describe('what the model is asked', () => {
  it('refuses an empty note, and says so differently while its scan is still being read', async () => {
    const empty = autofill(fake().jev, input({ attachments: [] }));
    await expect(empty).rejects.toBeInstanceOf(NothingToRead);
    await expect(empty).rejects.toThrow(/nothing to read/i);

    const pending = autofill(fake().jev, input({ attachments: [{ filename: 'scan.pdf', text: null }] }));
    await expect(pending).rejects.toThrow(/scan\.pdf is still being read/);

    // A photograph read and found empty is not "still being read".
    const photo = autofill(fake().jev, input({ attachments: [{ filename: 'photo.jpg', text: '' }] }));
    await expect(photo).rejects.toThrow(/nothing to read:/i);
  });

  it('sends the note and its files as the state, and asks the notebook, the title and each tag once', async () => {
    const { jev, calls } = fake();
    await autofill(jev, input({ note: { title: 'A title', body: 'Body text', tags: ['home'], notebookId: null } }));

    expect(calls).toHaveLength(1);
    const { state, questions } = calls[0]!;
    expect(state).toEqual({
      title: 'A title',
      body: 'Body text',
      attachments: [{ filename: 'scan.pdf', text: receipt }],
    });

    const notebook = questions['notebook'] as JevChoiceQuestion;
    expect(Object.keys(notebook.criteria)).toEqual(['Coupons', 'Receipts', 'none']);
    // A notebook with no purpose carries no purpose key — the model sees exactly what it
    // saw before this field existed.
    expect(notebook.criteria['Coupons']).toEqual({
      what: 'The notebook "Coupons"',
      examples: ['Target 20% off', 'Free coffee card'],
    });
    // A notebook with a purpose hands it to the model alongside the name and fields.
    expect(notebook.criteria['Receipts']).toMatchObject({
      purpose: 'Receipts and invoices for things already bought.',
      fields: expect.arrayContaining(['Vendor', 'Total']),
    });
    // The guidance tells the model to leave a note unfiled rather than force it into a
    // notebook whose purpose does not cover it — the abstain path that keeps a receipt out
    // of a "Shopping" wish list.
    const guidance = JSON.stringify(notebook.instructions);
    expect(guidance).toContain('purpose');
    expect(guidance).toContain('No notebook fits this note');

    const title = questions['title'] as JevChoiceQuestion;
    expect(title.criteria['ACME HARDWARE']).toBe('Line 1 of scan.pdf');
    expect(title.criteria['A title']).toBe('Line 1 of the note');
    expect(title.criteria['none']).toBeDefined();

    // "home" is already on the note, so it is not a suggestion and not a question.
    const tags = Object.entries(questions).filter(([id]) => id.startsWith('tag_'));
    expect(tags).toHaveLength(2);
    expect(tags.map(([, q]) => q.type)).toEqual(['noul', 'noul']);
    const asked = tags.map(([, q]) => JSON.stringify(q.instructions));
    expect(asked.some((text) => text.includes('taxes'))).toBe(true);
    expect(asked.some((text) => text.includes('home'))).toBe(false);
  });

  it('reports which files it read and which are still being read', async () => {
    const { jev } = fake();
    const out = await autofill(
      jev,
      input({
        attachments: [
          { filename: 'scan.pdf', text: receipt },
          { filename: 'later.pdf', text: null },
          { filename: 'blank.pdf', text: '' },
        ],
      }),
    );
    expect(out.read).toEqual({ attachments: ['scan.pdf'], pending: ['later.pdf'] });
  });
});

describe('the title', () => {
  const written = { textFields: noFields, title: vi.fn(async () => 'Acme Hardware invoice, March 2026') };

  it('is written by the language model when there is one, shown the note whole', async () => {
    const { jev } = fake({ title: choice('ACME HARDWARE', 0.9) });
    const out = await autofill(jev, input({ note: { title: 'Untitled scan', body: 'Paid.', tags: [], notebookId: null } }), written);
    expect(out.title).toEqual({ value: 'Acme Hardware Invoice, March 2026' });
    expect(written.title).toHaveBeenCalledWith({
      title: 'Untitled scan',
      body: 'Paid.',
      attachments: [{ filename: 'scan.pdf', text: receipt }],
    });
  });

  it('uses the reader\u2019s own name for a note that is one picture and nothing else, without asking', async () => {
    const reading = 'Acme Plumbing business card\nBusiness card: A card for a plumber.\n\nACME PLUMBING\n(612) 555-0148';
    const lone = input({ attachments: [{ filename: 'card.jpg', text: reading, readBy: 'vision' }] });
    const out = await autofill(fake().jev, lone, written);
    expect(out.title).toEqual({ value: 'Acme Plumbing Business Card' });
    expect(written.title).not.toHaveBeenCalled();

    // A body, a second file, or a title of the person's own is context the reader never
    // saw, so the model is asked.
    const withBody = input({ note: { title: '', body: 'Met at the fair.', tags: [], notebookId: null }, attachments: lone.attachments });
    await autofill(fake().jev, withBody, written);
    expect(written.title).toHaveBeenCalledTimes(1);
    const titled = input({ note: { title: 'Plumber', body: '', tags: [], notebookId: null }, attachments: lone.attachments });
    await autofill(fake().jev, titled, written);
    expect(written.title).toHaveBeenCalledTimes(2);
  });

  it('asks the fields before the title has come back, and collects the title last', async () => {
    let finish!: (title: string) => void;
    const slow = { textFields: noFields, title: vi.fn(() => new Promise<string>((resolve) => (finish = resolve))) };
    const { jev, calls } = fake({ notebook: choice('Receipts') });
    const running = autofill(jev, input(), slow);
    // Both rounds are asked while the title is still being written.
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    finish('Acme Hardware invoice, March 2026');
    expect((await running).title).toEqual({ value: 'Acme Hardware Invoice, March 2026' });
  });

  it('falls back to Jev\u2019s pick of a line, in title case, when the model declines or fails', async () => {
    const { jev } = fake({ title: choice('ACME HARDWARE', 0.7) });
    const declined = { textFields: noFields, title: vi.fn(async () => null) };
    expect((await autofill(jev, input(), declined)).title).toEqual({ value: 'Acme Hardware', confidence: 0.7 });
    const failing = { textFields: noFields, title: vi.fn(async () => { throw new Error('down'); }) };
    expect((await autofill(jev, input(), failing)).title).toEqual({ value: 'Acme Hardware', confidence: 0.7 });
    expect((await autofill(jev, input())).title).toEqual({ value: 'Acme Hardware', confidence: 0.7 });
  });

  it('tells an operator when the title model rejected its key, and no one else', async () => {
    const rejected = { textFields: noFields, title: vi.fn(async () => { throw new LlmError(401, 'invalid x-api-key'); }) };
    // The operator is told, alongside the fallback title \u2014 the fill still succeeds.
    const forOperator = await autofill(fake().jev, input(), rejected, true);
    expect(forOperator.titleModel).toBe('auth-failed');
    // Everyone else sees exactly the silent fallback, no signal.
    const forOther = await autofill(fake().jev, input(), rejected, false);
    expect(forOther.titleModel).toBeUndefined();
  });

  it('stays silent for a passing failure even for an operator', async () => {
    // A rate limit, a 5xx, a timeout (status 0): retrying would work, so Jev's pick stands
    // without crying wolf. Only 401/403 are the standing misconfiguration worth surfacing.
    for (const status of [429, 500, 529, 0]) {
      const flaky = { textFields: noFields, title: vi.fn(async () => { throw new LlmError(status, 'busy'); }) };
      expect((await autofill(fake().jev, input(), flaky, true)).titleModel).toBeUndefined();
    }
    const plain = { textFields: noFields, title: vi.fn(async () => { throw new Error('boom'); }) };
    expect((await autofill(fake().jev, input(), plain, true)).titleModel).toBeUndefined();
  });

  it('does not flag when the model wrote a title despite an operator watching', async () => {
    // No fault to report when the title came back \u2014 auth-failed only rides a fallback.
    const out = await autofill(fake().jev, input(), written, true);
    expect(out.title).toEqual({ value: 'Acme Hardware Invoice, March 2026' });
    expect(out.titleModel).toBeUndefined();
  });
});

describe('what the model answers', () => {
  it('takes the notebook, the title and the likeliest tags that clear the floors', async () => {
    const { jev } = fake({
      notebook: choice('Receipts', 0.8),
      title: choice('ACME HARDWARE', 0.7),
      tag_0: noul(0.9),
      tag_1: noul(0.5),
      tag_2: noul(0.8),
    });
    const out = await autofill(jev, input());
    expect(out.notebook).toEqual({ id: 'nb-receipts', name: 'Receipts', confidence: 0.8 });
    expect(out.title).toEqual({ value: 'Acme Hardware', confidence: 0.7 });
    // Likeliest first; "taxes" at 0.5 is below the floor.
    expect(out.tags).toEqual([
      { name: 'home', confidence: 0.9 },
      { name: 'car', confidence: 0.8 },
    ]);
  });

  it('leaves alone what the model is unsure of, or answers "none" to', async () => {
    const { jev } = fake({ notebook: choice('Receipts', 0.4), title: choice('none', 0.99) });
    const out = await autofill(jev, input());
    expect(out.notebook).toBeUndefined();
    expect(out.title).toBeUndefined();
    expect(out.tags).toEqual([]);
  });

  it('suggests at most a few tags, however many the model likes', async () => {
    const tags = Array.from({ length: 12 }, (_, i) => ({ name: `t${i}`, examples: [] }));
    const script = Object.fromEntries(tags.map((_, i) => [`tag_${i}`, noul(0.8 + i / 100)]));
    const out = await autofill(fake(script).jev, input({ tags }));
    expect(out.tags).toHaveLength(MAX_SUGGESTED_TAGS);
    expect(out.tags[0]?.name).toBe('t11');
  });

  it('never answers with a notebook it was not given', async () => {
    const out = await autofill(fake({ notebook: choice('Somewhere else', 0.99) }).jev, input());
    expect(out.notebook).toBeUndefined();
  });
});

describe('the fields', () => {
  it('asks the chosen notebook’s fields in a second round, each by its type', async () => {
    const { jev, calls } = fake({ notebook: choice('Receipts') });
    await autofill(jev, input());

    expect(calls).toHaveLength(2);
    const { questions } = calls[1]!;
    const byName = (i: number) => questions[`field_${i}`];

    // Vendor, a text field: the document's lines.
    const vendor = byName(0) as JevChoiceQuestion;
    expect(vendor.type).toBe('choice');
    expect(Object.keys(vendor.criteria)).toContain('ACME HARDWARE');
    expect(Object.keys(vendor.criteria)).toContain('none');

    // Total, an amount: every number that could be one, described as written.
    const total = byName(1) as JevChoiceQuestion;
    expect(Object.keys(total.criteria)).toEqual(
      expect.arrayContaining(['1234.56', '98.76', '1333.32', '4471', 'none']),
    );
    expect(Object.keys(total.criteria)).not.toContain('0148');
    expect(total.criteria['1234.56']).toBe('As written: $1,234.56');

    // Invoice date: every date, as ISO, described as written.
    const date = byName(2) as JevChoiceQuestion;
    expect(Object.keys(date.criteria)).toEqual(['2026-03-04', '2026-03-18', 'none']);
    expect(date.criteria['2026-03-18']).toBe('As written: March 18, 2026');

    // Kind, a select: its options.
    const kind = byName(3) as JevChoiceQuestion;
    expect(Object.keys(kind.criteria)).toEqual(['Hardware', 'Grocery', 'none']);

    // Paid, a checkbox: one yes/no. Paid via, a multi-select: one per option.
    expect(byName(4)?.type).toBe('noul');
    expect(questions['field_5_0']?.type).toBe('noul');
    expect(questions['field_5_2']?.type).toBe('noul');

    // A rating is never asked about.
    expect(byName(6)).toBeUndefined();

    // Contact, an email: the addresses in the text.
    const mail = byName(7) as JevChoiceQuestion;
    expect(Object.keys(mail.criteria)).toEqual(['billing@acme.example', 'none']);
  });

  it('turns the answers into values the fields can hold', async () => {
    const { jev } = fake({
      notebook: choice('Receipts'),
      field_0: choice('ACME HARDWARE', 0.85),
      field_1: choice('1333.32', 0.9),
      field_2: choice('2026-03-04', 0.6),
      field_3: choice('Hardware', 0.95),
      field_4: noul(0.8),
      field_5_0: noul(0.9),
      field_5_1: noul(0.1),
      field_5_2: noul(0.76),
      field_7: choice('billing@acme.example', 0.9),
    });
    const out = await autofill(jev, input());
    expect(out.fields.map((f) => [f.field.name, f.value, f.confidence])).toEqual([
      ['Vendor', 'ACME HARDWARE', 0.85],
      ['Total', 1333.32, 0.9],
      ['Invoice date', '2026-03-04', 0.6],
      ['Kind', 'Hardware', 0.95],
      ['Paid', true, 0.8],
      // The list's confidence is its least certain member's.
      ['Paid via', ['Card', 'Check'], 0.76],
      ['Contact', 'billing@acme.example', 0.9],
    ]);
    // The definition rides along, so a client can store the value before it has loaded it.
    expect(out.fields[1]?.field).toMatchObject({ id: 'f-total', type: 'number', currency: 'USD' });
  });

  it('fills the note’s own notebook’s fields when the model has no opinion on the notebook', async () => {
    const { jev, calls } = fake({ field_3: choice('Grocery') });
    const out = await autofill(jev, input({ note: { title: '', body: '', tags: [], notebookId: 'nb-receipts' } }));
    expect(calls).toHaveLength(2);
    expect(out.notebook).toBeUndefined();
    expect(out.fields).toEqual([{ field: receipts.fields[3], value: 'Grocery', confidence: 0.9 }]);
  });

  it('asks no second round for a notebook with no fields', async () => {
    const { jev, calls } = fake({ notebook: choice('Coupons') });
    const out = await autofill(jev, input());
    expect(calls).toHaveLength(1);
    expect(out.fields).toEqual([]);
  });

  it('drops an answer the field could not hold', async () => {
    // An option retired between the question and the answer, and a key never offered.
    const { jev } = fake({ notebook: choice('Receipts'), field_3: choice('Sundries'), field_1: choice('lots') });
    const out = await autofill(jev, input());
    expect(out.fields).toEqual([]);
  });
});

describe('text fields the language model writes (MAK-174)', () => {
  // A letterhead the vendor is a few words of, and an order number behind its label.
  const sale = [
    'Thank you for shopping at Acme Rentals Store #4471, 100 Example Rd',
    'Order number: 112-0042',
    'Total $141.80',
  ].join('\n');
  const rentals: AutofillInput['notebooks'][number] = {
    ...receipts,
    fields: [
      field({ id: 'f-vendor', name: 'Vendor', type: 'text', notebookId: 'nb-receipts' }),
      field({ id: 'f-total', name: 'Total', type: 'number', notebookId: 'nb-receipts' }),
      field({ id: 'f-order', name: 'Order number', type: 'text', notebookId: 'nb-receipts' }),
    ],
  };
  const filed = (over: Partial<AutofillInput> = {}) =>
    input({
      note: { title: '', body: '', tags: [], notebookId: 'nb-receipts' },
      attachments: [{ filename: 'sale.pdf', text: sale }],
      notebooks: [rentals],
      ...over,
    });
  const model = (answer: Record<string, string> | null | Error) => ({
    title: vi.fn(async () => null),
    textFields: vi.fn(async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    }),
  });

  it('asks the model for the text fields only, shown the note', async () => {
    const { jev } = fake();
    const llm = model({});
    await autofill(jev, filed(), llm);
    expect(llm.textFields).toHaveBeenCalledWith(
      expect.objectContaining({ attachments: [{ filename: 'sale.pdf', text: sale }] }),
      [
        { key: 'field_0', name: 'Vendor' },
        { key: 'field_1', name: 'Order number' },
      ],
    );
  });

  it('takes the part of a line that is the value, in place of Jev\u2019s whole line', async () => {
    const { jev } = fake({
      field_0: choice('Thank you for shopping at Acme Rentals Store #4471, 100 Example Rd', 0.85),
      field_1: choice('141.8', 0.9),
    });
    const out = await autofill(jev, filed(), model({ field_0: 'ACME RENTALS', field_1: '112-0042' }));
    expect(out.fields.map((f) => [f.field.name, f.value, f.confidence])).toEqual([
      // As the model copied it; found in the document without regard to case.
      ['Vendor', 'ACME RENTALS', undefined],
      ['Total', 141.8, 0.9],
      // Jev picked no line for it, and the written value fills it.
      ['Order number', '112-0042', undefined],
    ]);
  });

  it('drops a value the document does not contain, and Jev\u2019s pick stands', async () => {
    const line = 'Thank you for shopping at Acme Rentals Store #4471, 100 Example Rd';
    const { jev } = fake({ field_0: choice(line, 0.85) });
    for (const invented of ['Acme Rentals LLC', 'Rent', 'ntals Sto', '44']) {
      const out = await autofill(jev, filed(), model({ field_0: invented, field_1: '' }));
      expect(out.fields).toEqual([{ field: rentals.fields[0], value: line, confidence: 0.85 }]);
    }
    // A value with marks of its own still matches whole: the escaping is not a filter.
    const out = await autofill(jev, filed(), model({ field_0: 'Store #4471,', field_1: '' }));
    expect(out.fields[0]?.value).toBe('Store #4471,');
  });

  it('falls back to Jev\u2019s picks when the model fails or declines', async () => {
    for (const answer of [new Error('down'), null]) {
      const { jev } = fake({ field_2: choice('112-0042', 0.8) });
      const out = await autofill(jev, filed(), model(answer));
      expect(out.fields).toEqual([{ field: rentals.fields[2], value: '112-0042', confidence: 0.8 }]);
    }
  });

  it('is asked even when Jev has nothing to choose from, and fills the field alone', async () => {
    // One paragraph as one long line: too long to offer, so Jev gets no question at all.
    const prose =
      'We were glad to welcome you at Acme Rentals today and hope the truck served you well on your move across town this weekend.';
    const { jev, calls } = fake();
    const vendorOnly = { ...rentals, fields: [rentals.fields[0]!] };
    const out = await autofill(
      jev,
      filed({ attachments: [{ filename: 'letter.pdf', text: prose }], notebooks: [vendorOnly] }),
      model({ field_0: 'Acme Rentals' }),
    );
    expect(calls).toHaveLength(1);
    expect(out.fields).toEqual([{ field: rentals.fields[0], value: 'Acme Rentals' }]);
  });

  it('is not asked when the notebook has no text fields', async () => {
    const { jev } = fake();
    const llm = model({});
    await autofill(jev, input({ note: { title: '', body: '', tags: [], notebookId: 'nb-receipts' }, notebooks: [{ ...receipts, fields: receipts.fields.filter((f) => f.type !== 'text') }] }), llm);
    expect(llm.textFields).not.toHaveBeenCalled();
  });
});

describe('the candidates the code finds', () => {
  it('offers what follows a short label as a text value of its own', () => {
    const lines = candidateLines([
      { text: 'Order number: 112-0042\nhttps://acme.example/pay\nWe will be in touch about it: soon, we promise you, really', where: 'scan.pdf' },
    ]);
    const keys = labelledValues(lines).map((o) => o.key);
    expect(keys).toEqual([
      'Order number: 112-0042',
      '112-0042',
      'https://acme.example/pay',
      'We will be in touch about it: soon, we promise you, really',
      'soon, we promise you, really',
    ]);
    expect(labelledValues(lines)[1]?.description).toBe('After "Order number:" in Line 1 of scan.pdf');
  });

  it('never drops a line to make room for a value', () => {
    const text = Array.from({ length: 80 }, (_, i) => `Item ${i}: thing ${i}`).join('\n');
    const lines = candidateLines([{ text, where: 'scan.pdf' }]);
    const keys = labelledValues(lines).map((o) => o.key);
    for (const line of lines) expect(keys).toContain(line.key);
  });

  it('reads dates however the document writes them, once each', () => {
    const found = findDates('Paid 2026-03-04, due 3/18/26 and again on March 18, 2026; 25.12.2025; 4th Feb 2026; 13/13/2026');
    expect(found.map((o) => o.key)).toEqual(['2026-03-04', '2026-03-18', '2025-12-25', '2026-02-04']);
    expect(found[1]?.description).toBe('As written: 3/18/26');
  });

  it('reads numbers that could be amounts, and not the ones that are something else', () => {
    const found = findNumbers('Total $1,333.32 on 03/04/2026 at 10:30, ref 1234567890123, qty 3, tax 98.76, tel 612-555-0148');
    expect(found.map((o) => o.value)).toEqual([1333.32, 98.76, 3]);
  });

  it('reads addresses, links and phone numbers', () => {
    expect(findEmails('Write to Billing@acme.example or billing@acme.example').map((o) => o.key)).toEqual([
      'Billing@acme.example',
    ]);
    expect(findUrls('See https://acme.example/pay. Or www.acme.example/help, thanks').map((o) => o.value)).toEqual([
      'https://acme.example/pay',
      'https://www.acme.example/help',
    ]);
    expect(findPhones('Call (612) 555-0148 or +1 612.555.0148 or 612-555-0199').map((o) => o.key)).toEqual([
      '(612) 555-0148',
      '612-555-0199',
    ]);
  });

  it('offers the document’s lines as they read, without markdown or noise', () => {
    const lines = candidateLines([
      { text: '# Acme Hardware\n\n- **Invoice** 4471\n![scan](files/scan.png)\n12345\nab\nnone\nAcme hardware', where: 'the note' },
    ]);
    expect(lines.map((o) => o.key)).toEqual(['Acme Hardware', 'Invoice** 4471']);
    expect(lines[0]?.description).toBe('Line 1 of the note');
  });
});
