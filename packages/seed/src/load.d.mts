/**
 * Types for the seed's public entry, which is plain JavaScript so that `pnpm seed:demo`
 * can run it under Node with no build step. Only what callers use is declared; the data
 * modules behind it are the loader's business.
 */

/** The fetch the loader calls, already carrying whatever the caller authenticates with. */
export type SeedRequest = (path: string, init?: RequestInit) => Promise<Response>;

export interface SeedCounts {
  created: number;
  updated: number;
  files: number;
  trashed: number;
  /** Notes the seed puts in the trash that were already there from an earlier run. */
  skipped: number;
}

export function loadSeed(options: {
  request: SeedRequest;
  now?: number;
  /** Only the ten showcase notes. */
  small?: boolean;
  /** Warnings: a field the server skipped, a definition it could not apply. */
  log?: (line: string) => void;
  /** After each note, how many are done of how many. Called once with 0 before the first. */
  onProgress?: (done: number, total: number) => void;
}): Promise<SeedCounts>;

/** Deletes every note in the account for good, trash included. Answers how many. */
export function clearNotes(options: { request: SeedRequest }): Promise<number>;

export interface SeedNote {
  key: string;
  title: string;
  body: string;
  tags?: string[];
  notebook?: string;
  fields?: Record<string, unknown>;
  age: number;
  trashed?: boolean;
  files?: Array<{ name: string; image?: boolean; lines?: string[]; pages?: string[][] }>;
}

export function seedNotes(options?: { small?: boolean }): SeedNote[];
