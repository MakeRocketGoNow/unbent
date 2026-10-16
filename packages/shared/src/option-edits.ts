import { z } from 'zod';
import { MAX_FIELD_NAME_LENGTH, MAX_SELECT_OPTIONS } from './fields.js';

/**
 * Edits to a select's or multi-select's option list, described rather than spelled out.
 *
 * The options editor in the app works on the whole list, because the whole list is on
 * screen. A model does not have it on screen: to add one option it had to read the list,
 * resend every entry with the new one, and an entry it dropped on the way left the field
 * without a word (MAK-227). These say what changes — a rename, a removal, an addition, an
 * order — and the list the store already holds is the one they apply to, so nothing the
 * caller did not name can go missing.
 */

const optionSchema = z.string().trim().min(1).max(MAX_FIELD_NAME_LENGTH);

/** Where added options go: the end (the default), the start, in alphabetical place, or after a named one. */
export const optionPositionSchema = z.union([
  z.enum(['end', 'start', 'alpha']),
  z.object({ after: optionSchema }),
]);

export const optionEditSchema = z.object({
  rename: z.array(z.object({ from: optionSchema, to: optionSchema })).max(MAX_SELECT_OPTIONS).optional(),
  remove: z.array(optionSchema).max(MAX_SELECT_OPTIONS).optional(),
  add: z.array(optionSchema).max(MAX_SELECT_OPTIONS).optional(),
  position: optionPositionSchema.optional(),
  sort: z.literal('alpha').optional(),
  pinFirst: z.array(optionSchema).max(MAX_SELECT_OPTIONS).optional(),
  pinLast: z.array(optionSchema).max(MAX_SELECT_OPTIONS).optional(),
  /** Lets a rename land on an option that already stands, folding the two into one. */
  merge: z.boolean().optional(),
});

export type OptionPosition = z.infer<typeof optionPositionSchema>;
export type OptionEdit = z.infer<typeof optionEditSchema>;

/**
 * True when the edit asks for nothing, so a caller can tell it apart from one that does. A
 * `position` alone is not nothing: it is a mistake, and `applyOptionEdit` says so.
 */
export function isEmptyOptionEdit(edit: OptionEdit): boolean {
  return (
    !edit.rename?.length &&
    !edit.remove?.length &&
    !edit.add?.length &&
    edit.position === undefined &&
    !edit.sort &&
    !edit.pinFirst?.length &&
    !edit.pinLast?.length
  );
}

/**
 * Case- and accent-insensitive, numbers by value ("Item 2" before "Item 10"). The locale is
 * fixed rather than the runtime's, so the Worker, a test and a browser put a list in the
 * same order; `en` is a neutral base for the Latin-script options this mostly sees.
 */
const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

