import type { NoteFieldValue } from '@unbent/shared';
import { formatFieldValue } from './format-field.js';

/**
 * A note's field values, named, on one line: "Amount: $12.00 · Paid: Yes".
 *
 * What a note *is* when its notebook is a collection of records rather than of prose,
 * drawn the same way under a list row and under a card. One component rather than the
 * line written twice, so the two places cannot come to disagree about how a value reads
 * or what separates them. Cut with an ellipsis by its class (`.note-fields-line`): a
 * record's line is unbounded, and the row and the card each give it one line. The whole
 * line is its `title`, the one kind of text that keeps a native tooltip (AGENTS.md,
 * Tooltips): a card is narrow, and what the ellipsis drops is often the value wanted.
 *
 * Nothing at all for a note with no values, rather than an empty line: outside a
 * notebook most notes carry none, and a blank line under each would be rhythm spent on
 * nothing.
 */
export function NoteFieldsLine({ fields }: { fields: NoteFieldValue[] | undefined }) {
  if (!fields || fields.length === 0) return null;
  const line = fields
    .map((f) => `${f.name}: ${formatFieldValue(f.type, f.value, f.scale, f.currency)}`)
    .join(' · ');
  return (
    <span className="note-fields-line" title={line}>
      {line}
    </span>
  );
}
