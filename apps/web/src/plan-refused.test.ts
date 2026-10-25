import { afterEach, describe, expect, it, vi } from 'vitest';
import { onPlanFreed, planFreed, planIs, resetPlanRefused } from './plan-refused.js';

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
