import { useEffect, useRef, useState } from 'react';
import { Button } from './Button';
import { ViewNameField } from './ViewName.js';
import { SaveViewIcon } from './icons.js';

/** Why the actions that write a view are faded offline: they are requests, with no queue. */
export const VIEW_NEEDS_CONNECTION = 'Saving a view needs a connection';

interface ViewActionsProps {
  /**
   * What there is to offer. `unsaved`: the list is a notebook narrowed or ordered, with no
   * view open, so it can be saved as one. `edited`: a view is open and the list has
   * wandered from it, so the change can be saved into it, saved as a new view, or undone.
   */
  state: 'unsaved' | 'edited';
  /** The open view's name, for what Save says it will do. Only with `edited`. */
  viewName?: string | undefined;
  offline: boolean;
  /** Saves the list as a new view under `name`, and opens it. Rejects with the reason. */
  onCreate: (name: string) => Promise<void>;
  /** Saves the list into the open view. Rejects with the reason. */
  onSave: () => Promise<void>;
  /** Puts the list back the way the open view keeps it. */
  onRevert: () => void;
  /** Extra class on each piece, for where it sits: the chips row or the filter sheet. */
  className?: string;
}

/**
 * What can be done with the list as a view: the end of the chips row, and on a phone the
 * filter sheet's too.
 *
 * At the end of the chips because that is the neighbourhood of the question. The chips
 * are what narrows the list, so "keep this as a view" belongs beside them, and an edit to
 * a view is a chip added or taken off there, so "Edited" is said beside the chip that
 * made it. Not in the head's row of icons, which is full on a phone and is about how the
 * list is drawn rather than what it is.
 *
 * Every piece is a quiet small button, the density of the chips they follow: these
 * repeat on every list that narrows, and a filled or outlined button here would be the
 * loudest thing on screen for an action taken now and then. The edited group wraps as
 * one, after the chips or on a line under them (see `.view-actions`).
 *
 * Saving names the view in place: the button becomes the field (`ViewNameField`), in the
 * same row, and the row goes back to what it was once the name is saved or abandoned.
 */
export function ViewActions({ state, viewName, offline, onCreate, onSave, onRevert, className }: ViewActionsProps) {
  const [naming, setNaming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cls = (base: string) => [base, className].filter(Boolean).join(' ');
  /*
   * The button that opened the field gets focus back when the field is left without a
   * save: it is a new element by then (the field took its place), and without this the
   * keyboard and a screen reader were dropped on the page's body. A save needs nothing
   * here: the view opens, and the heading takes focus (`NotesLayout`).
   */
  const opener = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (naming || !refocus.current) return;
    refocus.current = false;
    opener.current?.focus();
  }, [naming]);
  const cancel = () => {
    refocus.current = true;
    setNaming(false);
  };

  if (naming) {
    return (
      <ViewNameField
        className={cls('view-actions-name')}
        label={state === 'edited' ? 'Name for the new view' : 'View name'}
        commitLabel="Save"
        onCommit={async (name) => {
          await onCreate(name);
          setNaming(false);
        }}
        onCancel={cancel}
      />
    );
  }

  const tip = offline ? VIEW_NEEDS_CONNECTION : undefined;

  if (state === 'unsaved') {
    return (
      <Button
        ref={opener}
        variant="quiet"
        size="small"
        className={cls('view-action')}
        disabled={offline}
        tip={tip}
        onClick={() => setNaming(true)}
      >
        <SaveViewIcon />
        Save view
      </Button>
    );
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await onSave();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={cls('view-actions')} role="group" aria-label="This view has been edited">
      {/* A word, not a control: the state the three buttons after it are about. */}
      <span className="view-edited">Edited</span>
      <Button
        variant="quiet"
        size="small"
        disabled={offline || saving}
        tip={tip ?? (viewName ? `Keep these changes in “${viewName}”` : undefined)}
        onClick={() => void save()}
      >
        {saving ? 'Saving…' : 'Save'}
      </Button>
      <Button
        ref={opener}
        variant="quiet"
        size="small"
        disabled={offline || saving}
        tip={tip}
        onClick={() => setNaming(true)}
      >
        Save as new
      </Button>
      {/* Not faded offline: it only rewrites the address, which needs nothing of the server. */}
      <Button variant="quiet" size="small" disabled={saving} onClick={onRevert}>
        Revert
      </Button>
      {error && (
        <p className="bad small view-actions-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
