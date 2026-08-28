import { EditorState, StateField, type Extension } from '@codemirror/state';
import { EditorView, showTooltip, type Tooltip } from '@codemirror/view';
import {
  addColumnAfter,
  addRowAfter,
  alignColumn,
  buildTable,
  deleteTable,
  readTable,
} from './markdown-commands.js';

/**
 * A toolbar over the table the cursor is in.
 *
 * Markdown tables are unfriendly to restructure by hand — adding a column means editing
 * every row including the delimiter — so the operations that are tedious in text get
 * buttons. Everything it does is an ordinary edit through the commands module, so the
 * document stays the only source of truth and every action undoes in one step.
 *
 * Built on `showTooltip` rather than a hand-positioned overlay: CodeMirror already solves
 * anchoring to a document position, following it on scroll, and clipping to the viewport.
 */

/** Buttons that act on the table, in the order they appear. */
interface Action {
  label: string;
  title: string;
  icon: string;
  run: (view: EditorView) => void;
}

/**
 * Icons as inline SVG paths.
 *
 * Inline rather than an icon set for the same reason the preview toggle is: this is the
 * only other real iconography in the app, and `currentColor` keeps it themed for free.
 */
const ICONS = {
  /** The size picker: a plain grid. */
  grid: 'M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18',
  /** Add row: a grid with the bottom band picked out and a plus beside it. */
  addRow: 'M3 4h14M3 9h14M3 14h14M19 12v6M16 15h6',
  /** Add column: the same idea rotated, so the two are never confused at a glance. */
  addColumn: 'M4 3v14M9 3v14M14 3v14M12 19h6M15 16v6',
  alignLeft: 'M3 6h18M3 12h10M3 18h14',
  alignCenter: 'M3 6h18M7 12h10M5 18h14',
  alignRight: 'M3 6h18M11 12h10M7 18h14',
  trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3',
} as const;

function icon(path: string): string {
  return [
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"',
    ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">',
    `<path d="${path}"/>`,
    '</svg>',
  ].join('');
}

const ACTIONS: Action[] = [
  {
    label: 'row',
    title: 'Add row below',
    icon: ICONS.addRow,
    run: (view) => addRowAfter({ state: view.state, dispatch: (tr) => view.dispatch(tr) }),
  },
  {
    label: 'column',
    title: 'Add column right',
    icon: ICONS.addColumn,
    run: (view) => addColumnAfter({ state: view.state, dispatch: (tr) => view.dispatch(tr) }),
  },
  {
    label: 'left',
    title: 'Align left',
    icon: ICONS.alignLeft,
    run: (view) => alignColumn('left')({ state: view.state, dispatch: (tr) => view.dispatch(tr) }),
  },
  {
    label: 'center',
    title: 'Align centre',
    icon: ICONS.alignCenter,
    run: (view) => alignColumn('center')({ state: view.state, dispatch: (tr) => view.dispatch(tr) }),
  },
  {
    label: 'right',
    title: 'Align right',
    icon: ICONS.alignRight,
    run: (view) => alignColumn('right')({ state: view.state, dispatch: (tr) => view.dispatch(tr) }),
  },
  {
    label: 'delete',
    title: 'Delete table',
    icon: ICONS.trash,
    run: (view) => deleteTable({ state: view.state, dispatch: (tr) => view.dispatch(tr) }),
  },
];

/** Largest grid the size picker offers, matching what fits without scrolling. */
const PICKER_ROWS = 8;
const PICKER_COLUMNS = 6;

/**
 * The grid picker for inserting a table of a chosen size.
 *
 * Hovering highlights the size, clicking inserts it — the interaction every word processor
 * uses, and far quicker than counting pipes.
 */
