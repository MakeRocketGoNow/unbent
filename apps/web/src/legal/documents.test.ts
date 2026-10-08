import { describe, it, expect } from 'vitest';
import { legalDocuments, type LegalDocument } from './documents.js';

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
  const docs = legalDocuments(OPERATOR, { errorTracking: false, backups: false });
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
    expect(body).not.toContain('CDeutsch');
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
  const without = legalDocuments(OPERATOR, { errorTracking: false, backups: false });
  const with_ = legalDocuments(OPERATOR, { errorTracking: true, backups: false });

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
 * that a deletion leaves every copy within ninety days, that the files pass through
 * GitHub's servers, and that the copies are not a way to bring one note back. An instance
 * with no backups bucket says none of it, and its deletion page keeps the shorter promise.
 */
describe('legalDocuments and backups', () => {
  const without = legalDocuments(OPERATOR, { errorTracking: false, backups: false });
  const with_ = legalDocuments(OPERATOR, { errorTracking: false, backups: true });

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
    expect(body).toContain('leaves every one of them within 90 days');
    expect(body).toContain('not a way to bring one note back');
  });

  it('names GitHub among the services, and counts it', () => {
    const body = text(with_.privacy);
    expect(body).toContain('GitHub');
    expect(body).toContain('Three other kinds of service');
    expect(text(legalDocuments(OPERATOR, { errorTracking: true, backups: true }).privacy)).toContain(
      'Four other kinds of service',
    );
  });

  it('tells the deletion page the copies remain, and leave within ninety days', () => {
    const body = text(with_.deletion);
    expect(body).toContain('gone within 90 days of the deletion');
    expect(body).toContain('do not use to bring back an account its owner deleted');
    expect(body).not.toContain('Nothing else of your account');
  });

  it('leaves the terms alone', () => {
    expect(text(with_.terms)).toBe(text(without.terms));
  });
});
