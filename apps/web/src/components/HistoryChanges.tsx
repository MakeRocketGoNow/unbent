import { useMemo, useState, type ReactNode } from 'react';
import type { NoteRevision, RevisionSkip } from '@unbent/shared';
import { diffNote, diffProps, type CurrentProps, type DiffPart, type DiffRow, type PropChange, type PropValue } from '../note-diff.js';
import { formatFieldValue } from './format-field.js';
import { RowChevronIcon } from './icons.js';

/** The note as it is on screen: its text, and where it is filed, its tags and its fields. */
export type HistoryCurrent = { title: string; body: string } & CurrentProps;

interface HistoryChangesProps {
  /** The workspace's draft, which the sheet's opening flushed. */
  current: HistoryCurrent;
  /** The version Restore would put back, with what the server says Restore would skip. */
  version: Pick<NoteRevision, 'title' | 'body' | 'props' | 'unfit'>;
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

  /*
     "Same" is the comparison's word, and it reads CRLF as LF and ignores trailing blank
     lines, since nobody can see those. Restore compares exactly: on such a version it
     writes, and offers its Undo. So the page does not call that version the same, which
     would promise that pressing Restore does nothing; it says what the difference is.
  */
  const unseen = diff.body === 'same' && current.body !== version.body;
  const sameText = unseen
    ? 'The text reads the same as the note now; only line endings or blank lines at the end differ.'
    : 'The text is the same as the note now.';

  /*
     The notebook, the tags and the fields (MAK-170), above the body where the note's own
     head has them, each drawn as the title line is. Only what differs, like everything
     on this page. A version from before these were kept has none to compare, and says
     so: silence there would read as "the fields are the same", and they may not be.
  */
  // By value, like the text above: the workspace builds `current` afresh each render.
  const filed = JSON.stringify([current.notebook, current.tags, current.fields]);
  const props = useMemo(
    () => {
      if (!version.props) return [];
      const [notebook, tags, fields] = JSON.parse(filed) as [CurrentProps['notebook'], string[], PropValue[]];
      return diffProps({ notebook, tags, fields }, version.props, version.unfit);
    },
    [filed, version.props, version.unfit],
  );
  const unrecorded = version.props === undefined && (
    <p className="history-diff-note small">
      This version was kept before fields, tags and the notebook were part of one. Restoring it leaves them as they
      are.
    </p>
  );

  if (!diff.titleChanged && diff.body === 'same' && props.length === 0) {
    return (
      <div className="history-diff">
        <p className="history-diff-note">{unseen ? sameText : 'This version is the same as the note now.'}</p>
        {unrecorded}
      </div>
    );
  }

