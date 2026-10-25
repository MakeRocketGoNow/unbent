import { afterEach, describe, expect, it, vi } from 'vitest';
import { claimPlanFor, onPlanFreed, onPlanRead, planFree, planFreeRestored, planFreed, planIs, resetPlanRefused } from './plan-refused.js';

/**
 * A read-only account is read-only only while it holds more than the free plan does
 * (2026-10-24), so a delete for good while the plan reads inactive is word that the plan
 * should be read again; while it reads otherwise, a purge changes nothing here.
 */
describe('planFreed', () => {
  afterEach(() => resetPlanRefused());

  it('asks for the plan again only while it reads inactive', () => {
    const heard = vi.fn();
    onPlanFreed(heard);
    planFreed();
    expect(heard).not.toHaveBeenCalled();
    planIs(true);
    planFreed();
    expect(heard).toHaveBeenCalledTimes(1);
    planIs(false);
    planFreed();
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

/**
 * The free plan's answer, as the outbox keeps it: told to a listener that comes after
 * the read, since the outbox usually opens after the plan has answered, and forgotten
 * when the tab is handed to another account, so one account's answer never reaches
 * another's outbox or counts its notes.
 */
describe('the free plan\u2019s answer', () => {
  afterEach(() => resetPlanRefused());

  it('is told to a listener that comes after this page read it', () => {
    planIs(false, true);
    const heard = vi.fn();
    onPlanRead(heard);
    expect(heard).toHaveBeenCalledWith(true);
  });

  it('is forgotten for another account, kept for the same one, and restored only until read', () => {
    claimPlanFor('a');
    planIs(false, true);
    claimPlanFor('a');
    expect(planFree()).toBe(true);
    claimPlanFor('b');
    expect(planFree()).toBe(false);
    const heard = vi.fn();
    onPlanRead(heard);
    expect(heard).not.toHaveBeenCalled();
    // The outbox restores what it kept for this account, until the page reads the plan.
    planFreeRestored(true);
    expect(planFree()).toBe(true);
    planIs(false, false);
    planFreeRestored(true);
    expect(planFree()).toBe(false);
  });
});
