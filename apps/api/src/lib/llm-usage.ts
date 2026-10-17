import type { LlmJob } from '@unbent/shared';
import type { PressLimits, UsageEntry } from '../store/llm-usage.js';
import { LlmError, type LanguageModel, type LlmUsage, type Metered } from './llm.js';
import { billingOn, type PaddleEnv } from './paddle.js';
import { planFor, planStateOf, type PlanRow } from './plan.js';

/**
 * The Worker's half of the usage counter (MAK-180): the cap an instance sets, the
 * sentence a refused press is answered with, and the log a press keeps of what the model
 * cost it. The store's half (the table, the check and the count) is store/llm-usage.ts.
 */

export interface UsageEnv extends PaddleEnv {
  /**
   * The most Auto-fill presses one account may make in a UTC day; a press past it is
   * answered 429. Unset, every instance until a number is chosen with the plans' pricing
   * (MAK-108), enforces nothing, though every press is still counted. The variable exists
   * so that the number is one deploy away. Not an allowance: this is the guard against a
   * press sent in a loop, which a price cannot absorb, and holds whatever the plan.
   */
  AUTOFILL_DAILY_CAP?: string;
  /**
   * The same ceiling for an account on its trial, where the instance sells a plan. Unset,
   * a trial account gets `AUTOFILL_DAILY_CAP` like everyone else.
   *
   * A per-account cap alone does nothing against throwaway accounts: a trial is free and
   * asks for no card, and email sign-in accepts any address, so the ordinary cap bounds
   * one account's day and nothing bounds how many accounts a day someone makes. The
   * ordinary number is sized for a person with an archive to file and a Paddle customer
   * record behind them; this one is sized for what a fortnight's free account may spend
   * before it is a customer, so a hundred of them made in a loop cost a hundred times
   * this number and not a hundred times the paying one. Where billing is off there is no
   * trial, and this setting is never read.
   */
  AUTOFILL_TRIAL_DAILY_CAP?: string;
  /**
   * The most one account's Auto-fill may cost the instance in a calendar year, in
   * cents, summed from the tokens the counter records and priced with the table in
   * `@unbent/shared` (`usageCents`); a press past it is answered 429 until 1 January.
   * The daily cap bounds a loop; this bounds the year a loop never quite trips it on,
   * and what a press that reads a stack of scans on a dear model adds up to. Unset
   * enforces nothing. unbent.app sets 5000 (fifty dollars): more than the plan costs,
   * and well under what a hundred days at the daily cap could reach.
   */
  AUTOFILL_YEARLY_CENTS?: string;
  /**
   * The same for an account on its trial, for the reason `AUTOFILL_TRIAL_DAILY_CAP`
   * gives: a trial is free to make, so its ceiling has to be one a loop of trials
   * cannot multiply into a bill. Unset, a trial gets `AUTOFILL_YEARLY_CENTS`. unbent.app
   * sets 300 (three dollars), about the cost of filing a fortnight's worth of scans.
   */
  AUTOFILL_TRIAL_YEARLY_CENTS?: string;
}

/** The four settings `parseCap` reads, each a whole number or nothing. */
type CapSetting = 'AUTOFILL_DAILY_CAP' | 'AUTOFILL_TRIAL_DAILY_CAP' | 'AUTOFILL_YEARLY_CENTS' | 'AUTOFILL_TRIAL_YEARLY_CENTS';

/** Each setting warned about once (see `parseCap`), by name. */
const warned = new Set<CapSetting>();

/**
 * A cap setting's value, or null for none. Anything but a whole number of at least one
 * is none, and says so in the log: a typo in a variable must not turn into a cap of zero
 * that refuses every press on the instance.
 */
function parseCap(env: UsageEnv, name: CapSetting): number | null {
  const raw = env[name]?.trim();
  if (!raw) return null;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    // Once an isolate: this runs on every press and every usage read, and the same line
    // a hundred times buries it rather than surfacing it.
    if (!warned.has(name)) console.warn(`${name} is not a whole number above zero ("${raw}"); no cap is enforced`);
    warned.add(name);
    return null;
  }
  return Number(raw);
}

