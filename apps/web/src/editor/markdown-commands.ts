import type { ChangeSpec, EditorState, StateCommand } from '@codemirror/state';
import type { KeyBinding } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';

/**
 * Markdown editing commands.
 *
 * These operate on the text directly rather than through a document model, so a formatting
 * action is an ordinary edit the user can undo, retype, or ignore. That is what keeps the
 * stored markdown byte-identical to what was typed.
 */

/**
 * Wraps or unwraps the selection in a delimiter, toggling like a word processor would.
 *
 * With no selection it inserts the pair and places the cursor between them, so pressing
 * the shortcut and typing works the way people expect.
 */
function toggleWrap(before: string, after = before): StateCommand {
  return ({ state, dispatch }) => {
    const changes: ChangeSpec[] = [];
    let anchor: number | undefined;

    for (const range of state.selection.ranges) {
      const { from, to } = range;
      const outerFrom = from - before.length;
      const outerTo = to + after.length;

      const alreadyWrapped =
        outerFrom >= 0 &&
        outerTo <= state.doc.length &&
        state.doc.sliceString(outerFrom, from) === before &&
        state.doc.sliceString(to, outerTo) === after;

      if (alreadyWrapped) {
        changes.push({ from: outerFrom, to: from }, { from: to, to: outerTo });
        anchor ??= from - before.length;
        continue;
      }

      changes.push({ from, insert: before }, { from: to, insert: after });
      anchor ??= range.empty ? from + before.length : to + before.length + after.length;
    }

    if (changes.length === 0) return false;

    dispatch(
      state.update({
        changes,
        selection: anchor === undefined ? undefined : { anchor },
        scrollIntoView: true,
      }),
    );
    return true;
  };
}

/**
 * Adds or removes a line prefix such as `## ` or `> `.
 *
 * Applied per line across the selection, and toggled off when every line already has it:
 * pressing "quote" twice should return the text to where it started.
 */
function toggleLinePrefix(prefix: string): StateCommand {
  return ({ state, dispatch }) => {
    const lines = new Set<number>();
    for (const range of state.selection.ranges) {
      for (let pos = range.from; pos <= range.to; ) {
        const line = state.doc.lineAt(pos);
        lines.add(line.number);
        pos = line.to + 1;
      }
    }

    const all = [...lines].map((n) => state.doc.line(n));

    /**
     * `existing` matches any heading level so one can replace another; `exact` matches
     * only this prefix. Toggling off requires the exact prefix: otherwise asking for H1
     * on an H3 line would strip the heading instead of changing its level.
     */
    const existing = prefix.startsWith('#') ? /^#{1,6} / : new RegExp(`^${escapeRegExp(prefix)}`);
    const exact = new RegExp(`^${escapeRegExp(prefix)}`);
    const remove = all.every((line) => exact.test(line.text));

    const changes: ChangeSpec[] = all.map((line) => {
      const match = existing.exec(line.text);
      if (remove && match) {
        return { from: line.from, to: line.from + match[0].length };
      }
      if (match) {
        // Replace one heading level with another instead of nesting them.
        return { from: line.from, to: line.from + match[0].length, insert: prefix };
      }
      return { from: line.from, insert: prefix };
    });

    dispatch(state.update({ changes, scrollIntoView: true }));
    return true;
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A list item's leading whitespace and marker, e.g. `  - ` or `1. `. */
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s+)?/;

interface ListLine {
  number: number;
  from: number;
  text: string;
  indent: string;
  marker: string;
}

/** Parses a line as a list item, or returns null when it is not one. */
function asListItem(text: string, number: number, from: number): ListLine | null {
  const m = LIST_ITEM.exec(text);
  if (!m) return null;
  return { number, from, text, indent: m[1] ?? '', marker: m[2] ?? '' };
}

/** The ordinal and delimiter of `1.` / `2)`, or null for a bullet. */
function asOrdered(marker: string): { ordinal: number; delimiter: string } | null {
  const m = /^(\d+)([.)])$/.exec(marker);
  if (!m) return null;
  return { ordinal: Number(m[1]), delimiter: m[2] ?? '.' };
}

/**
 * The ordinal an item should carry at `indent`, given the lines above it.
 *
 * A nested list is a new list and starts over at 1: carrying the parent's count down a
 * level is what produces `1. 2. 3.` where the third item is a child, which then renders
 * as `c.` instead of the `a.` that indenting a list is supposed to give you. Scanning
 * upward stops at the first shallower item, which is the parent: anything above that
 * belongs to a different list.
 */
function ordinalAt(
  state: Parameters<StateCommand>[0]['state'],
  lineNumber: number,
  indent: number,
): number {
  for (let n = lineNumber - 1; n >= 1; n -= 1) {
    const prev = state.doc.line(n);
    if (prev.text.trim() === '') continue;
    const item = asListItem(prev.text, n, prev.from);
    if (!item) break;
    if (item.indent.length < indent) break;
    if (item.indent.length === indent) {
      const ordered = asOrdered(item.marker);
      return ordered ? ordered.ordinal + 1 : 1;
    }
  }
  return 1;
}

