import { useEffect, useRef } from 'react';
import { EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';
import { languages } from '@codemirror/language-data';
import { pdfNamesChanged, richMarkdown } from '../editor/rich-markdown.js';
import { markdownKeymap } from '../editor/markdown-commands.js';
import { tableTools } from '../editor/table-toolbar.js';
import { fileDropCursor } from '../editor/drop-cursor.js';
import { attachments } from '../editor/attach.js';

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
  onUpload?: (file: File, signal: AbortSignal) => Promise<string>;
  /** How many uploads are in flight, whenever that changes. The Android app shows it. */
  onUploadsPending?: (count: number) => void;
  /** Style markdown inline instead of showing plain source. */
  rich?: boolean;
  /**
   * Names of this note's files that are stored as PDFs, for the rich renderer.
   *
   * Only needed for the ones whose name does not say so — an imported `Menu Card`.
   * May arrive after mount, and does not remount the view when it does.
   */
  pdfFilenames?: ReadonlySet<string>;
  /**
   * Take focus when the view mounts.
   *
   * On by default, which is what opening a note should do — you clicked it to write in it.
   * The sidebar's arrow keys turn it off: they mount a new editor for every note they
   * pass, and an editor that grabbed focus each time would take the second arrow press
   * and move a cursor through text instead of moving down the list.
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
  rich = false,
  pdfFilenames,
  autoFocus = true,
  onEscape,
  onViewReady,
}: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
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
  const onViewReadyRef = useRef(onViewReady);
  onViewReadyRef.current = onViewReady;
  // Read on every decoration rebuild rather than captured, so a list that arrives after
  // the view was built is seen without discarding the document's history.
  const pdfFilenamesRef = useRef(pdfFilenames);
  pdfFilenamesRef.current = pdfFilenames;
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    if (!host.current) return;

    const view = new EditorView({
      state: EditorState.create({
        doc: initialValue,
        extensions: [
          history(),
          // Markdown shortcuts come first so Mod-b and Mod-i win over any default binding.
          /*
             Before the default keymap, which is what gets the key first.

             Returning false when there is no handler leaves Escape to CodeMirror, so the
             behaviours that rely on it — closing an autocomplete, leaving the tab-capture
             escape hatch — keep working.
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
          // GFM parses task lists, tables, and strikethrough, which plain CommonMark
          // would leave as literal text — `[x]` otherwise reads as a link.
          markdown({ codeLanguages: languages, extensions: [GFM] }),
          // Structural table editing, which is what markdown tables are worst at by hand.
          // Only in rich mode: in plain source the point is to see the pipes.
          ...(rich ? [tableTools()] : []),
          ...(rich
            ? [
                richMarkdown({
                  resolveAttachment: (filename) =>
                    `/api/notes/${encodeURIComponent(noteId)}/files/${encodeURIComponent(filename)}`,
                  isPdfAttachment: (filename) => pdfFilenamesRef.current?.has(filename) ?? false,
                }),
              ]
            : []),
          EditorView.lineWrapping,
          // Draws the insertion point a dragged file will land on. The browser shows one
          // for dragged text but not for files, so this is the only aim the drop has.
          fileDropCursor(),
          cmPlaceholder('Start writing…'),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
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
              ? (file, signal) => {
                  const upload = onUploadRef.current;
                  if (!upload) throw new Error('Uploads are switched off for this note');
                  return upload(file, signal);
                }
              : undefined,
            onPending: (count) => onUploadsPendingRef.current?.(count),
          }),
          EditorView.theme({
            '&': { height: '100%', fontSize: '15px' },
            '.cm-scroller': {
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              lineHeight: '1.7',
              padding: '1rem 0',
            },
            '&.cm-focused': { outline: 'none' },
            '.cm-content': { caretColor: 'var(--fg)' },
          }),
        ],
      }),
      parent: host.current,
    });

    viewRef.current = view;
    if (autoFocusRef.current) view.focus();
    onViewReadyRef.current?.(view);

    return () => {
      onViewReadyRef.current?.(null);
      viewRef.current = null;
      view.destroy();
    };
    // initialValue is intentionally not a dependency: the view owns the document after
    // mount, and re-running on every keystroke would rebuild the editor.
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

  return <div ref={host} className="editor-host" />;
}
