import { describe, expect, it } from 'vitest';
import { instanceLine, instanceTitle, instanceToken, ribbonOf } from './instance-marker.js';

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

  /* Before the notes clause, so an ellipsis takes the clause rather than the commit. */
  it('puts the build right after the label', () => {
    expect(instanceLine({ instanceLabel: 'Dev' }, '00619da')).toBe('Dev · 00619da');
    expect(instanceLine({ instanceLabel: 'PR 9', ownStores: true }, '00619da')).toBe(
      'PR 9 · 00619da · notes are its own',
    );
  });

  it('still draws nothing on production, commit or not', () => {
    expect(instanceLine({}, '00619da')).toBeNull();
  });
});

describe('ribbonOf', () => {
  it('gives dev a ribbon that says so', () => {
    expect(ribbonOf({ instanceLabel: 'Dev', instanceKind: 'dev' })).toEqual({ kind: 'dev', text: 'Dev', short: 'Dev' });
  });

  it('gives a preview a ribbon naming its PR, since "Preview" alone does not say which', () => {
    expect(ribbonOf({ instanceLabel: 'PR 224', instanceKind: 'preview' })).toEqual({
      kind: 'preview',
      text: 'PR 224',
      short: '#224',
    });
  });

  it('shortens a four-digit PR to its number for the compact band, which "PR 1234" overruns', () => {
    expect(ribbonOf({ instanceLabel: 'PR 1234', instanceKind: 'preview' })?.short).toBe('#1234');
  });

  it('keeps a preview label that is not "PR <n>" as it is', () => {
    expect(ribbonOf({ instanceLabel: 'Branch x', instanceKind: 'preview' })?.short).toBe('Branch x');
  });

  it('gives local none, so screenshots shot against `pnpm dev` carry no ribbon', () => {
    expect(ribbonOf({ instanceLabel: 'Local', instanceKind: 'local' })).toBeNull();
  });

  it('gives production none, and a label of no known kind none', () => {
    expect(ribbonOf({})).toBeNull();
    expect(ribbonOf(undefined)).toBeNull();
    expect(ribbonOf({ instanceLabel: 'Staging' })).toBeNull();
  });
});

describe('instanceToken', () => {
  it('colours each kind by its own token, and an unknown one by the plain mark', () => {
    expect(instanceToken('preview')).toBe('--instance-preview');
    expect(instanceToken(undefined)).toBe('--instance-mark');
  });
});