/** Every line touched by the selection. */
function selectedLines(state: Parameters<StateCommand>[0]['state']) {
  const numbers = new Set<number>();
  for (const range of state.selection.ranges) {
    for (let pos = range.from; pos <= range.to; ) {
      const line = state.doc.lineAt(pos);
      numbers.add(line.number);
      pos = line.to + 1;
    }
  }
  return [...numbers].sort((a, b) => a - b).map((n) => state.doc.line(n));
}

/**
 * Indents list items under the item above them.
 *
 * The indent width has to match the parent's marker, not a fixed size: a bullet nests
 * under `- ` with two spaces, but an item under `1. ` needs three. Getting this wrong does
 * not error: the line simply stays a sibling, which looks like the key did nothing.
 */
export const indentList: StateCommand = ({ state, dispatch }) => {
  const lines = selectedLines(state);
  const items = lines
    .map((l) => asListItem(l.text, l.number, l.from))
    .filter((x): x is ListLine => x !== null);

  if (items.length === 0) return false;

  const changes: ChangeSpec[] = [];
  for (const item of items) {
    // Find the nearest preceding line at the same or shallower depth: that is the parent.
    let parent: ListLine | null = null;
    for (let n = item.number - 1; n >= 1; n -= 1) {
      const prev = state.doc.line(n);
      if (prev.text.trim() === '') continue;
      const prevItem = asListItem(prev.text, n, prev.from);
      if (!prevItem) break;
      if (prevItem.indent.length <= item.indent.length) {
        parent = prevItem;
        break;
      }
    }

    // The first item of a list has nothing to nest under; indenting it would orphan it.
    if (!parent) continue;

    const width = parent.marker.length + 1;
    changes.push({ from: item.from, insert: ' '.repeat(width) });

    /**
     * Restart the numbering at the level being moved into.
     *
     * Indenting only shifts the line, so an item that read `3.` stays `3.` as the first
     * child of its new parent, and since depth decides how the marker is displayed, that
     * shows up as `c.` where the user expected `a.`. Renumbering here keeps the source
     * markdown correct too: a nested list genuinely restarts at 1.
     */
    const ordered = asOrdered(item.marker);
    if (ordered) {
      const indent = item.indent.length + width;
      const ordinal = ordinalAt(state, item.number, indent);
      if (ordinal !== ordered.ordinal) {
        const markerFrom = item.from + item.indent.length;
        changes.push({
          from: markerFrom,
          to: markerFrom + item.marker.length,
          insert: `${ordinal}${ordered.delimiter}`,
        });
      }
    }
  }

  if (changes.length === 0) return false;
  dispatch(state.update({ changes, scrollIntoView: true, userEvent: 'input.indent' }));
  return true;
};

/** Outdents list items, removing one level of nesting. */
export const outdentList: StateCommand = ({ state, dispatch }) => {
  const lines = selectedLines(state);
  const items = lines
    .map((l) => asListItem(l.text, l.number, l.from))
    .filter((x): x is ListLine => x !== null && x.indent.length > 0);

  if (items.length === 0) return false;

  const changes: ChangeSpec[] = [];
  for (const item of items) {
    /**
     * Remove exactly one level rather than a fixed width.
     *
     * Levels are not uniformly sized: a bullet under `1. ` is indented three spaces while
     * one under `- ` is two, so the amount removed is measured from the nearest shallower
     * ancestor, keeping outdent the exact inverse of indent.
     */
    let target = 0;
    for (let n = item.number - 1; n >= 1; n -= 1) {
      const prev = state.doc.line(n);
      if (prev.text.trim() === '') continue;
      const prevItem = asListItem(prev.text, n, prev.from);
      if (!prevItem) break;
      if (prevItem.indent.length < item.indent.length) {
        target = prevItem.indent.length;
        break;
      }
    }

    const remove = item.indent.length - target;
    if (remove === 0) continue;
    changes.push({ from: item.from, to: item.from + remove });

    // Rejoin the numbering of the level it lands in, rather than keeping the child count.
    const ordered = asOrdered(item.marker);
    if (ordered) {
      const ordinal = ordinalAt(state, item.number, target);
      if (ordinal !== ordered.ordinal) {
        const markerFrom = item.from + item.indent.length;
        changes.push({
          from: markerFrom,
          to: markerFrom + item.marker.length,
          insert: `${ordinal}${ordered.delimiter}`,
        });
      }
    }
  }

  if (changes.length === 0) return false;
  dispatch(state.update({ changes, scrollIntoView: true, userEvent: 'delete.dedent' }));
  return true;
};

