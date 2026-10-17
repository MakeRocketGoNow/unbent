import { describe, expect, it } from 'vitest';
import { JEV_PRESS_CENTS, MODEL_PRICES, priceOf, tokensCents, usageCents } from './llm-prices.js';

const tokens = (model: string, inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0) => ({
  model,
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheWriteTokens,
});

describe('the price table', () => {
  it('converts a row’s four counts at its model’s price, in cents', () => {
    // A million of each on Haiku: $0.10 + $0.50 + $0.01 + $0.125 = $0.735.
    expect(tokensCents(tokens('claude-haiku-5-5', 1e6, 1e6, 1e6, 1e6))).toBeCloseTo(73.5, 6);
    // A typical read: 1,500 in and 300 out on Haiku is a fraction of a cent.
    expect(tokensCents(tokens('claude-haiku-5-5', 1500, 300))).toBeCloseTo(0.03, 6);
    expect(tokensCents(tokens('claude-opus-5-5', 1e6, 0))).toBe(400);
  });

  it('prices a dated or newer id by its family, and an unknown one as the dearest', () => {
    expect(priceOf('claude-sonnet-5-5-20270101')).toBe(MODEL_PRICES['claude-sonnet-5-5']);
    expect(priceOf('claude-haiku-6')).toBe(MODEL_PRICES['claude-haiku-5-5']);
    expect(priceOf('some-other-model')).toBe(MODEL_PRICES['claude-opus-5-5']);
  });

  it('sums presses at the fixed Jev figure beside the models’ tokens', () => {
    expect(usageCents(10, [])).toBeCloseTo(10 * JEV_PRESS_CENTS, 9);
    expect(usageCents(0, [tokens('claude-opus-5-5', 1e6, 0), tokens('claude-haiku-5-5', 1e6, 0)])).toBeCloseTo(410, 6);
    expect(usageCents(0, [])).toBe(0);
  });
});
