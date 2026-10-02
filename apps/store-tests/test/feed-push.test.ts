import { describe, expect, it } from 'vitest';
import { evictDurableObject } from 'cloudflare:test';
import { freshStore } from './helpers.js';

/**
 * The push: a socket accepted by the object through the hibernation API, told the
 * feed's seq after every write and nothing else. Reached here as the Worker reaches it,
 * with `stub.fetch` and an `Upgrade` header; the route that does that for a session is
 * covered by the live suite.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function open(stub: ReturnType<typeof freshStore>['stub']) {
  const res = await stub.fetch(new Request('https://store/socket', { headers: { Upgrade: 'websocket' } }));
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  const got: string[] = [];
  ws.addEventListener('message', (ev) => got.push(String(ev.data)));
  return { ws, got };
}

describe('the feed push', () => {
  it('refuses a plain request, and accepts an upgrade', async () => {
    const { stub } = freshStore('push-accept');
    expect((await stub.fetch(new Request('https://store/socket'))).status).toBe(426);
    const { ws } = await open(stub);
    ws.close(1000, 'done');
  });

  it('sends the seq after a write that recorded, nothing after one that did not, and answers pings itself', async () => {
    const { stub } = freshStore('push-write');
    const { ws, got } = await open(stub);
    const n = await stub.create({ id: crypto.randomUUID(), title: 'T', body: '', tags: [] });
    await sleep(100);
    expect(got).toEqual(['{"seq":1}']);
    // A write that changes nothing records nothing and so says nothing.
    await stub.update(n.id, { title: 'T' });
    await sleep(100);
    expect(got).toEqual(['{"seq":1}']);
    // A write that throws is rolled back, feed row included, and says nothing either.
    await expect(stub.update(n.id, { fields: { 'no-such-field': 1 } })).rejects.toThrow();
    await sleep(100);
    expect(got).toEqual(['{"seq":1}']);
    // One number per call, however many rows the call recorded.
    await stub.update(n.id, { title: 'U', tags: ['a', 'b'] });
    await sleep(100);
    expect(got).toEqual(['{"seq":1}', '{"seq":4}']);
    ws.send('ping');
    ws.send('anything else');
    await sleep(100);
    expect(got).toEqual(['{"seq":1}', '{"seq":4}', 'pong']);
    ws.close(1000, 'done');
  });

  it('reaches every socket, survives the object being evicted, and forgets a closed one', async () => {
    const { stub } = freshStore('push-many');
    const a = await open(stub);
    const b = await open(stub);
    await stub.create({ id: crypto.randomUUID(), title: 'T', body: '', tags: [] });
    await sleep(100);
    expect(a.got).toEqual(['{"seq":1}']);
    expect(b.got).toEqual(['{"seq":1}']);
    // Hibernation: the instance goes, the sockets stay attached, the next write still reaches them.
    await evictDurableObject(stub);
    await stub.create({ id: crypto.randomUUID(), title: 'T2', body: '', tags: [] });
    await sleep(100);
    expect(a.got).toEqual(['{"seq":1}', '{"seq":2}']);
    expect(b.got).toEqual(['{"seq":1}', '{"seq":2}']);
    a.ws.close(1000, 'bye');
    await sleep(100);
    await stub.create({ id: crypto.randomUUID(), title: 'T3', body: '', tags: [] });
    await sleep(100);
    expect(a.got).toHaveLength(2);
    expect(b.got).toEqual(['{"seq":1}', '{"seq":2}', '{"seq":3}']);
    b.ws.close(1000, 'bye');
  });
});