/** Inserts a link, using the selection as the text when there is one. */
export const insertLink: StateCommand = ({ state, dispatch }) => {
  const range = state.selection.main;
  const text = state.doc.sliceString(range.from, range.to);
  const insert = `[${text}](url)`;
  // Select the placeholder so typing replaces it.
  const urlFrom = range.from + text.length + 3;

  dispatch(
    state.update({
      changes: { from: range.from, to: range.to, insert },
      selection: { anchor: urlFrom, head: urlFrom + 3 },
      scrollIntoView: true,
    }),
  );
  return true;
};

export const toggleBold = toggleWrap('**');
export const toggleItalic = toggleWrap('_');
export const toggleCode = toggleWrap('`');
export const toggleStrikethrough = toggleWrap('~~');
export const toggleH1 = toggleLinePrefix('# ');
export const toggleH2 = toggleLinePrefix('## ');
export const toggleH3 = toggleLinePrefix('### ');
export const toggleQuote = toggleLinePrefix('> ');
export const toggleBullet = toggleLinePrefix('- ');
export const toggleTask = toggleLinePrefix('- [ ] ');

/**
 * Tab indents a list item, and otherwise does nothing.
 *
 * Deliberately narrow. Tab is how keyboard users move focus out of a control, so an editor
 * that swallows it universally becomes a trap. Returning false when the cursor is not in a
 * list lets the browser move focus as usual, while Escape-then-Tab remains available as
 * the conventional escape hatch either way.
 */

/**
 * Opening fence rows, capturing the indent, the fence characters, and the language.
 *
 * Backticks and tildes are both CommonMark fences, and a fence may be indented: inside a
 * list item, most often. The closing fence has to repeat the same character and be at
 * least as long, so both are carried over rather than assumed to be three backticks.
 */
const FENCE_LINE = /^(\s*)(`{3,}|~{3,})([^`]*)$/;

/**
 * Closes a fenced code block when Enter is pressed on its opening line.
 *
 * Typing ``` and pressing Enter almost always means "start a code block", and writing the
 * closing fence by hand is a step nobody wants. This inserts the blank line and the
 * closing fence together, leaving the cursor between them ready to type.
 *
 * Only fires when the fence is not already closed. The syntax tree cannot answer that
 * question: an unterminated fence swallows the rest of the document, claiming a later
 * block's opening fence as its own closing mark, so a node with two `CodeMark`s may still
 * be one the user is in the middle of opening. The check is textual instead: scan forward
 * for a line that would close this fence, which is what CommonMark itself does.
 */
export const closeCodeFence: StateCommand = ({ state, dispatch }) => {
  const range = state.selection.main;
  // A selection is a replacement, not a fence being opened.
  if (!range.empty) return false;

  const line = state.doc.lineAt(range.head);
  // Only at the very end of the line: pressing Enter mid-line is a split, not an open.
  if (range.head !== line.to) return false;

  const match = FENCE_LINE.exec(line.text);
  if (!match) return false;

  const [, indent = '', fence = '', info = ''] = match;
  // An info string cannot contain the fence character, and a tilde fence allows backticks
  // in it. Reject a line like ```` ```a`b ```` that is not an opening fence at all.
  if (fence.startsWith('~') ? false : info.includes('`')) return false;

  /**
   * A closing fence is the same three characters as an opening one, so the text alone
   * cannot tell them apart.
   *
   * Without this, pressing Enter at the end of a block's closing fence (the obvious way
   * to carry on writing below it) saw a fence-shaped line with nothing closing it after
   * and helpfully added another. That stray fence then opened a block that swallowed
   * everything the user typed next.
   */
  if (!isOpeningFence(state, line.from)) return false;

  if (hasClosingFence(state.doc, line.number, fence)) return false;

  const insert = `\n${indent}\n${indent}${fence}`;
  dispatch(
    state.update({
      changes: { from: line.to, insert },
      // Land on the blank line between the fences, after any indent.
      selection: { anchor: line.to + 1 + indent.length },
      scrollIntoView: true,
      userEvent: 'input',
    }),
  );
  return true;
};

/**
 * Whether the fence on this line opens its block rather than closing one.
 *
 * Asked of the syntax tree, which is the only thing that knows: the opening fence is the
 * first `CodeMark` child of the `FencedCode` node, and a closing fence is a later one.
 * `resolveInner` is used rather than walking the tree by hand so a block nested inside a
 * list item resolves the same way a top-level one does.
 */
function isOpeningFence(state: EditorState, lineFrom: number): boolean {
  const node = syntaxTree(state).resolveInner(lineFrom, 1);

  for (let scope: typeof node | null = node; scope; scope = scope.parent) {
    if (scope.name !== 'FencedCode') continue;
    const first = scope.firstChild;
    if (!first || first.name !== 'CodeMark') return false;
    return state.doc.lineAt(first.from).number === state.doc.lineAt(lineFrom).number;
  }

  // No enclosing fenced block yet: the fence is the one being typed right now.
  return true;
}

