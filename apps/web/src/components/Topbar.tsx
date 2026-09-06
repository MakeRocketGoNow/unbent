import { Link } from '@tanstack/react-router';
import { AccountMenu } from './AccountMenu.js';

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
 * sidebar floor with the notes it holds — and in the drawer, on a phone.
 *
 * The menu itself is `AccountMenu`, which the phone's drawer also draws. This row is only
 * the wordmark and a place to hang it.
 */
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
          <AccountMenu email={email} onSignOut={onSignOut} />
        </span>
      </div>
    </header>
  );
}
