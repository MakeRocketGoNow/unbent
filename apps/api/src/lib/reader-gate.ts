/**
 * A ceiling on how many attachment reads hold a file in memory at once.
 *
 * Reading a stored file into `attachment_text` (see read-attachment.ts) pulls the whole
 * thing back out of R2 into the isolate: the Workers AI conversion needs it as a Blob, and
 * the vision reader needs its bytes. Either way that is up to the read caps' worth of file
 * inside the 128MB an isolate has. One at a time it is well clear of the ceiling. A bulk
 * import is not one at a time — its uploads land back to back on the same isolate, each
 * starts a read in `waitUntil`, and `waitUntil` keeps every one of them alive for up to
 * thirty seconds after its own request returned. So a run of files stacks several full ones
 * in memory together, and enough at once is how the isolate is evicted with
 * `exceededResources` — which reaches the browser as an edge 503 and stops the import.
 *
 * This gate makes the reads take turns. It is a module-level singleton on purpose: the
 * thing being protected is the isolate's memory, which every request on that isolate shares,
 * so the count that matters is across requests, not within one. A slot is held only for the
 * read itself, never for the upload — the upload streams straight to R2 and holds nothing,
 * so it must not be made to wait behind a read.
 */

/**
 * How many reads may hold their file at once.
 *
 * Two, not one: a single slot would serialize every read across the whole isolate and make
 * an import of scans crawl, for no memory benefit until a second large file actually
 * overlaps. Two files at the read caps plus a reader's own working set sit far enough under
 * 128MB to be safe, and let one read proceed while another waits on the AI service.
 */
const MAX_CONCURRENT_READS = 2;

let active = 0;
const waiting: Array<() => void> = [];

/** Resolves when a slot is free, having taken it. The caller must `release` it after. */
function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT_READS) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    waiting.push(() => {
      active += 1;
      resolve();
    });
  });
}

function release(): void {
  active -= 1;
  const next = waiting.shift();
  if (next) next();
}

/**
 * Runs `work` with a slot held, waiting its turn when the isolate is already at the
 * ceiling. Releases the slot however `work` ends — a throw is the caller's to handle, but
 * the slot is freed first so one failed read never wedges the queue.
 */
export async function withReaderSlot<T>(work: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await work();
  } finally {
    release();
  }
}
