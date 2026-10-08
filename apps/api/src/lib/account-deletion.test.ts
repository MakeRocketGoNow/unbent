import { describe, expect, it, vi } from 'vitest';
import { deleteAccount } from './account-deletion.js';

/**
 * The operator's delete, against fakes that record the order things happen in. Over
 * HTTP the suites cannot reach it — none of their actors is an operator — and the order
 * is the point: files and store before the row, so a failure leaves an account that can
 * be deleted again rather than files nothing can name.
 */

function fakeEnv(fail?: 'blobs' | 'wipe') {
  const steps: string[] = [];
  const env = {
    BLOBS: {
      async list() {
        if (fail === 'blobs') throw new Error('R2 is down');
        steps.push('list');
        return { objects: [{ key: 'users/u1/a.pdf' }], truncated: false };
      },
      async delete() {
        steps.push('blobs');
      },
    },
    USER_STORE: {
      idFromName: (name: string) => name,
      get: () => ({
        async wipe() {
          if (fail === 'wipe') throw new Error('object reset');
          steps.push('wipe');
        },
      }),
    },
    DB: {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          async run() {
            steps.push(sql.startsWith('DELETE FROM user') ? `user ${String(args[0])}` : 'tombstone');
          },
        }),
      }),
    },
  };
  return { env: env as unknown as Parameters<typeof deleteAccount>[0], steps };
}

describe('deleteAccount', () => {
  it('deletes the files, then the store, then the row, then tombstones the directory', async () => {
    const { env, steps } = fakeEnv();
    await deleteAccount(env, 'u1');
    expect(steps).toEqual(['list', 'blobs', 'wipe', 'user u1', 'tombstone']);
  });

  it.each(['blobs', 'wipe'] as const)('keeps the account when the %s step fails', async (step) => {
    const { env, steps } = fakeEnv(step);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(deleteAccount(env, 'u1')).rejects.toThrow();
    quiet.mockRestore();
    expect(steps.some((s) => s.startsWith('user'))).toBe(false);
    expect(steps).not.toContain('tombstone');
  });
});
