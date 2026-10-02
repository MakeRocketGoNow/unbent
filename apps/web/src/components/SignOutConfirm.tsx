import { Confirm } from './Confirm.js';
import { useUnsyncedQuestion } from '../useSignOut.js';

/**
 * Asks before a sign-out takes changes the server has not heard of.
 *
 * Sign out waits a few seconds for the outbox to drain; what is still waiting after that
 * would go with the wipe, and a console line is nobody's warning. The question is asked
 * here, in the shell, where the failed-sign-out snackbar is, because the menu that was
 * pressed has closed by the time the outbox has had its chance. `Confirm` is inline, not
 * modal, and this is the inline place the whole app has in common: the strip across the
 * bottom where the one-shot answers land. One action, the destructive one, beside the
 * confirm's own Cancel, which is the safe way out: staying signed in is what not leaving
 * means, and a second button saying so would be Cancel under another name.
 */
export function SignOutConfirm() {
  const question = useUnsyncedQuestion();
  if (!question) return null;
  const { count, leave, stay } = question;
  const changes = `${count} change${count === 1 ? '' : 's'}`;
  return (
    <div className="sign-out-confirm">
      <Confirm
        label="Confirm sign out with unsynced changes"
        question={`${changes} ${count === 1 ? "hasn't" : "haven't"} synced yet. Sign out anyway?`}
        detail="Signing out removes them from this device. Staying signed in lets them finish syncing."
        onCancel={stay}
        actions={[{ label: 'Sign out anyway', tone: 'danger', onConfirm: leave }]}
      />
    </div>
  );
}
