import type { AutofillSuggestion } from '@unbent/shared';
import { attachmentTextFor, autofill, EXAMPLES_PER_OPTION, MAX_TAGS_ASKED } from './autofill.js';
import type { AttachmentsRepo } from './attachments-repo.js';
import type { Jev } from './jev.js';
import type { LanguageModel } from './llm.js';
import { capReached, PressUsage, yearReached } from './llm-usage.js';
import type { NotesRepo } from './notes-repo.js';
import type { PressLimits } from '../store/llm-usage.js';
import { readPendingFiles, type BlobStore, type Readers } from './read-attachment.js';

/**
 * How many of the note's unread files one press will read. A card and its back fit; a
 * note with a stack of twenty scans is read five at a press, with the rest reported as
 * still waiting, since a press that silently paid for the whole stack would be the
 * surprise this cap exists to prevent. Maintenance offered the rest as a pass of its own
 * until MAK-179; the press is the only reader now.
 */
export const OWN_FILES_TO_READ = 5;

/** What a press needs, handed in so a test can stand in for every part of it. */
export interface PressDeps {
  notes: Pick<NotesRepo, 'autofillPrelude' | 'autofillContext' | 'recordLlmUsage'>;
  attachments: Pick<AttachmentsRepo, 'recordText'>;
  blobs: BlobStore;
  /** The readers a press may use (`autofillReaders`); its `usage` is set here. */
  readers: Omit<Readers, 'usage'>;
  /** Null where the instance has no key for Jev: the press is answered 503 and not counted. */
  jev: Jev | null;
  /** The language model for the title and the text fields, where the instance has one. */
  llm?: Pick<LanguageModel, 'title' | 'textFields'> | undefined;
  /** The day's cap on presses and the year's on spend, each null for none (`limitsFor`). */
  limits: PressLimits;
  /** Whether the person pressing runs the instance; see `autofill`. */
  operator: boolean;
  /**
   * Hands the end-of-press record to the runtime to finish after the answer has gone
   * (`waitUntil`), where there is one. Without it the record is awaited, as in a test.
   */
  defer?: ((work: Promise<unknown>) => void) | undefined;
  now?: number;
}

export type PressOutcome =
  | { kind: 'missing' }
  | { kind: 'unconfigured' }
  | { kind: 'capped'; message: string; retryAfter: number }
  | { kind: 'filed'; suggestion: AutofillSuggestion };

/**
 * One press of Auto-fill: `POST /notes/:id/autofill`, less the HTTP. A function of its
 * own so a test can run a whole press against stand-ins and count what it cost (MAK-180).
 *
 * Ownership is checked before configuration, so the 404 for another user's note holds on
 * an instance with no key too; then the press is counted against the day's cap and the
 * year's spend, in the call that reads the note, and refused past either. Every press of
 * a live note on an instance that can answer is counted, failed ones included, which is
 * what makes the cap a ceiling on what can be asked rather than on what went well.
 *
 * What the model cost is recorded as it goes: each reading with its text, and the rest
 * (the title, the fields, any reading paid for and thrown away) in one call at the end,
 * whether the press succeeded or not. `NothingToRead` and `JevError` come out of here as
 * thrown, for the route to answer as before.
 */