/**
 * Whether a fence opened on `openLine` is already closed further down.
 *
 * A closing fence is a line of at least as many of the same character, with nothing after
 * it but whitespace. Scanning stops at the first one found; everything before it is
 * content, including lines that look like fences of the other character.
 */
function hasClosingFence(
  doc: { lines: number; line: (n: number) => { text: string } },
  openLine: number,
  fence: string,
): boolean {
  const char = fence[0]!;
  const closing = new RegExp(`^\\s*\\${char}{${fence.length},}\\s*$`);

  for (let n = openLine + 1; n <= doc.lines; n += 1) {
    if (closing.test(doc.line(n).text)) return true;
  }
  return false;
}


/**
 * Splits a pipe-table row into its cells.
 *
 * The leading and trailing pipes are optional in GFM, and a `\|` escape is a literal pipe
 * inside a cell rather than a separator, so this cannot be a plain `split('|')`.
 */
function splitRow(text: string): string[] {
  const cells: string[] = [];
  let cell = '';

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '\\' && text[i + 1] === '|') {
      cell += '\\|';
      i += 1;
      continue;
    }
    if (ch === '|') {
      cells.push(cell);
      cell = '';
      continue;
    }
    cell += ch;
  }
  cells.push(cell);

  // Drop the empty strings either side of the outer pipes, when they are present.
  if (cells.length && cells[0]!.trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1]!.trim() === '') cells.pop();
  return cells.map((c) => c.trim());
}

/** Alignment declared by one cell of the delimiter row: `:--`, `--:`, `:-:`, or none. */
type Align = 'left' | 'right' | 'center' | null;

function parseAlign(cell: string): Align {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}

/** A delimiter cell is only dashes, optionally colon-bounded. */
const DELIMITER_CELL = /^:?-+:?$/;

function isDelimiterRow(text: string): boolean {
  const cells = splitRow(text);
  return cells.length > 0 && cells.every((c) => DELIMITER_CELL.test(c));
}

/** Pads `text` to `width`, placing it according to the column's declared alignment. */
function padCell(text: string, width: number, align: Align): string {
  const slack = Math.max(0, width - [...text].length);
  if (align === 'right') return ' '.repeat(slack) + text;
  if (align === 'center') {
    const left = Math.floor(slack / 2);
    return ' '.repeat(left) + text + ' '.repeat(slack - left);
  }
  return text + ' '.repeat(slack);
}

/**
 * Rewrites the table under the cursor so its columns line up.
 *
 * Tables are rendered in monospace, so equal-width cells are aligned columns, which is what
 * the pipe format was designed for and why a table typed by hand is readable at all. Rich mode
 * sets prose in a serif but exempts table rows, so this holds in both views. This is
 * an ordinary edit rather than a rendering trick: the alignment is in the file, so it
 * survives export and reads the same in any other editor.
 *
 * Cell contents are never altered, only the padding around them, and the column count is
 * taken from the widest row so a short row gains the cells it is missing rather than
 * silently losing data.
 */
/**
 * A table read out of the document: its extent, its cells, and its column alignments.
 *
 * The header and body are kept as one `rows` array with the delimiter row removed, because
 * every structural operation (adding a column, deleting a row) has to treat the header
 * as just another row. Alignment lives in `aligns` instead, one entry per column.
 */
export interface TableModel {
  /** Document offsets of the whole table, delimiter row included. */
  from: number;
  to: number;
  /** First and last line numbers, for mapping the cursor back afterwards. */
  firstLine: number;
  lastLine: number;
  /** Leading whitespace, so a table inside a list item keeps its indent. */
  indent: string;
  /** Header first, then body. The delimiter row is not here (see `aligns`). */
  rows: string[][];
  aligns: Align[];
}

/**
 * Reads the table containing `pos`, or null when there is not one there.
 *
 * A table is a header line, a delimiter row, and any number of body rows. The delimiter
 * row is what distinguishes a table from prose that happens to contain a pipe, so its
 * absence is the check that rejects everything else.
 */
