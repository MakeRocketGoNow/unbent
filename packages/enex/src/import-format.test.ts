import { describe, expect, it } from 'vitest';
import { importFormat } from './import-format.js';

describe('importFormat', () => {
  it('names the three formats by extension, whatever the case', () => {
    expect(importFormat('Recipes.enex')).toBe('enex');
    expect(importFormat('unbent-export-2026-09-15.zip')).toBe('zip');
    expect(importFormat('meeting-notes-a1b2c3d4.md')).toBe('markdown');
    expect(importFormat('NOTE.MARKDOWN')).toBe('markdown');
    expect(importFormat('Archive.ZIP')).toBe('zip');
  });

  it('refuses anything else rather than guessing', () => {
    expect(importFormat('notes.txt')).toBeNull();
    expect(importFormat('export')).toBeNull();
    expect(importFormat('folder.zip/note')).toBeNull();
  });
});
