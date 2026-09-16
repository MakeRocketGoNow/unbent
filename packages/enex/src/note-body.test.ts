import { describe, expect, it } from 'vitest';
import { contentHash } from './note-body.js';

describe('contentHash', () => {
  it('is the same for the same title and body when no id is given', async () => {
    const a = await contentHash('Untitled', '');
    const b = await contentHash('Untitled', '');
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it('differs for two notes that share their text once each has an id', async () => {
    const a = await contentHash('Untitled', '', '0191c2a0-0000-7000-8000-000000000001');
    const b = await contentHash('Untitled', '', '0191c2b0-0000-7000-8000-000000000002');
    expect(a).not.toBe(b);
  });
});
