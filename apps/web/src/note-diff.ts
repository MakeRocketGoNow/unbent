import { foldNoCase, type FieldValue, type NoteFieldValue, type NoteRevisionProps, type RevisionSkip } from '@unbent/shared';
import { diffArrays, diffWordsWithSpace } from 'diff';
import { sameFieldValue } from './note-patch.js';

/**
 * What restoring a version would do to a note, line by line (MAK-167).
 *
 * The direction is fixed and everything else follows from it: *from* is the note as it
 * is now, *to* is the version. So "added" is text Restore would bring back, and
 * "removed" is text Restore would take out. The History sheet asks one question (what
 * will Restore do to my note), and a comparison with the version before this one would
 * answer a different question that nobody opening the sheet has.
 *
 * The Markdown source is compared, not the rendered note. Marks inside a table's pipes
 * or a link's brackets break the very rendering they would be marking, and a file has
 * no "changed" state to draw. Source is also what Restore actually writes back.
 *
 * jsdiff does the comparison only (lines first, then words inside lines that changed),
 * and nothing here knows how it is drawn; `HistoryChanges` does that.
 */

export interface DiffPart {
  kind: 'same' | 'added' | 'removed';
  text: string;
}

/**
 * One row of the comparison, in order.
 *
 * `fold` is a stretch of unchanged lines long enough to be worth hiding; it carries its
 * lines so the reader can open it in place. `changed` is a line that is partly the same
 * (the two numbers in a table row) with its words marked; `added` and `removed` are
 * lines that exist on one side only.
 */
export type DiffRow =
  | { kind: 'same'; text: string }
  | { kind: 'fold'; lines: string[] }
  | { kind: 'added' | 'removed' | 'changed'; parts: DiffPart[] };

export interface NoteDiff {
  titleChanged: boolean;
  body: 'same' | 'too-different' | DiffRow[];
}

interface NoteText {
  title: string;
  body: string;
}

/**
 * The most lines the line comparison may add and remove between them before it gives
 * up. jsdiff's cost grows with the square of this, not with the note's length: a note
 * of five thousand lines with one edit is as quick as a short one, and two wholly
 * different five-thousand-line bodies are the case being bounded. Measured on a desktop
 * against that case: 600 returns in about 20 ms, 1,000 in about 50, 2,000 in 200, and
 * uncapped in two and a half seconds. A phone is several times slower, so the low end:
 * a version three hundred lines away from the note is read better in Preview anyway.
 */
export const MAX_EDIT_LINES = 600;

/**
 * When one side is short, the cap above would refuse the case the sheet is most often
 * opened for (the note gutted to a line or two, and the long version before it) while
 * the comparison itself is cheap: jsdiff's work is about the short side's lines times
 * the whole length, since it cannot wander far from a diagonal that narrow. Under this
 * many line-pairs the comparison runs without the cap (about 20 ms at the bound).
 */
export const LOPSIDED_BUDGET = 200_000;

/**
 * The word comparison inside a block of changed lines is bounded the same way, and
 * skipped outright for a block too large to be a small edit: past these, whole lines
 * removed and then added say it as well and cost nothing.
 */
export const MAX_EDIT_WORDS = 400;
export const MAX_PAIR_CHARS = 4_000;
export const MAX_PAIR_LINES = 40;

/**
 * How much of a changed block must be the same, ignoring whitespace, for its words to
 * be marked. Below this the lines have little in common, and a word diff of unrelated
 * lines is confetti: a mark on every other word, each one true and none of them
 * helpful. Whole lines out and whole lines in read better.
 */
export const MIN_SIMILARITY = 0.5;

/** Unchanged lines kept beside a change, on each side. */
export const CONTEXT_LINES = 2;
/**
 * The shortest stretch worth folding. A "2 unchanged lines" row takes as much room as
 * the two lines it hides, and costs a click to read them; under four, they are shown.
 */
export const MIN_FOLD = 4;

export function diffNote(current: NoteText, version: NoteText): NoteDiff {
  return { titleChanged: current.title !== version.title, body: diffBody(current.body, version.body) };
}

/**
 * Only line endings are normalised. Trailing newlines are dropped with them: a body that
 * differs from the other only by a newline at the end reads the same in every view, and
 * a comparison that showed it as a changed last line would be reporting a difference
 * nobody can see.
 */
function toLines(body: string): string[] {
  const text = body.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  return text === '' ? [] : text.split('\n');
}

