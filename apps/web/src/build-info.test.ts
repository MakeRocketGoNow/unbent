import { describe, it, expect } from 'vitest';
import { commitDate, repoName, shortCommit, type BuildInfo } from './build-info.js';

const SHA = '3d544d9e0b7f4a1c2d3e4f5a6b7c8d9e0f1a2b3c';
const ci: BuildInfo = {
  commit: SHA,
  date: '2026-10-03T14:20:00Z',
  url: `https://github.com/example/unbent/commit/${SHA}`,
  repo: 'https://github.com/example/unbent',
  dirty: false,
};

describe('build info', () => {
  it('shortens the commit to the seven characters GitHub shows', () => {
    expect(shortCommit(ci)).toBe('3d544d9');
  });

  it('dates the commit with its year', () => {
    expect(commitDate(ci)).toContain('2026');
  });

  it('puts the time of day beside the date, since a day holds several merges', () => {
    // Locale and zone vary by machine; a clock reading is `h:mm` in every one of them.
    expect(commitDate(ci)).toMatch(/\d{1,2}:\d{2}/);
  });

  it('has no date it could not read, as a preview has none', () => {
    expect(commitDate({ ...ci, date: null })).toBeNull();
  });

  it('names the repository without its scheme', () => {
    expect(repoName(ci)).toBe('github.com/example/unbent');
    expect(repoName({ ...ci, repo: null })).toBeNull();
  });
});