function buildPicker(view: EditorView, close: () => void): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'cm-table-picker';

  const grid = document.createElement('div');
  grid.className = 'cm-table-picker-grid';
  const label = document.createElement('div');
  label.className = 'cm-table-picker-label';
  label.textContent = 'Insert table';

  const cells: HTMLElement[] = [];
  for (let r = 1; r <= PICKER_ROWS; r += 1) {
    for (let c = 1; c <= PICKER_COLUMNS; c += 1) {
      const cell = document.createElement('span');
      cell.className = 'cm-table-picker-cell';
      cell.dataset['row'] = String(r);
      cell.dataset['column'] = String(c);
      grid.appendChild(cell);
      cells.push(cell);
    }
  }

  function highlight(rows: number, columns: number) {
    for (const cell of cells) {
      const r = Number(cell.dataset['row']);
      const c = Number(cell.dataset['column']);
      cell.classList.toggle('on', r <= rows && c <= columns);
    }
    label.textContent = `${rows} × ${columns}`;
  }

  grid.addEventListener('mouseover', (event) => {
    const cell = (event.target as HTMLElement).closest<HTMLElement>('.cm-table-picker-cell');
    if (cell) highlight(Number(cell.dataset['row']), Number(cell.dataset['column']));
  });
  grid.addEventListener('mouseleave', () => highlight(0, 0));

  grid.addEventListener('mousedown', (event) => {
    const cell = (event.target as HTMLElement).closest<HTMLElement>('.cm-table-picker-cell');
    if (!cell) return;
    event.preventDefault();
    insertTable(view, Number(cell.dataset['row']), Number(cell.dataset['column']));
    close();
  });

  wrap.appendChild(grid);
  wrap.appendChild(label);
  return wrap;
}

/**
 * Inserts a table at the cursor, on its own blank line.
 *
 * A table has to start a line — one written mid-sentence is parsed as a paragraph — so
 * this opens a line first when the cursor is not already on an empty one.
 */
export function insertTable(view: EditorView, rows: number, columns: number): void {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const indent = /^\s*/.exec(line.text)?.[0] ?? '';
  const table = buildTable(rows, columns, indent);

  const onBlankLine = line.text.trim() === '';
  const prefix = onBlankLine ? '' : '\n';
  const at = onBlankLine ? line.from : line.to;

  const insert = `${prefix}${table}\n`;
  view.dispatch({
    changes: { from: at, to: onBlankLine ? line.to : at, insert },
    // Land in the first header cell, which is two characters past the leading pipe.
    selection: { anchor: at + prefix.length + indent.length + 2 },
    scrollIntoView: true,
  });
  view.focus();
}

/**
 * Builds the toolbar element, and the teardown that releases its document listeners.
 *
 * The tooltip is destroyed whenever the cursor leaves the table, which can happen with the
 * picker still open — without the teardown those listeners would outlive the DOM they
 * belong to and keep firing for the rest of the session.
 */
function buildToolbar(view: EditorView): { dom: HTMLElement; destroy: () => void } {
  const bar = document.createElement('div');
  bar.className = 'cm-table-toolbar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Table');

  let picker: HTMLElement | null = null;
  const closePicker = () => {
    picker?.remove();
    picker = null;
    document.removeEventListener('mousedown', onDocumentMouseDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
  };

  const sizeButton = document.createElement('button');
  sizeButton.type = 'button';
  sizeButton.className = 'cm-table-btn';
  sizeButton.title = 'Insert table';
  sizeButton.setAttribute('aria-label', 'Insert table');
  sizeButton.innerHTML = icon(ICONS.grid);
  // mousedown, not click: a click blurs the editor first and loses the selection the
  // commands act on.
  /**
   * Dismissal, while the picker is open.
   *
   * Registered on the document rather than the editor: a click anywhere — including
   * outside the editor entirely — should put the picker away, and without this it stayed
   * open over the text. Both listeners are removed as soon as it closes, so an open picker
   * is the only time anything is bound.
   */
  const onDocumentMouseDown = (event: MouseEvent) => {
    if (!picker) return;
    const target = event.target as Node | null;
    if (target && bar.contains(target)) return;
    closePicker();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') closePicker();
  };

  function openPicker() {
    picker = buildPicker(view, closePicker);
    bar.appendChild(picker);
    document.addEventListener('mousedown', onDocumentMouseDown, true);
    document.addEventListener('keydown', onKeyDown, true);
  }

  sizeButton.addEventListener('mousedown', (event) => {
    event.preventDefault();
    if (picker) {
      closePicker();
      return;
    }
    openPicker();
  });
  bar.appendChild(sizeButton);

  for (const action of ACTIONS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `cm-table-btn cm-table-btn-${action.label}`;
    button.title = action.title;
    button.setAttribute('aria-label', action.title);
    button.innerHTML = icon(action.icon);
    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
      closePicker();
      action.run(view);
      view.focus();
    });
    bar.appendChild(button);
  }

  return { dom: bar, destroy: closePicker };
}

