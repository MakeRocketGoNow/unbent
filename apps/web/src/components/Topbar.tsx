import { Link } from '@tanstack/react-router';

interface TopbarProps {
  email: string;
  onSignOut: () => void;
}

/**
 * App chrome: title, panel links, export, and sign-out.
 *
 * Notebooks and Import are links rather than toggles now that each has a route, so both
 * survive a reload and can be linked to. `activeProps` marks the current one, and
 * navigating to the same route again is a no-op — closing is what the panel's own Close
 * button does.
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
        <Link to="/settings" className="link" activeProps={{ className: 'link active' }}>
          Notebooks
        </Link>
        <Link to="/import" className="link" activeProps={{ className: 'link active' }}>
          Import
        </Link>
        {/* A plain link, not fetch+blob: the response streams, and letting the browser
            handle it means a large export never lands in a JS buffer. */}
        <a className="link" href="/api/export" download>
          Export
        </a>
        <span className="muted">{email}</span>
        <button type="button" className="link" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </header>
  );
}
