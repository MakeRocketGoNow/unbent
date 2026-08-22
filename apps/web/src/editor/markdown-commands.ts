import type { ChangeSpec, StateCommand } from '@codemirror/state';
import type { KeyBinding } from '@codemirror/view';

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

/** Shortcuts matching what people already know from other editors. */
export const markdownKeymap: KeyBinding[] = [
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
];
