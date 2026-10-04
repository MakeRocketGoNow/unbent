import { useMemo, useState } from 'react';
import { diffNote, type DiffPart, type DiffRow } from '../note-diff.js';
import { RowChevronIcon } from './icons.js';

interface NoteText {
  title: string;
  body: string;
}

interface HistoryChangesProps {
  /** The note as it is on screen: the workspace's draft, which the sheet's opening flushed. */
  current: NoteText;
  /** The version Restore would put back. */
  version: NoteText;
}

/**
 * What restoring a version would do to the note, as the History sheet's Changes view
 * (MAK-167).
 *
 * Against the note as it is now, not the version before this one: the page's question is
 * "what will Restore do to my note", and a comparison with the version's predecessor
 * answers how the note got here, which is a different question nobody opens this page
 * with. Text Restore would bring back is added; text it would take out is removed.
 *
 * The Markdown source, in one column. Highlighting the rendered preview was rejected:
 * a mark inside a table's pipes or a link's brackets breaks the rendering it marks, and
 * a file has no "changed" state to draw. Side by side was rejected for width: the sheet
 * is a phone's width on a phone and a narrow panel beside the list, and two columns of
 * source in that are two columns of three-word lines. A code-review renderer
 * (`@pierre/diffs`) was rejected too: it is Shiki and a review tool's look, heavy for a
 * bundle every device keeps offline, and wrong beside a note. jsdiff compares; the
 * drawing is this file's, in the sheet's own type.
 *
 * Not colour alone. Removed text is struck through and added text underlined, each on a
 * tint, and whole lines carry a − or + in the gutter, so the view reads on a monochrome
 * screen and to the commoner colour deficiencies. The sentence at the top says which way
 * round it is, in those same marks.
 */
export function HistoryChanges({ current, version }: HistoryChangesProps) {
  // By value: the caller's objects are new each render, and the comparison is the one
  // costly thing on this page.
  const diff = useMemo(
    () => diffNote({ title: current.title, body: current.body }, { title: version.title, body: version.body }),
    [current.title, current.body, version.title, version.body],
  );

  if (!diff.titleChanged && diff.body === 'same') {
    return <p className="history-diff-note">This version is the same as the note now.</p>;
  }

  return (
    <div className="history-diff">
      <p className="history-diff-legend muted small">
        Restoring this version would add what is <ins>underlined</ins> and remove what is{' '}
        <del>struck through</del>.
      </p>
      {diff.titleChanged && (
        <p className="history-diff-title">
          <span className="muted small">Title</span>{' '}
          <span className="history-diff-text">
            <del>{current.title || 'Untitled'}</del> <span aria-hidden="true">→</span>
            <span className="visually-hidden">becomes</span> <ins>{version.title || 'Untitled'}</ins>
          </span>
        </p>
      )}
      {diff.body === 'same' ? (
        <p className="history-diff-note">The text is the same as the note now.</p>
      ) : diff.body === 'too-different' ? (
        <p className="history-diff-note">This version is too different to compare; see Preview.</p>
      ) : (
        <div className="history-diff-rows">
          {diff.body.map((row, i) => (
            <Row key={i} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}

/** What a screen reader hears before a line, since `ins` and `del` are rarely announced. */
const SPOKEN: Record<'added' | 'removed' | 'changed', string> = {
  added: 'Restore adds: ',
  removed: 'Restore removes: ',
  changed: 'Restore changes: ',
};

/** The gutter's mark. ± for a line that keeps some words and changes others. */
const MARK: Record<'added' | 'removed' | 'changed', string> = { added: '+', removed: '−', changed: '±' };

function Row({ row }: { row: DiffRow }) {
  if (row.kind === 'fold') return <Fold lines={row.lines} />;
  if (row.kind === 'same') return <Same text={row.text} />;
  return (
    <div className={`history-diff-row is-${row.kind}`}>
      <span className="history-diff-mark" aria-hidden="true">
        {MARK[row.kind]}
      </span>
      <span className="history-diff-text">
        <span className="visually-hidden">{SPOKEN[row.kind]}</span>
        {row.parts.map((part, i) => (
          <Part key={i} part={part} />
        ))}
      </span>
    </div>
  );
}

function Same({ text }: { text: string }) {
  return (
    <div className="history-diff-row is-same">
      <span className="history-diff-mark" aria-hidden="true" />
      <span className="history-diff-text">{text}</span>
    </div>
  );
}

function Part({ part }: { part: DiffPart }) {
  if (part.kind === 'added') return <ins>{part.text}</ins>;
  if (part.kind === 'removed') return <del>{part.text}</del>;
  return <>{part.text}</>;
}

/**
 * A stretch of unchanged lines, folded to a row that opens it.
 *
 * A real button, a whole row wide, and it stays where it is when open: the lines appear
 * under it and nothing above moves, and the button that opened them is the one that
 * closes them, so focus is never left on something that has gone. The chevron turns, as
 * a disclosure's does, and `aria-expanded` says the same to a screen reader.
 */
function Fold({ lines }: { lines: string[] }) {
  const [open, setOpen] = useState(false);
  const label = `${lines.length.toLocaleString()} unchanged ${lines.length === 1 ? 'line' : 'lines'}`;
  return (
    <>
      <button type="button" className="history-diff-fold" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <RowChevronIcon />
        {label}
      </button>
      {open && lines.map((text, i) => <Same key={i} text={text} />)}
    </>
  );
}