/** The ordinary cap, `AUTOFILL_DAILY_CAP`, or null for none. */
export function dailyCap(env: UsageEnv): number | null {
  return parseCap(env, 'AUTOFILL_DAILY_CAP');
}

/**
 * The cap for an account on its trial: `AUTOFILL_TRIAL_DAILY_CAP`, or the ordinary cap
 * where that is unset, so an instance that sets one number behaves as it did before
 * there were two. A trial setting that fails to parse falls back the same way rather
 * than to no cap at all: it is the setting a typo in should fail safe.
 */
export function trialDailyCap(env: UsageEnv): number | null {
  return parseCap(env, 'AUTOFILL_TRIAL_DAILY_CAP') ?? dailyCap(env);
}

/** The year's spend cap, `AUTOFILL_YEARLY_CENTS`, or null for none. */
export function yearlyCents(env: UsageEnv): number | null {
  return parseCap(env, 'AUTOFILL_YEARLY_CENTS');
}

/** The trial's, `AUTOFILL_TRIAL_YEARLY_CENTS`, falling back to the ordinary one as `trialDailyCap` does. */
export function trialYearlyCents(env: UsageEnv): number | null {
  return parseCap(env, 'AUTOFILL_TRIAL_YEARLY_CENTS') ?? yearlyCents(env);
}

/**
 * The number that applies to this account: the trial's while its plan is a trial, the
 * ordinary one otherwise. `plan` is the row `requireActivePlan` put on the context for
 * the press, or one read for the usage page, and is undefined where billing is off,
 * which is also when no account is on a trial; a missing row with billing on reads as
 * `planStateOf` reads it, a trial that starts now, since `planFor` would have written
 * one. Nothing but the state is read off the row: a comped account and a paying one get
 * the same number, since the question is only whether the account is free to make.
 */
function forPlan(
  env: UsageEnv,
  plan: PlanRow | null | undefined,
  now: number,
  ordinary: (env: UsageEnv) => number | null,
  trial: (env: UsageEnv) => number | null,
): number | null {
  return onTrial(env, plan, now) ? trial(env) : ordinary(env);
}

/** Whether this account gets the trial's numbers: see `forPlan` for `plan`. */
export function onTrial(env: UsageEnv, plan: PlanRow | null | undefined, now: number): boolean {
  return billingOn(env) && planStateOf(plan ?? null, now) === 'trial';
}

/** Which of a press's refusals speak as the trial's; see `trialSentences`. */
export interface TrialSentences {
  day: boolean;
  year: boolean;
}

/**
 * Which refusals should be worded as the trial's: those whose number is the trial's own.
 * A trial on an instance that set only the ordinary settings falls back to them
 * (`trialDailyCap`, `trialYearlyCents`), and is then on the same numbers as everyone
 * else: told "during the trial" it would be told a number that is not the trial's, and
 * told "a subscription comes with more" it would be told something false, since
 * subscribing gives it the same cap and the year still ends on 1 January. The year's
 * sentence also needs the paying number to be the larger, or more is not what comes.
 */
export function trialSentences(env: UsageEnv, plan: PlanRow | null | undefined, now: number): TrialSentences {
  const trial = onTrial(env, plan, now);
  const ownYear = parseCap(env, 'AUTOFILL_TRIAL_YEARLY_CENTS');
  const paidYear = yearlyCents(env);
  return {
    day: trial && parseCap(env, 'AUTOFILL_TRIAL_DAILY_CAP') !== null,
    year: trial && ownYear !== null && (paidYear === null || paidYear > ownYear),
  };
}

/** The daily cap that applies to this account; see `forPlan`. */
export function capFor(env: UsageEnv, plan: PlanRow | null | undefined, now: number): number | null {
  return forPlan(env, plan, now, dailyCap, trialDailyCap);
}

/** The yearly spend cap that applies to this account; see `forPlan`. */
export function yearlyCentsFor(env: UsageEnv, plan: PlanRow | null | undefined, now: number): number | null {
  return forPlan(env, plan, now, yearlyCents, trialYearlyCents);
}

