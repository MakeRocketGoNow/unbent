import { describe, expect, it } from 'vitest';
import { contentHash, enexNoteHash } from './note-body.js';

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

describe('enexNoteHash', () => {
  const base = {
    title: 'Parking receipt',
    body: '![scan.jpg](files/scan.jpg)',
    tags: ['Car', 'Receipts'],
    created: Date.parse('2024-01-15T09:30:00Z'),
    updated: Date.parse('2024-02-01T10:00:00Z'),
    attachments: ['5d41402abc4b2a76b9719d911017c592', '7d793037a0760186574b0282f2f435e7'],
  };

  it('is the same for the same note', async () => {
    expect(await enexNoteHash(base)).toBe(await enexNoteHash({ ...base }));
  });

  it('differs when only the bytes behind an attachment differ', async () => {
    const other = { ...base, attachments: ['5d41402abc4b2a76b9719d911017c592', 'f'.repeat(32)] };
    expect(await enexNoteHash(base)).not.toBe(await enexNoteHash(other));
  });

  it('differs when only the tags or a date differ', async () => {
    const key = await enexNoteHash(base);
    expect(await enexNoteHash({ ...base, tags: ['Car'] })).not.toBe(key);
    expect(await enexNoteHash({ ...base, created: base.created + 1000 })).not.toBe(key);
    expect(await enexNoteHash({ ...base, updated: undefined })).not.toBe(key);
  });

  it('ignores the order of tags and attachments, and how tags are spaced or repeated', async () => {
    const shuffled = {
      ...base,
      tags: [' Receipts', 'Car', 'Car', ''],
      attachments: [...base.attachments].reverse(),
    };
    expect(await enexNoteHash(shuffled)).toBe(await enexNoteHash(base));
  });
});
