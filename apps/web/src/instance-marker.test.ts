import { describe, expect, it } from 'vitest';
import { instanceLine, instanceTitle } from './instance-marker.js';

describe('instanceTitle', () => {
  it('puts the label in front of the title', () => {
    expect(instanceTitle('PR 222', 'Unbent')).toBe('PR 222 · Unbent');
  });

  it('does not stack the label when applied twice', () => {
    expect(instanceTitle('Dev', instanceTitle('Dev', 'Unbent'))).toBe('Dev · Unbent');
  });
});

describe('instanceLine', () => {
  it('draws nothing on production, which has no label', () => {
    expect(instanceLine({})).toBeNull();
  });

  it('names an instance that is not a preview by its label alone', () => {
    expect(instanceLine({ instanceLabel: 'Dev' })).toBe('Dev');
    expect(instanceLine({ instanceLabel: 'Local' })).toBe('Local');
  });

  it('says a preview reads the dev instance’s notes, since an edit there changes them', () => {
    expect(instanceLine({ instanceLabel: 'PR 9', previewRelay: { origin: 'https://dev.example.com' } })).toBe(
      "PR 9 · notes are dev.example.com's",
    );
  });

  it('says a store-changing preview’s notes are its own', () => {
    expect(
      instanceLine({ instanceLabel: 'PR 9', ownStores: true, previewRelay: { origin: 'https://dev.example.com' } }),
    ).toBe('PR 9 · notes are its own');
  });
});
