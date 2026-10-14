import { describe, expect, it, vi } from 'vitest';
import { OutboxLeader } from './leader.js';
import { fakeLocks } from './test-locks.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('OutboxLeader', () => {
  it('leads when nobody holds the account’s lock', async () => {
    const locks = fakeLocks();
    const a = new OutboxLeader('unbent-outbox-leader-u1', locks);
    expect(await a.requestLeadership()).toBe(true);
    expect(a.isLeader()).toBe(true);
    expect(locks.held('unbent-outbox-leader-u1')).toBe(true);
  });

  it('follows while another tab holds it, and leads once that tab lets go', async () => {
    const locks = fakeLocks();
    const a = new OutboxLeader('lock', locks);
    const b = new OutboxLeader('lock', locks);
    await a.requestLeadership();
    expect(await b.requestLeadership()).toBe(false);
    const heard = vi.fn();
    b.onLeadershipChange(heard);

    a.releaseLeadership();
    await tick();
    expect(a.isLeader()).toBe(false);
    expect(b.isLeader()).toBe(true);
    expect(heard).toHaveBeenCalledWith(true);
    expect(locks.held('lock')).toBe(true);
  });

  it('is told when the lock is taken from it', async () => {
    const locks = fakeLocks();
    const a = new OutboxLeader('lock', locks);
    await a.requestLeadership();
    const heard = vi.fn();
    a.onLeadershipChange(heard);
    // The browser took the lock: the hold's request settles under the tab.
    a.releaseLeadership();
    await tick();
    expect(heard).toHaveBeenCalledWith(false);
    expect(a.isLeader()).toBe(false);
  });

  it('leaves the queue when released before its turn, so the next tab leads instead', async () => {
    const locks = fakeLocks();
    const a = new OutboxLeader('lock', locks);
    const b = new OutboxLeader('lock', locks);
    const c = new OutboxLeader('lock', locks);
    await a.requestLeadership();
    await b.requestLeadership();
    await c.requestLeadership();
    const heardB = vi.fn();
    b.onLeadershipChange(heardB);

    b.releaseLeadership();
    a.releaseLeadership();
    await tick();
    expect(heardB).not.toHaveBeenCalled();
    expect(b.isLeader()).toBe(false);
    expect(c.isLeader()).toBe(true);
  });

  it('never leads without Web Locks, where two tabs could not be told apart', async () => {
    const a = new OutboxLeader('lock', undefined);
    expect(await a.requestLeadership()).toBe(false);
    expect(a.isLeader()).toBe(false);
  });

  it('answers a second ask without a second request', async () => {
    const locks = fakeLocks();
    const spy = vi.spyOn(locks, 'request');
    const a = new OutboxLeader('lock', locks);
    await a.requestLeadership();
    expect(await a.requestLeadership()).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
