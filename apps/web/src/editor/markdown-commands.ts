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
 * Applied per line across the selection, and toggled off when every line already has it —
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
     * only this prefix. Toggling off requires the exact prefix — otherwise asking for H1
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
 * A nested list is a new list and starts over at 1 — carrying the parent's count down a
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
 * not error — the line simply stays a sibling, which looks like the key did nothing.
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
     * child of its new parent — and since depth decides how the marker is displayed, that
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
     * Levels are not uniformly sized — a bullet under `1. ` is indented three spaces while
     * one under `- ` is two — so the amount removed is measured from the nearest shallower
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
 * Backticks and tildes are both CommonMark fences, and a fence may be indented — inside a
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
 * be one the user is in the middle of opening. The check is textual instead — scan forward
 * for a line that would close this fence — which is what CommonMark itself does.
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
   * Without this, pressing Enter at the end of a block's closing fence — the obvious way
   * to carry on writing below it — saw a fence-shaped line with nothing closing it after
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

  // No enclosing fenced block yet — the fence is the one being typed right now.
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
 * The editor is monospace, so equal-width cells are aligned columns — which is what the
 * pipe format was designed for and why a table typed by hand is readable at all. This is
 * an ordinary edit rather than a rendering trick: the alignment is in the file, so it
 * survives export and reads the same in any other editor.
 *
 * Cell contents are never altered, only the padding around them, and the column count is
 * taken from the widest row so a short row gains the cells it is missing rather than
 * silently losing data.
 */
export const formatTable: StateCommand = ({ state, dispatch }) => {
  const cursorLine = state.doc.lineAt(state.selection.main.head);

  // Walk out to the full extent of the table, which the cursor may be anywhere inside.
  let first = cursorLine.number;
  let last = cursorLine.number;
  const looksLikeRow = (n: number) => state.doc.line(n).text.includes('|');

  if (!looksLikeRow(cursorLine.number)) return false;
  while (first > 1 && looksLikeRow(first - 1)) first -= 1;
  while (last < state.doc.lines && looksLikeRow(last + 1)) last += 1;

  const lines: string[] = [];
  for (let n = first; n <= last; n += 1) lines.push(state.doc.line(n).text);

  // A table is a header, a delimiter row, and any number of body rows.
  if (lines.length < 2 || !isDelimiterRow(lines[1] ?? '')) return false;

  const indent = /^\s*/.exec(lines[0] ?? '')?.[0] ?? '';
  const rows = lines.map(splitRow);
  const aligns = (rows[1] ?? []).map(parseAlign);
  const columns = Math.max(...rows.map((r) => r.length));

  const widths: number[] = [];
  for (let c = 0; c < columns; c += 1) {
    let width = 3; // a delimiter cell needs `---` at minimum
    rows.forEach((row, index) => {
      if (index === 1) return; // the delimiter row is rebuilt, not measured
      width = Math.max(width, [...(row[c] ?? '')].length);
    });
    widths.push(width);
  }

  const rendered = rows.map((row, index) => {
    if (index === 1) {
      const cells = widths.map((width, c) => {
        const align = aligns[c] ?? null;
        const dashes = '-'.repeat(Math.max(1, width - (align === 'center' ? 2 : align ? 1 : 0)));
        if (align === 'center') return `:${dashes}:`;
        if (align === 'right') return `${dashes}:`;
        if (align === 'left') return `:${dashes}`;
        return dashes;
      });
      return `${indent}| ${cells.join(' | ')} |`;
    }
    const cells = widths.map((width, c) => padCell(row[c] ?? '', width, aligns[c] ?? null));
    return `${indent}| ${cells.join(' | ')} |`;
  });

  const next = rendered.join('\n');
  const from = state.doc.line(first).from;
  const to = state.doc.line(last).to;
  if (state.doc.sliceString(from, to) === next) return false;

  dispatch(
    state.update({
      changes: { from, to, insert: next },
      selection: { anchor: Math.min(state.selection.main.head, from + next.length) },
      scrollIntoView: true,
    }),
  );
  return true;
};


/**
 * Moves to the next cell of a table, formatting the table on the way.
 *
 * Tab between cells is what every table editor does, and it is the natural moment to
 * re-align: the row has just been finished. Returns false anywhere outside a table so Tab
 * falls through to list indenting, which is what it does everywhere else.
 *
 * At the last cell of the last row this adds a new row rather than escaping the table,
 * matching a spreadsheet — leaving is what the arrow keys and the mouse are for.
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
   * nothing afterwards — the cursor has to be re-derived from the cell index rather than
   * carried across as a position. This counts the separators to the cursor's left.
   */
  const cellIndex = countCellsBefore(line.text, head - line.from);

  /**
   * Formatting runs first so the offsets below are the ones the user will see, but its
   * transaction is captured rather than dispatched.
   *
   * Both the reformat and the cursor move have to reach the editor as a single
   * transaction. Dispatching a selection-only update built from the formatted state
   * against the editor's current state silently drops the text changes — the offsets are
   * interpreted, the edits are not — so Tab appeared to do nothing at all.
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
   * that default, so it split a fence line instead of closing it — the same keystroke
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
];
