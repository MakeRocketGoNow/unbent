import { describe, it, expect } from 'vitest';
import { LEGAL_VERSION } from '@unbent/shared';
import { REFUNDS_ID, legalDocuments, type LegalDocument } from './documents.js';

const OPERATOR = {
  name: 'Example Co',
  email: 'help@example.com',
  host: 'notes.example.com',
};

/** Every string in a document, which is what these assertions are really about. */
function text(doc: LegalDocument): string {
  return JSON.stringify(doc);
}

/**
 * The documents used to name one company from a constant, which meant every self-hosted
 * copy of this repository published somebody else's legal entity on its own domain.
 *
 * These pin the substitution rather than the prose: the wording will change for legal
 * reasons and should be free to, but the operator's own name, address and host must be
 * what appears, and the previous operator's must not survive anywhere in any of the three.
 */
describe('legalDocuments', () => {
  const docs = legalDocuments(OPERATOR, { errorTracking: false, backups: false, sellsPlan: false });
  const all: [string, LegalDocument][] = [
    ['privacy', docs.privacy],
    ['terms', docs.terms],
    ['deletion', docs.deletion],
  ];

  it.each(all)('names the operator in the %s document', (_name, doc) => {
    const body = text(doc);
    expect(body).toContain('Example Co');
    expect(body).toContain('help@example.com');
    expect(body).toContain('notes.example.com');
  });

  it.each(all)('leaves nothing of the hosted instance in the %s document', (_name, doc) => {
    const body = text(doc);
    expect(body).not.toContain('MakeRocketGoNow');
    expect(body).not.toContain('unbent.app');
    expect(body).not.toContain('hello@');
  });

  /** The software's name, not the operator's — it stays whoever is running the instance. */
  it.each(all)('still calls the software Unbent in the %s document', (_name, doc) => {
    expect(text(doc)).toContain('Unbent');
  });

  it('gives each document a title and an effective date to render', () => {
    for (const [, doc] of all) {
      expect(doc.title.length).toBeGreaterThan(0);
      expect(doc.effective).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

/**
 * The policy must describe an error-tracking service exactly when the instance has one. A
 * self-hosted copy sends errors only to its own logs, and a policy naming a third party it
 * never contacts is as wrong as one that hides a third party it does.
 */
describe('legalDocuments and error tracking', () => {
  const without = legalDocuments(OPERATOR, { errorTracking: false, backups: false, sellsPlan: false });
  const with_ = legalDocuments(OPERATOR, { errorTracking: true, backups: false, sellsPlan: false });

  it('says nothing about it on an instance that does not do it', () => {
    expect(text(without.privacy)).not.toContain('error-tracking');
    expect(text(without.privacy)).toContain('Two other kinds of service');
  });

  it('describes it, counts it among the services, and says Do Not Track stops it', () => {
    const body = text(with_.privacy);
    expect(body).toContain('error-tracking service');
    expect(body).toContain('Three other kinds of service');
    expect(body).toContain('Do Not Track');
  });

  /* It is a privacy-policy matter only: nothing about the terms or how to delete an
     account changes because errors are grouped somewhere. */
  it('leaves the terms and the deletion page identical either way', () => {
    expect(text(with_.terms)).toBe(text(without.terms));
    expect(text(with_.deletion)).toBe(text(without.deletion));
  });
});

/**
 * The backups (MAK-171) are described exactly where the instance keeps them. What a
 * customer who lost data would hold us to is pinned by phrase: how long each copy is kept,
 * that a deletion leaves every copy within about three months — "about", because the
 * lifecycle rule counts from the night of the copy, a day or two after the deletion — that
 * the sign-in records are copied too, that the files pass through
 * GitHub's servers, and that the copies are not a way to bring one note back. An instance
 * with no backups bucket says none of it, and its deletion page keeps the shorter promise.
 */
describe('legalDocuments and backups', () => {
  const without = legalDocuments(OPERATOR, { errorTracking: false, backups: false, sellsPlan: false });
  const with_ = legalDocuments(OPERATOR, { errorTracking: false, backups: true, sellsPlan: false });

  it('says nothing about them on an instance that keeps none', () => {
    for (const doc of [without.privacy, without.deletion]) {
      expect(text(doc)).not.toContain('backup');
      expect(text(doc)).not.toContain('GitHub');
    }
    expect(text(without.deletion)).toContain('Nothing else of your account or its contents is kept');
  });

  it('states the retention, the ninety days a deletion takes, and what they are for', () => {
    const body = text(with_.privacy);
    expect(body).toContain('kept for 14 days');
    expect(body).toContain('kept for up to 90 days');
    expect(body).toContain('leaves every one of them within about three months');
    expect(body).toContain('sign-in records');
    expect(body).toContain('not a way to bring one note back');
  });

  it('names GitHub among the services, and counts it', () => {
    const body = text(with_.privacy);
    expect(body).toContain('GitHub');
    expect(body).toContain('Three other kinds of service');
    expect(text(legalDocuments(OPERATOR, { errorTracking: true, backups: true, sellsPlan: false }).privacy)).toContain(
      'Four other kinds of service',
    );
  });

  it('tells the deletion page the copies remain, and leave within ninety days', () => {
    const body = text(with_.deletion);
    expect(body).toContain('gone within about three months of the deletion');
    expect(body).toContain('do not use to bring back an account its owner deleted');
    expect(body).not.toContain('Nothing else of your account');
  });

  it('leaves the terms alone', () => {
    expect(text(with_.terms)).toBe(text(without.terms));
  });
});

/**
 * The plan, its renewal and the refund policy (MAK-108) are in the terms exactly where the
 * instance sells one, and Paddle is in the policy exactly then. What Paddle's website review
 * reads for is pinned by phrase — the price, Paddle as merchant of record, how to cancel,
 * the refund window — and the refund section keeps the anchor that is handed to the review.
 */
describe('legalDocuments and billing', () => {
  const without = legalDocuments(OPERATOR, { errorTracking: false, backups: false, sellsPlan: false });
  const with_ = legalDocuments(OPERATOR, { errorTracking: false, backups: false, sellsPlan: true });

  it('says nothing about a price, a refund or Paddle on an instance that sells nothing', () => {
    for (const doc of [without.terms, without.privacy, without.deletion]) {
      expect(text(doc)).not.toContain('Paddle');
      expect(text(doc)).not.toContain('refund');
      expect(text(doc)).not.toContain('$');
    }
  });

  it('states the merchant of record, renewal and how to cancel', () => {
    const body = text(with_.terms);
    expect(body).toContain('free trial, with no card asked for');
    expect(body).toContain('Paddle is the merchant of record');
    expect(body).toContain('renews automatically');
    expect(body).toContain('Manage subscription');
    expect(body).toContain('becomes read-only');
  });

  /* The price lives on the pricing page and at checkout. Quoted here, a price change would
     rewrite the terms without moving their date or asking anyone to agree. */
  it('quotes no price, storage or trial length', () => {
    const body = text(with_.terms);
    expect(body).not.toContain('$');
    expect(body).not.toMatch(/\d+ GB/);
    expect(body).toContain('shown on our pricing page and at checkout');
  });

  it('has a refund policy under its own anchor', () => {
    const refunds = with_.terms.sections.find((s) => s.id === REFUNDS_ID);
    expect(refunds?.heading).toBe('Refunds');
    expect(JSON.stringify(refunds)).toContain('within 14 days of any charge');
    expect(JSON.stringify(refunds)).toContain('help@example.com');
  });

  it('says deleting the account cancels the plan', () => {
    expect(text(with_.terms)).toContain('cancels your plan at once');
    expect(text(without.terms)).not.toContain('cancels your plan');
  });

  it('names Paddle among the services, and counts it', () => {
    const body = text(with_.privacy);
    expect(body).toContain('Paddle, which sells the plan as merchant of record');
    expect(body).toContain('Three other kinds of service');
    expect(
      text(legalDocuments(OPERATOR, { errorTracking: true, backups: true, sellsPlan: true }).privacy),
    ).toContain('Five other kinds of service');
  });

  it('leaves the deletion page alone', () => {
    expect(text(with_.deletion)).toBe(text(without.deletion));
  });
});

/**
 * The version people agree to (MAK-209) moves only for a change worth asking about, and
 * the documents' dates move for every change — so a date older than the version means a
 * version was moved without the documents saying they changed, and people would be asked
 * to agree again to text dated before the change they were told about.
 */
describe('the agreement version', () => {
  const docs = legalDocuments(OPERATOR, { errorTracking: false, backups: false, sellsPlan: false });

  it('is not newer than either document', () => {
    expect(docs.terms.effective >= LEGAL_VERSION).toBe(true);
    expect(docs.privacy.effective >= LEGAL_VERSION).toBe(true);
  });

  /** What the policy says about the device is what lets this instance show no banner. */
  it('is agreed to under a policy that says what is kept on the device', () => {
    const body = text(docs.privacy);
    expect(body).toContain('Cookies, and what is kept on your device');
    expect(body).toContain('no cookie banner');
    expect(body).toContain('Global Privacy Control');
    expect(body).toContain('If you are in California');
  });
});
