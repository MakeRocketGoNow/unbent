import type { LlmJob } from '@unbent/shared';
import type { UsageEntry } from '../store/llm-usage.js';
import { LlmError, type LanguageModel, type LlmUsage, type Metered } from './llm.js';

/**
 * The Worker's half of the usage counter (MAK-180): the cap an instance sets, the
 * sentence a refused press is answered with, and the log a press keeps of what the model
 * cost it. The store's half — the table, the check and the count — is store/llm-usage.ts.
 */

export interface UsageEnv {
  /**
   * The most Auto-fill presses one account may make in a UTC day; a press past it is
   * answered 429. Unset — every instance until a number is chosen with the plans' pricing
   * (MAK-108) — enforces nothing, though every press is still counted. The variable exists
   * so that the number is one deploy away. Not an allowance: this is the guard against a
   * press sent in a loop, which a price cannot absorb, and holds whatever the plan.
   */
  AUTOFILL_DAILY_CAP?: string;
}

/**
 * The cap, or null for none. Anything but a whole number of at least one is none, and
 * says so in the log: a typo in a variable must not turn into a cap of zero that refuses
 * every press on the instance.
 */
export function dailyCap(env: UsageEnv): number | null {
  const raw = env.AUTOFILL_DAILY_CAP?.trim();
  if (!raw) return null;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    console.warn(`AUTOFILL_DAILY_CAP is not a whole number above zero ("${raw}"); no cap is enforced`);
    return null;
  }
  return Number(raw);
}

/**
 * What the button says when a press is refused, and how long until it may press again.
 * The day is UTC, which is nobody's midnight in particular, so the sentence names the
 * hours rather than "tomorrow": at seven in the evening in California, "tomorrow" would
 * be wrong by the evening.
 */
export function capReached(cap: number, now: number): { message: string; retryAfter: number } {
  const midnight = new Date(now);
  midnight.setUTCHours(24, 0, 0, 0);
  const seconds = Math.max(1, Math.ceil((midnight.getTime() - now) / 1000));
  const hours = Math.ceil(seconds / 3600);
  const when = hours <= 1 ? 'within the hour' : `in ${hours} hours`;
  const presses = cap === 1 ? 'once a day' : `${cap} times a day`;
  return {
    message: `Auto-fill can be used ${presses} on this instance, and today's are used up. It will work again ${when}.`,
    retryAfter: seconds,
  };
}

/** One model answer as the store counts it. */
export function usageEntry(job: LlmJob, usage: LlmUsage): UsageEntry {
  return { job, ...usage };
}

/**
 * What a press's model calls cost, kept as they answer, for the one store call that
 * records them at the end (`recordLlmUsage`). Readings are not kept here: their cost goes
 * into the transaction that records their text. What is kept is the title and the fields,
 * which have no row of their own to ride with, and any answer that was paid for and then
 * thrown away — a reply cut off at its budget.
 */
export class PressUsage {
  readonly entries: UsageEntry[] = [];

  /** Keeps a thrown call's cost, when the API had billed for it, and rethrows. */
  failed(job: LlmJob, err: unknown): never {
    if (err instanceof LlmError && err.usage) this.entries.push(usageEntry(job, err.usage));
    throw err;
  }

  /**
   * The model, with every title and fields answer counted here on its way through, paid
   * for or failed. Auto-fill reads only the values; this is what lets it stay unaware of
   * the counter, and what makes a stand-in in a test count exactly as the real model does.
   */
  metering<M extends Pick<LanguageModel, 'title' | 'textFields'>>(llm: M): Pick<LanguageModel, 'title' | 'textFields'> {
    const through = async <T>(job: LlmJob, call: () => Promise<Metered<T>>): Promise<Metered<T>> => {
      let answer: Metered<T>;
      try {
        answer = await call();
      } catch (err) {
        return this.failed(job, err);
      }
      this.entries.push(usageEntry(job, answer.usage));
      return answer;
    };
    return {
      title: (note) => through('title', () => llm.title(note)),
      textFields: (note, fields) =>
        // No fields means no request, and nothing to count.
        fields.length === 0 ? llm.textFields(note, fields) : through('fields', () => llm.textFields(note, fields)),
    };
  }
}
