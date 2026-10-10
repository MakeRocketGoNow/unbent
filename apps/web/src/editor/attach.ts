import { Facet, type Extension, type Text } from '@codemirror/state';
import { EditorView, ViewPlugin, type PluginValue } from '@codemirror/view';
import { findAbsoluteAttachmentLinks, formatAttachmentMarkdown } from '@unbent/shared';

/**
 * Every way a file gets into the editor: a drop, a paste, and the toolbar's Attach button.
 *
 * The three used to be two closures inside `Editor.tsx`, which was fine while the only
 * callers were DOM events the editor itself received. The toolbar changed that: it has the
 * `EditorView` and nothing else, so the routine has to be reachable from the view alone.
 * A facet is the CodeMirror way to say "this is configuration of the view" — the uploader
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
 * Known gap, not fixed here: remounting the editor mid-upload (switching rich/source, or
 * deleting an attachment, which rewrites the body) leaves a placeholder the old view can
 * no longer replace. The upload is allowed to finish so the file at least reaches the
 * panel.
 */
export interface AttachConfig {
  /** Uploads one file; resolves to its relative markdown path. Absent: uploads unsupported. */
  upload?: (file: File, signal: AbortSignal) => Promise<string>;
  /** Uploads in flight for this view, whenever the number changes. */
  onPending?: (count: number) => void;
}

export const attachConfig = Facet.define<AttachConfig, AttachConfig>({
  combine: (values) => values[0] ?? {},
});

/**
 * The uploads a view has in flight, so they can be counted and abandoned.
 *
 * A view plugin rather than a module-level map because this state belongs to one view
 * and should go when the view goes. `destroy` reports zero but does not abort: a file
 * half-way to the server is worth having even if the view that sent it has gone.
 */
class PendingUploads implements PluginValue {
  readonly jobs = new Map<string, AbortController>();

  constructor(private readonly view: EditorView) {}

  add(token: string, controller: AbortController) {
    this.jobs.set(token, controller);
    this.notify();
  }

  remove(token: string) {
    if (this.jobs.delete(token)) this.notify();
  }

  destroy() {
    if (this.jobs.size === 0) return;
    this.jobs.clear();
    this.notify();
  }

  private notify() {
    this.view.state.facet(attachConfig).onPending?.(this.jobs.size);
  }
}

const pendingPlugin = ViewPlugin.fromClass(PendingUploads);

/** The facet, the drop and paste handlers, and the per-view bookkeeping. */
export function attachments(config: AttachConfig): Extension {
  return [
    attachConfig.of(config),
    pendingPlugin,
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
           here — copied key to key on the server, original bytes, no upload — so the
           clipboard handler (editor/clipboard.ts) takes that paste, and this one declines.
        */
        if (findAbsoluteAttachmentLinks(event.clipboardData?.getData('text/plain') ?? '').length > 0) {
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

export function pendingUploads(view: EditorView): number {
  return view.plugin(pendingPlugin)?.jobs.size ?? 0;
}

/**
 * Uploads files, each behind a placeholder inserted at `at`.
 *
 * Every placeholder goes in before the first upload starts, in one transaction. The loop
 * used to insert each file's placeholder at `at` only when its turn came, after the
 * previous upload had finished — so three dropped files came out in reverse order, and
 * landed in the wrong place if the user had typed above `at` in the meantime. One insert
 * is also one undo step, which is what dropping three files at once should be.
 *
 * The uploads themselves run one at a time. On a phone radio a PDF and a photo racing
 * each other finish later than the two in sequence, and the order in the note is already
 * settled by the placeholders.
 *
 * `ownParagraph` sets each file apart as a paragraph of its own, with a blank line either
 * side — for a drop beside the text rather than into it (`noteDropZone`), which was not
 * aimed into the middle of anything. A single line break is not enough: markdown reads a
 * line written straight under a paragraph, a quote or a list item as more of it, so a
 * picture dropped under a closing quote would be drawn inside the quote. Only what is
 * missing goes in — no blank line is doubled — and a file that ends the note is followed
 * by one line break, as a file dropped into an empty note always was. Without it, a file
 * goes exactly where `at` is, on the line it is dropped into.
 */
export async function insertUploads(
  view: EditorView,
  files: File[],
  at: number,
  { ownParagraph = false }: { ownParagraph?: boolean } = {},
): Promise<void> {
  // The one routine every way in shares — drop, paste, the toolbar's Attach — so the
  // read-only check here covers any caller that forgot its own.
  if (view.state.readOnly) return;
  const { upload } = view.state.facet(attachConfig);
  const pending = view.plugin(pendingPlugin);
  if (!upload || !pending || files.length === 0) return;

  const jobs = files.map((file) => ({
    file,
    token: `![uploading ${file.name}…](#upload-${uniqueId()})`,
    controller: new AbortController(),
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
  for (const job of jobs) pending.add(job.token, job.controller);

  for (const { file, token, controller } of jobs) {
    // Abandoned while an earlier file was still going: its placeholder is already gone.
    if (controller.signal.aborted) continue;
    try {
      const path = await upload(file, controller.signal);
      const link = formatAttachmentMarkdown(file.name, path, {
        image: file.type.startsWith('image/'),
      });
      replaceToken(view, token, link);
    } catch (err) {
      // An abort is not a failure the note should record; the placeholder was removed by
      // whoever aborted, and a comment in its place would be the very junk they avoided.
      if (!controller.signal.aborted) {
        replaceToken(view, token, `<!-- upload failed: ${(err as Error).message} -->`);
      }
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
