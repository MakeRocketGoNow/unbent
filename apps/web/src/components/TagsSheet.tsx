import type { NoteSummary } from '@unbent/shared';
import { Sheet } from './Sheet.js';
import { TagInput } from './TagInput.js';
import { Button } from './Button';
import { tintIndex } from '../tint.js';

interface TagsSheetProps {
  open: boolean;
  onClose: () => void;
  /** The selected notes, whose tags are what the sheet reports and changes. */
  notes: NoteSummary[];
  /** Every tag, for completions in the field. */
  suggestions: string[];
  busy: boolean;
  /** Applies a change to every selected note at once. */
  onChange: (change: { add?: string[]; remove?: string[] }) => void;
}

/**
 * The selection's tags: what they carry between them, and a field to give them another.
 *
 * Tags are added and taken away rather than set, because the notes need not agree: three
 * notes with three tag lists gain a fourth tag each and keep their own. So the sheet
 * reports each tag the selection carries with how many notes carry it, as Gmail's label
 * menu does: a checked box for a tag on every note, a half-filled one for a tag on some,
 * and pressing either makes the whole selection agree: on for a tag some have, off for
 * a tag all have. Each press writes at once and the sheet stays open, the way the filter
 * sheet applies as it goes, so tidying a selection's tags is one visit rather than a
 * round trip per tag.
 *
 * The field is the note's own tag editor with no chips in it: what it commits is added to
 * every selected note and shows up in the rows below, which is where the chips would have
 * gone. One control for typing a tag, wherever a tag is typed.
 */
export function TagsSheet({ open, onClose, notes, suggestions, busy, onChange }: TagsSheetProps) {
  const total = notes.length;
  const counts = new Map<string, number>();
  for (const note of notes) {
    for (const tag of note.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  // The most shared first, so what the selection has in common heads the list; the name
  // breaks ties, so a long tail of one-note tags is still in a predictable order.
  const rows = [...counts.entries()].sort(
    ([a, an], [b, bn]) => bn - an || a.localeCompare(b, undefined, { sensitivity: 'base' }),
  );

  return (
    <Sheet open={open} onClose={onClose} title={`Tags for ${total} ${total === 1 ? 'note' : 'notes'}`}>
      <div className="tags-sheet">
        <TagInput
          tags={[]}
          suggestions={suggestions}
          onChange={(next) => {
            if (next.length > 0 && !busy) onChange({ add: next });
          }}
        />

        {rows.length === 0 ? (
          <p className="muted small tags-sheet-empty">
            {total === 1 ? 'This note has no tags yet.' : 'These notes have no tags yet.'}
          </p>
        ) : (
          <ul className="tags-sheet-list">
            {rows.map(([name, count]) => {
              const all = count === total;
              return (
                <li key={name}>
                  <label className="tags-sheet-row">
                    <input
                      type="checkbox"
                      checked={all}
                      disabled={busy}
                      ref={(el) => {
                        // Neither checked nor clear: a tag some of the notes carry.
                        if (el) el.indeterminate = !all && count > 0;
                      }}
                      aria-label={
                        all
                          ? `${name}, on every selected note`
                          : `${name}, on ${count} of ${total} selected notes`
                      }
                      onChange={() => onChange(all ? { remove: [name] } : { add: [name] })}
                    />
                    <span className="tag-chip" data-tint={tintIndex(name)}>
                      {name}
                    </span>
                    {!all && (
                      <span className="tag-count">
                        {count} of {total}
                      </span>
                    )}
                  </label>
                </li>
              );
            })}
          </ul>
        )}

        {/* Done, as the filter sheet has it: the way out where a thumb is. */}
        <div className="sheet-foot">
          <Button variant="quiet" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
