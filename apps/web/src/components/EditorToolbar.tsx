import { useEffect, useRef, useState } from 'react';
import type { EditorView } from '@codemirror/view';
import type { StateCommand } from '@codemirror/state';
import * as cmd from '../editor/markdown-commands.js';
import { buildSizePicker, PICKER_CSS } from '../editor/table-size-picker.js';

interface EditorToolbarProps {
  /** Null until the editor mounts. */
  view: EditorView | null;
  /**
   * The preview toggle, shown at the right edge of the row.
   *
   * It lives here rather than in the workspace head because it acts on the panes directly
   * below it, and because a row that already spans the editor's width has the one piece of
   * layout it needs: somewhere to push a control to the far end.
   */
  preview: {
    /** Whether the preview is currently on screen at this width. */
    shown: boolean;
    /**
     * Which job the button has here. 'split' adds or removes a second pane; 'pane' swaps
     * which single pane is showing. Only the wording differs — the caller decides both.
     */
    label: 'split' | 'pane';
    onToggle: () => void;
  };
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


/**
 * The picker's styles, injected once.
 *
 * They live with the module that owns those class names rather than in the global
 * stylesheet, so the control and its appearance cannot drift apart — and the CodeMirror
 * copy of the picker gets them from the same string.
 */
function usePickerStyles() {
  useEffect(() => {
    const id = 'unbent-table-picker-css';
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = PICKER_CSS;
    document.head.appendChild(style);
  }, []);
}

/**
 * The table button, which opens the same size picker the table toolbar does.
 *
 * Inserting a fixed 2×3 made the same icon mean two different things depending on where it
 * was clicked — a picker over a table, a silent insert in the formatting bar. Choosing the
 * size up front is also simply what people expect of a table button.
 */
function TableButton({ view }: { view: EditorView | null }) {
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  usePickerStyles();

  useEffect(() => {
    if (!open || !view || !host.current) return;

    const picker = buildSizePicker({
      // Always a fresh table: this button is how one is made, not how one is resized.
      current: null,
      onPick: (rows, columns) => {
        cmd.insertTableOfSize(rows, columns)({
          state: view.state,
          dispatch: (tr) => view.dispatch(tr),
        });
        setOpen(false);
        view.focus();
      },
    });
    host.current.appendChild(picker);

    const onOutside = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && anchor.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onKey, true);

    return () => {
      picker.remove();
      document.removeEventListener('mousedown', onOutside, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, view]);

  return (
    <span className="tb-table" ref={anchor}>
      <button
        type="button"
        className="tb-btn"
        title="Table (⌘⇧T)"
        aria-label="Table"
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={!view}
        // onMouseDown for the same reason the formatting buttons use it: a click would
        // blur the editor first and drop the selection the command acts on.
        onMouseDown={(e) => {
          e.preventDefault();
          setOpen((v) => !v);
        }}
      >
        ▦
      </button>
      <div ref={host} />
    </span>
  );
}

export function EditorToolbar({ view, preview }: EditorToolbarProps) {
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

      <TableButton view={view} />

      {/*
          Pushed to the far end, away from the formatting controls: this acts on the whole
          pane rather than on the selection, and sitting in the same run as B/I/S implied
          it was another formatting command.

          `aria-pressed` rather than a changing label — the icon carries the state
          visually, and a toggle button is what this is. The title differs by width
          because the meaning does: with room for both panes it adds or removes the
          second one, and on a phone it swaps which single pane is showing.
      */}
      <button
        type="button"
        className="tb-btn tb-preview"
        title={previewLabel(preview)}
        aria-label={previewLabel(preview)}
        aria-pressed={preview.shown}
        onMouseDown={(e) => {
          e.preventDefault();
          preview.onToggle();
        }}
      >
        <PreviewIcon shown={preview.shown} />
      </button>
    </div>
  );
}

/** Says what the next press does, which differs by width — see the `label` prop. */
function previewLabel({ shown, label }: { shown: boolean; label: 'split' | 'pane' }): string {
  if (label === 'pane') return shown ? 'Back to editor' : 'Preview';
  return shown ? 'Hide preview' : 'Show preview';
}

/**
 * An eye, struck through when the preview is hidden.
 *
 * Inline rather than from an icon set: this is the only true icon in the app, and the
 * rest of the toolbar is letterforms. `currentColor` and no explicit size so it inherits
 * the button's colour and the surrounding font-size like the text buttons do.
 */
function PreviewIcon({ shown }: { shown: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1.05em"
      height="1.05em"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
      {!shown && <path d="M4 20 20 4" />}
    </svg>
  );
}