  const marked = diff.titleChanged || Array.isArray(diff.body) || props.some((p) => p.kind !== 'unfit');
  return (
    <div className="history-diff">
      {/* Only over marks it explains: above "too different to compare" alone it described
          an underline and a strike that were nowhere on the page. */}
      {marked && (
        <p className="history-diff-legend muted small">
          Restoring this version would add what is <ins>underlined</ins> and remove what is{' '}
          <del>struck through</del>.
        </p>
      )}
      {(diff.titleChanged || props.length > 0) && (
        /* One list, so the title and the fields share a rhythm and a label column. */
        <dl className="history-props">
          {diff.titleChanged && (
            <PropLine label="Title" className="history-diff-title">
              <Swap from={current.title || 'Untitled'} to={version.title || 'Untitled'} />
            </PropLine>
          )}
          {props.map((change, i) => (
            <PropChangeLine key={i} change={change} />
          ))}
        </dl>
      )}
      {unrecorded}
      {diff.body === 'same' ? (
        <p className="history-diff-note">{sameText}</p>
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

/** A label and its value: one line of the list the title, notebook, tags and fields share. */
export function PropLine({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div className={className ? `history-prop ${className}` : 'history-prop'}>
      <dt className="muted small">{label}</dt>
      <dd className="history-diff-text">{children}</dd>
    </div>
  );
}

/**
 * One value for another, as the title line has always drawn it. A side that is nothing
 * is left out rather than written as a struck-through "None": a value set where there
 * was none is an addition, and reads as one. The words between and before are for a
 * screen reader, which rarely announces `ins` and `del`.
 */
function Swap({ from, to }: { from: string | null; to: string | null }) {
  if (from !== null && to !== null) {
    return (
      <>
        <del>{from}</del> <span aria-hidden="true">→</span>
        <span className="visually-hidden">becomes</span> <ins>{to}</ins>
      </>
    );
  }
  if (to !== null) {
    return (
      <>
        <span className="visually-hidden">added </span>
        <ins>{to}</ins>
      </>
    );
  }
  return (
    <>
      <span className="visually-hidden">removed </span>
      <del>{from}</del>
    </>
  );
}

/** A field's value as the note's own rows draw it: stars, money, Yes and No. */
export const shown = (v: PropValue) => formatFieldValue(v.type, v.value, v.scale, v.currency);

/**
 * Why Restore would leave something as it is, in the words of what happened to it.
 * These are the server's three reasons (`RevisionSkip`), said before the press: the
 * snackbar after a restore says them again, but by then the person has pressed.
 */
export function skipReason(skip: RevisionSkip, held?: string): string {
  if (skip.what === 'notebook') return `“${skip.name}” has been deleted, so the note stays where it is.`;
  if (skip.what === 'tag') return `“${skip.name}” has been deleted, and is not put back.`;
  const value = held === undefined ? 'its value' : `“${held}”`;
  if (skip.why === 'deleted') return `This field has been deleted, so ${value} is not put back.`;
  if (skip.why === 'option') return `This field no longer offers ${value}, so it stays as it is.`;
  return `This field can no longer hold ${value}, so it stays as it is.`;
}

function PropChangeLine({ change }: { change: PropChange }) {
  if (change.kind === 'notebook') {
    // No notebook is "Inbox" everywhere a person reads it; see `FilingRows`.
    return (
      <PropLine label="Notebook">
        <Swap from={change.from ?? 'Inbox'} to={change.to ?? 'Inbox'} />
      </PropLine>
    );
  }
  if (change.kind === 'tags') {
    return (
      <PropLine label="Tags">
        {[
          ...change.same.map((t) => <span key={`s-${t}`}>{t}</span>),
          ...change.removed.map((t) => (
            <del key={`r-${t}`}>
              <span className="visually-hidden">removed </span>
              {t}
            </del>
          )),
          ...change.added.map((t) => (
            <ins key={`a-${t}`}>
              <span className="visually-hidden">added </span>
              {t}
            </ins>
          )),
        ].flatMap((el, i) => (i === 0 ? [el] : [', ', el]))}
      </PropLine>
    );
  }
  if (change.kind === 'field') {
    return (
      <PropLine label={change.name}>
        <Swap from={change.from ? shown(change.from) : null} to={change.to ? shown(change.to) : null} />
      </PropLine>
    );
  }
  const { skip, held, stays } = change;
  const label = skip.what === 'notebook' ? 'Notebook' : skip.what === 'tag' ? 'Tags' : skip.name;
  return (
    <PropLine label={label}>
      <span className="muted">
        {/* The other way round: a value the version never had, which Restore would clear
            if its field still existed. Clearing it could not be undone, so it stays. */}
        {stays
          ? `This field has been deleted, so “${shown(stays)}” stays on the note.`
          : skipReason(skip, held ? shown(held) : undefined)}
      </span>
    </PropLine>
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
          <Part
            key={i}
            part={part}
            abuts={i > 0 && row.parts[i - 1]!.kind !== 'same'}
            spoken={row.kind === 'changed'}
          />
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

/*
   `abuts`: this mark starts where another ended, which is what a replaced word is — its
   old text and its new, back to back. Two numbers so set read as one: 45 for 40 was
   "4540", with only the tints to say where one stopped. The class puts a sliver between
   them, as a margin and not a space, which would be a character the note never had
   sitting among its own. (A copied line is still not the note's source: the words said
   for a screen reader are selected with it.) Said from here and not with `del + ins` in the stylesheet, which matches across the unchanged text
   between two marks as well: a sibling selector does not see text.
*/
function Part({ part, abuts, spoken }: { part: DiffPart; abuts: boolean; spoken: boolean }) {
  const className = abuts ? 'history-diff-abuts' : undefined;
  if (part.kind === 'same') return <>{part.text}</>;
  /*
     `spoken`: on a line that keeps some words, each mark says which it is. The line's own
     "Restore changes:" does not say where the old text stops and the new starts, and a
     screen reader heard 45 for 40 as one number, as the eye did before the gap above.
     Not on a whole line added or removed, whose prefix has already said it.
  */
  const said = spoken && <span className="visually-hidden">{part.kind === 'added' ? 'added ' : 'removed '}</span>;
  if (part.kind === 'added') {
    return (
      <ins className={className}>
        {said}
        {part.text}
      </ins>
    );
  }
  return (
    <del className={className}>
      {said}
      {part.text}
    </del>
  );
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
