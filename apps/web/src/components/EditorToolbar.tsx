import type { EditorView } from '@codemirror/view';
import type { StateCommand } from '@codemirror/state';
import * as cmd from '../editor/markdown-commands.js';

interface EditorToolbarProps {
  /** Null until the editor mounts. */
  view: EditorView | null;
}

interface Action {
  label: string;
  title: string;
  run: StateCommand;
  className?: string;
}

const ACTIONS: Action[] = [
  { label: 'B', title: 'Bold (⌘B)', run: cmd.toggleBold, className: 'tb-bold' },
  { label: 'I', title: 'Italic (⌘I)', run: cmd.toggleItalic, className: 'tb-italic' },
  { label: 'S', title: 'Strikethrough (⌘⇧X)', run: cmd.toggleStrikethrough, className: 'tb-strike' },
  { label: '‹›', title: 'Code (⌘E)', run: cmd.toggleCode },
  { label: 'H1', title: 'Heading 1 (⌘⌥1)', run: cmd.toggleH1 },
  { label: 'H2', title: 'Heading 2 (⌘⌥2)', run: cmd.toggleH2 },
  { label: '“', title: 'Quote (⌘⇧9)', run: cmd.toggleQuote },
  { label: '•', title: 'Bullet list (⌘⇧8)', run: cmd.toggleBullet },
  { label: '☑', title: 'Task list', run: cmd.toggleTask },
  { label: '🔗', title: 'Link (⌘K)', run: cmd.insertLink },
];

export function EditorToolbar({ view }: EditorToolbarProps) {
  function apply(run: StateCommand) {
    if (!view) return;
    run({ state: view.state, dispatch: view.dispatch });
    // Formatting should never cost the user their place in the document.
    view.focus();
  }

  return (
    <div className="editor-toolbar" role="toolbar" aria-label="Formatting">
      {ACTIONS.map((action) => (
        <button
          key={action.title}
          type="button"
          className={`tb-btn ${action.className ?? ''}`}
          title={action.title}
          aria-label={action.title}
          disabled={!view}
          // onMouseDown, not onClick: a click would blur the editor first and drop the
          // selection the command is meant to act on.
          onMouseDown={(e) => {
            e.preventDefault();
            apply(action.run);
          }}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}
