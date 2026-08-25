import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { trashCountQuery } from '../queries.js';

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
 * Trash sits here rather than in the notes sidebar. It is a destination — a different
 * view of different records — not a filter over the current list, and in the sidebar's
 * filter stack it both read as one and, once it stopped hiding itself when empty, took up
 * more room than anything else there. A link beside Settings is the same landmark at a
 * tenth of the weight. The count is what stays conditional.
 */
export function Topbar({ email, onSignOut }: TopbarProps) {
  const trashCount = useQuery(trashCountQuery());
  const trashed = trashCount.data ?? 0;

  return (
    <header className="topbar">
      <h1>
        <Link to="/notes" className="plain">
          Unbent
        </Link>
      </h1>
      <div className="account">
        <Link to="/trash" className="link" activeProps={{ className: 'link active' }}>
          Trash
          {trashed > 0 && <span className="tag-count topbar-count">{trashed}</span>}
        </Link>
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
