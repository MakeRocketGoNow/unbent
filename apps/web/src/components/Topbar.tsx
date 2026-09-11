import { Link } from '@tanstack/react-router';
import { AccountMenu } from './AccountMenu.js';
import { SettingsIcon } from './icons.js';

interface TopbarProps {
  email: string;
  onSignOut: () => void;
}

/**
 * App chrome: the wordmark, the way to Settings, and the account menu.
 *
 * Notebooks, Import and Export each used to sit here as their own link, which made the
 * topbar a list of unrelated verbs and still left maintenance without an entry at all.
 * They are all ways of configuring the app, so they live behind one Settings entry with a
 * sub-nav of their own.
 *
 * That entry is a gear beside the avatar rather than an item inside its menu. The two are
 * different kinds of thing — the gear is about the app, the avatar about the account — and
 * Keep's web app draws exactly this pair in exactly this corner. It also keeps the desktop
 * honest with the phone, where Settings is a row on the drawer's floor: one tap at both
 * widths, never a menu to open first.
 *
 * Trash used to sit here too and was the reason the row needed splitting: it is a view of
 * notes, not of the account, and it now lives on the sidebar floor with the notes it
 * holds — and in the drawer, on a phone.
 *
 * The menu itself is `AccountMenu`, which the phone's drawer also draws. This row is the
 * wordmark and a place to hang the two controls.
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
        {/* A link, not a button: it navigates, and middle-click and copy should work. */}
        <Link to="/settings" className="icon-btn" aria-label="Settings" title="Settings">
          <SettingsIcon />
        </Link>
        <span className="account-menu">
          <AccountMenu email={email} onSignOut={onSignOut} />
        </span>
      </div>
    </header>
  );
}
