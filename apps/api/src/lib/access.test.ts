import { describe, expect, it } from 'vitest';
import { AccessRefused, connectionInstructions, isAccessRefusalReason, PARTIAL_NOTICE } from './access.js';

/**
 * What a restricted connection is told (MAK-264). These are read by a model, which
 * acts on the words: each has to say what to do next, and none may say anything about
 * what the connection was not given.
 */
describe('what a restricted connection is told', () => {
  it('has a sentence for every reason the store refuses with, each naming a way on', () => {
    expect(new AccessRefused('notebook').message).toContain('list_notebooks');
    expect(new AccessRefused('unfiled').message).toContain('list_notebooks');
    expect(new AccessRefused('manage').message).toContain('Settings under AI assistants');
    expect(new AccessRefused('method').message).toContain('only some notebooks');
    expect(new AccessRefused('values').message).toContain('Nothing was changed');
    for (const reason of ['notebook', 'unfiled', 'manage', 'values', 'method']) expect(isAccessRefusalReason(reason)).toBe(true);
    for (const not of ['later', '', 'toString', 'constructor', undefined, 3]) expect(isAccessRefusalReason(not)).toBe(false);
  });

  it('says a listing is partial without saying what is missing from it', () => {
    expect(PARTIAL_NOTICE).toContain('not everything');
    expect(PARTIAL_NOTICE).toContain('not that it does not exist');
    expect(PARTIAL_NOTICE).not.toMatch(/\d/);
  });

  it('tells a connection what it was not given when it connects, and one given everything nothing', () => {
    expect(connectionInstructions({ notebooks: null, unfiled: true, readOnly: false })).toBeUndefined();
    const some = connectionInstructions({ notebooks: ['nb-1'], unfiled: false, readOnly: false })!;
    expect(some).toContain('only some of their notebooks');
    expect(some).not.toContain('read only');
    // Said as the store has it: what is refused, and what a model might wrongly think is.
    expect(some).toContain('cannot be created, renamed or deleted');
    expect(some).toContain('purpose, emoji and fields can still be changed');
    // No id, and no count: the instructions say that there is a limit, not what is past it.
    expect(some).not.toContain('nb-1');
    const readOnly = connectionInstructions({ notebooks: null, unfiled: true, readOnly: true })!;
    expect(readOnly).toContain('read only');
    expect(readOnly).not.toContain('only some of their notebooks');
    const both = connectionInstructions({ notebooks: [], unfiled: true, readOnly: true })!;
    expect(both).toContain('only some of their notebooks');
    expect(both).toContain('read only');
  });
});
