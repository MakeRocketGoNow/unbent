import { usageCents, type LlmJob, type LlmJobUsage, type LlmTokens } from '@unbent/shared';
import type { Sql } from './sql.js';

/** One answer the model was paid for: the job, the model, and the API's four counts. */
export type UsageEntry = LlmTokens & { job: LlmJob };

/** What a press is checked against: the day's presses and the year's spend, each null for none. */
export interface PressLimits {
  /** The most presses in a UTC day (`AUTOFILL_DAILY_CAP`, or the trial's). */
  cap: number | null;
  /** The most the calendar year's Auto-fill may have cost, in cents (`AUTOFILL_YEARLY_CENTS`, or the trial's). */
  yearlyCents: number | null;
}

/** What a press was told: whether it may go ahead, and how many the day had before it. */
export interface PressCheck {
  allowed: boolean;
  /** Presses counted today, this one included when it was allowed. */
  today: number;
  /** Which limit refused it, when one did: the day's count or the year's spend. */
  reason?: 'day' | 'year';
}

/** The UTC day of `at`, as the table keys it. */
export function usageDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * The language model's cost and the Auto-fill presses, by day (schema 0007, MAK-180).
 *
 * Private helpers in the sense `Sql.tx` means: each runs inside the transaction of the
 * object method that calls it: `add` inside `recordText`'s, so a file's reading and what
 * it cost are written together or not at all. Nothing here records in the change feed;
 * no client holds this.
 *
 * Each write logs a line, `[llm]` the way the `Sql` seam's is `[store]`, with the user id
 * and the counts, so the operator can see a loop in the Worker's log before anyone reads
 * the table.
 */
export class LlmUsageCounter {
  constructor(
    private readonly sql: Sql,
    private readonly userId: string,
  ) {}

  /**
   * Counts a press, unless `cap` presses have been counted today already. The check and
   * the count are one transaction in a single-threaded object, so a loop of presses sent
   * all at once cannot each read the same count and all go through: the press is counted
   * before it runs, not after. A press that is then answered with an error (Jev down,
   * nothing to read) has still been counted. That is the guard working: it caps what can
   * be asked, and a failed press asked as much.
   *
   * A null limit counts and never refuses, which is every instance until it sets
   * `AUTOFILL_DAILY_CAP` or `AUTOFILL_YEARLY_CENTS`.
   *
   * The year's spend is checked after the day's count and only when there is a yearly
   * limit, since it reads the year's rows (`year`: at most one a day per job and model)
   * where the day's check reads one. It is summed from tokens and converted here, at the
   * check, with the price table in `@unbent/shared`; no cents are written to the store,
   * so a price corrected in the table corrects the year's spend at the next press.
   */
  press(limits: PressLimits, at: number): PressCheck {
    const day = usageDay(at);
    const before =
      this.sql.first<{ requests: number }>(
        `SELECT requests FROM llm_usage WHERE day = ?1 AND job = 'press' AND model = ''`,
        day,
      )?.requests ?? 0;
    if (limits.cap !== null && before >= limits.cap) {
      console.warn(`[llm] user=${this.userId} job=press refused today=${before} cap=${limits.cap}`);
      return { allowed: false, today: before, reason: 'day' };
    }
    if (limits.yearlyCents !== null) {
      const spent = this.spentCents(at);
      if (spent >= limits.yearlyCents) {
        console.warn(`[llm] user=${this.userId} job=press refused year=${spent.toFixed(2)} cap=${limits.yearlyCents}`);
        return { allowed: false, today: before, reason: 'year' };
      }
    }
    this.sql.exec(
      `INSERT INTO llm_usage (day, job, model, requests) VALUES (?1, 'press', '', 1)
       ON CONFLICT(day, job, model) DO UPDATE SET requests = requests + 1`,
      day,
    );
    console.log(`[llm] user=${this.userId} job=press today=${before + 1}`);
    return { allowed: true, today: before + 1 };
  }

  /** Adds one answer's tokens to its day, job and model. */
  add(entry: UsageEntry, at: number): void {
    this.sql.exec(
      `INSERT INTO llm_usage (day, job, model, requests, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
       VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6, ?7)
       ON CONFLICT(day, job, model) DO UPDATE SET
         requests = requests + 1,
         input_tokens = input_tokens + excluded.input_tokens,
         output_tokens = output_tokens + excluded.output_tokens,
         cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
         cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens`,
      usageDay(at),
      entry.job,
      entry.model,
      entry.inputTokens,
      entry.outputTokens,
      entry.cacheReadTokens,
      entry.cacheWriteTokens,
    );
    console.log(
      `[llm] user=${this.userId} job=${entry.job} model=${entry.model} in=${entry.inputTokens} out=${entry.outputTokens} cacheRead=${entry.cacheReadTokens} cacheWrite=${entry.cacheWriteTokens}`,
    );
  }

  /** What the calendar year of `at` has cost so far, in cents, by the price table. */
  spentCents(at: number): number {
    const { presses, models } = this.year(at);
    return usageCents(presses, models);
  }

  /**
   * The calendar year of `at`, UTC: presses, today's presses, and the tokens by job and
   * model. A range on the primary key, so it reads the year's rows (at most four a day)
   * and none of another year's.
   */
  year(at: number): { year: number; presses: number; today: number; models: LlmJobUsage[] } {
    const year = new Date(at).getUTCFullYear();
    const today = usageDay(at);
    const rows = this.sql.exec<{
      day: string;
      job: string;
      model: string;
      requests: number;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
    }>(
      `SELECT day, job, model, requests, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
         FROM llm_usage
        WHERE day >= ?1 AND day < ?2`,
      `${year}-01-01`,
      `${year + 1}-01-01`,
    );
    let presses = 0;
    let pressesToday = 0;
    const models = new Map<string, LlmJobUsage>();
    for (const row of rows) {
      if (row.job === 'press') {
        presses += row.requests;
        if (row.day === today) pressesToday += row.requests;
        continue;
      }
      const key = `${row.job}\u001F${row.model}`;
      const sum =
        models.get(key) ??
        { job: row.job as LlmJob, model: row.model, requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      sum.requests += row.requests;
      sum.inputTokens += row.input_tokens;
      sum.outputTokens += row.output_tokens;
      sum.cacheReadTokens += row.cache_read_tokens;
      sum.cacheWriteTokens += row.cache_write_tokens;
      models.set(key, sum);
    }
    return { year, presses, today: pressesToday, models: [...models.values()] };
  }
}
