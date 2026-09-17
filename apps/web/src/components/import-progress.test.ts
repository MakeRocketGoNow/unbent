import type { ImportProgress } from '@unbent/enex';
import { describe, expect, it } from 'vitest';
import { importPercent } from './import-progress.js';

function progress(over: Partial<ImportProgress> = {}): ImportProgress {
  return {
    processed: 0,
    created: 0,
    skipped: 0,
    failed: 0,
    filesUploaded: 0,
    filesIndexed: 0,
    bytesRead: 0,
    bytesTotal: 0,
    currentTitle: '',
    ...over,
  };
}

describe('importPercent', () => {
  it('divides by the file when the importer names no total', () => {
    // The ENEX case: bytes come off the file's own stream, so the file is the total.
    expect(importPercent(progress({ bytesRead: 250 }), 1000, false)).toBe(25);
  });

  it("divides by the importer's total when it has one", () => {
    // A zip's entries hold half of what the zip weighs; the file's size would read 25%
    // on a run that is in fact half done.
    expect(importPercent(progress({ bytesRead: 250, bytesTotal: 500 }), 1000, false)).toBe(50);
  });

  it('reaches 100 on an archive whose entries are all read', () => {
    expect(importPercent(progress({ bytesRead: 500, bytesTotal: 500 }), 1000, false)).toBe(100);
  });

  it('never goes past 100, even if a shared file is counted twice', () => {
    expect(importPercent(progress({ bytesRead: 700, bytesTotal: 500 }), 1000, false)).toBe(100);
  });

  it('is full once the run is over, whatever the last bytes did', () => {
    // The final uploads land after the last byte is read; a bar a percent short reads
    // as stalled on a run that finished.
    expect(importPercent(progress({ bytesRead: 499, bytesTotal: 500 }), 1000, true)).toBe(100);
  });

  it('is empty before a run has anything to report', () => {
    expect(importPercent(null, 1000, false)).toBe(0);
    expect(importPercent(progress(), 0, false)).toBe(0);
  });
});
