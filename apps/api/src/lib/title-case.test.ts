import { describe, expect, it } from 'vitest';
import { titleCase } from './title-case.js';

describe('titleCase', () => {
  it('capitalizes every word but the short joining ones', () => {
    expect(titleCase('Acme Hardware invoice, March 2026')).toBe('Acme Hardware Invoice, March 2026');
    expect(titleCase('roof quote from summit roofing')).toBe('Roof Quote From Summit Roofing');
    expect(titleCase('Lasagna at Luigi’s')).toBe('Lasagna at Luigi’s');
    expect(titleCase('Notes On The Bill Of Sale')).toBe('Notes on the Bill of Sale');
  });

  it('capitalizes a short word that opens or closes the title, or opens a phrase', () => {
    expect(titleCase('the plan to sign up')).toBe('The Plan to Sign Up');
    expect(titleCase('Budget: a first draft')).toBe('Budget: A First Draft');
    expect(titleCase('Lease — the renewal')).toBe('Lease — The Renewal');
  });

  it('cases each part of a hyphenated word and anything inside brackets', () => {
    expect(titleCase('follow-up on the claim')).toBe('Follow-Up on the Claim');
    expect(titleCase('Jane Doe, Acme Plumbing (business card)')).toBe('Jane Doe, Acme Plumbing (Business Card)');
    expect(titleCase('up-to-date report (final) v2')).toBe('Up-to-Date Report (Final) v2');
  });

  it('leaves words cased on purpose, numbers, and addresses as they are', () => {
    expect(titleCase('IRS letter about the W-2')).toBe('IRS Letter About the W-2');
    expect(titleCase('iPhone receipt from eBay')).toBe('iPhone Receipt From eBay');
    expect(titleCase('McDonald’s receipt, Q3')).toBe('McDonald’s Receipt, Q3');
    expect(titleCase('invite from jane@example.com')).toBe('Invite From jane@example.com');
    expect(titleCase('order on example.com')).toBe('Order on example.com');
  });

  it('brings a title shouted in capitals down to title case, keeping vowelless acronyms', () => {
    expect(titleCase('ACME HARDWARE')).toBe('Acme Hardware');
    expect(titleCase('SAMPLE INVOICE (ACME) FINAL COPY')).toBe('Sample Invoice (Acme) Final Copy');
    expect(titleCase('ACME PLUMBING LLC STATEMENT OF ACCOUNT')).toBe('Acme Plumbing LLC Statement of Account');
    // A single capital word could as well be an acronym, so it stands.
    expect(titleCase('INVOICE #4471')).toBe('INVOICE #4471');
  });

  it('keeps the spacing it was given', () => {
    expect(titleCase('')).toBe('');
    expect(titleCase('a  receipt')).toBe('A  Receipt');
  });
});
