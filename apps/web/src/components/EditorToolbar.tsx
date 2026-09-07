import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { EditorView } from '@codemirror/view';
import type { StateCommand } from '@codemirror/state';
import * as cmd from '../editor/markdown-commands.js';
import { attachConfig, insertUploads } from '../editor/attach.js';
import { buildSizePicker, PICKER_CSS } from '../editor/table-size-picker.js';
import { ToolbarIcon } from './icons.js';

/**
 * The three ways to look at a note, and the one modifier that applies to one of them.
 *
 * They are exclusive because they are the same content rendered three ways, not three
 * things that could sensibly be on screen at once. Modelling them as one value rather
 * than as two booleans is what removed the state this component used to have to explain:
 * a "rich" that was also "previewing" had no meaning, but two booleans could express it.
 */
export type NoteView = 'rich' | 'source' | 'preview';

interface EditorToolbarProps {
  /** Null until the editor mounts. */
  view: EditorView | null;
  /**
   * Pin the bar above the on-screen keyboard instead of leaving it above the document.
   *
   * Set only on a phone with the editor focused. The controls are worth their space while
   * typing and worth none of it while reading, which is the whole reason for moving them.
   */
  docked?: boolean;
  /** How far up from the bottom the keyboard pushes it; see `useKeyboardInset`. */
  keyboardInset?: number;
  /**
   * The view switcher, shown at the right edge of the row.
   *
   * It lives here rather than in the workspace head because every one of these acts on the
   * panes directly below it, and because a row that already spans the editor's width has
   * the one piece of layout it needs: somewhere to push a control to the far end. The head
   * is for the note as an object — what it is called, and what can be done to it.
   */
  noteView: {
    current: NoteView;
    onChange: (next: NoteView) => void;
    /**
     * Show the source pane and the rendered pane side by side.
     *
     * A modifier on `source` rather than a fourth view: it is two renderings of one
     * document, which is only a coherent thing to ask for when one of them is the source.
     * Undefined where it cannot apply — on a phone, which has room for one pane — and the
     * control is then not rendered at all rather than rendered inert.
     */
    split?: { on: boolean; onToggle: () => void };
  };
}

interface Action {
  /** A letterform for the type controls, an icon for the ones with no letter. */
  label: ReactNode;
  title: string;
  run: StateCommand;
  className?: string;
}

/*
 * The icons that stand in for the glyphs.
 *
 * `☑`, `🔗` and `▦` were literal characters, and they never matched the letterforms
 * beside them: U+1F517 is an emoji codepoint, so the OS paints it in full colour whatever
 * `color` says, and the other two came from a fallback font that renders heavier than the
 * UI face. Drawn as SVG they inherit `currentColor` and the button's size like a letter
 * does, so the row reads as one set.
 *
 * `ToolbarIcon` itself moved to `icons.tsx` when the note list header started drawing icons
 * too — it was never specific to this toolbar, and importing it from here would have said
 * it was. The reasoning about not taking an icon library moved with it.
 */

/** A ticked box, for the task-list command. */
const TaskIcon = (
  <ToolbarIcon>
    <rect x="3" y="3" width="18" height="18" rx="3" />
    <path d="m8 12 3 3 5-6" />
  </ToolbarIcon>
);

/** Two links of a chain, at the angle the emoji used. */
const LinkIcon = (
  <ToolbarIcon>
    <path d="M10.5 13.5a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 0 0-5.7-5.7l-1.4 1.4" />
    <path d="M13.5 10.5a4 4 0 0 0-5.7 0l-2.8 2.8a4 4 0 0 0 5.7 5.7l1.4-1.4" />
  </ToolbarIcon>
);

/** A grid, for the table command. */
const TableIcon = (
  <ToolbarIcon>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 9h18M3 15h18M9 3v18" />
  </ToolbarIcon>
);

/** A paperclip, for attaching a file. */
const AttachIcon = (
  <ToolbarIcon>
    <path d="M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />
  </ToolbarIcon>
);