/**
 * The tooltip shown for the table the cursor is in, or none when it is elsewhere.
 *
 * Anchored to the table's first character and drawn above it, so it sits over the table
 * the way Typora's does rather than covering the row being edited.
 */
function tableToolbar(state: EditorState): Tooltip | null {
  const range = state.selection.main;
  // A selection spanning the table is a text operation, not a structural one.
  if (!range.empty) return null;

  const table = readTable(state, range.head);
  if (!table) return null;

  return {
    /**
     * Anchored to the end of the header row rather than the start of the table.
     *
     * Drawn above the first character, the bar covered whatever preceded the table — a
     * heading, most often, since that is what usually introduces one. There is frequently
     * no free space above a table at all, so it hangs off the header's right edge
     * instead, where the padding leaves room and nothing is hidden.
     */
    pos: state.doc.line(table.firstLine).to,
    above: true,
    strictSide: false,
    arrow: false,
    create: (view) => {
      const { dom, destroy } = buildToolbar(view);
      return { dom, destroy, offset: { x: 4, y: 2 } };
    },
  };
}

const tableToolbarField = StateField.define<Tooltip | null>({
  create: tableToolbar,
  update(value, tr) {
    // Rebuilding only when something moved keeps the DOM — and an open picker — alive.
    if (!tr.docChanged && !tr.selection) return value;
    return tableToolbar(tr.state);
  },
  provide: (field) => showTooltip.from(field),
});

const tableToolbarTheme = EditorView.theme({
  '.cm-table-toolbar': {
    display: 'flex',
    gap: '0.1rem',
    padding: '0.2rem',
    background: 'var(--bg, #fff)',
    border: '1px solid color-mix(in srgb, currentColor 15%, transparent)',
    borderRadius: '0.35rem',
    boxShadow: '0 1px 4px color-mix(in srgb, currentColor 12%, transparent)',
    position: 'relative',
  },
  '.cm-table-btn': {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '1.6rem',
    height: '1.6rem',
    padding: '0',
    border: 'none',
    borderRadius: '0.25rem',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    opacity: '0.7',
  },
  '.cm-table-btn:hover': {
    opacity: '1',
    background: 'color-mix(in srgb, currentColor 10%, transparent)',
  },
  '.cm-table-btn-delete:hover': { color: '#c0392b' },

  '.cm-table-picker': {
    position: 'absolute',
    top: 'calc(100% + 0.3rem)',
    left: '0',
    padding: '0.4rem',
    background: 'var(--bg, #fff)',
    border: '1px solid color-mix(in srgb, currentColor 15%, transparent)',
    borderRadius: '0.35rem',
    boxShadow: '0 2px 8px color-mix(in srgb, currentColor 15%, transparent)',
    zIndex: '20',
  },
  '.cm-table-picker-grid': {
    display: 'grid',
    gridTemplateColumns: `repeat(${PICKER_COLUMNS}, 1rem)`,
    gap: '2px',
  },
  '.cm-table-picker-cell': {
    width: '1rem',
    height: '1rem',
    border: '1px solid color-mix(in srgb, currentColor 20%, transparent)',
    borderRadius: '2px',
  },
  '.cm-table-picker-cell.on': {
    background: 'var(--accent, #2f6f4f)',
    borderColor: 'var(--accent, #2f6f4f)',
  },
  '.cm-table-picker-label': {
    paddingTop: '0.35rem',
    textAlign: 'center',
    fontSize: '0.75rem',
    opacity: '0.6',
  },
});

export function tableTools(): Extension {
  return [tableToolbarField, tableToolbarTheme];
}
