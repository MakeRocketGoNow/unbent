import { describe, expect, it } from 'vitest';
import { GB } from '@unbent/shared';
import type { AttachmentsRepo } from './attachments-repo.js';
import { StorageFull, assertRoom, quotaOf, storageFullMessage } from './quota.js';
import type { PlanRow } from './plan.js';

const paddle = {
  PADDLE_API_KEY: 'pdl_sdbx_apikey_x',
  PADDLE_WEBHOOK_SECRET: 's',
  PADDLE_CLIENT_TOKEN: 't',
  PADDLE_PLAN_PRICE_ID: 'p',
  PADDLE_STORAGE_PRICE_ID: 'q',
};

const repo = (used: number) => ({ storageUsed: async () => used }) as unknown as AttachmentsRepo;

describe('the storage quota', () => {
  it('is none where billing is off, and the plan\'s gigabytes where it is on', () => {
    const row = { storageGb: 35 } as PlanRow;
    expect(quotaOf({}, row)).toBeNull();
    expect(quotaOf(paddle, undefined)).toBeNull();
    expect(quotaOf(paddle, row)).toBe(35 * GB);
  });

  it('lets a file in that fits exactly, and refuses one byte more', async () => {
    await expect(assertRoom(repo(9 * GB), 10 * GB, GB)).resolves.toBeUndefined();
    await expect(assertRoom(repo(9 * GB), 10 * GB, GB + 1)).rejects.toBeInstanceOf(StorageFull);
    await expect(assertRoom(repo(99 * GB), null, GB)).resolves.toBeUndefined();
  });

  it('says how full in a sentence a person can act on', () => {
    expect(storageFullMessage(9.96 * GB, 10 * GB)).toBe(
      "This account's storage is full: 10.0 GB of 10 GB used. Delete some files, or add storage under Settings → Plan.",
    );
    expect(storageFullMessage(34.5 * GB, 35 * GB)).toContain('35 GB of 35 GB');
    const err = new StorageFull(5 * GB, 10 * GB, 6 * GB);
    expect(err.code).toBe('STORAGE_FULL');
    expect(err.message).toContain('5.0 GB of 10 GB');
  });
});