function diffBody(currentBody: string, versionBody: string): NoteDiff['body'] {
  const from = toLines(currentBody);
  const to = toLines(versionBody);
  if (from.length === to.length && from.every((line, i) => line === to[i])) return 'same';

  // One side empty is the whole of the other, and asks nothing of the differ.
  if (from.length === 0) return to.map((text) => ({ kind: 'added', parts: [{ kind: 'added', text }] }));
  if (to.length === 0) return from.map((text) => ({ kind: 'removed', parts: [{ kind: 'removed', text }] }));

  const lopsided = Math.min(from.length, to.length) * (from.length + to.length) <= LOPSIDED_BUDGET;
  const changes = lopsided ? diffArrays(from, to) : diffArrays(from, to, { maxEditLength: MAX_EDIT_LINES });
  if (!changes) return 'too-different';

  /*
     Runs of equal lines, and between them a block of change: everything removed and
     added before the next equal run, in whichever order jsdiff gave them.
  */
  const runs: ({ same: string[] } | { removed: string[]; added: string[] })[] = [];
  for (const change of changes) {
    if (!change.added && !change.removed) {
      runs.push({ same: change.value });
      continue;
    }
    let last = runs[runs.length - 1];
    if (!last || 'same' in last) {
      last = { removed: [], added: [] };
      runs.push(last);
    }
    (change.added ? last.added : last.removed).push(...change.value);
  }

  const rows: DiffRow[] = [];
  runs.forEach((run, i) => {
    if ('same' in run) rows.push(...context(run.same, i === 0, i === runs.length - 1));
    else rows.push(...changeRows(run.removed, run.added));
  });
  return rows;
}

/** An unchanged run, folded down to the lines beside the changes it sits between. */
function context(lines: string[], first: boolean, last: boolean): DiffRow[] {
  const head = first ? 0 : CONTEXT_LINES;
  const tail = last ? 0 : CONTEXT_LINES;
  const same = (text: string): DiffRow => ({ kind: 'same', text });
  if (lines.length - head - tail < MIN_FOLD) return lines.map(same);
  return [
    ...lines.slice(0, head).map(same),
    { kind: 'fold', lines: lines.slice(head, lines.length - tail) },
    ...lines.slice(lines.length - tail).map(same),
  ];
}

function wholeLines(removed: string[], added: string[]): DiffRow[] {
  return [
    ...removed.map((text): DiffRow => ({ kind: 'removed', parts: [{ kind: 'removed', text }] })),
    ...added.map((text): DiffRow => ({ kind: 'added', parts: [{ kind: 'added', text }] })),
  ];
}

/**
 * A block of change. Lines removed and lines added side by side are usually the same
 * lines edited, so their words are compared and the lines drawn once, with the removed
 * and added words marked inside them: the two numbers in a table row, and not the row
 * twice. Lines on one side only, a block too big to be an edit, and a block whose two
 * sides have little in common are drawn as whole lines.
 */
function changeRows(removed: string[], added: string[]): DiffRow[] {
  if (removed.length === 0 || added.length === 0) return wholeLines(removed, added);
  const before = removed.join('\n');
  const after = added.join('\n');
  if (
    removed.length > MAX_PAIR_LINES ||
    added.length > MAX_PAIR_LINES ||
    before.length + after.length > MAX_PAIR_CHARS
  ) {
    return wholeLines(removed, added);
  }
  const words = diffWordsWithSpace(before, after, { maxEditLength: MAX_EDIT_WORDS });
  if (!words) return wholeLines(removed, added);
  /*
     A line break only the note has cannot be drawn in one column. The rows below are cut
     at every newline in the stream, so two lines the version holds as one were drawn as
     two, the first with no mark on it: the note as it is, where Restore would join them.
     Whole lines then: both of the note's removed, the version's one added.
  */
  if (words.some((w) => w.removed && w.value.includes('\n'))) return wholeLines(removed, added);

  const solid = (text: string) => text.replace(/\s+/g, '').length;
  const common = words.filter((w) => !w.added && !w.removed).reduce((n, w) => n + solid(w.value), 0);
  const total = solid(before) + solid(after);
  if (total === 0 || (2 * common) / total < MIN_SIMILARITY) return wholeLines(removed, added);

  // The marked stream, cut back into lines wherever it holds a newline.
  const lines: DiffPart[][] = [[]];
  for (const word of words) {
    const kind: DiffPart['kind'] = word.added ? 'added' : word.removed ? 'removed' : 'same';
    word.value.split('\n').forEach((text, j) => {
      if (j > 0) lines.push([]);
      if (text !== '') lines[lines.length - 1]!.push({ kind, text });
    });
  }
  return lines.map((parts): DiffRow => {
    const kinds = new Set(parts.map((p) => p.kind));
    if (kinds.size === 0 || (kinds.size === 1 && kinds.has('same'))) {
      return { kind: 'same', text: parts.map((p) => p.text).join('') };
    }
    if (kinds.size === 1) return { kind: kinds.has('added') ? 'added' : 'removed', parts };
    return { kind: 'changed', parts };
  });
}

/**
 * A field value with enough of its definition to draw it: what a version holds for each
 * field, and what the workspace can say of each value on screen.
 */
export type PropValue = Pick<NoteFieldValue, 'fieldId' | 'name' | 'type' | 'value' | 'scale' | 'currency' | 'style'> &
  // The notebook the field belongs to, when known; see the last rule of `diffProps`.
  Partial<Pick<NoteFieldValue, 'notebookId'>>;

/**
 * The note on screen, beyond its text: where it is filed, its tags and its field values
 * (MAK-170). The notebook's id is absent when the draft names a notebook this device has
 * not heard of yet, and the comparison then goes by name.
 */