/** Both limits a press is checked against, for this account. */
export function limitsFor(env: UsageEnv, plan: PlanRow | null | undefined, now: number): PressLimits {
  return { cap: capFor(env, plan, now), yearlyCents: yearlyCentsFor(env, plan, now) };
}

/**
 * The same, for a caller without the row on its context: the usage read, a GET, which
 * `requireActivePlan` lets through without reading anything. One D1 read by key where
 * billing is on, and none where it is off. The plan row is the control plane's, the same
 * read `requireActivePlan` and `quotaFor` make, and it lives here beside `capFor` as
 * `quotaFor` lives beside `quotaOf`: the note routes read notes from the account's object
 * and nothing from D1, and that stays true.
 */
export async function limitsForUser(env: UsageEnv & { DB: D1Database }, userId: string, now: number): Promise<PressLimits> {
  const plan = billingOn(env) ? await planFor(env.DB, userId, now) : undefined;
  return limitsFor(env, plan, now);
}

/** A refused press's answer: the sentence the button shows, and the seconds until it may press again, where that is known. */
export interface Refusal {
  message: string;
  /** For the Retry-After header; null where nothing but a change of plan lifts the refusal. */
  retryAfter: number | null;
}

/**
 * What the button says when the day's cap refuses a press, and how long until it may
 * press again. The day is UTC, which is nobody's midnight in particular, so the sentence
 * names the hours rather than "tomorrow": at seven in the evening in California,
 * "tomorrow" would be wrong by the evening.
 *
 * "On this account", not "on this instance": the number is the account's since the trial
 * got one of its own, and a trial told "this instance allows 50" would be told something
 * false of the instance. A trial is told it is the trial's number, since that is the one
 * thing about it a person can change.
 */
export function capReached(cap: number, now: number, trial = false): Refusal {
  const midnight = new Date(now);
  midnight.setUTCHours(24, 0, 0, 0);
  const seconds = Math.max(1, Math.ceil((midnight.getTime() - now) / 1000));
  const hours = Math.ceil(seconds / 3600);
  const when = hours <= 1 ? 'within the hour' : `in ${hours} hours`;
  const presses = cap === 1 ? 'once a day' : cap === 2 ? 'twice a day' : `${cap} times a day`;
  const whose = trial ? 'during the trial' : 'on this account';
  return {
    message: `Auto-fill can be used ${presses} ${whose}, and today's are used up. It will work again ${when}.`,
    retryAfter: seconds,
  };
}

/**
 * What the button says when the year's spend cap refuses a press. No dollars: the cap is
 * the instance's cost, which is not the person's business and would read as a bill, so
 * the sentence says the year's Auto-fill has been used. The year is UTC, like the day,
 * and the next one starts on 1 January whatever the hour here; `retryAfter` is the
 * seconds until it does, for anything that reads headers.
 *
 * A trial is told something else, because "1 January" would be false for it: its trial
 * ends within the fortnight, and subscribing gives it the paying number at once, with
 * what it has spent counted against that. No Retry-After either, since no time lifts it.
 * Nothing here says "included", which is plan language an instance with billing off has
 * no plan for.
 */
export function yearReached(now: number, trial = false): Refusal {
  if (trial) return { message: "The trial's Auto-fill has been used up. A subscription comes with more.", retryAfter: null };
  const next = Date.UTC(new Date(now).getUTCFullYear() + 1, 0, 1);
  return {
    message: "This account has used this year's Auto-fill. It will work again on 1 January.",
    retryAfter: Math.max(1, Math.ceil((next - now) / 1000)),
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
 * thrown away: a reply cut off at its budget.
 */
export class PressUsage {
  readonly entries: UsageEntry[] = [];
  /**
   * Every metered call started, answered or not. The title call runs beside Jev's rounds,
   * and when a round throws, `autofill` rejects without waiting for it; a record written
   * then would miss a call that is still on its way to being paid for.
   */
  private readonly inflight: Promise<unknown>[] = [];

  /** Settles once every metered call has answered or failed, so its cost is in `entries`. */
  settled(): Promise<unknown> {
    return Promise.allSettled(this.inflight);
  }

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
      const started = call();
      this.inflight.push(started);
      try {
        answer = await started;
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
