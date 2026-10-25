import { FREE_STORAGE_GB, GB, STORAGE_FULL_CODE, storageQuotaBytes, storeLimitBytes } from '@unbent/shared';
import type { AttachmentsRepo } from './attachments-repo.js';
import { freeLimitsOf } from './free-plan.js';
import { billingOn, type StripeEnv } from './stripe.js';
import { lapsed, planFor, type PlanRow } from './plan.js';
import type { WriteLimits } from '../store/user-store.js';

/**
 * The plan's storage, enforced where bytes come in (MAK-108): an upload, a copy, a
 * fetched picture, a duplicate. The quota is the plan row's `storage_gb`; what is held
 * is the store's own sum of its files (`attachmentBytes`, schema 0008). Null is no quota
 * (an instance with billing off), and a caller that has null checks nothing.
 *
 * Decided in the store, in the transaction that records the row, against the sum it
 * keeps (`AttachmentsStore.record`), so two uploads in flight cannot both take the last
 * block. `assertRoom` is a check ahead of that one, on the size declared, for the paths
 * where refusing early saves something real: a streamed upload, so the client stops
 * sending into a refusal, and a copy of several files, so none are copied to be deleted.
 * It costs its own call to the account's object (`storageUsed`), one more per file than
 * the record makes, so a path whose bytes are already in hand (a fetched picture)
 * skips it and lets the record decide alone.
 */

/** Which of the two bounds refused: the files in R2, or the account's own store (MAK-234). */
export type StorageOf = 'files' | 'notes';

/**
 * A write the plan has no room for. `of` says which bound: `files` is the quota on
 * attachment bytes, `notes` the limit on the store itself (`storeLimitBytes`), and the
 * sentence is the one for that bound, since what to delete differs. `usedBytes` and
 * `quotaBytes` are the numbers of whichever bound it was.
 */
export class StorageFull extends Error {
  readonly code = STORAGE_FULL_CODE;
  constructor(
    readonly usedBytes: number,
    readonly quotaBytes: number,
    readonly addingBytes: number,
    readonly of: StorageOf = 'files',
  ) {
    super(of === 'notes' ? storeFullMessage(usedBytes, quotaBytes) : storageFullMessage(usedBytes, quotaBytes));
    this.name = 'StorageFull';
  }
}

/** The sentence a refused upload is answered with, in round gigabytes, with what to do about it. */
export function storageFullMessage(usedBytes: number, quotaBytes: number): string {
  const used = (usedBytes / GB).toFixed(usedBytes >= 10 * GB ? 0 : 1);
  const quota = Math.round(quotaBytes / GB);
  return `This account's storage is full: ${used} GB of ${quota} GB used. Delete some files, or add storage under Settings → Plan.`;
}

/**
 * The sentence a note write refused for the store's size is answered with. The way out
 * is named: notes and their history are what the store holds (clearing a note's history
 * frees room without deleting anything), and a trashed note still holds its room, so
 * the trash has to be emptied too. Adding storage helps as well, since the limit grows
 * with the quota.
 */
export function storeFullMessage(usedBytes: number, limitBytes: number): string {
  return `This account's notes take more room than its plan allows: ${roomOf(usedBytes)} of ${roomOf(limitBytes)}. Delete some notes or clear their history, empty the trash, or add storage under Settings → Plan.`;
}

const MB = 1024 * 1024;

/** Bytes as a person reads them: round megabytes under a gigabyte, one decimal above. The store's sentences use it, so a refusal and the storage route agree. */
export function roomOf(bytes: number): string {
  return bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${Math.round(bytes / MB)} MB`;
}

/*
 * The store limit's number and its reasoning live in the shared package
 * (`storeLimitBytes` in `plan.ts`), beside the quota it is derived from: the Plan page
 * works the smaller plan's limit out for itself before offering to remove a block.
 */

/** The account's store limit in bytes, or null for none: billing off. */
export function storeLimitOf(env: StripeEnv, plan: PlanRow | undefined): number | null {
  const quota = quotaOf(env, plan);
  return quota === null ? null : storeLimitBytes(quota);
}

/**
 * Everything a write carries to the store (`WriteLimits`): the store's room, and the
 * free plan's limits while no plan holds. Null where billing is off, which bounds
 * nothing. What `reposFor`'s source answers for a request with the row in hand.
 */
export function writeLimitsOf(env: StripeEnv, plan: PlanRow | undefined): WriteLimits | null {
  if (!billingOn(env) || !plan) return null;
  return { store: storeLimitOf(env, plan), free: freeLimitsOf(env, plan) };
}

/** The same, read from the database, for a caller without the row on its context. */
export async function writeLimitsFor(env: StripeEnv, db: D1Database, userId: string): Promise<WriteLimits | null> {
  if (!billingOn(env)) return null;
  return writeLimitsOf(env, await planFor(db, userId));
}

/**
 * The gigabytes of files the account may hold: its plan's, or the free plan's while no
 * plan holds, so a free account's uploads stop at its gigabyte with the same refusal a
 * full paid plan's do, and its store's room follows from that as every account's does.
 * An account that lapsed holding more is past the free plan and read-only besides.
 */
export function storageGbOf(plan: PlanRow, now = Date.now()): number {
  return lapsed(plan, now) ? FREE_STORAGE_GB : plan.storageGb;
}

/** The account's quota in bytes, or null for none: billing off. */
export function quotaOf(env: StripeEnv, plan: PlanRow | undefined): number | null {
  if (!billingOn(env) || !plan) return null;
  return storageQuotaBytes(storageGbOf(plan));
}

/** The same, read from the database, for a caller without the row on its context. */
export async function quotaFor(env: StripeEnv, db: D1Database, userId: string): Promise<number | null> {
  if (!billingOn(env)) return null;
  return storageQuotaBytes(storageGbOf(await planFor(db, userId)));
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

/** The JSON a route answers a `StorageFull` with: the 402's body, with the numbers for the page. */
export function storageFullBody(err: StorageFull) {
  return { code: err.code, error: err.message, of: err.of, usedBytes: err.usedBytes, quotaBytes: err.quotaBytes };
}
