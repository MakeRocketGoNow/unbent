import { describe, expect, it, vi } from 'vitest';
import type { FieldDef } from '@unbent/shared';
import { press, type PressDeps } from './autofill-press.js';
import type { Jev } from './jev.js';
import { LlmError, type LanguageModel, type LlmUsage } from './llm.js';
import { capReached, dailyCap } from './llm-usage.js';

/** A Jev with no opinion about anything: what is counted here is the model, not the filing. */
const jev: Jev = {
  async ask(_state, questions) {
    return Object.fromEntries(
      Object.entries(questions).map(([id, q]) => [
        id,
        q.type === 'choice' ? { type: 'choice', choice: 'none', probabilities: {}, confidence: 0.9 } : { type: 'noul', noul: 0.1 },
      ]),
    );
  },
};

const cost = (inputTokens: number, outputTokens: number): LlmUsage => ({
  model: 'stand-in',
  inputTokens,
  outputTokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

const vendor: FieldDef = {
  id: 'f-vendor',
  notebookId: 'nb-receipts',
  name: 'Vendor',
  type: 'text',
  options: [],
  scale: null,
  currency: null,
  position: 0,
};

const note = { id: 'n1', title: '', body: 'Paid at Acme Hardware.', tags: [], notebookId: 'nb-receipts' };
const photo = { id: 'a1', noteId: 'n1', filename: 'card.jpg', contentType: 'image/jpeg', size: 100, r2Key: 'k', writtenBy: null };

/**
 * A press against stand-ins for every part of it: a store that answers with one note, one
 * picture to read and a notebook with one text field, and a model that answers each job
 * at a cost of its own. `today` is the presses the day has had before this one.
 */
function setup(opts: { cap?: number | null; today?: number; jev?: Jev | null; title?: LanguageModel['title'] } = {}) {
  let today = opts.today ?? 0;
  const recordText = vi.fn(async () => {});
  const recordLlmUsage = vi.fn(async () => {});
  const autofillPrelude = vi.fn(async (_id: string, _n: number, counting?: { cap: number | null }) => {
    if (!counting) return { note, forText: [], forVision: [photo], press: null };
    if (counting.cap !== null && today >= counting.cap) return { note, forText: [], forVision: [], press: { allowed: false, today } };
    today += 1;
    return { note, forText: [], forVision: [photo], press: { allowed: true, today } };
  });
  const deps: PressDeps = {
    notes: {
      autofillPrelude,
      autofillContext: async () => ({
        files: [{ filename: 'card.jpg', contentType: 'image/jpeg', text: 'Acme Hardware receipt', readBy: 'vision' }],
        notebooks: [{ id: 'nb-receipts', name: 'Receipts', purpose: null }],
        fields: [vendor],
        examples: { notebooks: new Map(), tags: [] },
      }),
      recordLlmUsage,
    } as unknown as PressDeps['notes'],
    attachments: { recordText },
    blobs: { get: async () => ({ arrayBuffer: async () => new ArrayBuffer(8) }) },
    readers: {
      llm: {
        read: async () => ({
          value: { name: 'Acme Hardware receipt', kind: 'receipt', description: 'A receipt.', text: 'ACME HARDWARE' },
          usage: cost(1500, 300),
        }),
      },
    },
    jev: opts.jev === undefined ? jev : opts.jev,
    llm: {
      title: opts.title ?? (async () => ({ value: 'Acme Hardware Receipt', usage: cost(400, 20) })),
      textFields: async () => ({ value: { field_0: 'Acme Hardware' }, usage: cost(450, 30) }),
    },
    cap: opts.cap ?? null,
    operator: false,
    now: Date.UTC(2026, 9, 8, 18, 0),
  };
  return { deps, recordText, recordLlmUsage, autofillPrelude };
}

describe('one press, counted', () => {
  it('counts the press, its reading with the reading, and the title and fields at the end', async () => {
    const { deps, recordText, recordLlmUsage, autofillPrelude } = setup();
    const outcome = await press(deps, 'n1');
    expect(outcome.kind).toBe('filed');

    // The press itself, counted in the call that read the note.
    expect(autofillPrelude).toHaveBeenCalledWith('n1', 5, { cap: null });
    // The reading's cost rides with its text, in one write.
    expect(recordText).toHaveBeenCalledTimes(1);
    expect(recordText).toHaveBeenCalledWith(expect.objectContaining({ attachmentId: 'a1', readBy: 'vision' }), { job: 'read', ...cost(1500, 300) });
    // The title and the fields, in the one call at the end.
    expect(recordLlmUsage).toHaveBeenCalledTimes(1);
    expect(recordLlmUsage).toHaveBeenCalledWith([
      { job: 'title', ...cost(400, 20) },
      { job: 'fields', ...cost(450, 30) },
    ]);
  });

  it('refuses a press past the day’s cap, with a sentence the button can show, and reads nothing', async () => {
    const { deps, recordText, recordLlmUsage } = setup({ cap: 3, today: 3 });
    const outcome = await press(deps, 'n1');
    expect(outcome).toEqual({ kind: 'capped', ...capReached(3, deps.now!) });
    expect(outcome.kind === 'capped' && outcome.message).toBe(
      'Auto-fill can be used 3 times a day on this instance, and today’s are used up. It will work again in 6 hours.'.replace('’', "'"),
    );
    expect(recordText).not.toHaveBeenCalled();
    expect(recordLlmUsage).not.toHaveBeenCalled();

    // The last one under the cap still goes through.
    expect((await press(setup({ cap: 3, today: 2 }).deps, 'n1')).kind).toBe('filed');
  });

  it('counts nothing on an instance with no Jev, and answers 404 before 503', async () => {
    const { deps, autofillPrelude, recordLlmUsage } = setup({ jev: null });
    expect(await press(deps, 'n1')).toEqual({ kind: 'unconfigured' });
    expect(autofillPrelude).toHaveBeenCalledWith('n1', 5, undefined);
    expect(recordLlmUsage).not.toHaveBeenCalled();

    const missing = setup({ jev: null });
    missing.deps.notes.autofillPrelude = async () => null;
    expect(await press(missing.deps, 'n1')).toEqual({ kind: 'missing' });
  });

  it('still records what was paid for when the title was cut off', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { deps, recordLlmUsage } = setup({
      title: async () => {
        throw new LlmError(0, 'ran out of room', cost(400, 1024));
      },
    });
    expect((await press(deps, 'n1')).kind).toBe('filed');
    expect(recordLlmUsage).toHaveBeenCalledWith([
      { job: 'title', ...cost(400, 1024) },
      { job: 'fields', ...cost(450, 30) },
    ]);
    quiet.mockRestore();
  });
});

describe('the cap', () => {
  it('is a whole number above zero, or none', () => {
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(dailyCap({})).toBeNull();
    expect(dailyCap({ AUTOFILL_DAILY_CAP: '' })).toBeNull();
    expect(dailyCap({ AUTOFILL_DAILY_CAP: ' 50 ' })).toBe(50);
    // A typo is no cap, never a cap of zero that refuses every press.
    for (const typo of ['0', '-5', '5.5', 'fifty', '50x']) expect(dailyCap({ AUTOFILL_DAILY_CAP: typo })).toBeNull();
    quiet.mockRestore();
  });

  it('says how long until the next UTC day, in hours', () => {
    const late = Date.UTC(2026, 9, 8, 23, 30);
    expect(capReached(1, late)).toEqual({
      message: "Auto-fill can be used once a day on this instance, and today's are used up. It will work again within the hour.",
      retryAfter: 1800,
    });
    expect(capReached(20, Date.UTC(2026, 9, 8, 0, 0)).message).toContain('in 24 hours');
  });
});