export async function press(deps: PressDeps, id: string): Promise<PressOutcome> {
  const now = deps.now ?? Date.now();
  // The note and its own unread files, in one call; the read below wants both.
  const prelude = await deps.notes.autofillPrelude(id, OWN_FILES_TO_READ, deps.jev ? deps.limits : undefined);
  if (!prelude) return { kind: 'missing' };
  if (!deps.jev) return { kind: 'unconfigured' };
  if (prelude.press && !prelude.press.allowed) {
    // The store says which limit refused; each has a sentence of its own.
    const refusal = prelude.press.reason === 'year' ? yearReached(now) : capReached(deps.limits.cap!, now);
    return { kind: 'capped', ...refusal };
  }
  const { note, forText, forVision } = prelude;
  const usage = new PressUsage();
  /*
     Registered now rather than in `finally`: a client that disconnects cancels whatever
     has no `waitUntil` pending, and the press (its readings and its record) would go
     with it. Resolved with the record once there is one.
  */
  let recorded!: (work: Promise<unknown>) => void;
  deps.defer?.(new Promise<unknown>((resolve) => (recorded = resolve)));

  try {
    /*
       The note's own files first, before anything is suggested. This is the one place
       the model reads a file (MAK-179): a picture, or a scan whose text layer had
       nothing, is not read when it arrives but here, when a person presses, so the
       press is the person asking for exactly this read, and it happens awaited. A few
       seconds for a card is what the button costs anyway, and the text it records is
       what the suggestion is then built from. Before that rule a file was read once, at
       upload, and a press on one whose read had failed that day only ever answered "a
       file is still being read".

       Scoped to this note and capped, never the account's backlog: that is a thousand
       paid requests on a real archive, and nothing runs it. A file this instance has no
       reader for stays as it was and is reported in `read.pending`, as before. A read
       that fails is logged and left pending rather than failing the press: the
       suggestion still comes from whatever text there is.
    */
    const readers: Readers = { ...deps.readers, usage };
    if (readers.converter || readers.llm) {
      const pending = [
        ...forText.map((f) => ({ ...f, pending: 'text' as const })),
        ...forVision.map((f) => ({ ...f, pending: 'vision' as const })),
      ];
      if (pending.length > 0) await readPendingFiles(deps.blobs, readers, deps.attachments, pending);
    }

    /*
       Everything the model is shown beside the note, in one call: the files' text (read
       just above, where it was pending), the notebooks and fields, and the most-used tags
       with their examples. More tags than auto-fill's cap: it drops the note's own tags
       first, and compares them without case, so a note tagged "Tax" also drops "tax".
    */
    const { files, notebooks, fields, examples } = await deps.notes.autofillContext(
      id,
      EXAMPLES_PER_OPTION,
      MAX_TAGS_ASKED + 2 * note.tags.length,
    );

    const suggestion = await autofill(
      deps.jev,
      {
        note: { title: note.title, body: note.body, tags: note.tags, notebookId: note.notebookId ?? null },
        attachments: files.map((f) => ({
          filename: f.filename,
          text: attachmentTextFor(f, Boolean(deps.readers.llm)),
          // Only the model's reading opens with a name for the file; an assistant's words
          // are plain text to Auto-fill, wherever they came from.
          readBy: f.readBy === 'vision' ? 'vision' : null,
        })),
        notebooks: notebooks.map((nb) => ({
          id: nb.id,
          name: nb.name,
          purpose: nb.purpose,
          fields: fields.filter((f) => f.notebookId === nb.id),
          examples: examples.notebooks.get(nb.id) ?? [],
        })),
        tags: examples.tags.map((t) => ({ name: t.name, examples: t.examples })),
      },
      // The language model writes the title and the text fields' values where the
      // instance has one; see `autofill`. Counted on its way through.
      deps.llm ? usage.metering(deps.llm) : undefined,
      // Only an operator is told when that model rejects its key: a fault they can fix.
      deps.operator,
    );
    return { kind: 'filed', suggestion };
  } finally {
    /*
       In `finally`, because a press that failed after the model answered was still paid
       for; after every metered call has settled, because a title still being written when
       Jev failed is paid for too, and `autofill` does not wait for it on that path. Handed
       to `waitUntil` (registered above) rather than awaited: a person waiting on an error
       should not also wait out the title's timeout. `waitUntil` runs about thirty seconds
       past the response, and a title's two attempts can take longer, so on that one path
       a slow title's cost can still be lost at the edge. A failure to record is logged
       rather than thrown: the count is what is lost, and the log line is what the
       operator then has.
    */
    const recording = usage
      .settled()
      .then(() => (usage.entries.length > 0 ? deps.notes.recordLlmUsage(usage.entries) : undefined))
      .catch((err: unknown) => {
        console.error('autofill usage:', (err as Error).message);
      });
    if (deps.defer) recorded(recording);
    else await recording;
  }
}
