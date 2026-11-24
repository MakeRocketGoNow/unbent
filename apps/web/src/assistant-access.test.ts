import { describe, expect, it } from 'vitest';
import type { AssistantGrant, NotebookSummary } from '@unbent/shared';
import { answerConsent, grantIsEmpty, grantSentence, grantSummary, grantedNotebooks, PICK_SOME_MESSAGE } from './assistant-access.js';

const nb = (id: string, name: string): NotebookSummary => ({ id, name, count: 3, fields: 0, purpose: null, emoji: null });
const notebooks = [nb('a', 'Coupons'), nb('b', 'Receipts'), nb('c', 'Travel')];
const grant = (over: Partial<AssistantGrant> = {}): AssistantGrant => ({ notebooks: null, unfiled: true, readOnly: false, ...over });

describe('grantSummary', () => {
  it('says what a connection reaches and whether it may write', () => {
    expect(grantSummary(grant(), notebooks)).toBe('All notebooks, can edit');
    expect(grantSummary(grant({ readOnly: true }), notebooks)).toBe('All notebooks, read only');
    expect(grantSummary(grant({ notebooks: ['a', 'b'], unfiled: false }), notebooks)).toBe('2 notebooks, can edit');
    expect(grantSummary(grant({ notebooks: ['a'], unfiled: true, readOnly: true }), notebooks)).toBe('1 notebook and the Inbox, read only');
    expect(grantSummary(grant({ notebooks: [], unfiled: true }), notebooks)).toBe('The Inbox only, can edit');
    expect(grantSummary(grant({ notebooks: [], unfiled: false }), notebooks)).toBe('No notebooks, can edit');
  });

  // A grant keeps the id of a notebook that has since been deleted, and it reaches nothing.
  it('counts only the notebooks that still exist', () => {
    const stale = grant({ notebooks: ['a', 'deleted-since'], unfiled: false });
    expect(grantSummary(stale, notebooks)).toBe('1 notebook, can edit');
    expect(grantedNotebooks(stale, notebooks).map((n) => n.name)).toEqual(['Coupons']);
  });

  // While the notebooks load, or when they could not be read: not "No notebooks".
  it('says "some" of a list it cannot count yet', () => {
    expect(grantSummary(grant({ notebooks: ['a', 'b'], unfiled: false, readOnly: true }), undefined)).toBe('Some notebooks, read only');
    expect(grantSummary(grant({ notebooks: ['a'], unfiled: true }), undefined)).toBe('Some notebooks and the Inbox, can edit');
    expect(grantSummary(grant(), undefined)).toBe('All notebooks, can edit');
  });
});

describe('grantSentence', () => {
  it('says the whole library as it always has', () => {
    expect(grantSentence('Claude', grant(), notebooks)).toBe(
      'If you allow it, Claude will be able to read every note you have. It will also be able to create notes, change them, and move them to the trash (the same things you can do).',
    );
  });

  it('says a list, and that it is all there is', () => {
    expect(grantSentence('Claude', grant({ notebooks: ['a', 'b'], unfiled: false, readOnly: true }), notebooks)).toBe(
      'If you allow it, Claude will be able to read the notes in the 2 notebooks you picked, and nothing else. It will not be able to change anything.',
    );
    expect(grantSentence('Claude', grant({ notebooks: ['a'], unfiled: true }), notebooks)).toBe(
      'If you allow it, Claude will be able to read the notes in the 1 notebook you picked and in your Inbox, and nothing else. There, it will also be able to create notes, change them, and move them to the trash.',
    );
    expect(grantSentence('Claude', grant({ notebooks: [], unfiled: true, readOnly: true }), notebooks)).toContain('read the notes in your Inbox, and nothing else');
  });

  it('does not describe a grant with nothing in it as one', () => {
    expect(grantSentence('Claude', grant({ notebooks: [], unfiled: false }), notebooks)).toBe(
      'No notebook is picked yet, so Claude would not be able to read any of your notes.',
    );
  });

  it('says "it" for an app with no name', () => {
    expect(grantSentence(null, grant({ readOnly: true }), notebooks)).toMatch(/^If you allow it, it will be able to read every note/);
    expect(grantSentence(null, grant({ notebooks: [], unfiled: false }), notebooks)).toBe('No notebook is picked yet, so it would not be able to read any of your notes.');
  });

  it('does not count notebooks it has not been told of', () => {
    expect(grantSentence('Claude', grant({ notebooks: ['a', 'b'], unfiled: false, readOnly: true }), undefined)).toBe(
      'If you allow it, Claude will be able to read the notes in the notebooks picked for it, and nothing else. It will not be able to change anything.',
    );
  });
});

