import { useEffect, useRef } from 'react';
import { EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view';
import { Compartment, EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { languages } from '@codemirror/language-data';
import { caretRoom, pdfNamesChanged, richMarkdown } from '../editor/rich-markdown.js';
import { markdownKeymap } from '../editor/markdown-commands.js';
import { tableTools } from '../editor/table-toolbar.js';
import { fileDropCursor } from '../editor/drop-cursor.js';
import { proseSpellcheck } from '../editor/spellcheck.js';
import { attachments } from '../editor/attach.js';
import { attachmentClipboard } from '../editor/clipboard.js';
import { attachmentSrc, editorMarkdown } from '../editor/links.js';
import { copyAttachmentToClipboard } from '../attachment-clipboard.js';

interface EditorProps {
  /** Changes to this remount the editor; it is not a controlled value. */
  noteId: string;
  initialValue: string;
  onChange: (value: string) => void;
  /**
   * Uploads a dropped, pasted or chosen file and resolves to its relative markdown path.
   *
   * Absent, files are refused rather than inserted: a read-only note has no uploader, and
   * without the handler CodeMirror's own drop would paste a file's bytes in as text.
   */
  onUpload?: (file: File) => Promise<string>;
  /** How many uploads are in flight, whenever that changes. The Android app shows it. */
  onUploadsPending?: (count: number) => void;
  /**
   * Copies files from another note into this one, for a paste that links them.
   *
   * Resolves to the name each file has here, by the name asked for. Absent (a read-only
   * note): pasted links to other notes' files stay absolute; see editor/clipboard.ts.
   */
  onCopyAttachments?: (
    from: string,
    filenames: string[],
    move: boolean,
  ) => Promise<Map<string, string>>;
  /**
   * Fetches a web image into this note as a stored file, resolving to its filename.
   * Absent (a read-only note): remote images offer no save control.
   */
  onSaveRemoteImage?: (url: string) => Promise<string>;
  /**
   * Permanently deletes a stored file, for the bin on a rendered attachment. The editor
   * removes the markdown itself afterwards. Absent, the bin only removes the markdown.
   */
  onDeleteAttachment?: (filename: string) => Promise<void>;
  /**
   * How to open a path on this site in place, for a link written from the root
   * (`[Import](/settings/import)`), as the router would; undefined for a path the app has
   * no page for, which stays text to edit, as does every such link when this is absent. A
   * prop because the editor knows nothing of the router: the workspace hands over
   * `sitePathOpener`.
   */
  pathOpener?: (path: string) => (() => void) | undefined;
  /** Style markdown inline instead of showing plain source. */
  rich?: boolean;
  /**
   * Names of this note's files that are stored as PDFs, for the rich renderer.
   *
   * Only needed for the ones whose name does not say so: an imported `Menu Card`.
   * May arrive after mount, and does not remount the view when it does.
   */
  pdfFilenames?: ReadonlySet<string>;
  /**
   * Take focus when the view mounts.
   *
   * On by default, which is what opening a note should do: you clicked it to write in it.
   * The sidebar's arrow keys turn it off: they mount a new editor for every note they
   * pass, and an editor that grabbed focus each time would take the second arrow press
   * and move a cursor through text instead of moving down the list. A note that has just
   * been created turns it off too, so that its title can have the caret instead.
   */
  autoFocus?: boolean;
  /**
   * Escape pressed with the cursor in the document.
   *
   * The sidebar uses it to take focus back, which is the way out of the editor that Enter
   * is the way into. A prop rather than a keybinding of its own here: what Escape should
   * leave *to* is the caller's business, and the editor has no idea a list exists.
   */
  onEscape?: () => void;
  /** Receives the view so a toolbar can act on it. */
  onViewReady?: (view: EditorView | null) => void;
  /**
   * Show the document without accepting any change to it: offline, or a note in the
   * trash. Flips in place rather than rebuilding the view, so the undo history and the
   * caret survive going offline and coming back.
   */
  readOnly?: boolean;
}

/**
 * Whether the document takes changes, as its own slot in the configuration so it can be
 * swapped without touching the rest.
 *
 * Both halves: `editable` takes the keyboard and the caret away from the content (and
 * marks it `contenteditable="false"`, which the stylesheet hides the widgets' editing
 * tools on), and `readOnly` is what CodeMirror's own drop and paste handling, and this
 * codebase's handlers that dispatch directly, check before changing anything.
 */
function readOnlyExtension(on: boolean) {
  return [EditorView.editable.of(!on), EditorState.readOnly.of(on)];
}

/**
 * CodeMirror editing raw markdown.
 *
 * Deliberately uncontrolled: feeding every keystroke back through React state would fight
 * CodeMirror's own transaction handling and drop the cursor. The view owns the document,
 * and `onChange` reports upward for autosave. Remounting on noteId is what switches notes.
 */
export function Editor({
  noteId,
  initialValue,
  onChange,
  onUpload,
  onUploadsPending,
  onCopyAttachments,
  onSaveRemoteImage,
  onDeleteAttachment,
  pathOpener,
  rich = false,
  pdfFilenames,
  autoFocus = true,
  onEscape,
  onViewReady,
  readOnly = false,
}: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  // One per editor, held across rebuilds; the view reads the current value when it is made.
  const readOnlySlot = useRef(new Compartment());
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  // Read at mount, never a dependency: this flips as the user moves between the mouse and
  // the arrow keys, and rebuilding the view on that would discard the document's history.
  const autoFocusRef = useRef(autoFocus);
  autoFocusRef.current = autoFocus;
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onUploadRef = useRef(onUpload);
  onUploadRef.current = onUpload;
  const onUploadsPendingRef = useRef(onUploadsPending);
  onUploadsPendingRef.current = onUploadsPending;
  const onCopyAttachmentsRef = useRef(onCopyAttachments);
  onCopyAttachmentsRef.current = onCopyAttachments;
  const onSaveRemoteImageRef = useRef(onSaveRemoteImage);
  onSaveRemoteImageRef.current = onSaveRemoteImage;
  const onDeleteAttachmentRef = useRef(onDeleteAttachment);
  onDeleteAttachmentRef.current = onDeleteAttachment;
  const pathOpenerRef = useRef(pathOpener);
  pathOpenerRef.current = pathOpener;
  const onViewReadyRef = useRef(onViewReady);
  onViewReadyRef.current = onViewReady;
  // Read on every decoration rebuild rather than captured, so a list that arrives after
  // the view was built is seen without discarding the document's history.
  const pdfFilenamesRef = useRef(pdfFilenames);
  pdfFilenamesRef.current = pdfFilenames;
  const viewRef = useRef<EditorView | null>(null);
  /**
   * The view that is live now, for an extension's write that lands after a round trip.
   *
   * The view is rebuilt on a rich/source switch (the effect below) and on every
   * `editorRevision` the workspace bumps (a conflict, a restore, a body rewrite), and
   * each extension is built with the view it is in. A write that waits on the server (a
   * web image saved, an upload finished, a pasted file copied across) was dispatched to
   * that captured view, and CodeMirror takes a dispatch to a destroyed view without a
   * word: it stores the state and returns, no update listener fires, and the draft never
   * hears of it. So the file was on the server and the note did not say so, with the
   * head saying "Saved". The extensions cannot see a later view on their own, which is
   * why each takes this getter; `viewRef` is set on mount and cleared on teardown, so it
   * answers the view open at the moment the write lands, or null between two. The
   * alternative, not rebuilding the view on a switch, is a refactor of the editor for a
   * bug in four round trips.
   */
  const liveView = () => viewRef.current;
  /**
   * The live document, held across a rebuild that is only a change of clothes.
   *
   * The view is torn down when `rich` flips: the two modes are different extensions, not
   * a decoration that can be swapped in place. `initialValue` is the last *saved* body
   * the parent knows, so seeding the new view from it used to throw away whatever had
   * been typed since: switching Rich → Source before the debounce landed put the saved
   * text back on screen, and the next keystroke then saved *that*, losing the edit.
   * Carrying the live document across is what makes the toggle a change of mode rather
   * than a revert.
   *
   * Not used when `noteId` changes: that is a different note, and the saved seed is the
   * right one. Workspace also remounts on note id, so this ref is empty on that path in
   * practice; the id check is what makes the invariant hold even without that key.
   *
   * The caret rides along with the text. A mode toggle that dropped the selection back to
   * the document start would be exactly the unasked-for motion the rest of this file works
   * to avoid: you flip to Source to fix a pipe and the cursor is suddenly three paragraphs
   * up. The offsets stay valid because the same doc string is carried across; a note change
   * clears both together, so a stale caret is never applied to a different note.
   */
  const preservedDoc = useRef<string | null>(null);
  const preservedSelection = useRef<{ anchor: number; head: number } | null>(null);
  const lastNoteId = useRef(noteId);

  useEffect(() => {
    if (!host.current) return;

    const sameNote = lastNoteId.current === noteId;
    lastNoteId.current = noteId;
    const doc = sameNote && preservedDoc.current !== null ? preservedDoc.current : initialValue;
    const selection = sameNote ? (preservedSelection.current ?? undefined) : undefined;
    preservedDoc.current = null;
    preservedSelection.current = null;

    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection,
        extensions: [
          readOnlySlot.current.of(readOnlyExtension(readOnlyRef.current)),
          history(),
          // Markdown shortcuts come first so Mod-b and Mod-i win over any default binding.
          /*
             Before the default keymap, which is what gets the key first.

             Returning false when there is no handler leaves Escape to CodeMirror, so the
             behaviours that rely on it (closing an autocomplete, leaving the tab-capture
             escape hatch) keep working.
          */
          keymap.of([
            {
              key: 'Escape',
              run: () => {
                if (!onEscapeRef.current) return false;
                onEscapeRef.current();
                return true;
              },
            },
          ]),
          keymap.of([...markdownKeymap, ...defaultKeymap, ...historyKeymap]),
          editorMarkdown(languages),
          // Structural table editing, which is what markdown tables are worst at by hand.
          // Only in rich mode: in plain source the point is to see the pipes.
          ...(rich ? [tableTools()] : []),
          ...(rich
            ? [
                richMarkdown({
                  resolveAttachment: (filename) => attachmentSrc(noteId, filename),
                  isPdfAttachment: (filename) => pdfFilenamesRef.current?.has(filename) ?? false,
                  // The same clipboard payload the Attachments panel's Copy writes. The
                  // type only decides whether a PNG goes along; the size is not used.
                  copyAttachment: async (filename, kind) => {
                    await copyAttachmentToClipboard(
                      noteId,
                      { filename, contentType: kind === 'image' ? 'image/*' : 'application/pdf', size: 0 },
                      { origin: window.location.origin },
                    );
                  },
                  saveRemoteImage: onSaveRemoteImage
                    ? (url) => {
                        const save = onSaveRemoteImageRef.current;
                        if (!save) throw new Error('Saving web images is switched off for this note');
                        return save(url);
                      }
                    : undefined,
                  deleteAttachment: onDeleteAttachment
                    ? (filename) => {
                        const del = onDeleteAttachmentRef.current;
                        if (!del) throw new Error('Deleting files is switched off for this note');
                        return del(filename);
                      }
                    : undefined,
                  // Read through the ref, like the handlers above: the view outlives the
                  // props. Offered on a read-only note too: following a link changes nothing.
                  pathOpener: pathOpener ? (path) => pathOpenerRef.current?.(path) : undefined,
                  liveView,
                }),
              ]
            : []),
          EditorView.lineWrapping,
          // Spellcheck, autocorrect and sentence capitals, which CodeMirror turns off.
          proseSpellcheck(),
          // Draws the insertion point a dragged file will land on. The browser shows one
          // for dragged text but not for files, so this is the only aim the drop has.
          fileDropCursor(),
          cmPlaceholder('Start writing…'),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            // A line opened only to put the caret below a picture is not a change worth a
            // save; see `caretRoom`. Whatever is typed there next carries it along.
            if (update.transactions.every((tr) => !tr.docChanged || tr.annotation(caretRoom))) return;
            onChangeRef.current(update.state.doc.toString());
          }),
          /*
             Drop, paste and the toolbar's Attach button, through one routine. The view
             outlives the props (it is rebuilt only on noteId and rich), so the facet holds
             readers of the refs above rather than the props themselves. `upload` is left
             undefined, not wrapped, when there is no handler: the toolbar reads its
             absence as "nothing to attach with" and disables itself.
          */
          attachments({
            upload: onUpload
              ? (file) => {
                  const upload = onUploadRef.current;
                  if (!upload) throw new Error('Uploads are switched off for this note');
                  return upload(file);
                }
              : undefined,
            onPending: (count) => onUploadsPendingRef.current?.(count),
          }),
          /*
             Attachment links across the clipboard: copied ones name this note, pasted
             ones bring their files across. The same ref pattern as the uploader, and the
             same absence rule: no handler, no copies, and foreign links stay absolute.
          */
          attachmentClipboard({
            noteId,
            origin: window.location.origin,
            copyFrom: onCopyAttachments
              ? (from, filenames, move) => {
                  const copy = onCopyAttachmentsRef.current;
                  if (!copy) throw new Error('Copying files is switched off for this note');
                  return copy(from, filenames, move);
                }
              : undefined,
          }),
          /*
             The two modes are two different kinds of text, and the font is what says which.

             Source is markup: the asterisks and pipes are the content, character positions
             matter, and monospace is the honest rendering of that. Rich mode has hidden the
             markup and is showing a document, so it gets a serif at the larger size prose
             wants: mono there reads as a code editor no matter how the headings are styled.

             Tables keep their own monospace inside rich mode; see the rich theme, where the
             padding that aligns their columns depends on it.
          */
          EditorView.theme({
            '&': { height: '100%', fontSize: rich ? '17px' : '15px' },
            '.cm-scroller': {
              fontFamily: rich ? 'var(--font-prose)' : 'var(--font-mono)',
              lineHeight: '1.7',
              /*
                 The note's text starts where everything above it does.

                 CodeMirror indents every line by 6px of its own, which put the body 6px
                 right of the title, the filing row and the attachments panel: close enough
                 to read as a mistake rather than as an indent, and the workspace column
                 already supplies the inset those share.

                 Zeroing that line padding alone is not the fix, though it looks like it.
                 Both sides of the default exist so a caret at the very start or end of a
                 line is not drawn half outside the scroller and clipped by its
                 `overflow-x: auto`, and measured with the padding at zero the caret at
                 offset 0 landed exactly on the scroller's left edge with nothing to spare.

                 So the room moves rather than disappears: pulled 6px left and given the 6px
                 back as padding. The line boxes now begin at the column's own inset
                 (the text aligns), while the caret keeps the same margin it always had. The 2px
                 on the right is CodeMirror's own and is left alone; nothing else is doing
                 that job at the end of a line.
              */
              margin: '0 0 0 -6px',
              padding: '1rem 0 1rem 6px',
            },

            '&.cm-focused': { outline: 'none' },
            '.cm-content': { caretColor: 'var(--fg)' },
            // See the scroller above for why this is safe to zero.
            '.cm-line': { paddingLeft: '0' },
          }),
        ],
      }),
      parent: host.current,
    });

    viewRef.current = view;
    if (autoFocusRef.current) view.focus();
    onViewReadyRef.current?.(view);

    return () => {
      // Written on every teardown, the last unmount included, where it is a dead store,
      // since the ref goes with the component. Only a same-note rebuild that runs straight
      // after this cleanup ever reads it back; a note change clears it first.
      preservedDoc.current = view.state.doc.toString();
      preservedSelection.current = {
        anchor: view.state.selection.main.anchor,
        head: view.state.selection.main.head,
      };
      onViewReadyRef.current?.(null);
      viewRef.current = null;
      view.destroy();
    };
    // initialValue is intentionally not a dependency: the view owns the document after
    // mount, and re-running on every keystroke would rebuild the editor. A rebuild for
    // `rich` reuses `preservedDoc` rather than the saved seed; see that ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId, rich]);

  /**
   * Repaint when the attachment list answers.
   *
   * The rich renderer rebuilds its decorations on edits, scrolls and selection changes.
   * A finished fetch is none of those, so without this an imported PDF whose name lacks
   * the extension would stay a plain link until the next keystroke.
   */
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !rich) return;
    view.dispatch({ effects: pdfNamesChanged.of(null) });
  }, [pdfFilenames, rich]);

  /**
   * Going offline and coming back. Reconfigured in place: rebuilding the view would throw
   * away the history and the caret, which is exactly what someone reading through a
   * tunnel expects to still have when the connection returns.
   */
  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.readOnly === readOnly) return;
    view.dispatch({ effects: readOnlySlot.current.reconfigure(readOnlyExtension(readOnly)) });
  }, [readOnly]);

  return <div ref={host} className="editor-host" />;
}
