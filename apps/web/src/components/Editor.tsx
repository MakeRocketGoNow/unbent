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
}

/**
 * CodeMirror editing raw markdown.
 *
 * Deliberately uncontrolled: feeding every keystroke back through React state would fight
 * CodeMirror's own transaction handling and drop the cursor. The view owns the document,
 * and `onChange` reports upward for autosave. Remounting on noteId is what switches notes.
 */
export function Editor({ noteId, initialValue, onChange }: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

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
}
