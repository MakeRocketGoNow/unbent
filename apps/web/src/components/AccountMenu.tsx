import { useQuery } from '@tanstack/react-query';
import { configQuery } from '../queries.js';
import { OverflowMenu, type OverflowItem } from './OverflowMenu.js';

interface AccountMenuProps {
  email: string;
  onSignOut: () => void;
}

/** A legal document as a menu item: a route for the built-in ones, an anchor for the rest. */
function legalItem(label: string, url: string): OverflowItem {
  return url.startsWith('/') ? { label, to: url } : { label, external: url };
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
  const config = useQuery(configQuery());
  const legal = config.data?.legal;

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
        // Findable once signed in, which is the half the sign-in screen's own links cannot
        // cover. They sit below Settings because they are reference, not something to act
        // on, and above Sign out so the destructive item stays last.
        //
        // Absent entirely on an instance that publishes neither, rather than pointing at a
        // page that says there is nothing there — a menu offering Privacy and answering
        // "not published" reads as a broken app rather than an unconfigured one. They are
        // also whichever kind of link this instance needs: the built-in documents are
        // routes, an operator's own are another site.
        ...(legal ? [legalItem('Privacy', legal.privacy), legalItem('Terms', legal.terms)] : []),
        { label: 'Sign out', onSelect: onSignOut, tone: 'danger' },
      ]}
    />
  );
}
