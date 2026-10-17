import type { LlmTokens } from './schemas.js';

/**
 * What the language model's tokens cost, in dollars per million, by model: the table the
 * yearly spend cap (`AUTOFILL_YEARLY_CENTS`) converts the usage counter's tokens with.
 * The counter keeps tokens and never money (`LlmTokens`), so the conversion is made at
 * check time from this table, and a price Anthropic changes is one line here rather than
 * a store full of stale cents.
 *
 * It goes stale all the same: Anthropic changes a price and this file does not notice.
 * That is a percent-level error on a guard, not a hole. The cap exists to stop a looping
 * account from costing the instance a hundred times what its plan pays, and a table ten
 * percent out stops it at a hundred and ten instead. Correct it when a price moves;
 * nothing else depends on it being exact. Written 2026-10 from the Claude API's price
 * list, with cache reads and writes as that list gives them (cache writes at a quarter
 * over input, cache reads at a tenth of input on Haiku and a flat twenty cents on the
 * two larger models).
 *
 * Here rather than in the API's lib/llm.ts, which names the default model, because the
 * check runs inside the account's object (store/llm-usage.ts), which imports from this
 * package and nothing from lib; the Auto-fill harness in apps/api/eval prices with it too,
 * so its counts and the cap cannot disagree.
 */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** The models an instance can be configured with, by their exact id; see `priceOf` for the rest. */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};

/**
 * What TypeSafe bills for Jev, in dollars per million input tokens (it bills input only).
 * It reports no counts, so nothing in the app can convert with this; the Auto-fill
 * harness estimates a press from the bytes it sends, at four to a token, and prices the
 * estimate at this rate. Here beside `JEV_PRESS_CENTS` so the figure that rate justifies
 * and the rate itself are read together.
 */
export const JEV_PER_MILLION = 0.042;

/**
 * What one press costs on the decision model, in cents, as a fixed figure: Jev reports
 * no token counts, so there is nothing to convert. A tenth of a cent is a round figure
 * above what the harness's estimate gives (at `JEV_PER_MILLION` a press would have to
 * send about 24,000 tokens of state to cost this much), chosen high so the guard errs
 * towards refusing a little early rather than late.
 */
export const JEV_PRESS_CENTS = 0.1;

/**
 * The table's price for a model id, or undefined for one it does not know. An exact id,
 * or a dated form of one (`claude-haiku-5-5-20270101` is Haiku 5.5 pinned to a snapshot,
 * at Haiku 5.5's price). Not by family: an older Opus or Sonnet costs several times the
 * current one, and a guard that priced `claude-opus-4-7` at Opus 5.5's rate would
 * under-protect by that much and say nothing.
 */
export function knownPrice(model: string): ModelPrice | undefined {
  return MODEL_PRICES[model] ?? Object.entries(MODEL_PRICES).find(([id]) => model.startsWith(`${id}-`))?.[1];
}

/**
 * The price of a model id: `knownPrice`, or for an id the table does not know, the
 * dearest rate in it, since a guard that cannot price something should assume the worst
 * rather than count it as free. That is a floor, not a ceiling, for a model dearer than
 * anything here, so the caller that sums (`LlmUsageCounter.spentCents`) warns once per
 * such id, naming it, so the operator adds a line; this package has no console to do so.
 */
export function priceOf(model: string): ModelPrice {
  return knownPrice(model) ?? Object.values(MODEL_PRICES).reduce((dearest, p) => (p.output > dearest.output ? p : dearest));
}

/** What one usage row's tokens cost, in cents, by its model's price. */
export function tokensCents(t: LlmTokens): number {
  const p = priceOf(t.model);
  const dollars =
    (t.inputTokens * p.input + t.outputTokens * p.output + t.cacheReadTokens * p.cacheRead + t.cacheWriteTokens * p.cacheWrite) / 1e6;
  return dollars * 100;
}

/**
 * What a period of Auto-fill cost, in cents: every model answer by its tokens and every
 * press by `JEV_PRESS_CENTS`. What the yearly cap is checked against.
 */
export function usageCents(presses: number, tokens: readonly LlmTokens[]): number {
  return presses * JEV_PRESS_CENTS + tokens.reduce((sum, t) => sum + tokensCents(t), 0);
}