const ACTIONS: Action[] = [
  { label: 'B', title: 'Bold (⌘B)', run: cmd.toggleBold, className: 'tb-bold' },
  { label: 'I', title: 'Italic (⌘I)', run: cmd.toggleItalic, className: 'tb-italic' },
  { label: 'S', title: 'Strikethrough (⌘⇧X)', run: cmd.toggleStrikethrough, className: 'tb-strike' },
  { label: '‹›', title: 'Code (⌘E)', run: cmd.toggleCode },
  { label: 'H1', title: 'Heading 1 (⌘⌥1)', run: cmd.toggleH1 },
  { label: 'H2', title: 'Heading 2 (⌘⌥2)', run: cmd.toggleH2 },
  { label: '“', title: 'Quote (⌘⇧9)', run: cmd.toggleQuote },
  { label: '•', title: 'Bullet list (⌘⇧8)', run: cmd.toggleBullet },
  { label: TaskIcon, title: 'Task list', run: cmd.toggleTask },
  { label: LinkIcon, title: 'Link (⌘K)', run: cmd.insertLink },
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
        {TableIcon}
      </button>
      <div ref={host} />
    </span>
  );
}

/**
 * The way a file gets in without a mouse to drag it or a clipboard to paste it from —
 * which is to say, the way on a phone. Files land at the cursor through the same routine
 * a drop uses, so the result is one undoable text edit either way.
 *
 * Placed beside Link, among the inserts (Link, Attach, Table): it brings something into
 * the note rather than shaping what is there, and that is the family it belongs to. On a
 * phone that puts it in the part of the bar that scrolls, so the fade at the switcher's
 * edge (`tb-more`) is what says the bar continues. Pinned at the left edge was tried
 * first — always visible, but it left a run three buttons wide and read as a different
 * kind of control from its family.
 *
 * Opened from `onClick` rather than the `onMouseDown` its neighbours use. A file input
 * only opens inside a user activation, click is the event every browser grants one for,
 * and it is also the event a keyboard produces. Mousedown still prevents default so the
 * button never takes focus from the editor; the picker is a modal and takes it anyway,
 * but the selection survives blur, and `selection.main.head` is where the file lands.
 *
 * Afterwards the editor gets focus back only when the bar is not docked. Docked means a
 * phone, where refocusing raises the keyboard over the note the user is looking at;
 * undocked means a desktop, where "formatting should never cost the user their place"
 * applies to attaching too.
 */
function AttachButton({
  view,
  disabled,
  docked,
}: {
  view: EditorView | null;
  disabled: boolean;
  docked: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  // No uploader means a note that cannot take files — read-only, in the trash — and a
  // button that opened a picker for nothing would be a lie.
  const canUpload = view !== null && view.state.facet(attachConfig).upload !== undefined;

  return (
    <span className="tb-attach">
      <button
        type="button"
        className="tb-btn"
        title="Attach file"
        aria-label="Attach file"
        disabled={disabled || !canUpload}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => input.current?.click()}
      >
        {AttachIcon}
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        tabIndex={-1}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          // Cleared so the same file can be chosen twice in a row; a file input only
          // fires change when its value differs from last time.
          e.target.value = '';
          if (!view || files.length === 0) return;
          void insertUploads(view, files, view.state.selection.main.head);
          if (!docked) view.focus();
        }}
      />
    </span>
  );
}

