import { GB, STORAGE_FULL_CODE, storageQuotaBytes } from '@unbent/shared';
import type { AttachmentsRepo } from './attachments-repo.js';
import { billingOn, type PaddleEnv } from './paddle.js';
import { planFor, type PlanRow } from './plan.js';

/**
 * The plan's storage, enforced where bytes come in (MAK-108): an upload, a copy, a
 * fetched picture, a duplicate. The quota is the plan row's `storage_gb`; what is held
 * is the store's own sum of its files (`attachmentBytes`, schema 0008). Null is no quota
 * — an instance with billing off — and a caller that has null checks nothing.
 *
 * Checked before the bytes move where their size is known (a request's Content-Length,
 * a row's `size`), and again after R2 has them where it was not, since a declared length
 * is a claim: `storeAttachment` deletes what it just stored when the true size turns out
 * to be past the line. The sum is read once per check, a row from the store, which the
 * upload was going to reach anyway.
 */

export class StorageFull extends Error {
  readonly code = STORAGE_FULL_CODE;
  constructor(
    readonly usedBytes: number,
    readonly quotaBytes: number,
    readonly addingBytes: number,
  ) {
    super(storageFullMessage(usedBytes, quotaBytes));
    this.name = 'StorageFull';
  }
}

/** The sentence a refused upload is answered with, in round gigabytes, with what to do about it. */
export function storageFullMessage(usedBytes: number, quotaBytes: number): string {
  const used = (usedBytes / GB).toFixed(usedBytes >= 10 * GB ? 0 : 1);
  const quota = Math.round(quotaBytes / GB);
  return `This account's storage is full: ${used} GB of ${quota} GB used. Delete some files, or add storage under Settings → Plan.`;
}

/** The account's quota in bytes, or null for none: billing off. */
export function quotaOf(env: PaddleEnv, plan: PlanRow | undefined): number | null {
  if (!billingOn(env) || !plan) return null;
  return storageQuotaBytes(plan.storageGb);
}

/** The same, read from the database, for a caller without the row on its context. */
export async function quotaFor(env: PaddleEnv, db: D1Database, userId: string): Promise<number | null> {
  if (!billingOn(env)) return null;
  return storageQuotaBytes((await planFor(db, userId)).storageGb);
}

/**
 * Throws `StorageFull` when `adding` bytes would take the account past `quota`. A file
 * that fits exactly fits. Nothing is read when there is no quota.
 */
export async function assertRoom(attachments: AttachmentsRepo, quota: number | null, adding: number): Promise<void> {
  if (quota === null) return;
  const used = await attachments.storageUsed();
  if (used + adding > quota) throw new StorageFull(used, quota, adding);
}

/**
 * The store's refusal, as it arrives over RPC: `StorageExceeded` in store/attachments.ts
 * loses its class on the way and keeps its properties. Null for any other error.
 */
export function storageExceeded(err: unknown): StorageFull | null {
  const e = err as { code?: unknown; usedBytes?: unknown; quotaBytes?: unknown; addingBytes?: unknown } | null;
  if (e?.code !== STORAGE_FULL_CODE || typeof e.usedBytes !== 'number' || typeof e.quotaBytes !== 'number') return null;
  return new StorageFull(e.usedBytes, e.quotaBytes, typeof e.addingBytes === 'number' ? e.addingBytes : 0);
}

/** The JSON a route answers a `StorageFull` with: the 402's body, with the numbers for the page. */
export function storageFullBody(err: StorageFull) {
  return { code: err.code, error: err.message, usedBytes: err.usedBytes, quotaBytes: err.quotaBytes };
}
