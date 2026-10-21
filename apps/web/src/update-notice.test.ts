import { COMPAT_LEVEL } from '@unbent/shared/compat';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SETTLED_MS, clearNotice, dismissNotice, needsReload, noticeShown, onCaughtUp, resetNotice, sawLevel } from './update-notice.js';

describe('needsReload', () => {
  it('says so when the deploy in charge has a higher compatibility level than the page', () => {
    expect(needsReload(1, 2)).toBe(true);
  });

  /* Most deploys: another build, the same level, and nothing to say. */
  it('says nothing for a build at the page’s own level', () => {
    expect(needsReload(1, 1)).toBe(false);
  });

  /* A bump reverted after this page loaded it: the page is the newer side, and a reload brings the server's build. */
  it('says so for a lower level too', () => {
    expect(needsReload(2, 1)).toBe(true);
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

  /* Pressed between two answers of a rollout, the dismissal is for the level it was about. */
  it('stays closed when dismissed just after an answer at the page’s own level', () => {
    sawLevel(COMPAT_LEVEL + 1, 1_000);
    sawLevel(COMPAT_LEVEL, 2_000);
    dismissNotice();
    sawLevel(COMPAT_LEVEL + 1, 3_000);
    expect(noticeShown()).toBe(false);
  });

  /* A bump reverted before the person answered: nothing is left to reload for. */
  it('closes on an own-level answer once no other level has come for a while', () => {
    sawLevel(COMPAT_LEVEL + 1, 1_000);
    sawLevel(COMPAT_LEVEL, 1_000 + SETTLED_MS);
    expect(noticeShown()).toBe(false);
  });

  /* A deploy reaching the edges answers with both versions in turn for a few seconds. */
  it('does not blink while answers alternate between levels', () => {
    sawLevel(COMPAT_LEVEL + 1, 1_000);
    sawLevel(COMPAT_LEVEL, 2_000);
    expect(noticeShown()).toBe(true);
    sawLevel(COMPAT_LEVEL + 1, 3_000);
    sawLevel(COMPAT_LEVEL, 3_000 + SETTLED_MS - 1);
    expect(noticeShown()).toBe(true);
  });

  /* The outbox replays on it, so it fires once per return, not on every agreeing answer. */
  it('says when the levels agree again after the page was behind', () => {
    const listener = vi.fn();
    const off = onCaughtUp(listener);
    sawLevel(COMPAT_LEVEL);
    expect(listener).not.toHaveBeenCalled();
    sawLevel(COMPAT_LEVEL + 1);
    sawLevel(COMPAT_LEVEL);
    sawLevel(COMPAT_LEVEL);
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });

  it('closes when answered by a reload', () => {
    sawLevel(COMPAT_LEVEL + 1);
    clearNotice();
    expect(noticeShown()).toBe(false);
  });
});
