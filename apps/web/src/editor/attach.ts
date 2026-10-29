import { Facet, type Extension, type Text } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { formatAttachmentMarkdown, mayHoldAbsoluteAttachmentLink } from '@unbent/shared';

/**
 * Every way a file gets into the editor: a drop, a paste, and the toolbar's Attach button.
 *
 * The three used to be two closures inside `Editor.tsx`, which was fine while the only
 * callers were DOM events the editor itself received. The toolbar changed that: it has the
 * `EditorView` and nothing else, so the routine has to be reachable from the view alone.
 * A facet is the CodeMirror way to say "this is configuration of the view": the uploader
 * goes in through `attachments()` once, and anything holding the view can find it with
 * `view.state.facet(attachConfig)`. The alternatives were a callback prop threaded from
 * `Workspace` to the toolbar (neither owns the routine, so the toolbar would have reached
 * the editor two ways for one job) and a `StateEffect` the toolbar dispatches (starting
 * fetches from a transaction listener is indirection, and the pending count would have
 * needed another effect).
 *
 * What an upload looks like in the document: a placeholder `![uploading NAME…](#upload-…)`
 * goes in at once, and is replaced by the real link when the upload finishes. Uploads are
 * slow enough that a person keeps typing, so the replacement finds the placeholder by
 * searching for it rather than remembering an offset. A placeholder the user deleted
 * mid-upload is simply not replaced; the file is still on the server, and the
 * Attachments panel lists it as not linked.
 *
 * The editor is rebuilt on a rich/source switch and on a rewrite of the body, and the
 * document, placeholder and all, is carried into the new view. The replacement goes
 * into the view that is open when the upload lands (`liveView`), not the one the files
 * were dropped into: a dispatch to a destroyed view is taken silently, and the
 * placeholder stayed in the note while the file sat in the panel. The count of uploads
 * in flight outlives the view the same way, in a `PendingUploads` the owner hands in.
 */
export interface AttachConfig {
  /** Uploads one file; resolves to its relative markdown path. Absent: uploads unsupported. */
  upload?: (file: File) => Promise<string>;
  /**
   * Where the uploads in flight are counted. The owner's, so the count survives the
   * view (see `PendingUploads`). Absent, `attachments()` keeps one per view.
   */
  pending?: PendingUploads;
  /**
   * The editor to write into once an upload answers: the one open then, which may not
   * be the one the files went into, or null for none, when the note the files went
   * into is no longer open. `liveViewNow` in `Editor.tsx` says why an extension needs
   * this at all. Absent, the view the files went into.
   */
  liveView?: () => EditorView | null;
}

export const attachConfig = Facet.define<AttachConfig, AttachConfig>({
  combine: (values) => values[0] ?? {},
});

/**
 * The uploads in flight, counted for whoever holds the page open while they run.
 *
 * Owned by the editor's owner and handed in through the config, not kept by a view
 * plugin. This was a plugin, because the state seemed to belong to one view and should
 * go when the view goes; but the view goes long before the uploads do. The editor is
 * rebuilt on a rich/source switch and remounted on a revision bump, and the plugin's
 * `destroy` reported zero and let the uploads finish, so the leave-page guard
 * (`holdPage` in `Workspace.tsx`) was released mid-upload: closing the tab in that
 * window lost the file without a word. The jobs are the note's, not the view's, and
 * the one thing that outlives every view is the owner that also answers `liveView`.
 *
 * The owner hears each change of the number and nothing else: a replacement is still
 * the view's business (`replaceToken`), and the count is one number for the guard.
 */
export class PendingUploads {
  private readonly jobs = new Set<string>();

  constructor(private readonly onChange?: (count: number) => void) {}

  get size(): number {
    return this.jobs.size;
  }

  add(token: string) {
    this.jobs.add(token);
    this.onChange?.(this.jobs.size);
  }

  remove(token: string) {
    if (this.jobs.delete(token)) this.onChange?.(this.jobs.size);
  }
}

/** The facet and the drop and paste handlers. */
export function attachments(config: AttachConfig): Extension {
  return [
    // A caller with no owner to count for (a test, a bare view) still gets a count,
    // with the view's lifetime, which is what the plugin this replaced had.
    attachConfig.of({ ...config, pending: config.pending ?? new PendingUploads() }),
    EditorView.domEventHandlers({
      drop(event, view) {
        const files = [...(event.dataTransfer?.files ?? [])];
        if (files.length === 0) return false;
        event.preventDefault();
        // Taken and dropped on a read-only note. These handlers run before CodeMirror's
        // own, which are the ones that respect `readOnly`; declining would hand the
        // browser a file to open in place of the app.
        if (view.state.readOnly) return true;
        // Insert where the file was dropped, not where the cursor happened to be.
        const at = view.posAtCoords({ x: event.clientX, y: event.clientY });
        void insertUploads(view, files, at ?? view.state.selection.main.head);
        return true;
      },
      paste(event, view) {
        const files = [...(event.clipboardData?.files ?? [])];
        if (files.length === 0) return false;
        /*
           A picture copied from the Attachments panel arrives twice: as a PNG, for other
           apps, and as a link naming the note it lives in. The link is the better source
           here (copied key to key on the server, original bytes, no upload), so the
           clipboard handler (editor/clipboard.ts) takes that paste, and this one declines.
        */
        if (mayHoldAbsoluteAttachmentLink(event.clipboardData?.getData('text/plain') ?? '')) {
          return false;
        }
        event.preventDefault();
        if (view.state.readOnly) return true;
        void insertUploads(view, files, view.state.selection.main.head);
        return true;
      },
    }),
  ];
}

