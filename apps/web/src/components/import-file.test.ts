import { describe, expect, it } from 'vitest';
import { describeImportFile } from './import-file.js';

describe('describeImportFile', () => {
  it('tells an Evernote export where its notes will be filed', () => {
    const d = describeImportFile('Podcast Bookmarks.enex');
    expect(d.format).toBe('enex');
    expect(d.text).toContain('“Podcast Bookmarks”');
  });

  it('says an archive carries its own notebooks', () => {
    expect(describeImportFile('unbent-export-2026-09-15.zip')).toEqual({
      format: 'zip',
      text: expect.stringContaining('keeps its own notebook'),
    });
  });

  it('knows a bare markdown file is one note', () => {
    expect(describeImportFile('meeting-notes-a1b2c3d4.md').format).toBe('markdown');
  });

  it('refuses anything else and says what it wanted', () => {
    const d = describeImportFile('notes.txt');
    expect(d.format).toBeNull();
    expect(d.text).toContain('.enex, .zip or .md');
  });
});
