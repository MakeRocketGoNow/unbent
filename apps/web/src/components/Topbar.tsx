import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { trashCountQuery } from '../queries.js';
import { OverflowMenu } from './OverflowMenu.js';

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
 * On a phone the links collapse behind an avatar. An email address is arbitrarily long —
 * a long one wrapped "Sign out" onto its own line and pushed the whole bar taller — and
 * the address is identification, not a control, so it belongs inside the menu it
 * identifies rather than beside the things you can press.
 *
 * The avatar is drawn locally from the address rather than fetched from Gravatar: this
 * app is otherwise entirely self-hosted, and an avatar is not worth announcing a stable
 * hash of the user's email to a third party on every page load.
 *
 * Trash sits here rather than in the notes sidebar. It is a destination — a different
 * view of different records — not a filter over the current list, and in the sidebar's
 * filter stack it both read as one and, once it stopped hiding itself when empty, took up
 * more room than anything else there. A link beside Settings is the same landmark at a
 * tenth of the weight. The count is what stays conditional.
 */
/** First letter of the address, which is as much as a 1.75rem circle can carry. */
function initialOf(email: string): string {
  return (email.trim()[0] ?? '?').toUpperCase();
}

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
        <Link
          to="/settings"
          className="link desktop-only"
          activeProps={{ className: 'link active desktop-only' }}
        >
          Settings
        </Link>
        <Link
          to="/trash"
          className="link desktop-only"
          activeProps={{ className: 'link active desktop-only' }}
        >
          Trash
          {trashed > 0 && <span className="tag-count topbar-count">{trashed}</span>}
        </Link>
        <span className="muted desktop-only">{email}</span>
        <button type="button" className="link desktop-only" onClick={onSignOut}>
          Sign out
        </button>

        <span className="mobile-only account-menu">
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
              // The address itself, so the menu says which account it belongs to. Not
              // selectable as an action — see `.overflow-email`.
              { label: email, className: 'overflow-email' },
              { label: 'Settings', to: '/settings' },
              {
                label: trashed > 0 ? `Trash (${trashed})` : 'Trash',
                to: '/trash',
              },
              { label: 'Sign out', onSelect: onSignOut, tone: 'danger' },
            ]}
          />
        </span>
      </div>
    </header>
  );
}