/** How many uploads are in flight for the view's owner. */
export function pendingUploads(view: EditorView): number {
  return view.state.facet(attachConfig).pending?.size ?? 0;
}

/**
 * Uploads files, each behind a placeholder inserted at `at`.
 *
 * Every placeholder goes in before the first upload starts, in one transaction. The loop
 * used to insert each file's placeholder at `at` only when its turn came, after the
 * previous upload had finished, so three dropped files came out in reverse order, and
 * landed in the wrong place if the user had typed above `at` in the meantime. One insert
 * is also one undo step, which is what dropping three files at once should be.
 *
 * The uploads themselves run one at a time. On a phone radio a PDF and a photo racing
 * each other finish later than the two in sequence, and the order in the note is already
 * settled by the placeholders.
 *
 * `ownParagraph` sets each file apart as a paragraph of its own, with a blank line either
 * side, for a drop beside the text rather than into it (`noteDropZone`), which was not
 * aimed into the middle of anything. A single line break is not enough: markdown reads a
 * line written straight under a paragraph, a quote or a list item as more of it, so a
 * picture dropped under a closing quote would be drawn inside the quote. Only what is
 * missing goes in (no blank line is doubled), and a file that ends the note is followed
 * by one line break, as a file dropped into an empty note always was. Without it, a file
 * goes exactly where `at` is, on the line it is dropped into.
 */
export async function insertUploads(
  view: EditorView,
  files: File[],
  at: number,
  { ownParagraph = false }: { ownParagraph?: boolean } = {},
): Promise<void> {
  // The one routine every way in shares (drop, paste, the toolbar's Attach), so the
  // read-only check here covers any caller that forgot its own.
  if (view.state.readOnly) return;
  const { upload, liveView, pending } = view.state.facet(attachConfig);
  if (!upload || !pending || files.length === 0) return;

  const jobs = files.map((file) => ({
    file,
    token: `![uploading ${file.name}…](#upload-${uniqueId()})`,
  }));

  const tokens = jobs.map((job) => job.token);
  view.dispatch({
    changes: {
      from: at,
      insert: ownParagraph
        ? apart(view.state.doc, at, tokens)
        : tokens.map((token) => `${token}\n`).join(''),
    },
    // A file chosen from the toolbar may land off-screen, and so, rarely, may one dropped
    // beside a block taller than the screen (`landingFor`); scrolling to something
    // already visible is a no-op.
    effects: EditorView.scrollIntoView(at),
  });
  for (const job of jobs) pending.add(job.token);

  // The replacement goes to the live view, and a `liveView` that answers null (the
  // note is no longer open) means nowhere: the view the files went into is gone then,
  // and a dispatch to it would be taken silently. The count is the owner's and needs
  // no moving, since the same `pending` is in every view the owner builds.
  for (const { file, token } of jobs) {
    let replacement: string;
    try {
      const path = await upload(file);
      replacement = formatAttachmentMarkdown(file.name, path, {
        image: file.type.startsWith('image/'),
      });
    } catch (err) {
      replacement = `<!-- upload failed: ${(err as Error).message} -->`;
    }
    try {
      const live = liveView ? liveView() : view;
      if (live) replaceToken(live, token, replacement);
    } finally {
      pending.remove(token);
    }
  }
}

/** The tokens for `ownParagraph`, with the line breaks `at` lacks on either side. */
function apart(doc: Text, at: number, tokens: string[]): string {
  const line = doc.lineAt(at);
  const blank = (n: number) => doc.line(n).text.trim() === '';
  // Text on this line before `at` needs a blank line; a line above that is not blank
  // already ends in a break, so it needs one more; the top of the note or a blank line
  // above needs nothing.
  const lead = at > line.from ? '\n\n' : line.number === 1 || blank(line.number - 1) ? '' : '\n';
  // The same below, except that the end of the note takes the one break.
  const tail = at < line.to ? '\n\n' : line.number === doc.lines ? '\n' : blank(line.number + 1) ? '' : '\n';
  return lead + tokens.join('\n\n') + tail;
}

function replaceToken(view: EditorView, token: string, replacement: string) {
  const doc = view.state.doc.toString();
  const index = doc.indexOf(token);
  if (index === -1) return; // the user deleted the placeholder mid-upload
  view.dispatch({
    changes: { from: index, to: index + token.length, insert: replacement },
  });
}

/** Distinct enough to find one placeholder among others; not a security boundary. */
function uniqueId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID().slice(0, 8);
  return Math.random().toString(16).slice(2, 10);
}