export function compareOptions(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

export type OptionEditResult =
  | {
      options: string[];
      /** Renames that changed something, in the order given; `to` may name an option that already stood (a merge). */
      renamed: Array<{ from: string; to: string }>;
      /** Options taken off the list. Notes keep these as values; see `removeFieldOption`. */
      removed: string[];
      /** Options that were not on the list before. One already there is not repeated. */
      added: string[];
    }
  /** `merge` marks the one refusal that the edit's own flag would have allowed. */
  | { error: string; merge?: true };

/**
 * Applies `edit` to `current`, in a fixed order: renames, then removals, then additions,
 * then the sort and the pins. That order is what makes one call able to rename an option
 * and pin the new name last, or remove one and sort what is left.
 *
 * Names match exactly, case included, as option values do everywhere else. A name that is
 * not on the list is refused rather than skipped: the point of this is that nothing
 * changes that the caller did not mean, and a misspelt rename quietly doing nothing is the
 * same failure as a dropped option quietly vanishing.
 *
 * A rename onto an option that already stands merges the two: the old one leaves the list
 * and its notes take the other's value. That is how "Grocery" and "Groceries" become one,
 * and the store moves the values with it. It is refused unless `merge` says it is meant,
 * as `rename_tag` refuses one: afterwards nothing tells which notes held which, and a
 * model that misread the list should hear so before that happens, not after.
 */
export function applyOptionEdit(current: string[], edit: OptionEdit): OptionEditResult {
  let list = [...current];
  const renamed: Array<{ from: string; to: string }> = [];
  const touched = new Set<string>();

  const targets = new Set<string>();
  for (const { from, to } of edit.rename ?? []) {
    if (touched.has(from)) return { error: `"${from}" is named twice in the edit.` };
    // A chain or a swap (A to B and B to A) would move values twice, through an order the
    // caller did not mean to depend on. Two calls say it plainly.
    if (targets.has(from) || touched.has(to)) {
      return { error: `"${targets.has(from) ? from : to}" is both renamed and a rename's new name; do it in two calls.` };
    }
    touched.add(from);
    targets.add(to);
    const at = list.indexOf(from);
    if (at < 0) return { error: `"${from}" is not one of this field's options.` };
    if (from === to) continue;
    // A merge keeps the option it lands on where it stands; a plain rename keeps its place.
    if (list.includes(to)) {
      if (!edit.merge) {
        return {
          // "Already an option" only when it was one before this edit: two renames onto
          // one new name meet here too, and the caller never saw that name on the list.
          error: current.includes(to)
            ? `"${to}" is already an option, so renaming "${from}" to it would merge the two: ` +
              `every note holding "${from}" would hold "${to}" instead.`
            : `"${to}" is the new name of more than one rename, which would merge them into one.`,
          merge: true,
        };
      }
      list.splice(at, 1);
    } else list[at] = to;
    renamed.push({ from, to });
  }

  const removed: string[] = [];
  for (const option of edit.remove ?? []) {
    if (touched.has(option)) return { error: `"${option}" is named twice in the edit.` };
    // The notes a rename just moved onto it would be left on a value the list no longer has.
    if (targets.has(option)) return { error: `"${option}" is a rename's new name; it cannot also be removed.` };
    touched.add(option);
    const at = list.indexOf(option);
    if (at < 0) return { error: `"${option}" is not one of this field's options.` };
    list.splice(at, 1);
    removed.push(option);
  }

  const added: string[] = [];
  // Checked whether or not anything turns out to be new, for the reason names are checked
  // at all: a position that could never have applied is a misread the caller should hear.
  if (edit.position !== undefined && !edit.add?.length) {
    return { error: 'A position says where added options go, so it needs options to add.' };
  }
  if (typeof edit.position === 'object' && !list.includes(edit.position.after)) {
    return { error: `"${edit.position.after}" is not one of this field's options.` };
  }
  const fresh = [...new Set(edit.add ?? [])].filter((o) => !list.includes(o));
  if (fresh.length > 0) {
    const position = edit.position ?? 'end';
    if (position === 'end') list.push(...fresh);
    else if (position === 'start') list.unshift(...fresh);
    else if (position === 'alpha') {
      // Into the place the alphabet gives it among the list as it stands, which keeps a
      // sorted list sorted and does not reorder one someone arranged by hand.
      for (const option of fresh) {
        const at = list.findIndex((o) => compareOptions(o, option) > 0);
        if (at < 0) list.push(option);
        else list.splice(at, 0, option);
      }
    } else {
      list.splice(list.indexOf(position.after) + 1, 0, ...fresh);
    }
    added.push(...fresh);
  }
  if (list.length > MAX_SELECT_OPTIONS) {
    return { error: `A field can have at most ${MAX_SELECT_OPTIONS} options.` };
  }

  if (edit.sort === 'alpha') list = [...list].sort(compareOptions);

  const first = edit.pinFirst ?? [];
  const last = edit.pinLast ?? [];
  for (const option of [...first, ...last]) {
    if (!list.includes(option)) return { error: `"${option}" is not one of this field's options.` };
  }
  if (first.some((o) => last.includes(o))) {
    return { error: 'An option cannot be pinned both first and last.' };
  }
  if (first.length > 0 || last.length > 0) {
    // Pins come out in the order they were named, the rest keep theirs between them.
    const pinned = new Set([...first, ...last]);
    list = [...new Set(first), ...list.filter((o) => !pinned.has(o)), ...new Set(last)];
  }

  return { options: list, renamed, removed, added };
}
