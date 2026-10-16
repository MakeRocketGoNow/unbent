import { describe, expect, it } from 'vitest';
import { LEGAL_CHANGE, LEGAL_VERSION, coversLegalVersion } from './legal.js';

describe('coversLegalVersion', () => {
  it('is the version itself, and nothing earlier or unset', () => {
    expect(coversLegalVersion(LEGAL_VERSION, LEGAL_VERSION)).toBe(true);
    expect(coversLegalVersion('2026-01-01', LEGAL_VERSION)).toBe(false);
    expect(coversLegalVersion(null, LEGAL_VERSION)).toBe(false);
    expect(coversLegalVersion(undefined, LEGAL_VERSION)).toBe(false);
  });

  /*
   * An instance that stopped selling asks for the version before the billing-only change
   * again; an account that agreed to the newer one agreed to all of that and more, and is
   * not asked twice. The other way round is still an ask: the newer terms say more.
   */
  it('counts the newer version as agreement to the one a billing-only change moved from', () => {
    if (!LEGAL_CHANGE?.billingOnly) return;
    expect(coversLegalVersion(LEGAL_VERSION, LEGAL_CHANGE.since)).toBe(true);
    expect(coversLegalVersion(LEGAL_CHANGE.since, LEGAL_VERSION)).toBe(false);
    expect(coversLegalVersion(LEGAL_CHANGE.since, LEGAL_CHANGE.since)).toBe(true);
  });
});
