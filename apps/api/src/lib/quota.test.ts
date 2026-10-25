import { describe, expect, it } from 'vitest';
import { GB, STORE_FLOOR_BYTES, storeLimitBytes } from '@unbent/shared';
import type { AttachmentsRepo } from './attachments-repo.js';
import { StorageFull, assertRoom, quotaOf, storageFullMessage, storeFullMessage, storeLimitOf, writeLimitsOf } from './quota.js';
import type { PlanRow } from './plan.js';

const stripe = {
  STRIPE_SECRET_KEY: 'sk_test_x',
  STRIPE_WEBHOOK_SECRET: 's',
  STRIPE_PLAN_PRICE_ID: 'p',
  STRIPE_STORAGE_PRICE_ID: 'q',
};

const repo = (used: number) => ({ storageUsed: async () => used }) as unknown as AttachmentsRepo;

describe('the storage quota', () => {
  it('is none where billing is off, and the plan\'s gigabytes where it is on', () => {
    const row = { storageGb: 35 } as PlanRow;
    expect(quotaOf({}, row)).toBeNull();
    expect(quotaOf(stripe, undefined)).toBeNull();
    expect(quotaOf(stripe, row)).toBe(35 * GB);
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

  /**
   * The store's own bound (MAK-234): a floor plus a tenth of the quota, none where
   * billing is off, and a sentence that names the way out for notes rather than files.
   */
  it('bounds the store at a floor plus a tenth of the quota, and not at all where billing is off', () => {
    expect(storeLimitBytes(10 * GB)).toBe(STORE_FLOOR_BYTES + GB);
    expect(storeLimitBytes(35 * GB)).toBe(STORE_FLOOR_BYTES + 3.5 * GB);
    const row = { storageGb: 10 } as PlanRow;
    expect(storeLimitOf({}, row)).toBeNull();
    expect(storeLimitOf(stripe, undefined)).toBeNull();
    expect(storeLimitOf(stripe, row)).toBe(STORE_FLOOR_BYTES + GB);
  });

  /**
   * An account no plan holds is held to the free plan's gigabyte, and its store's room
   * follows from that for notes; a file's text keeps the room its own storage gave it,
   * so a read-only archive's text pass is not refused at a fraction of what it had.
   */
  it('gives a lapsed account the free plan\u2019s room for notes and its own for files\u2019 text', () => {
    const ended = { plan: 'inactive', planUntil: 1, storageGb: 35, source: null, subscriptionStatus: null, cancelsAt: null } as unknown as PlanRow;
    expect(quotaOf(stripe, ended)).toBe(GB);
    expect(writeLimitsOf(stripe, ended)).toEqual({
      store: storeLimitBytes(GB),
      free: { notes: 100, attachmentBytes: GB },
      text: storeLimitBytes(35 * GB),
    });
    const active = { plan: 'active', planUntil: null, storageGb: 35, source: 'comp', subscriptionStatus: null, cancelsAt: null } as unknown as PlanRow;
    expect(writeLimitsOf(stripe, active)).toEqual({ store: storeLimitBytes(35 * GB), free: null });
  });

  it('says the notes are what to delete when it is the store that is full', () => {
    expect(storeFullMessage(1.6 * GB, STORE_FLOOR_BYTES + GB)).toBe(
      "This account's notes take more room than its plan allows: 1.6 GB of 1.5 GB. Delete some notes or clear their history, empty the trash, or add storage under Settings → Plan.",
    );
    expect(storeFullMessage(600 * 1024 * 1024, STORE_FLOOR_BYTES)).toContain('600 MB of 512 MB');
    const err = new StorageFull(1.6 * GB, STORE_FLOOR_BYTES + GB, 0, 'notes');
    expect(err.code).toBe('STORAGE_FULL');
    expect(err.of).toBe('notes');
    expect(err.message).toContain('notes take more room');
    // The upload's refusal is unchanged, and is the default.
    expect(new StorageFull(5 * GB, 10 * GB, 6 * GB).of).toBe('files');
  });
});
