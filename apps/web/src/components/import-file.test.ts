import { describe, expect, it } from 'vitest';
import { describeImportFile } from './import-file.js';

describe('describeImportFile', () => {
  it('tells an Evernote export where its notes will be filed', () => {
    const d = describeImportFile('Podcast Bookmarks.enex');
    expect(d.format).toBe('enex');
    expect(d.text).toContain('“Podcast Bookmarks”');
  });

  it('says a zip is being read until the worker has said which kind it is', () => {
    expect(describeImportFile('unbent-export-2026-09-15.zip')).toEqual({
      format: 'zip',
      text: expect.stringContaining('Reading'),
    });
  });

  it('says an archive carries its own notebooks, and a Notion export is chosen from', () => {
    expect(describeImportFile('unbent-export-2026-09-15.zip', 'unbent').text).toContain('keeps its own notebook');
    expect(describeImportFile('Export-3332a9d4.zip', 'notion').text).toContain('Choose what to bring in');
  });

  it('knows a bare markdown file is one note', () => {
    expect(describeImportFile('meeting-notes-a1b2c3d4.md').format).toBe('markdown');
  });

  it('refuses anything else and says what it wanted', () => {
    const d = describeImportFile('notes.txt');
    expect(d.format).toBeNull();
    expect(d.text).toContain('.enex, .zip or .md');
    expect(d.text).toContain('PDFs and images');
  });
});
