/**
 * What the operator page reads (MAK-171, part 5): the two status files the backup
 * leaves in the backups bucket, and the directory's view of each account. Shared
 * because the Worker writes one of the files (`lib/backups.ts`), a script writes the
 * other (`scripts/mirror/write-status.mjs`), and the page draws both; a shape declared
 * in the API alone would leave the page reading a copy that drifts.
 */

/**
 * How far back a store's history reaches, in days: what the restore route accepts
 * (`RESTORE_WINDOW_MS` in the API derives from it) and what the operator page says.
 * Here rather than in the API so the two cannot drift.
 */
export const RESTORE_WINDOW_DAYS = 30;

/**
 * How long a deleted file's object stays in the live bucket after its row has gone
 * (`DELETED_BLOB_RETENTION_MS` in the API's store derives from it): five more than the
 * restore window, so a store wound back to any moment finds its files. Part 1 of MAK-171.
 */
export const DELETED_FILES_KEPT_DAYS = RESTORE_WINDOW_DAYS + 5;

/**
 * How many days the backups bucket keeps a daily dump: its `expire-dumps` lifecycle
 * rule, set by hand on the bucket (README, "Where your notes live", under Daily dumps),
 * not by anything in the code. Stated here so the page and the Worker say one number.
 */
export const DUMPS_KEPT_DAYS = 14;

/** The mirror's `expire-stores` lifecycle rule on the second account's bucket, set by hand there. */
export const MIRROR_KEPT_DAYS = 90;

/** What the daily dump run writes to `status/dumps.json`; see `dumpStores` in the API. */
export interface DumpStatus {
  ranAt: string;
  run: {
    /** Accounts dumped this run, and the bytes written for them. */
    dumped: number;
    bytes: number;
    /** Accounts whose newest dump was still current. */
    unchanged: number;
    failed: number;
    /** Accounts left for a later run: a transient store failure, or the budget ran out. */
    deferred: number;
    /** Whether every account due was reached. */
    done: boolean;
    subrequests: number;
    ms: number;
  };
  /** Live accounts in the directory. */
  accounts: number;
  /** Accounts whose last attempt failed, with the error; at most fifty of them. */
  failing: Array<{ userId: string; error: string; triedAt: string | null }>;
  failingCount: number;
  /** Accounts no run has found current in `staleAfterHours`; at most fifty of them. */
  stale: string[];
  staleCount: number;
  staleAfterHours: number;
}

/** The tally of one `rclone copy`, as `write-status.mjs` reads it from rclone's log. */
export interface MirrorCopy {
  copied: number | null;
  bytes: number | null;
  errors: number | null;
  /** The first few error lines, each naming its object. */
  errorLines: string[];
}

/** What the nightly mirror writes to `status/mirror.json`; see `scripts/mirror/write-status.mjs`. */
export interface MirrorStatus {
  /** When the run started, and when the file was written. */
  ranAt: string;
  finishedAt: string;
  ok: boolean;
  /** GitHub's `job.status`: success, failure or cancelled. */
  outcome: string;
  failedSteps: string[];
  run: { event: string | null; id: string | null; url: string | null };
  blobs: MirrorCopy & { live: number | null; mirror: number | null };
  stores: MirrorCopy;
  d1: { key: string; bytes: number; written: boolean } | null;
  prune: { gone: number; pruned: number; goneDays: number } | null;
  /** What `check-dumps.mjs` made of the Worker's status file. */
  dumps: { ok: boolean; reasons: string[]; ranAt: string | null; ageHours: number | null } | null;
}

/**
 * What `GET /api/admin/backups` answers. `bound: false` is an instance with no backups
 * bucket, where nothing is dumped and the page says so rather than showing empty
 * numbers; either file is null until its run has written it.
 */
export type BackupsStatus =
  | { bound: false }
  | {
      bound: true;
      dumps: DumpStatus | null;
      mirror: MirrorStatus | null;
      /**
       * The email of every account the dump status names as failing or stale, by id, so
       * the health card can name them whatever pages of the accounts list have been read.
       * The status file carries ids alone; the lists are bounded at fifty each.
       */
      names: Record<string, string>;
    };

/** One account as the directory knows it, for the operator's list. */
export interface OperatorAccount {
  userId: string;
  email: string;
  name: string | null;
  createdAt: number;
  /** As of the last sweep, not live; see `lib/directory.ts`. */
  noteCount: number;
  storageBytes: number;
  lastActiveAt: number | null;
  /** The daily backup's record of the account's newest dump (migration 0037). */
  dump: {
    at: number | null;
    bytes: number | null;
    /** When a run last found the newest dump current, by writing it or by finding the store unchanged. */
    checkedAt: number | null;
    triedAt: number | null;
    /** The last attempt's failure, cleared by the next success. */
    error: string | null;
  };
  /**
   * The last wind-back of the store to a moment (migration 0038): when it was applied,
   * the moment it went back to, and the bookmark that reverses it, good for
   * `RESTORE_WINDOW_DAYS` from `at`, or null when the runtime handed none back. Kept here
   * rather than in the answer alone so the page can offer Undo after a reload. A restore
   * to a bookmark — an undo — clears it rather than replacing it: see `recordRestore`.
   */
  restore: { at: number; toAt: number; undo: string | null } | null;
}

/** How many accounts one page of the operator's list carries, and the most a request may ask for. */
export const OPERATOR_PAGE_SIZE = 50;
export const OPERATOR_PAGE_MAX = 200;

export interface OperatorAccountsPage {
  /** Newest activity first: the newest write the sweep recorded, else the account's creation. */
  accounts: OperatorAccount[];
  /** Where this page ended, to pass back as `after` for the next; null when this was the last page. */
  next: string | null;
}

/** One file under an account's `stores/` prefix in the backups bucket. */
export interface AccountDump {
  key: string;
  /** The file's name under the prefix: `2026-10-06.sql`, or `…-before-load.sql`. */
  name: string;
  size: number;
  uploadedAt: string;
}

export interface AccountDumps {
  dumps: AccountDump[];
}