export function EditorToolbar({
  view,
  noteView,
  docked = false,
  keyboardInset = 0,
}: EditorToolbarProps) {
  function apply(run: StateCommand) {
    if (!view) return;
    run({ state: view.state, dispatch: view.dispatch });
    // Formatting should never cost the user their place in the document.
    view.focus();
  }

  /*
     Formatting acts on a selection in a text editor, so it has nothing to act on in the
     rendered view. Disabled rather than removed: a row that loses two thirds of its
     controls when you switch views reads as a different toolbar, and the buttons coming
     back in different places is worse than their being briefly greyed.
  */
  const editing = noteView.current !== 'preview';

  /*
     Whether the docked run has more to the right of what is on screen.

     A row that scrolls looks, at rest, exactly like a row that does not, and the phone's
     only way to attach a file is past the fold. The switcher's edge fades the run out
     while there is more, and stops the moment the end is reached, so the hint is never
     a lie about a button that isn't there. Measured rather than styled with a mask,
     because a mask fades the last button even once it has been scrolled to.
  */
  const scroller = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    const el = scroller.current;
    if (!docked || !el) {
      setMore(false);
      return;
    }
    const update = () => setMore(el.scrollWidth - el.clientWidth - el.scrollLeft > 1);
    update();
    el.addEventListener('scroll', update, { passive: true });
    // The run's own width changes with the viewport; its content changes with `editing`.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      observer?.disconnect();
    };
  }, [docked, editing]);

  return (
    <div
      className={['editor-toolbar', docked ? 'docked' : '', more ? 'tb-more' : ''].filter(Boolean).join(' ')}
      role="toolbar"
      aria-label="Formatting"
      style={docked ? { bottom: `${keyboardInset}px` } : undefined}
    >
      {/*
          The formatting run, and the only part of the bar that scrolls.

          Twelve 44px touch targets do not fit a phone's width and never did — the bar has
          always scrolled here. That is fine for formatting, which you dip into and can
          swipe for. It is not fine for the view switcher, which answers "where am I", so
          that sits outside this box and stays put. Splitting them is what lets each
          behave the way its job requires.
      */}
      <div className="tb-scroll" ref={scroller}>
        {ACTIONS.map((action) => (
          <button
            key={action.title}
            type="button"
            className={`tb-btn ${action.className ?? ''}`}
            title={action.title}
            aria-label={action.title}
            disabled={!view || !editing}
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

        <AttachButton view={view} disabled={!editing} docked={docked} />
        {editing && <TableButton view={view} />}
      </div>

      {/*
          Pushed to the far end, away from the formatting controls: these act on the whole
          pane rather than on the selection, and sitting in the same run as B/I/S implied
          they were more formatting commands.

          Outside the scroller on purpose — see the comment above it.
      */}
      <div className="tb-views">
        {noteView.split && noteView.current === 'source' && (
          /*
              Only in source, because that is the only view it means anything in, and only
              at a width with room for two panes. Rendering it where it cannot apply would
              make people wonder what it does there.
          */
          <button
            type="button"
            className="tb-btn tb-split"
            title={noteView.split.on ? 'Hide the preview beside the source' : 'Show a preview beside the source'}
            aria-label="Preview beside source"
            aria-pressed={noteView.split.on}
            onMouseDown={(e) => {
              e.preventDefault();
              noteView.split?.onToggle();
            }}
          >
            <SplitIcon />
          </button>
        )}

        {/*
            A radio group, not three toggles: exactly one is always on, which is what
            `radio` means and what a set of `aria-pressed` buttons would fail to say. The
            labels are words because there is no icon anyone reads as "plain source" —
            `</>` is already the inline-code button three positions to the left.
        */}
        <div className="tb-segmented" role="radiogroup" aria-label="View">
          {VIEWS.map(({ value, label, title }) => (
            <button
              key={value}
              type="button"
              className="tb-seg"
              role="radio"
              aria-checked={noteView.current === value}
              title={title}
              onMouseDown={(e) => {
                e.preventDefault();
                noteView.onChange(value);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

const VIEWS: { value: NoteView; label: string; title: string }[] = [
  { value: 'rich', label: 'Rich', title: 'Rich text' },
  { value: 'source', label: 'Source', title: 'Plain source' },
  { value: 'preview', label: 'Preview', title: 'Rendered preview' },
];

/**
 * Two panes side by side.
 *
 * Inline for the same reason as the toolbar's other icons: the rest of this row is
 * letterforms, and `currentColor` with no explicit size makes it inherit the button's
 * colour and the surrounding font-size the way a letter does.
 */
function SplitIcon() {
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
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M12 4v16" />
    </svg>
  );
}
