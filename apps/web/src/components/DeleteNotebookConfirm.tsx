import { Confirm } from './Confirm.js';

/**
 * The two-option delete a notebook gets, in one place because it is offered from two: the
 * notebook list and the notebook's own page. Both need to say the same thing — a notebook's
 * notes have somewhere to go, so deleting the notebook does not delete them unless you ask —
 * and both need the same emphasis, keeping the notes first so the cascade is reached for
 * deliberately.
 *
 * Nothing is said about custom fields because nothing happens to their values: the
 * definitions go with the notebook, but every value already entered stays on the note that
 * holds it, labelled with this notebook's name. A warning would describe a loss that no
 * longer occurs.
 */
export function DeleteNotebookConfirm({
  name,
  count,
  busy,
  onCancel,
  onConfirm,
}: {
  name: string;
  /** Live notes in the notebook; decides whether the cascade option appears and how it reads. */
  count: number;
  busy: boolean;
  onCancel: () => void;
  /** `trashNotes` is true only for the second, cascade action. */
  onConfirm: (trashNotes: boolean) => void;
}) {
  const noteLabel = count > 0 ? `${count} note${count === 1 ? '' : 's'}` : null;
  return (
    <Confirm
      label="Confirm delete notebook"
      question={
        <>
          Delete the notebook <strong>{name}</strong>?
        </>
      }
      detail={noteLabel ? `Its ${noteLabel} will become unfiled, not deleted.` : 'It has no notes.'}
      busy={busy}
      onCancel={onCancel}
      actions={[
        {
          label: 'Delete notebook',
          busyLabel: 'Deleting…',
          tone: 'danger',
          onConfirm: () => onConfirm(false),
        },
        ...(noteLabel
          ? [
              {
                label: `Delete notebook and move ${noteLabel} to Trash`,
                tone: 'danger' as const,
                onConfirm: () => onConfirm(true),
              },
            ]
          : []),
      ]}
    />
  );
}
