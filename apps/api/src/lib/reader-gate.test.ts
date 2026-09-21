import { describe, expect, it } from 'vitest';
import { withReaderSlot } from './reader-gate.js';

/**
 * A slot the test releases by hand, so it can hold several open at once and watch what the
 * gate lets through. `started` resolves once the work is actually running (past the gate);
 * `finish` lets it return.
 */
function heldSlot() {
  let release!: () => void;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const promise = withReaderSlot(async () => {
    markStarted();
    await done;
  });
  return { promise, started, finish: release };
}

/** Lets the microtask queue drain so any slot that could start has started. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('withReaderSlot', () => {
  it('lets at most two extractions run at once', async () => {
    const a = heldSlot();
    const b = heldSlot();
    const c = heldSlot();

    // The first two get in immediately; the third is still waiting on a slot.
    await Promise.all([a.started, b.started]);
    await settle();
    let cStarted = false;
    void c.started.then(() => {
      cStarted = true;
    });
    await settle();
    expect(cStarted).toBe(false);

    // Freeing one lets the third through.
    a.finish();
    await c.started;
    expect(cStarted).toBe(true);

    b.finish();
    c.finish();
    await Promise.all([a.promise, b.promise, c.promise]);
  });

  it('frees the slot even when the work throws, so the queue never wedges', async () => {
    const boom = withReaderSlot(async () => {
      throw new Error('conversion failed');
    });
    await expect(boom).rejects.toThrow('conversion failed');

    // Two more must both still be admittable after the failure — the slot came back.
    const a = heldSlot();
    const b = heldSlot();
    await Promise.all([a.started, b.started]);
    a.finish();
    b.finish();
    await Promise.all([a.promise, b.promise]);
  });

  it('admits waiters in the order they arrived', async () => {
    const order: number[] = [];
    const a = heldSlot();
    const b = heldSlot();
    await Promise.all([a.started, b.started]);

    const c = withReaderSlot(async () => {
      order.push(3);
    });
    const d = withReaderSlot(async () => {
      order.push(4);
    });
    await settle();

    a.finish();
    await c;
    b.finish();
    await d;
    expect(order).toEqual([3, 4]);
    await Promise.all([a.promise, b.promise]);
  });
});
