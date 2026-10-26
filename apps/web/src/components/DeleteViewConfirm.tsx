import { Confirm } from './Confirm.js';

/**
 * The delete a saved view gets, in one place because it is offered from two: the open
 * view's own menu above the list, and the notebook's settings page. Both must say the same
 * thing, and what is worth saying is the blast radius, which here is nothing: a view is a
 * way of looking at a notebook, so deleting one leaves every note where it is. Written out
 * twice, the wording would drift the first time one of them was edited.
 */
export function DeleteViewConfirm({
  name,
  busy,
  onCancel,
  onConfirm,
}: {
  name: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Confirm
      label="Confirm delete view"
      question={`Delete the view “${name}”?`}
      detail="Its notes stay where they are."
      busy={busy}
      onCancel={onCancel}
      actions={[{ label: 'Delete view', busyLabel: 'Deleting…', tone: 'danger', onConfirm }]}
    />
  );
}