export function readTable(state: EditorState, pos: number): TableModel | null {
  const cursorLine = state.doc.lineAt(pos);
  const looksLikeRow = (n: number) => state.doc.line(n).text.includes('|');
  if (!looksLikeRow(cursorLine.number)) return null;

  let first = cursorLine.number;
  let last = cursorLine.number;
  while (first > 1 && looksLikeRow(first - 1)) first -= 1;
  while (last < state.doc.lines && looksLikeRow(last + 1)) last += 1;

  const lines: string[] = [];
  for (let n = first; n <= last; n += 1) lines.push(state.doc.line(n).text);
  if (lines.length < 2 || !isDelimiterRow(lines[1] ?? '')) return null;

  const parsed = lines.map(splitRow);
  const aligns = (parsed[1] ?? []).map(parseAlign);
  // Drop the delimiter row; it is rebuilt from `aligns` on the way out.
  const rows = parsed.filter((_, index) => index !== 1);
  const columns = Math.max(...rows.map((r) => r.length), aligns.length);

  return {
    from: state.doc.line(first).from,
    to: state.doc.line(last).to,
    firstLine: first,
    lastLine: last,
    indent: /^\s*/.exec(lines[0] ?? '')?.[0] ?? '',
    // Square the grid so every operation can index without checking for holes.
    rows: rows.map((row) => Array.from({ length: columns }, (_, c) => row[c] ?? '')),
    aligns: Array.from({ length: columns }, (_, c) => aligns[c] ?? null),
  };
}

/**
 * Renders a table back to markdown with its columns padded to equal width.
 *
 * Tables are rendered in monospace, so equal-width cells are aligned columns: that is what
 * the pipe format was designed for and why a table typed by hand is readable at all.
 */
export function renderTable(table: TableModel): string {
  const columns = table.aligns.length;

  const widths: number[] = [];
  for (let c = 0; c < columns; c += 1) {
    // A delimiter cell needs `---` at minimum, so no column is narrower than that.
    let width = 3;
    for (const row of table.rows) width = Math.max(width, [...(row[c] ?? '')].length);
    widths.push(width);
  }

  const delimiter = widths.map((width, c) => {
    const align = table.aligns[c] ?? null;
    const dashes = '-'.repeat(Math.max(1, width - (align === 'center' ? 2 : align ? 1 : 0)));
    if (align === 'center') return `:${dashes}:`;
    if (align === 'right') return `${dashes}:`;
    if (align === 'left') return `:${dashes}`;
    return dashes;
  });

  const line = (cells: string[]) => `${table.indent}| ${cells.join(' | ')} |`;
  const body = table.rows.map((row) =>
    line(widths.map((width, c) => padCell(row[c] ?? '', width, table.aligns[c] ?? null))),
  );

  // Header, delimiter, then the rest: the delimiter always sits second.
  return [body[0] ?? line(widths.map(() => '')), line(delimiter), ...body.slice(1)].join('\n');
}

export const formatTable: StateCommand = ({ state, dispatch }) => {
  const table = readTable(state, state.selection.main.head);
  if (!table) return false;

  const next = renderTable(table);
  if (state.doc.sliceString(table.from, table.to) === next) return false;

  dispatch(
    state.update({
      changes: { from: table.from, to: table.to, insert: next },
      selection: { anchor: Math.min(state.selection.main.head, table.from + next.length) },
      scrollIntoView: true,
    }),
  );
  return true;
};



/**
 * Where the cursor sits inside a table, as a grid coordinate.
 *
 * Row and column survive a reformat; a character offset does not, because rewriting the
 * table moves every position in it.
 */
export interface CellRef {
  row: number;
  column: number;
}

/** The cell containing `pos`, or null when `pos` is not inside `table`. */
export function cellAt(state: EditorState, table: TableModel, pos: number): CellRef | null {
  const line = state.doc.lineAt(pos);
  if (line.number < table.firstLine || line.number > table.lastLine) return null;

  // The delimiter row is not in `rows`, so lines below it shift up by one.
  const delimiterLine = table.firstLine + 1;
  if (line.number === delimiterLine) return null;
  const row = line.number < delimiterLine ? 0 : line.number - table.firstLine - 1;

  return { row, column: Math.max(0, countCellsBefore(line.text, pos - line.from)) };
}

/**
 * The document offset of a cell's first character, for placing the cursor after an edit.
 *
 * Derived from the rendered text rather than tracked through the change, because a
 * structural edit rewrites the whole table and no original position survives it.
 */
export function cellOffset(rendered: string, from: number, cell: CellRef): number {
  const lines = rendered.split('\n');
  // Map the model row back onto a rendered line, skipping the delimiter row.
  const lineIndex = cell.row === 0 ? 0 : cell.row + 1;
  const line = lines[Math.min(lineIndex, lines.length - 1)] ?? '';

  let offset = 0;
  for (let i = 0; i < Math.min(lineIndex, lines.length); i += 1) {
    offset += (lines[i] ?? '').length + 1;
  }

  const pipes = pipePositions(line);
  // Cell `n` opens two characters after pipe `n`: the pipe and the padding space.
  const at = pipes[cell.column];
  return from + offset + (at === undefined ? line.length : Math.min(at + 2, line.length));
}

/**
 * Rewrites the table under the cursor, keeping the cursor in the same cell.
 *
 * Every structural operation goes through here so they all share the one hard part: a
 * table edit rewrites the entire block, so the cursor has to be re-derived from its grid
 * position rather than carried across as an offset.
 */
