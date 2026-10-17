import { describe, expect, it, vi } from 'vitest';
import type { FieldDef } from '@unbent/shared';
import { press, type PressDeps } from './autofill-press.js';
import type { Jev } from './jev.js';
import { LlmError, type LanguageModel, type LlmUsage } from './llm.js';
import { capFor, capReached, dailyCap, limitsFor, trialDailyCap, yearlyCentsFor, yearReached } from './llm-usage.js';
import type { PressLimits } from '../store/llm-usage.js';
import type { PlanRow } from './plan.js';

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
function setup(
  opts: { cap?: number | null; yearlyCents?: number | null; spentCents?: number; today?: number; jev?: Jev | null; title?: LanguageModel['title'] } = {},
) {
  let today = opts.today ?? 0;
  const recordText = vi.fn(async () => {});
  const recordLlmUsage = vi.fn(async () => {});
  // The store's check, as store/llm-usage.ts makes it: the day first, then the year's spend.
  const autofillPrelude = vi.fn(async (_id: string, _n: number, counting?: PressLimits) => {
    if (!counting) return { note, forText: [], forVision: [photo], press: null };
    if (counting.cap !== null && today >= counting.cap) return { note, forText: [], forVision: [], press: { allowed: false, today, reason: 'day' as const } };
    if (counting.yearlyCents !== null && (opts.spentCents ?? 0) >= counting.yearlyCents) {
      return { note, forText: [], forVision: [], press: { allowed: false, today, reason: 'year' as const } };
    }
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
    limits: { cap: opts.cap ?? null, yearlyCents: opts.yearlyCents ?? null },
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
    expect(autofillPrelude).toHaveBeenCalledWith('n1', 5, { cap: null, yearlyCents: null });
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
      "Auto-fill can be used 3 times a day on this instance, and today's are used up. It will work again in 6 hours.",
    );
    expect(recordText).not.toHaveBeenCalled();
    expect(recordLlmUsage).not.toHaveBeenCalled();

    // The last one under the cap still goes through.
    expect((await press(setup({ cap: 3, today: 2 }).deps, 'n1')).kind).toBe('filed');
  });

  it('refuses a press past the year’s spend with a sentence that names no money, and reads nothing', async () => {
    const { deps, recordText, recordLlmUsage } = setup({ yearlyCents: 300, spentCents: 300 });
    const outcome = await press(deps, 'n1');
    expect(outcome).toEqual({ kind: 'capped', ...yearReached(deps.now!) });
    expect(outcome.kind === 'capped' && outcome.message).toBe(
      "This year's included Auto-fill has been used up on this account. It will work again on 1 January.",
    );
    expect(outcome.kind === 'capped' && outcome.message).not.toMatch(/\$|cent|dollar/);
    expect(recordText).not.toHaveBeenCalled();
    expect(recordLlmUsage).not.toHaveBeenCalled();

    // A cent under the cap still goes through, and the day's refusal comes first.
    expect((await press(setup({ yearlyCents: 300, spentCents: 299.5 }).deps, 'n1')).kind).toBe('filed');
    const both = await press(setup({ cap: 1, today: 1, yearlyCents: 300, spentCents: 300 }).deps, 'n1');
    expect(both.kind === 'capped' && both.message).toMatch(/^Auto-fill can be used once a day/);
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

describe('a press that fails', () => {
  it('still counts a title that answers after Jev has failed, and records once it has', async () => {
    let finish!: () => void;
    const late = new Promise<void>((resolve) => (finish = resolve));
    const down: Jev = {
      async ask() {
        throw new Error('Jev is down');
      },
    };
    const { deps, recordLlmUsage } = setup({
      jev: down,
      title: async () => {
        await late;
        return { value: 'Acme Hardware Receipt', usage: cost(400, 20) };
      },
    });
    const deferred: Promise<unknown>[] = [];
    deps.defer = (work) => deferred.push(work);

    // The press answers with Jev's error without waiting for the title...
    await expect(press(deps, 'n1')).rejects.toThrow('Jev is down');
    expect(recordLlmUsage).not.toHaveBeenCalled();
    // ...and what the title cost is recorded once it has answered, after the response.
    finish();
    await Promise.all(deferred);
    expect(recordLlmUsage).toHaveBeenCalledWith([{ job: 'title', ...cost(400, 20) }]);
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

  it('names the setting it warns about', () => {
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Each setting is warned about once per isolate, so the count depends on what ran
    // before this; the line's shape does not.
    dailyCap({ AUTOFILL_DAILY_CAP: 'x' });
    trialDailyCap({ AUTOFILL_TRIAL_DAILY_CAP: 'y' });
    const lines = quiet.mock.calls.map((c) => String(c[0]));
    expect(lines.every((l) => /^AUTOFILL_(TRIAL_)?DAILY_CAP is not a whole number above zero/.test(l))).toBe(true);
    quiet.mockRestore();
  });

  describe('by plan', () => {
    const paddle = {
      PADDLE_API_KEY: 'pdl_sdbx_apikey_x',
      PADDLE_WEBHOOK_SECRET: 's',
      PADDLE_CLIENT_TOKEN: 't',
      PADDLE_PLAN_PRICE_ID: 'p',
      PADDLE_STORAGE_PRICE_ID: 'q',
    };
    const now = Date.UTC(2026, 9, 16, 12, 0);
    const day = 24 * 60 * 60 * 1000;
    const trial = { plan: 'trial', planUntil: now + 10 * day, source: null, paddleStatus: null, paddleCancelsAt: null } as PlanRow;
    const paying = { plan: 'active', planUntil: now + 300 * day, source: 'paddle', paddleStatus: 'active', paddleCancelsAt: null } as PlanRow;
    const comped = { plan: 'active', planUntil: null, source: 'comp', paddleStatus: null, paddleCancelsAt: null } as PlanRow;
    const both = { ...paddle, AUTOFILL_DAILY_CAP: '1000', AUTOFILL_TRIAL_DAILY_CAP: '100' };

    it('gives a trial the trial cap and everyone else the ordinary one', () => {
      expect(capFor(both, trial, now)).toBe(100);
      expect(capFor(both, paying, now)).toBe(1000);
      expect(capFor(both, comped, now)).toBe(1000);
      // A trial that has run out is inactive, which the plan gate refuses before the
      // press is counted; the cap it would get is the ordinary one all the same.
      expect(capFor(both, { ...trial, planUntil: now - day }, now)).toBe(1000);
    });

    it('reads a missing row as the trial it is about to become', () => {
      expect(capFor(both, undefined, now)).toBe(100);
      expect(capFor(both, null, now)).toBe(100);
    });

    it('falls back to the ordinary cap where the trial cap is unset or mistyped', () => {
      const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(capFor({ ...paddle, AUTOFILL_DAILY_CAP: '1000' }, trial, now)).toBe(1000);
      expect(capFor({ ...paddle, AUTOFILL_DAILY_CAP: '1000', AUTOFILL_TRIAL_DAILY_CAP: 'lots' }, trial, now)).toBe(1000);
      expect(capFor({ ...paddle, AUTOFILL_DAILY_CAP: '1000', AUTOFILL_TRIAL_DAILY_CAP: '0' }, trial, now)).toBe(1000);
      // A trial cap on its own caps the trial and nobody else.
      expect(capFor({ ...paddle, AUTOFILL_TRIAL_DAILY_CAP: '100' }, trial, now)).toBe(100);
      expect(capFor({ ...paddle, AUTOFILL_TRIAL_DAILY_CAP: '100' }, paying, now)).toBeNull();
      quiet.mockRestore();
    });

    it('is the ordinary cap for every account where billing is off', () => {
      expect(capFor({ AUTOFILL_DAILY_CAP: '1000', AUTOFILL_TRIAL_DAILY_CAP: '100' }, undefined, now)).toBe(1000);
      expect(capFor({ AUTOFILL_DAILY_CAP: '1000', AUTOFILL_TRIAL_DAILY_CAP: '100' }, trial, now)).toBe(1000);
      expect(capFor({ AUTOFILL_TRIAL_DAILY_CAP: '100' }, trial, now)).toBeNull();
    });

    it('refuses at the number the account was given', () => {
      expect(capReached(capFor(both, trial, now)!, now).message).toMatch(/^Auto-fill can be used 100 times a day/);
      expect(capReached(capFor(both, paying, now)!, now).message).toMatch(/^Auto-fill can be used 1000 times a day/);
    });

    it('chooses the year’s spend cap the same way, with the same fallback', () => {
      const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const cents = { ...paddle, AUTOFILL_YEARLY_CENTS: '5000', AUTOFILL_TRIAL_YEARLY_CENTS: '300' };
      expect(yearlyCentsFor(cents, trial, now)).toBe(300);
      expect(yearlyCentsFor(cents, paying, now)).toBe(5000);
      expect(yearlyCentsFor(cents, comped, now)).toBe(5000);
      expect(yearlyCentsFor({ ...paddle, AUTOFILL_YEARLY_CENTS: '5000' }, trial, now)).toBe(5000);
      expect(yearlyCentsFor({ ...paddle, AUTOFILL_YEARLY_CENTS: '5000', AUTOFILL_TRIAL_YEARLY_CENTS: 'three' }, trial, now)).toBe(5000);
      expect(yearlyCentsFor({ ...paddle }, trial, now)).toBeNull();
      // Billing off: the ordinary number for everyone, and the trial's never read.
      expect(yearlyCentsFor({ AUTOFILL_YEARLY_CENTS: '5000', AUTOFILL_TRIAL_YEARLY_CENTS: '300' }, trial, now)).toBe(5000);
      // Both limits at once, as the press is handed them.
      expect(limitsFor({ ...both, ...cents }, trial, now)).toEqual({ cap: 100, yearlyCents: 300 });
      expect(limitsFor({ ...both, ...cents }, paying, now)).toEqual({ cap: 1000, yearlyCents: 5000 });
      expect(limitsFor({}, undefined, now)).toEqual({ cap: null, yearlyCents: null });
      quiet.mockRestore();
    });
  });

  it('says when the year’s Auto-fill returns, in seconds to 1 January UTC', () => {
    const { message, retryAfter } = yearReached(Date.UTC(2026, 11, 31, 23, 0));
    expect(message).toBe("This year's included Auto-fill has been used up on this account. It will work again on 1 January.");
    expect(retryAfter).toBe(3600);
    expect(yearReached(Date.UTC(2026, 0, 1, 0, 0)).retryAfter).toBe(365 * 86_400);
  });

  it('says how long until the next UTC day, in hours', () => {
    const late = Date.UTC(2026, 9, 8, 23, 30);
    expect(capReached(1, late)).toEqual({
      message: "Auto-fill can be used once a day on this instance, and today's are used up. It will work again within the hour.",
      retryAfter: 1800,
    });
    expect(capReached(20, Date.UTC(2026, 9, 8, 0, 0)).message).toContain('in 24 hours');
    expect(capReached(2, late).message).toMatch(/^Auto-fill can be used twice a day/);
  });
});
