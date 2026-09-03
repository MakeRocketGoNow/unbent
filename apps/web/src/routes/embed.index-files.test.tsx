import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../notes-api.js';
import { IndexFiles } from './embed.index-files.js';
import type { IndexOptions, IndexResult } from '../attachment-text.js';

const { indexPendingFiles } = vi.hoisted(() => ({
  indexPendingFiles: vi.fn<(opts: IndexOptions) => Promise<IndexResult>>(),
}));
vi.mock('../attachment-text.js', () => ({ indexPendingFiles }));

/** What the app would hear, decoded the way the app decodes it. */
function listen(): Array<Record<string, unknown>> {
  const heard: Array<Record<string, unknown>> = [];
  window.UnbentApp = { postMessage: (json) => heard.push(JSON.parse(json)) };
  return heard;
}

const settle = () => act(async () => {});

describe('the indexing page', () => {
  // Braces matter: a hook that returns the mock hands vitest a "cleanup" it will call.
  beforeEach(() => {
    indexPendingFiles.mockReset();
  });
  afterEach(() => {
    cleanup();
    delete window.UnbentApp;
  });

  it('asks for the one note it was given, and reports progress and the result', async () => {
    const heard = listen();
    indexPendingFiles.mockImplementation((opts) => {
      opts.onProgress?.({ done: 1, indexed: 1, unusable: 0, failed: 0, total: 2 });
      return Promise.resolve({ done: 2, indexed: 1, unusable: 1, failed: 0, total: 2 });
    });

    render(<IndexFiles note="n1" />);
    await settle();

    expect(indexPendingFiles).toHaveBeenCalledWith(expect.objectContaining({ note: 'n1' }));
    expect(heard).toEqual([
      { type: 'ready' },
      { type: 'index-progress', done: 1, total: 2 },
      { type: 'index-done', indexed: 1, unusable: 1, failed: 0 },
    ]);
    expect(screen.getByText('Indexed 1 of 2.')).toBeTruthy();
  });

  it('tells the app when there was no session', async () => {
    const heard = listen();
    indexPendingFiles.mockRejectedValue(new ApiError(401, '401'));

    render(<IndexFiles note="n1" />);
    await settle();

    expect(heard.at(-1)).toEqual({ type: 'unauthorized' });
  });

  it('tells the app what went wrong otherwise', async () => {
    const heard = listen();
    indexPendingFiles.mockRejectedValue(new Error('R2 is on fire'));

    render(<IndexFiles note="n1" />);
    await settle();

    expect(heard.at(-1)).toEqual({ type: 'index-error', message: 'R2 is on fire' });
    expect(screen.getByText('Could not index: R2 is on fire')).toBeTruthy();
  });

  it('says nothing for a run it abandoned', async () => {
    const heard = listen();
    let finish: (result: IndexResult) => void = () => {};
    indexPendingFiles.mockImplementation(() => new Promise((resolve) => (finish = resolve)));

    const view = render(<IndexFiles note="n1" />);
    view.unmount();
    finish({ done: 1, indexed: 1, unusable: 0, failed: 0, total: 1 });
    await settle();

    expect(heard).toEqual([{ type: 'ready' }]);
  });
});