function editTable(
  state: EditorState,
  dispatch: (tr: import('@codemirror/state').Transaction) => void,
  change: (table: TableModel, cell: CellRef) => CellRef | null,
): boolean {
  const head = state.selection.main.head;
  const table = readTable(state, head);
  if (!table) return false;

  const cell = cellAt(state, table, head) ?? { row: 0, column: 0 };
  const next = change(table, cell);
  if (!next) return false;

  const rendered = renderTable(table);
  dispatch(
    state.update({
      changes: { from: table.from, to: table.to, insert: rendered },
      selection: { anchor: cellOffset(rendered, table.from, next) },
      scrollIntoView: true,
    }),
  );
  return true;
}

/** Inserts a column at `index`, giving every row, header included, an empty cell. */
export function insertColumn(table: TableModel, index: number): void {
  for (const row of table.rows) row.splice(index, 0, '');
  table.aligns.splice(index, 0, null);
}

/** Removes column `index`. */
export function removeColumn(table: TableModel, index: number): void {
  for (const row of table.rows) row.splice(index, 1);
  table.aligns.splice(index, 1);
}

/** Inserts an empty row at `index`. Index 0 is the header, which cannot be displaced. */
export function insertRow(table: TableModel, index: number): void {
  table.rows.splice(index, 0, table.aligns.map(() => ''));
}

export const addColumnAfter: StateCommand = ({ state, dispatch }) =>
  editTable(state, dispatch, (table, cell) => {
    insertColumn(table, cell.column + 1);
    return { row: cell.row, column: cell.column + 1 };
  });

export const addColumnBefore: StateCommand = ({ state, dispatch }) =>
  editTable(state, dispatch, (table, cell) => {
    insertColumn(table, cell.column);
    return cell;
  });

/**
 * Deletes the cursor's column, unless it is the only one.
 *
 * A table with no columns is not a table (it renders as a run of bare pipes), so the last
 * column stays and the user deletes the table instead.
 */
export const deleteColumn: StateCommand = ({ state, dispatch }) =>
  editTable(state, dispatch, (table, cell) => {
    if (table.aligns.length <= 1) return null;
    removeColumn(table, cell.column);
    return { row: cell.row, column: Math.max(0, cell.column - 1) };
  });

export const addRowAfter: StateCommand = ({ state, dispatch }) =>
  editTable(state, dispatch, (table, cell) => {
    insertRow(table, cell.row + 1);
    return { row: cell.row + 1, column: 0 };
  });

export const addRowBefore: StateCommand = ({ state, dispatch }) =>
  editTable(state, dispatch, (table, cell) => {
    // Above the header would put a body row where the header must be.
    const at = Math.max(1, cell.row);
    insertRow(table, at);
    return { row: at, column: 0 };
  });

/**
 * Deletes the cursor's row.
 *
 * The header is not deletable: a table without one has no delimiter row to describe, and
 * removing it would silently promote the first body row into a header.
 */
export const deleteRow: StateCommand = ({ state, dispatch }) =>
  editTable(state, dispatch, (table, cell) => {
    if (cell.row === 0 || table.rows.length <= 2) return null;
    table.rows.splice(cell.row, 1);
    return { row: Math.max(1, cell.row - 1), column: cell.column };
  });

/** Sets the alignment of the cursor's column. */
export function alignColumn(align: Align): StateCommand {
  return ({ state, dispatch }) =>
    editTable(state, dispatch, (table, cell) => {
      if (table.aligns[cell.column] === align) return null;
      table.aligns[cell.column] = align;
      return cell;
    });
}

/** Removes the whole table, leaving the surrounding text joined up. */
export const deleteTable: StateCommand = ({ state, dispatch }) => {
  const table = readTable(state, state.selection.main.head);
  if (!table) return false;

  // Take the newline that followed the table too, so no blank line is left behind.
  const to = Math.min(state.doc.length, table.to + 1);
  dispatch(
    state.update({
      changes: { from: table.from, to },
      selection: { anchor: table.from },
      scrollIntoView: true,
    }),
  );
  return true;
};

/**
 * Builds an empty table of the given size, ready to type into.
 *
 * Written as text like everything else here, so an inserted table is an ordinary edit the
 * user can undo in one step.
 */
export function buildTable(rows: number, columns: number, indent = ''): string {
  const model: TableModel = {
    from: 0,
    to: 0,
    firstLine: 0,
    lastLine: 0,
    indent,
    // One header row plus `rows` body rows.
    rows: Array.from({ length: rows + 1 }, () => Array.from({ length: columns }, () => '')),
    aligns: Array.from({ length: columns }, () => null),
  };
  return renderTable(model);
}



