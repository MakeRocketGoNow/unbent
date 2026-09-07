import { OverflowMenu } from './OverflowMenu.js';

interface AccountMenuProps {
  email: string;
  onSignOut: () => void;
}

/** First letter of the address, which is as much as a 1.75rem circle can carry. */
function initialOf(email: string): string {
  return (email.trim()[0] ?? '?').toUpperCase();
}

/**
 * Who you are signed in as, how the app is configured, and how to leave.
 *
 * One coherent menu behind one avatar, which is why it collapses at every width rather than
 * only on a phone: what it holds is account chrome, not navigation. Trash used to sit here
 * and was the reason the row needed splitting — it is a view of notes, not of the account.
 *
 * Lifted out of `Topbar` because the phone no longer shows a topbar over the note list: the
 * list has a heading of its own now, and this menu is reached from the drawer's floor
 * instead. Two callers, one menu, so the two cannot come to disagree about what the account
 * can do.
 *
 * The avatar is drawn locally from the address rather than fetched from Gravatar: this app
 * is otherwise entirely self-hosted, and an avatar is not worth announcing a stable hash of
 * the user's email to a third party on every page load.
 */
export function AccountMenu({ email, onSignOut }: AccountMenuProps) {
  return (
    <OverflowMenu
      label={`Account: ${email}`}
      className="overflow-account"
      triggerClassName="avatar-trigger"
      trigger={
        <span className="avatar" aria-hidden="true">
          {initialOf(email)}
        </span>
      }
      items={[
        // The address itself, so the menu says which account it belongs to. Static
        // rather than selectable: it names the account, it does not act on it. It
        // truncates to one line, so it carries the full address as a tooltip.
        { label: email, className: 'overflow-email', static: true, title: email },
        { label: 'Settings', to: '/settings' },
        { label: 'Sign out', onSelect: onSignOut, tone: 'danger' },
      ]}
    />
  );
}
