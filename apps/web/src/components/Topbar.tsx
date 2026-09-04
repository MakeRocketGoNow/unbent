import { Link } from '@tanstack/react-router';
import { OverflowMenu } from './OverflowMenu.js';

interface TopbarProps {
  email: string;
  onSignOut: () => void;
}

/**
 * App chrome: the wordmark, and the account menu.
 *
 * Notebooks, Import and Export each used to sit here as their own link, which made the
 * topbar a list of unrelated verbs and still left maintenance without an entry at all.
 * They are all ways of configuring the app, so they live behind one Settings link with a
 * sub-nav of their own.
 *
 * Everything left is account chrome, so at every width it collapses behind an avatar
 * rather than only on a phone. Trash used to sit here too and was the reason the row
 * needed splitting: it is a view of notes, not of the account, and it now lives on the
 * sidebar floor with the notes it holds. What remains — who you are signed in as, how the
 * app is configured, and how to leave — is one coherent menu, so it is one menu at both
 * breakpoints instead of a row of links that had to be duplicated as items and hidden
 * from each other by class.
 *
 * An email address is arbitrarily long — a long one wrapped "Sign out" onto its own line
 * and pushed the whole bar taller — and the address is identification, not a control, so
 * it belongs inside the menu it identifies rather than beside the things you can press.
 *
 * The avatar is drawn locally from the address rather than fetched from Gravatar: this
 * app is otherwise entirely self-hosted, and an avatar is not worth announcing a stable
 * hash of the user's email to a third party on every page load.
 */
/** First letter of the address, which is as much as a 1.75rem circle can carry. */
function initialOf(email: string): string {
  return (email.trim()[0] ?? '?').toUpperCase();
}

export function Topbar({ email, onSignOut }: TopbarProps) {
  return (
    <header className="topbar">
      <h1>
        <Link to="/notes" className="plain">
          Unbent
        </Link>
      </h1>
      <div className="account">
        <span className="account-menu">
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
        </span>
      </div>
    </header>
  );
}