/**
 * Resizes a table to `rows` body rows and `columns` columns.
 *
 * Truncating drops cells, which is why the picker showing the current size matters: the
 * user is dragging away from a known starting point rather than guessing. The edit is an
 * ordinary one, so an accidental shrink is a single undo away.
 *
 * Rows are counted excluding the header, matching how the picker presents them: a 3×2
 * table has a header and three rows of data.
 */
export function resizeTable(table: TableModel, rows: number, columns: number): void {
  const width = Math.max(1, columns);
  const height = Math.max(1, rows);

  for (const row of table.rows) {
    if (row.length > width) row.length = width;
    while (row.length < width) row.push('');
  }
  table.aligns.length = Math.min(table.aligns.length, width);
  while (table.aligns.length < width) table.aligns.push(null);

  // `rows` counts body rows; `table.rows` includes the header at index 0.
  const target = height + 1;
  if (table.rows.length > target) table.rows.length = target;
  while (table.rows.length < target) table.rows.push(table.aligns.map(() => ''));
}

/** The size of a table as the picker presents it: body rows, then columns. */
export function tableSize(table: TableModel): { rows: number; columns: number } {
  return { rows: Math.max(1, table.rows.length - 1), columns: table.aligns.length };
}

/**
 * Resizes the table under the cursor, or inserts one when there is none.
 *
 * One command for both so the picker has a single entry point: whether it is creating or
 * reshaping is a detail of where the cursor happens to be.
 */
export function resizeOrInsertTable(rows: number, columns: number): StateCommand {
  return ({ state, dispatch }) => {
    const table = readTable(state, state.selection.main.head);

    if (!table) {
      return insertTableOfSize(rows, columns)({ state, dispatch });
    }

    const before = renderTable(table);
    resizeTable(table, rows, columns);
    const rendered = renderTable(table);
    if (rendered === before) return false;

    // Clamp the cursor into the table that now exists: it may have just shrunk past it.
    const cell = cellAt(state, table, state.selection.main.head) ?? { row: 0, column: 0 };
    const clamped = {
      row: Math.min(cell.row, table.rows.length - 1),
      column: Math.min(cell.column, table.aligns.length - 1),
    };

    dispatch(
      state.update({
        changes: { from: table.from, to: table.to, insert: rendered },
        selection: { anchor: cellOffset(rendered, table.from, clamped) },
        scrollIntoView: true,
      }),
    );
    return true;
  };
}

/** Inserts an empty table of the given size at the cursor. */
export function insertTableOfSize(rows: number, columns: number): StateCommand {
  return ({ state, dispatch }) => {
    const line = state.doc.lineAt(state.selection.main.head);
    const indent = /^\s*/.exec(line.text)?.[0] ?? '';
    const table = buildTable(rows, columns, indent);

    // A table has to begin a line; one written mid-sentence parses as a paragraph.
    const onBlankLine = line.text.trim() === '';
    const from = onBlankLine ? line.from : line.to;
    const insert = onBlankLine ? `${table}\n` : `\n${table}\n`;

    dispatch(
      state.update({
        changes: { from, to: onBlankLine ? line.to : from, insert },
        // Land in the first header cell, past the indent and the leading `| `.
        selection: { anchor: from + (onBlankLine ? 0 : 1) + indent.length + 2 },
        scrollIntoView: true,
      }),
    );
    return true;
  };
}

/**
 * Inserts a starter table at the cursor.
 *
 * The toolbar's size picker only exists once the cursor is inside a table, so it cannot be
 * how the first one is made. This is the way in: a 2×3 to type over, which is the size
 * most tables start at.
 */
export const insertTableCommand: StateCommand = insertTableOfSize(2, 3);

/**
 * Moves to the next cell of a table, formatting the table on the way.
 *
 * Tab between cells is what every table editor does, and it is the natural moment to
 * re-align: the row has just been finished. Returns false anywhere outside a table so Tab
 * falls through to list indenting, which is what it does everywhere else.
 *
 * At the last cell of the last row this adds a new row rather than escaping the table,
 * matching a spreadsheet: leaving is what the arrow keys and the mouse are for.
 */
