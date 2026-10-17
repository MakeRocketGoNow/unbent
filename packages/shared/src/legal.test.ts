import { describe, expect, it } from 'vitest';
import { LEGAL_BASE_VERSION, LEGAL_CHANGES, LEGAL_VERSION, coversLegalVersion, legalVersionFor } from './legal.js';

const NEITHER = { sellsPlan: false, autofill: false };
const BOTH = { sellsPlan: true, autofill: true };

describe('LEGAL_CHANGES', () => {
  it('is oldest first, after the base, and ends at LEGAL_VERSION', () => {
    const versions = [LEGAL_BASE_VERSION, ...LEGAL_CHANGES.map((c) => c.version)];
    expect([...versions].sort()).toEqual(versions);
    expect(new Set(versions).size).toBe(versions.length);
    expect(LEGAL_VERSION).toBe(versions[versions.length - 1]);
  });
});

/*
 * An instance asks for the newest change whose text it publishes. One that publishes none
 * of the conditional text stays on the base, and its accounts are not asked again for
 * documents that read as they did (MAK-230: the Auto-fill change on a fork with no key).
 */
describe('legalVersionFor', () => {
  it('stays on the base where no change applies', () => {
    expect(legalVersionFor(NEITHER)).toEqual({ version: LEGAL_BASE_VERSION });
  });

  it('asks for the newest change that applies, with its sentence', () => {
    const newest = LEGAL_CHANGES[LEGAL_CHANGES.length - 1]!;
    expect(legalVersionFor(BOTH)).toEqual({ version: newest.version, change: newest.text });
  });

  it('skips a change whose text the instance does not publish', () => {
    for (const change of LEGAL_CHANGES) {
      if (!change.onlyWhere) continue;
      const without = legalVersionFor({ ...BOTH, [change.onlyWhere]: false });
      expect(without.version).not.toBe(change.version);
      const only = legalVersionFor({ ...NEITHER, [change.onlyWhere]: true });
      expect(only).toEqual({ version: change.version, change: change.text });
    }
  });
});

describe('coversLegalVersion', () => {
  it('is the version itself, and nothing earlier or unset', () => {
    expect(coversLegalVersion(LEGAL_VERSION, LEGAL_VERSION)).toBe(true);
    expect(coversLegalVersion(LEGAL_BASE_VERSION, LEGAL_VERSION)).toBe(false);
    expect(coversLegalVersion('2026-01-01', LEGAL_VERSION)).toBe(false);
    expect(coversLegalVersion(null, LEGAL_VERSION)).toBe(false);
    expect(coversLegalVersion(undefined, LEGAL_VERSION)).toBe(false);
  });

  /*
   * An instance that stopped selling, or turned Auto-fill off, asks for an earlier version
   * again; an account that agreed to a later one agreed to all of that and more, and is
   * not asked twice. The other way round is still an ask: the later text says more.
   */
  it('counts a later built-in version as agreement to an earlier one', () => {
    expect(coversLegalVersion(LEGAL_VERSION, LEGAL_BASE_VERSION)).toBe(true);
    for (const change of LEGAL_CHANGES) expect(coversLegalVersion(LEGAL_VERSION, change.version)).toBe(true);
  });

  /* An operator's own documents are versioned by the operator, and not in date order. */
  it('compares versions that are not built-in by equality alone', () => {
    expect(coversLegalVersion('2', '1')).toBe(false);
    expect(coversLegalVersion('2099-01-01', LEGAL_VERSION)).toBe(false);
    expect(coversLegalVersion(LEGAL_VERSION, '1')).toBe(false);
  });
});
