import { describe, it, expect } from 'vitest';
import { buildLabel, buildTitle, type BuildInfo } from './build-info.js';
import { buildItem } from './components/AccountMenu.js';

const SHA = '3d544d9e0b7f4a1c2d3e4f5a6b7c8d9e0f1a2b3c';
const ci: BuildInfo = {
  commit: SHA,
  date: '2026-10-03T14:20:00Z',
  url: `https://github.com/example/unbent/commit/${SHA}`,
  dirty: false,
};

describe('build info', () => {
  it('names the short commit and the day, without the year when it is this one', () => {
    const label = buildLabel(ci, new Date('2026-12-01T00:00:00Z'));
    expect(label).toMatch(/^Version 3d544d9 · /);
    expect(label).not.toContain('2026');
  });

  it('adds the year to a build from another one', () => {
    expect(buildLabel(ci, new Date('2027-02-01T00:00:00Z'))).toContain('2026');
  });

  it('goes without a date it could not read, as a preview does', () => {
    expect(buildLabel({ ...ci, date: null })).toBe('Version 3d544d9');
  });

  it('says when a local build carries uncommitted changes', () => {
    const local = { ...ci, url: null, dirty: true, date: null };
    expect(buildLabel(local)).toBe('Version 3d544d9 + changes');
    expect(buildTitle(local)).toContain('uncommitted');
  });

  it('carries the whole commit in the tooltip, for a search or git show', () => {
    expect(buildTitle(ci)).toContain(`Commit ${SHA}`);
  });

  it('links to the commit from a CI build, and is plain text from a local one', () => {
    expect(buildItem(ci)).toMatchObject({ external: ci.url });
    const local = buildItem({ ...ci, url: null });
    expect(local).toMatchObject({ static: true });
    expect(local?.external).toBeUndefined();
  });

  it('draws nothing where the build could not say', () => {
    expect(buildItem(null)).toBeNull();
  });
});
