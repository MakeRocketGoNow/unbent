import { COMPAT_LEVEL } from '@unbent/shared/compat';
import { afterEach, describe, expect, it } from 'vitest';
import { clearNotice, dismissNotice, needsReload, noticeShown, resetNotice, sawLevel } from './update-notice.js';

describe('needsReload', () => {
  it('says so when the deploy in charge has a higher compatibility level than the page', () => {
    expect(needsReload(1, 2)).toBe(true);
  });

  /* Most deploys: another build, the same level, and nothing to say. */
  it('says nothing for a build at the page’s own level', () => {
    expect(needsReload(1, 1)).toBe(false);
  });

  /* A word that might be wrong is worse than none: the next load is the newest build regardless. */
  it('says nothing when the deploy is too old to say', () => {
    expect(needsReload(1, null)).toBe(false);
  });
});

describe('the notice', () => {
  afterEach(resetNotice);

  it('shows for a higher level from either source, and not for the page’s own', () => {
    sawLevel(COMPAT_LEVEL);
    sawLevel(null);
    expect(noticeShown()).toBe(false);
    sawLevel(COMPAT_LEVEL + 1);
    expect(noticeShown()).toBe(true);
  });

  /* Every API answer states the level, so a dismissal that the next answer undid would be no dismissal. */
  it('stays closed for the level it was dismissed for, and opens for a higher one', () => {
    sawLevel(COMPAT_LEVEL + 1);
    dismissNotice();
    sawLevel(COMPAT_LEVEL + 1);
    expect(noticeShown()).toBe(false);
    sawLevel(COMPAT_LEVEL + 2);
    expect(noticeShown()).toBe(true);
  });

  it('closes when answered by a reload', () => {
    sawLevel(COMPAT_LEVEL + 1);
    clearNotice();
    expect(noticeShown()).toBe(false);
  });
});
