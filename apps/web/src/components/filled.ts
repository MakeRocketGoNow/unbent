import type { CSSProperties } from 'react';
import type { AutofillChanges } from '../autofill.js';

/**
 * A mark's place in what an Auto-fill press just wrote, as the stylesheet staggers it:
 * `--filled-i` on the marked element, read by `.filled` and its relatives. Undefined for
 * anything the press did not write, which draws as it always does.
 */
export function filledStyle(at: number | undefined): CSSProperties | undefined {
  return at === undefined ? undefined : ({ '--filled-i': at } as CSSProperties);
}

/**
 * How long one mark takes, start to finish, and how far apart they start. The stylesheet's
 * `.filled` animations are written to these; they are here so the marks can be cleared
 * once the last has faded.
 */
export const FILLED_MS = 2200;
export const FILLED_STAGGER_MS = 70;

/**
 * Where each thing a press wrote falls in the order the marks run: the title, the notebook,
 * each tag it added, then the fields from `fieldsAt`, in the order the list draws them.
 */
export function filledMarks(changes: AutofillChanges) {
  let at = 0;
  const title = changes.title !== undefined ? at++ : undefined;
  const notebook = changes.notebook !== undefined ? at++ : undefined;
  const tags = changes.tags.length > 0 ? { at, names: changes.tags } : undefined;
  at += changes.tags.length;
  const fields = new Set(changes.fields.map((f) => f.def.id));
  return { title, notebook, tags, fields, fieldsAt: at, count: at + fields.size };
}