describe('grantIsEmpty', () => {
  it('is only "some notebooks" with nothing picked and no Inbox', () => {
    expect(grantIsEmpty(grant({ notebooks: [], unfiled: false }), notebooks)).toBe(true);
    expect(grantIsEmpty(grant({ notebooks: [], unfiled: true }), notebooks)).toBe(false);
    expect(grantIsEmpty(grant({ notebooks: ['a'], unfiled: false }), notebooks)).toBe(false);
    expect(grantIsEmpty(grant({ readOnly: true }), notebooks)).toBe(false);
  });

  // The sentence already said "No notebook is picked yet" of this one, and Allow went through.
  it('counts a grant of only deleted notebooks as empty, as the sentence does', () => {
    const dead = grant({ notebooks: ['deleted-since'], unfiled: false });
    expect(grantIsEmpty(dead, notebooks)).toBe(true);
    expect(grantSentence('Claude', dead, notebooks)).toMatch(/^No notebook is picked yet/);
    // Not judged against notebooks nobody has read yet.
    expect(grantIsEmpty(dead, undefined)).toBe(false);
    expect(PICK_SOME_MESSAGE).toContain('Pick at least one notebook');
  });
});

describe('answerConsent', () => {
  const limited = grant({ notebooks: ['a'], unfiled: false, readOnly: true });
  function io(over: { save?: () => Promise<void>; consent?: () => Promise<{ data?: { url?: string }; error?: { message?: string } }> } = {}) {
    const calls: string[] = [];
    return {
      calls,
      save: async (clientId: string, g: AssistantGrant) => {
        calls.push(`save ${clientId} ${JSON.stringify(g)}`);
        await over.save?.();
      },
      consent: async (accept: boolean) => {
        calls.push(`consent ${accept}`);
        return over.consent ? over.consent() : { data: { url: 'https://client.example/callback?code=1' } };
      },
    };
  }

  it('saves the grant before it tells the provider, and goes where the provider says', async () => {
    const deps = io();
    expect(await answerConsent(true, 'client-1', limited, deps)).toEqual({ url: 'https://client.example/callback?code=1' });
    expect(deps.calls).toEqual([`save client-1 ${JSON.stringify(limited)}`, 'consent true']);
  });

  // The whole point of the order: no consent without its limits.
  it('never asks the provider when the grant did not save', async () => {
    const deps = io({ save: async () => Promise.reject(new Error('You are offline.')) });
    expect(await answerConsent(true, 'client-1', limited, deps)).toEqual({ error: 'You are offline.' });
    expect(deps.calls).toEqual([`save client-1 ${JSON.stringify(limited)}`]);
  });

  it('saves nothing for a refusal', async () => {
    const deps = io({ consent: async () => ({ data: { url: 'https://client.example/callback?error=access_denied' } }) });
    expect(await answerConsent(false, 'client-1', limited, deps)).toEqual({ url: 'https://client.example/callback?error=access_denied' });
    expect(deps.calls).toEqual(['consent false']);
  });

  // An app that is already connected has a consent whatever this screen does, so what
  // was saved is in force at once and a failure has to take it back.
  it('puts back what an already-connected app had when the provider fails', async () => {
    const everything = grant();
    for (const consent of [async () => ({ error: { message: 'expired' } }), async () => ({ data: {} }), async () => Promise.reject(new Error('offline'))]) {
      const deps = io({ consent });
      expect('error' in (await answerConsent(true, 'client-1', everything, deps, limited))).toBe(true);
      expect(deps.calls).toEqual([`save client-1 ${JSON.stringify(everything)}`, 'consent true', `save client-1 ${JSON.stringify(limited)}`]);
    }
    // Nothing to put back when the save itself failed, or when it all worked.
    const unsaved = io({ save: async () => Promise.reject(new Error('offline')) });
    await answerConsent(true, 'client-1', everything, unsaved, limited);
    expect(unsaved.calls).toHaveLength(1);
    const fine = io();
    await answerConsent(true, 'client-1', everything, fine, limited);
    expect(fine.calls).toEqual([`save client-1 ${JSON.stringify(everything)}`, 'consent true']);
  });

  it('reports what the provider refused, and an answer with nowhere to go', async () => {
    expect(await answerConsent(true, 'c', limited, io({ consent: async () => ({ error: { message: 'expired' } }) }))).toEqual({ error: 'expired' });
    expect(await answerConsent(true, 'c', limited, io({ consent: async () => ({ data: {} }) }))).toEqual({ error: 'The sign-in service did not say where to go next.' });
  });
});
