import { describe, expect, it } from 'vitest';
import { coverageText } from './SearchCoverage.js';

describe('coverageText', () => {
  it('says only where the answer came from when every file in scope was searched', () => {
    expect(coverageText({ built: true, files: { searched: 0, total: 0 } })).toBe('Searched on this device.');
    expect(coverageText({ built: true, files: { searched: 12, total: 12 } })).toBe('Searched on this device.');
  });

  it('counts the files it could not see, and says which files a device does see', () => {
    expect(coverageText({ built: true, files: { searched: 4, total: 5 } })).toBe(
      'Searched on this device, without the text inside 1 file. Offline, files are searched in notebooks kept offline and in notes opened lately.',
    );
    expect(coverageText({ built: true, files: { searched: 0, total: 1204 } })).toContain(`the text inside ${(1204).toLocaleString()} files.`);
  });

  it('says the index is not whole yet rather than counting files it has not reached', () => {
    expect(coverageText({ built: false, files: { searched: 0, total: 9 } })).toMatch(/still indexing/);
  });
});
