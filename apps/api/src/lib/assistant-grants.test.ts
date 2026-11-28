import { describe, expect, it } from 'vitest';
import { ASSISTANT_GRANT_MAX_NOTEBOOKS } from '@unbent/shared';
import { grantOf, storeAccessOf, uploadAccess } from './assistant-grants.js';

/**
 * A grant row read back (MAK-264). The rule under every case: a row this code cannot
 * make sense of is a grant of nothing, never of everything, since a stored grant was
 * meant to hold something back.
 */
describe('grantOf', () => {
  it('reads a list of notebooks, the unfiled flag and read only', () => {
    expect(grantOf({ notebooks: '["nb-1","nb-2"]', unfiled: 1, read_only: 0 })).toEqual({ notebooks: ['nb-1', 'nb-2'], unfiled: true, readOnly: false });
    expect(grantOf({ notebooks: '[]', unfiled: 0, read_only: 1 })).toEqual({ notebooks: [], unfiled: false, readOnly: true });
  });

  it('reads no list as every notebook, with the unfiled among them', () => {
    expect(grantOf({ notebooks: null, unfiled: 0, read_only: 0 })).toEqual({ notebooks: null, unfiled: true, readOnly: false });
    // The whole library, to read and not to change: a restriction all the same.
    expect(grantOf({ notebooks: null, unfiled: 0, read_only: 1 })).toEqual({ notebooks: null, unfiled: true, readOnly: true });
  });

  it('takes a column it cannot read for a grant of nothing', () => {
    const nothing = { notebooks: [], unfiled: false, readOnly: true };
    for (const notebooks of ['', 'not json', '{"all":true}', '"nb-1"', '[1,2]', '[null]', JSON.stringify(Array.from({ length: ASSISTANT_GRANT_MAX_NOTEBOOKS + 1 }, (_, i) => `nb-${i}`))]) {
      expect(grantOf({ notebooks, unfiled: 1, read_only: 0 }), notebooks.slice(0, 20)).toEqual(nothing);
    }
  });
});

describe('storeAccessOf', () => {
  it('holds the store to a list, and to nothing for the whole library', () => {
    expect(storeAccessOf({ notebooks: ['nb-1'], unfiled: true, readOnly: true })).toEqual({ notebooks: ['nb-1'], unfiled: true });
    expect(storeAccessOf({ notebooks: [], unfiled: false, readOnly: false })).toEqual({ notebooks: [], unfiled: false });
    // Read only is not the store's: it is the tools that are withheld.
    expect(storeAccessOf({ notebooks: null, unfiled: true, readOnly: true })).toBeNull();
  });
});

describe('uploadAccess', () => {
  const client = 'client-1';
  const limited = { notebooks: ['nb-1'], unfiled: false, readOnly: false };

  it('holds a live connection to the grant it has now', () => {
    expect(uploadAccess(client, limited)).toEqual({ ok: true, access: { notebooks: ['nb-1'], unfiled: false } });
    expect(uploadAccess(client, { notebooks: null, unfiled: true, readOnly: false })).toEqual({ ok: true, access: null });
  });

  it('refuses a link that cannot name its assistant, a disconnected one, and a read-only one', () => {
    expect(uploadAccess(null, limited)).toEqual({ ok: false });
    expect(uploadAccess('', limited)).toEqual({ ok: false });
    expect(uploadAccess(client, null)).toEqual({ ok: false });
    // The store would still take the write: read only is the tools, not the notebooks.
    expect(uploadAccess(client, { notebooks: null, unfiled: true, readOnly: true })).toEqual({ ok: false });
    expect(uploadAccess(client, { ...limited, readOnly: true })).toEqual({ ok: false });
  });
});
