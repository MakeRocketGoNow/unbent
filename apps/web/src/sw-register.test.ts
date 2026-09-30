import { describe, expect, it } from 'vitest';
import { shouldApplyUpdate } from './sw-register.js';
import { holdPage, pageBusy } from './busy.js';

const ready = { ready: true, busy: false, preload: false, from: '/notes', to: '/settings' };

describe('shouldApplyUpdate', () => {
  it('takes a waiting deploy on the way to another page', () => {
    expect(shouldApplyUpdate(ready)).toBe(true);
    expect(shouldApplyUpdate({ ...ready, from: '/notes/a', to: '/notes/b' })).toBe(true);
  });

  it('does nothing without a deploy waiting', () => {
    expect(shouldApplyUpdate({ ...ready, ready: false })).toBe(false);
  });

  it('waits while the page holds work a reload would lose', () => {
    expect(shouldApplyUpdate({ ...ready, busy: true })).toBe(false);
  });

  it('never reloads for a hover preload', () => {
    expect(shouldApplyUpdate({ ...ready, preload: true })).toBe(false);
  });

  it('leaves a change of filter on the same page alone', () => {
    expect(shouldApplyUpdate({ ...ready, from: '/notes', to: '/notes' })).toBe(false);
  });

  it('stays out of the Android app’s embed pages', () => {
    expect(shouldApplyUpdate({ ...ready, from: '/embed/notes/a', to: '/notes' })).toBe(false);
    expect(shouldApplyUpdate({ ...ready, from: '/notes', to: '/embed/notes/a' })).toBe(false);
  });
});

describe('holdPage', () => {
  it('keeps the page busy until every hold is released', () => {
    expect(pageBusy()).toBe(false);
    const first = holdPage();
    const second = holdPage();
    first();
    expect(pageBusy()).toBe(true);
    second();
    expect(pageBusy()).toBe(false);
  });
});
