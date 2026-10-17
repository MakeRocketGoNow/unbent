import { GB, STORAGE_FULL_CODE, storageQuotaBytes } from '@unbent/shared';
import type { AttachmentsRepo } from './attachments-repo.js';
import { billingOn, type PaddleEnv } from './paddle.js';
import { planFor, type PlanRow } from './plan.js';

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

/** Bytes as a person reads them: round megabytes under a gigabyte, one decimal above. */
function roomOf(bytes: number): string {
  return bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${Math.round(bytes / MB)} MB`;
}

/**
 * How much room the account's own store may take (MAK-234): a floor, plus a tenth of
 * the quota on files.
 *
 * The quota bounds the bytes in R2 and nothing else; what the store holds (note bodies,
 * the copies the history keeps of them, the text extracted from files, the search
 * index) had no bound at all, and a loop writing maximum-size notes held tens of
 * gigabytes on a trial with no card (measured 2026-10-16: a maximum note costs about
 * 2.2 MB of store, so ten thousand of them are 22 GB). Store bytes are also the dearer
 * kind, about thirteen times R2's price per gigabyte-month, so a tenth of the quota in
 * the store costs what the whole quota does in the bucket: within what the plan is
 * priced for, and no more.
 *
 * The floor is for the archive this app is for, whose store is mostly its files' text.
 * A real one measured at a few percent of its files (21.8 MB of text in a 46 MB store
 * for 2,415 files, 2026-09-29), so a tenth of the quota is a wide margin for text
 * that comes with files; the floor is the margin for an account whose files are
 * small and whose notes are not, and for the history of a long-kept archive. Nothing
 * this app does on purpose comes near the sum, and the refusal must never fire for an
 * account that only filed what it scanned. One number for every plan rather than a
 * setting, as the quota's blocks are: an operator who finds it wrong changes it here.
 *
 * Note writes and a file's text are held to it (`NotesRepo`, `AttachmentsRepo`):
 * deleting, trashing and emptying the trash are the way back under. The text is
 * bounded too because the quota on files counts bytes in the bucket, and a text layer
 * sent for a file is as long as the sender makes it, whatever the file's size.
 */
export const STORE_FLOOR_BYTES = 512 * MB;

export function storeLimitBytes(quotaBytes: number): number {
  return STORE_FLOOR_BYTES + Math.floor(quotaBytes / 10);
}

/** The account's store limit in bytes, or null for none: billing off. */
export function storeLimitOf(env: PaddleEnv, plan: PlanRow | undefined): number | null {
  const quota = quotaOf(env, plan);
  return quota === null ? null : storeLimitBytes(quota);
}

/** The same, read from the database, for a caller without the row on its context. */
export async function storeLimitFor(env: PaddleEnv, db: D1Database, userId: string): Promise<number | null> {
  const quota = await quotaFor(env, db, userId);
  return quota === null ? null : storeLimitBytes(quota);
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

/** The JSON a route answers a `StorageFull` with: the 402's body, with the numbers for the page. */
export function storageFullBody(err: StorageFull) {
  return { code: err.code, error: err.message, of: err.of, usedBytes: err.usedBytes, quotaBytes: err.quotaBytes };
}
