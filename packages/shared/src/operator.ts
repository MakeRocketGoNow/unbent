import type { AccountPlan } from './plan.js';
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
 * rule, set by hand on the bucket (docs/architecture.md, "Where your notes live", under
 * Daily dumps), not by anything in the code. Stated here so the page and the Worker say one
 * number.
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
  /**
   * The account's plan as the Plan page reads it (MAK-108), from its row rather than the
   * sweep; absent where the instance sells no plan. The single-account route carries it;
   * the list does not, since a list that read a second table per row would be two reads
   * a row for a column most pages never look at.
   */
  plan?: AccountPlan;
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
}

/**
 * One restore or load of an account's store, as the operator page lists it (migration
 * 0041, `lib/restores.ts`). Newest first in `StoreRestores`.
 */
export interface StoreRestore {
  id: number;
  /**
   * A wind-back to a `moment`; a restore to a `bookmark`, which is an undo when `undoes`
   * names the row whose bookmark it was; or the `load` of a dump.
   */
  kind: 'moment' | 'bookmark' | 'load';
  /**
   * `started` until the store answered, and for good when it never did: the Worker log
   * says whether it applied. `failed` is a load that emptied the store and did not fill it.
   */
  state: 'started' | 'applied' | 'failed';
  startedAt: number;
  appliedAt: number | null;
  /** The moment a `moment` went back to. */
  toAt: number | null;
  /** A load's dump, and the dump it wrote of the store as it stood first; keys in the backups bucket. */
  dump: string | null;
  before: string | null;
  /**
   * The bookmark that reverses this row, good for `RESTORE_WINDOW_DAYS` from when it was
   * taken, which is no earlier than `startedAt`; null when the runtime handed none back.
   */
  undo: string | null;
  /** The row this one undid. */
  undoes: number | null;
  /** The row that undid this one, when it is in the same answer. */
  undoneBy: number | null;
  /** Who asked: null on a wind-back recorded before the history was kept, which named no one. */
  operator: { id: string; email: string | null } | null;
}

/** How many of an account's restores the page lists. */
export const RESTORES_LISTED = 20;

export interface StoreRestores {
  /** Newest first, at most `RESTORES_LISTED`. */
  restores: StoreRestore[];
  /** Whether older ones exist beyond the list. */
  more: boolean;
}

/** How many accounts one page of the operator's list carries by default. */
export const OPERATOR_PAGE_SIZE = 50;
/** The most accounts one request may ask for; the route clamps `limit` to it. */
export const OPERATOR_PAGE_MAX = 200;
/** The longest search the accounts list takes: an address's own limit, 64 + 1 + 255. */
export const OPERATOR_SEARCH_MAX = 320;

/**
 * The columns the accounts list sorts by, as the route's `sort` takes them. `email` is
 * the default and the only one an index serves; see `listOperatorAccounts`.
 */
export const OPERATOR_SORTS = ['email', 'created', 'notes', 'size', 'active', 'dump'] as const;
export type OperatorSort = (typeof OPERATOR_SORTS)[number];
export type OperatorSortDir = 'asc' | 'desc';
/** An order the list was asked for; what is left out is the default (`email`, and the sort's first direction). */
export interface OperatorOrder {
  sort?: OperatorSort;
  dir?: OperatorSortDir;
}

/**
 * Which way a column sorts when it is first chosen: an address A to Z, everything else
 * newest or largest first, since that end of a date or a size is the one looked for.
 */
export const OPERATOR_SORT_FIRST: Record<OperatorSort, OperatorSortDir> = {
  email: 'asc',
  created: 'desc',
  notes: 'desc',
  size: 'desc',
  active: 'desc',
  dump: 'desc',
};

export interface OperatorAccountsPage {
  /**
   * In the order asked for (by email, A to Z, unless told otherwise); only those whose
   * email or name holds the search, when there is one.
   */
  accounts: OperatorAccount[];
  /** Where this page ended, to pass back as `after` for the next; null when this was the last page. Opaque. */
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

/**
 * What an assistant's feedback is about (MAK-212), the `send_feedback` tool's
 * `category`. The set Axiom's own tool settled on, since the point of a category is that
 * the operator can tell a wrong answer from a missing feature at a glance, and theirs was
 * drawn from what agents actually reported. Each has its label on the operator page.
 */
export const FEEDBACK_CATEGORIES = {
  'tool-result': 'Tool result',
  'error-message': 'Error message',
  'missing-capability': 'Missing capability',
  'tool-description': 'Tool description',
  performance: 'Performance',
  praise: 'Praise',
  other: 'Other',
} as const;

export type FeedbackCategory = keyof typeof FEEDBACK_CATEGORIES;

/** The longest feedback the tool takes: a bug report's length, not an essay's. */
export const FEEDBACK_MAX_CHARS = 2000;

/** One piece of an assistant's feedback, as the operator page lists it. */
export interface AssistantFeedback {
  id: number;
  userId: string;
  /** The account's address; null only when the row outlived a `user` row it should have gone with. */
  email: string | null;
  /** The OAuth client that sent it, and the name it registered under then. */
  clientId: string;
  clientName: string | null;
  category: FeedbackCategory;
  /** The tool it is about, as the assistant named it. */
  tool: string | null;
  body: string;
  createdAt: number;
  /** When the operator dismissed it; null while it is unread. */
  readAt: number | null;
}

export interface AssistantFeedbackPage {
  /** Unread, or every row when the dismissed were asked for too, newest first. */
  feedback: AssistantFeedback[];
  /** Pass back as `after` for the next page; null when this was the last. */
  next: string | null;
}
