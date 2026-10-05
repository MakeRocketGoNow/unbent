import { afterEach, describe, expect, it, vi } from 'vitest';
import { installLaunchQueue, launchPath } from './launch-queue.js';

const ORIGIN = 'https://app.example';
const NOTE = '00000000-0000-4000-8000-000000000001';

describe('launchPath', () => {
  it('keeps the path, query and fragment of an address on this site', () => {
    expect(launchPath(`${ORIGIN}/notes/${NOTE}`, ORIGIN)).toBe(`/notes/${NOTE}`);
    expect(launchPath(`${ORIGIN}/notes?view=table#top`, ORIGIN)).toBe('/notes?view=table#top');
  });

  it("opens a file's note rather than the file", () => {
    expect(launchPath(`${ORIGIN}/api/notes/${NOTE}/files/Report%20(final)%20v2.pdf`, ORIGIN)).toBe(
      `/notes/${NOTE}`,
    );
  });

  it("hands on the Worker's other addresses whole", () => {
    expect(launchPath(`${ORIGIN}/api/auth/callback/google?code=x`, ORIGIN)).toBe(
      '/api/auth/callback/google?code=x',
    );
  });

  it("refuses another site's address, and one that is not an address", () => {
    expect(launchPath(`https://elsewhere.example/notes/${NOTE}`, ORIGIN)).toBeUndefined();
    expect(launchPath('not a url', ORIGIN)).toBeUndefined();
  });
});

describe('installLaunchQueue', () => {
  afterEach(() => {
    delete window.launchQueue;
  });

  /** A queue that keeps the consumer, for the test to deliver launches to. */
  function stubQueue() {
    let consumer: ((params: { files: FileSystemFileHandle[]; targetURL?: string }) => unknown) | undefined;
    window.launchQueue = { setConsumer: (c) => void (consumer = c) };
    return async (params: { files?: FileSystemFileHandle[]; targetURL?: string }) => {
      await consumer?.({ files: params.files ?? [], targetURL: params.targetURL });
    };
  }

  /** Installs with the router showing `showing`, which the test can change. */
  function install(showing = '/notes') {
    const handlers = { files: vi.fn(async () => {}), link: vi.fn(), showing: vi.fn(() => showing) };
    installLaunchQueue(handlers);
    return handlers;
  }

  const at = (path: string) => `${window.location.origin}${path}`;

  it('does nothing where there is no launch queue', () => {
    expect(() => install()).not.toThrow();
  });

  it('opens a link launched into the open app', async () => {
    const launch = stubQueue();
    const handlers = install();
    await launch({ targetURL: at(`/notes/${NOTE}`) });
    expect(handlers.link).toHaveBeenCalledWith(`/notes/${NOTE}`);
  });

  it('skips the launch that opened the window, which the router already handled', async () => {
    const launch = stubQueue();
    // The window was opened at the page's address and the router has since redirected it,
    // to the sign-in page say; opening the address again would undo that.
    const handlers = install('/login');
    await launch({ targetURL: window.location.href });
    expect(handlers.link).not.toHaveBeenCalled();
    // A later launch to the same address is a click, and is followed.
    await launch({ targetURL: window.location.href });
    expect(handlers.link).toHaveBeenCalledTimes(1);
  });

  it('skips a link to the page already showing', async () => {
    const launch = stubQueue();
    const handlers = install(`/notes/${NOTE}`);
    await launch({ targetURL: at('/settings') });
    await launch({ targetURL: at(`/notes/${NOTE}`) });
    expect(handlers.link).toHaveBeenCalledTimes(1);
    expect(handlers.link).toHaveBeenCalledWith('/settings');
  });

  it('makes a note of launched files and ignores their address', async () => {
    const launch = stubQueue();
    const handlers = install();
    const file = new File(['%PDF'], 'scan.pdf', { type: 'application/pdf' });
    const handle = { getFile: async () => file } as unknown as FileSystemFileHandle;
    await launch({ files: [handle], targetURL: at('/notes') });
    expect(handlers.files).toHaveBeenCalledWith([file]);
    expect(handlers.link).not.toHaveBeenCalled();
  });
});
