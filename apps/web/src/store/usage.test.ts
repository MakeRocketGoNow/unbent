import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { storedBytes } from './usage.js';
import { installMemoryOpfs, type MemoryDirectory } from './test-opfs.js';

let root: MemoryDirectory;
beforeEach(() => {
  root = installMemoryOpfs();
});
afterEach(() => vi.unstubAllGlobals());

const MB = 1024 ** 2;

/** Puts `bytes` of zeros at `path` in the fake file system. */
async function put(path: string, bytes: number) {
  const parts = path.split('/');
  let dir = root;
  for (const name of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(name, { create: true });
  (await dir.getFileHandle(parts.at(-1)!, { create: true })).data = new Blob([new Uint8Array(bytes)]);
}

function estimate(value: StorageEstimate & { usageDetails?: Record<string, number> }) {
  navigator.storage.estimate = async () => value;
}

/**
 * The shape seen on 2026-11-12: Chrome's estimate put gigabytes under the file system that
 * the files in it did not add up to, and the caches beside it were right. Only the file
 * system's part is replaced, so the caches still count.
 */
describe('what Unbent says it has stored on the device', () => {
  it('replaces the browser\'s figure for the file system with the files that are there', async () => {
    await put('unbent-u1.sqlite', 23 * MB);
    await put('unbent-u1.search.sqlite', 8 * MB);
    await put('unbent-files-u1/kept/n1/Report (final) v2.pdf', 2 * MB);
    await put('.ahp-scratch/0', 0);
    estimate({ usage: 4272 * MB, quota: 15000 * MB, usageDetails: { fileSystem: 4245 * MB, caches: 27 * MB } });
    expect(await storedBytes()).toBe(27 * MB + 33 * MB);
  });

  it('says the browser\'s total as it is where the browser gives no parts', async () => {
    await put('unbent-u1.sqlite', 23 * MB);
    estimate({ usage: 100 * MB, quota: 15000 * MB });
    expect(await storedBytes()).toBe(100 * MB);
  });

  it('is unknown when a file cannot be sized, rather than a total that leaves it out or the miscount', async () => {
    await put('unbent-u1.sqlite', 23 * MB);
    const held = await root.getFileHandle('unbent-u1.sqlite');
    held.getFile = async () => {
      throw Object.assign(new Error('held by an access handle'), { name: 'NoModificationAllowedError' });
    };
    estimate({ usage: 4272 * MB, quota: 15000 * MB, usageDetails: { fileSystem: 4245 * MB, caches: 27 * MB } });
    expect(await storedBytes()).toBeNull();
  });

  it('is unknown where the browser will not estimate at all', async () => {
    navigator.storage.estimate = undefined as never;
    expect(await storedBytes()).toBeNull();
  });
});