export const tableNextCell: StateCommand = ({ state, dispatch }) => {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  if (!line.text.includes('|')) return false;

  // Only inside a real table: a lone pipe in prose is not one.
  const next = line.number < state.doc.lines ? state.doc.line(line.number + 1).text : '';
  const prev = line.number > 1 ? state.doc.line(line.number - 1).text : '';
  const inTable =
    isDelimiterRow(next) || isDelimiterRow(prev) || isDelimiterRow(line.text) || hasDelimiterAbove(state, line.number);
  if (!inTable) return false;

  /**
   * Which cell the cursor is in, counted before formatting.
   *
   * Formatting rewrites the whole table, so a character offset taken beforehand means
   * nothing afterwards: the cursor has to be re-derived from the cell index rather than
   * carried across as a position. This counts the separators to the cursor's left.
   */
  const cellIndex = countCellsBefore(line.text, head - line.from);

  /**
   * Formatting runs first so the offsets below are the ones the user will see, but its
   * transaction is captured rather than dispatched.
   *
   * Both the reformat and the cursor move have to reach the editor as a single
   * transaction. Dispatching a selection-only update built from the formatted state
   * against the editor's current state silently drops the text changes (the offsets are
   * interpreted, the edits are not), so Tab appeared to do nothing at all.
   */
  let working = state;
  let changes: ChangeSpec | null = null;
  formatTable({
    state,
    dispatch: (tr) => {
      working = tr.state;
      changes = tr.changes;
    },
  });

  const formattedLine = working.doc.line(Math.min(line.number, working.doc.lines));
  const pipes = pipePositions(formattedLine.text).map((at) => at + formattedLine.from);

  /**
   * The pipe opening the cell after the cursor's own.
   *
   * `pipes[cellIndex + 1]` because a row starts with a leading pipe: cell 0 sits between
   * pipes 0 and 1, so the cell after it opens at pipe 1 + its index.
   */
  const target = pipes[cellIndex + 1];
  const anchor =
    target !== undefined && target + 2 <= formattedLine.to
      ? target + 2
      : nextRowStart(working, formattedLine.number);

  dispatch(
    state.update({
      ...(changes ? { changes } : {}),
      selection: { anchor },
      scrollIntoView: true,
    }),
  );
  return true;
};


/** Byte offsets of the unescaped `|` characters in a row. */
function pipePositions(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '|' && text[i - 1] !== '\\') out.push(i);
  }
  return out;
}

/**
 * How many cells begin before `offset` in a row, which survives a reformat when a raw
 * character position does not.
 */
function countCellsBefore(text: string, offset: number): number {
  return pipePositions(text).filter((at) => at < offset).length - 1;
}

/** Whether a delimiter row sits somewhere above this line without prose in between. */
function hasDelimiterAbove(state: EditorState, lineNumber: number): boolean {
  for (let n = lineNumber - 1; n >= 1; n -= 1) {
    const text = state.doc.line(n).text;
    if (!text.includes('|')) return false;
    if (isDelimiterRow(text)) return true;
  }
  return false;
}

/**
 * The first cell of the row below, adding one when the cursor is in the last row.
 *
 * Tab off the end of a table should extend it, the way it does in a spreadsheet.
 */
function nextRowStart(state: EditorState, lineNumber: number): number {
  if (lineNumber < state.doc.lines) {
    const below = state.doc.line(lineNumber + 1);
    if (below.text.includes('|')) return Math.min(below.from + 2, below.to);
  }
  return state.doc.line(lineNumber).to;
}

const tabIndent: StateCommand = (target) => indentList(target);
const shiftTabOutdent: StateCommand = (target) => outdentList(target);

/** Shortcuts matching what people already know from other editors. */
export const markdownKeymap: KeyBinding[] = [
  /**
   * Before the default Enter binding, which would otherwise just split the line.
   *
   * `shift` as well as `run`: CodeMirror expresses Shift-Enter as a property of the Enter
   * binding rather than a separate `'Shift-Enter'` key, which is how the default keymap
   * gives both the same command. Binding only `run` left Shift-Enter falling through to
   * that default, so it split a fence line instead of closing it: the same keystroke
   * doing two different things depending on a modifier that means nothing here.
   */
  { key: 'Enter', run: closeCodeFence, shift: closeCodeFence },
  // Before list indenting: inside a table Tab moves between cells, and `tableNextCell`
  // returns false everywhere else so Tab keeps its usual meaning.
  { key: 'Tab', run: tableNextCell },
  { key: 'Tab', run: tabIndent },
  { key: 'Shift-Tab', run: shiftTabOutdent },
  { key: 'Mod-b', run: toggleBold, preventDefault: true },
  { key: 'Mod-i', run: toggleItalic, preventDefault: true },
  { key: 'Mod-e', run: toggleCode, preventDefault: true },
  { key: 'Mod-k', run: insertLink, preventDefault: true },
  { key: 'Mod-Shift-x', run: toggleStrikethrough, preventDefault: true },
  { key: 'Mod-Alt-1', run: toggleH1, preventDefault: true },
  { key: 'Mod-Alt-2', run: toggleH2, preventDefault: true },
  { key: 'Mod-Alt-3', run: toggleH3, preventDefault: true },
  { key: 'Mod-Shift-9', run: toggleQuote, preventDefault: true },
  { key: 'Mod-Shift-8', run: toggleBullet, preventDefault: true },
  { key: 'Mod-Shift-f', run: formatTable, preventDefault: true },
  { key: 'Mod-Shift-t', run: insertTableCommand, preventDefault: true },
];