export interface CurrentProps {
  notebook: { id?: string | undefined; name: string } | null;
  tags: string[];
  fields: PropValue[];
}

/**
 * One line of what Restore would do to the note's notebook, tags and fields. `from` is
 * the note now and `to` the version, as everywhere in this file; null is "none": no
 * notebook, no value. `unfit` is something the version holds that Restore would leave as
 * the note has it, with the server's reason (`tags-gone` is that for the version's
 * deleted tags, all on one line): `held` is the value the version has and
 * Restore cannot put back, `stays` a value the note has and Restore will not take away.
 */
export type PropChange =
  | { kind: 'notebook'; from: string | null; to: string | null }
  | { kind: 'tags'; same: string[]; removed: string[]; added: string[] }
  | { kind: 'field'; name: string; from: PropValue | null; to: PropValue | null }
  | { kind: 'tags-gone'; names: string[] }
  | { kind: 'unfit'; skip: RevisionSkip; held?: PropValue; stays?: PropValue };

/**
 * What restoring a version would do to the note's notebook, tags and field values, in
 * the order the note's own head has them. Empty when it would do nothing.
 *
 * This mirrors the store's `planRestore`, which is the code that decides: the version's
 * state is the target, by id; what the server said it would skip (`unfit`) is drawn as
 * skipped and never as a change; a value the note has gained since is cleared. The last
 * rule has the store's exception too: when the version's notebook is gone and the note
 * stays where it is, that notebook's values stay with it, and a value under a deleted
 * field is never cleared.
 *
 * A tag renamed since the version is compared under today's name (`renamed`, from the
 * server, which goes by id): the note carries it under that name, so the version's old
 * name would read as one tag going on and another coming off where the restore leaves
 * the tag alone. That includes a tag whose id is gone but whose name a tag holds today in
 * any case, which the store resolves by name (MAK-127) and reports the same way.
 */
export function diffProps(
  current: CurrentProps,
  props: NoteRevisionProps,
  unfit: readonly RevisionSkip[] = [],
  renamed: ReadonlyArray<{ id: string; name: string }> = [],
): PropChange[] {
  const changes: PropChange[] = [];
  const skip = (what: RevisionSkip['what'], id: string) => unfit.find((u) => u.what === what && u.id === id);

  const notebookSkip = props.notebook ? skip('notebook', props.notebook.id) : undefined;
  if (notebookSkip) {
    changes.push({ kind: 'unfit', skip: notebookSkip });
  } else {
    const now = current.notebook;
    const then = props.notebook;
    const same =
      now === null || then === null
        ? now === then
        : now.id !== undefined
          ? now.id === then.id
          : now.name.toLowerCase() === then.name.toLowerCase();
    if (!same) changes.push({ kind: 'notebook', from: now?.name ?? null, to: then?.name ?? null });
  }

  // Once per name: a version kept before tags matched without case can hold two
  // spellings the store has since made one, and the server names both under it.
  const target: string[] = [];
  const seen = new Set<string>();
  for (const t of props.tags) {
    if (skip('tag', t.id)) continue;
    const name = renamed.find((r) => r.id === t.id)?.name ?? t.name;
    if (seen.has(foldNoCase(name))) continue;
    seen.add(foldNoCase(name));
    target.push(name);
  }
  const removed = current.tags.filter((t) => !target.includes(t));
  const added = target.filter((t) => !current.tags.includes(t));
  if (removed.length > 0 || added.length > 0) {
    changes.push({ kind: 'tags', same: current.tags.filter((t) => target.includes(t)), removed, added });
  }
  // One line for every tag that is gone, however many: a line each was a column of
  // rows all labelled "Tags".
  const gone = props.tags.flatMap((t) => skip('tag', t.id) ?? []);
  if (gone.length > 0) changes.push({ kind: 'tags-gone', names: gone.map((g) => g.name) });

  const held = new Map(current.fields.map((v) => [v.fieldId, v]));
  for (const was of props.fields) {
    const stands = held.get(was.fieldId);
    if (stands && sameFieldValue(stands.value, was.value)) continue;
    const skipped = skip('field', was.fieldId);
    if (skipped) changes.push({ kind: 'unfit', skip: skipped, held: was });
    else changes.push({ kind: 'field', name: stands?.name ?? was.name, from: stands ?? null, to: was });
  }
  const inVersion = new Set(props.fields.map((v) => v.fieldId));
  for (const stands of current.fields) {
    if (inVersion.has(stands.fieldId)) continue;
    if (notebookSkip && stands.notebookId !== undefined && stands.notebookId === current.notebook?.id) continue;
    // A value under a deleted field stays: this device cannot tell a deleted field from
    // a live one, so the server's list is how it learns.
    const skipped = skip('field', stands.fieldId);
    if (skipped) changes.push({ kind: 'unfit', skip: skipped, stays: stands });
    else changes.push({ kind: 'field', name: stands.name, from: stands, to: null });
  }
  return changes;
}
