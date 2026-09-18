import { Link } from '@tanstack/react-router';
import { AccountMenu } from './AccountMenu.js';
import { SettingsIcon } from './icons.js';

interface TopbarProps {
  email: string;
  onSignOut: () => void;
}

/**
 * The phone's chrome, on the pages that have no heading of their own.
 *
 * This was the desktop's chrome too: the wordmark, a gear for Settings and the account
 * menu across the top of every signed-in screen. The navigation rail carries all three
 * now, so above the breakpoint the stylesheet hides this bar, and every screen gets the
 * bar's height back. The reasoning that shaped it — Settings as its own control beside the
 * account rather than inside its menu, Trash leaving for the notes' own navigation —
 * moved to `Rail.tsx` with the controls.
 *
 * Below the breakpoint it still has a job. The notes, a note, Settings and Trash each
 * carry a heading and a way back of their own and hide it (see the phone rules in the
 * stylesheet), but the hand-off pages — connecting another app, consenting to one,
 * signing in a device, relaying a preview sign-in — have no heading, no back arrow and
 * no drawer, and this is the only thing that says which app they belong to and offers a
 * way out. Rejected: deleting it and giving those four pages a small header each, four
 * new headers for flows most people see once.
 *
 * The menu itself is `AccountMenu`, which the drawer and the rail also draw.
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
