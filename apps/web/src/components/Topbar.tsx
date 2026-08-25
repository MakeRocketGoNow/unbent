import { Link } from '@tanstack/react-router';

interface TopbarProps {
  email: string;
  onSignOut: () => void;
}

/**
 * App chrome: title, settings, and sign-out.
 *
 * Notebooks, Import and Export each used to sit here as their own link, which made the
 * topbar a list of unrelated verbs and still left maintenance without an entry at all.
 * They are all ways of configuring the app, so they live behind one Settings link with a
 * sub-nav of their own. `activeProps` needs no `exact` — prefix matching means every
 * `/settings/*` page marks this active, which is what we want.
 *
 * Trash is deliberately not here. It holds notes, not settings, and belongs beside the
 * note list it is a subset of.
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
          Settings
        </Link>
        <span className="muted">{email}</span>
        <button type="button" className="link" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </header>
  );
}
