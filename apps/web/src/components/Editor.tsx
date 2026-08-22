import { useEffect, useRef } from 'react';
import { EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';

interface EditorProps {
  /** Changes to this remount the editor; it is not a controlled value. */
  noteId: string;
  initialValue: string;
  onChange: (value: string) => void;
  /** Uploads a dropped or pasted file and resolves to its relative markdown path. */
  onUpload?: (file: File) => Promise<string>;
}

/**
 * CodeMirror editing raw markdown.
 *
 * Deliberately uncontrolled: feeding every keystroke back through React state would fight
 * CodeMirror's own transaction handling and drop the cursor. The view owns the document,
 * and `onChange` reports upward for autosave. Remounting on noteId is what switches notes.
 */
export function Editor({ noteId, initialValue, onChange, onUpload }: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onUploadRef = useRef(onUpload);
  onUploadRef.current = onUpload;

  useEffect(() => {
    if (!host.current) return;

    const view = new EditorView({
      state: EditorState.create({
        doc: initialValue,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdown({ codeLanguages: languages }),
          EditorView.lineWrapping,
          cmPlaceholder('Start writing…'),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
          EditorView.domEventHandlers({
            drop(event, view) {
              const files = [...(event.dataTransfer?.files ?? [])];
              if (files.length === 0) return false;
              event.preventDefault();
              // Insert where the file was dropped, not where the cursor happened to be.
              const at = view.posAtCoords({ x: event.clientX, y: event.clientY });
              void insertUploads(view, files, at ?? view.state.selection.main.head);
              return true;
            },
            dragover(event) {
              // Without this the browser navigates away to the dropped file.
              if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
              return false;
            },
            paste(event, view) {
              const files = [...(event.clipboardData?.files ?? [])];
              if (files.length === 0) return false;
              event.preventDefault();
              void insertUploads(view, files, view.state.selection.main.head);
              return true;
            },
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

    view.focus();
    return () => view.destroy();
    // initialValue is intentionally not a dependency: the view owns the document after
    // mount, and re-running on every keystroke would rebuild the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId]);

  return <div ref={host} className="editor-host" />;

  /**
   * Uploads files and replaces a placeholder with the real link when each finishes.
   *
   * The placeholder matters: uploads are slow enough that a user keeps typing, and
   * inserting at a remembered offset afterwards would land in the wrong place. Replacing a
   * unique marker is position-independent.
   */
  async function insertUploads(view: EditorView, files: File[], at: number) {
    const upload = onUploadRef.current;
    if (!upload) return;

    for (const file of files) {
      const token = `![uploading ${file.name}…](#upload-${crypto.randomUUID().slice(0, 8)})`;
      view.dispatch({ changes: { from: at, insert: `${token}\n` } });

      try {
        const path = await upload(file);
        const isImage = file.type.startsWith('image/');
        const link = isImage ? `![${file.name}](${path})` : `[${file.name}](${path})`;
        replaceToken(view, token, link);
      } catch (err) {
        replaceToken(view, token, `<!-- upload failed: ${(err as Error).message} -->`);
      }
    }
  }

  function replaceToken(view: EditorView, token: string, replacement: string) {
    const doc = view.state.doc.toString();
    const index = doc.indexOf(token);
    if (index === -1) return; // the user deleted the placeholder mid-upload
    view.dispatch({
      changes: { from: index, to: index + token.length, insert: replacement },
    });
  }
}
