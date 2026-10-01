import { describe, expect, it } from 'vitest';
import { shouldApplyOnReturn, shouldApplyUpdate } from './sw-register.js';
import { holdPage, pageBusy } from './busy.js';

const ready = { ready: true, busy: false, preload: false, from: '/notes', to: '/settings' };

describe('shouldApplyUpdate', () => {
  it('takes a waiting deploy on the way to another section', () => {
    expect(shouldApplyUpdate(ready)).toBe(true);
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

  /* Opening a note from the list is the most common navigation there is; reloading the
     split view there lost the list's place. Within a section, never. */
  it('leaves list to note and note to note alone', () => {
    expect(shouldApplyUpdate({ ...ready, from: '/notes', to: '/notes/a' })).toBe(false);
    expect(shouldApplyUpdate({ ...ready, from: '/notes/a', to: '/notes/b' })).toBe(false);
    expect(shouldApplyUpdate({ ...ready, from: '/settings/tags', to: '/settings/notebooks' })).toBe(false);
  });

  it('leaves a change of filter on the same page alone', () => {
    expect(shouldApplyUpdate({ ...ready, from: '/notes', to: '/notes' })).toBe(false);
  });

  it('stays out of the Android app’s embed pages', () => {
    expect(shouldApplyUpdate({ ...ready, from: '/embed/notes/a', to: '/notes' })).toBe(false);
    expect(shouldApplyUpdate({ ...ready, from: '/notes', to: '/embed/notes/a' })).toBe(false);
  });
});

const back = { ready: true, busy: false, path: '/notes', awayFor: 10 * 60 * 1000 };

describe('shouldApplyOnReturn', () => {
  it('takes a waiting deploy on coming back after a real absence', () => {
    expect(shouldApplyOnReturn(back)).toBe(true);
  });

  /* A tab switch to copy something comes back to a list mid-read; reloading it there lost
     the place. The deploy waits for a change of section or a longer absence. */
  it('leaves the page alone after a quick switch away', () => {
    expect(shouldApplyOnReturn({ ...back, awayFor: 2000 })).toBe(false);
    expect(shouldApplyOnReturn({ ...back, awayFor: 4 * 60 * 1000 })).toBe(false);
  });

  it('does nothing without a deploy waiting, or with work a reload would lose', () => {
    expect(shouldApplyOnReturn({ ...back, ready: false })).toBe(false);
    expect(shouldApplyOnReturn({ ...back, busy: true })).toBe(false);
  });

  it('stays out of the Android app’s embed pages', () => {
    expect(shouldApplyOnReturn({ ...back, path: '/embed/notes/a' })).toBe(false);
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
