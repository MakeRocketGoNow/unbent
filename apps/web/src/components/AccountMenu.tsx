import { useQuery } from '@tanstack/react-query';
import { configQuery } from '../queries.js';
import { instanceLine } from '../instance-marker.js';
import { useOffline } from '../connectivity.js';
import { isHosted } from '../app-bridge.js';
import { buildInfo, feedbackUrl, shortCommit, type BuildInfo } from '../build-info.js';
import { OverflowMenu, type OverflowItem } from './OverflowMenu.js';

interface AccountMenuProps {
  email: string;
  onSignOut: () => void;
  /**
   * Draw the address beside the avatar, as a row: the rail's floor, where the trigger
   * has a whole width to itself and an initial in a circle would be an unlabelled dot at
   * the bottom of a column of labelled rows. The head of a topbar or a drawer keeps the
   * avatar alone; there the row has other things in it.
   */
  withAddress?: boolean | undefined;
  /** Which build this page is, for its instance line and feedback link. Tests pass their own. */
  build?: BuildInfo | null;
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
 * Who you are signed in as, and how to leave.
 *
 * One coherent menu behind one avatar, which is why it collapses at every width rather than
 * only on a phone: what it holds is account chrome, not navigation. Trash used to sit here
 * and was the reason the row needed splitting: it is a view of notes, not of the account.
 * Settings went the same way later: it is about the app, not the account, and it has a
 * place of its own at both widths, a row on the floor of the rail and of the drawer,
 * which is where Keep puts it. Leaving it here as well would have been two routes to one
 * page a thumb's width apart.
 *
 * Lifted out of `Topbar` because the phone no longer shows a topbar over the note list: the
 * list has a heading of its own now, and this menu is reached from the drawer's head
 * instead, and on a desktop from the rail's floor. Three callers, one menu, so they cannot
 * come to disagree about what the account can do.
 *
 * The avatar is drawn locally from the address rather than fetched from Gravatar: this app
 * is otherwise entirely self-hosted, and an avatar is not worth announcing a stable hash of
 * the user's email to a third party on every page load.
 */
export function AccountMenu({
  email,
  onSignOut,
  withAddress = false,
  build = buildInfo,
}: AccountMenuProps) {
  const config = useQuery(configQuery());
  const legal = config.data?.legal;
  const instance = config.data
    ? instanceLine(config.data, build ? shortCommit(build) : null)
    : null;
  const signOutNeedsConnection = useOffline() && !isHosted();
  const feedback = build ? feedbackUrl(build) : null;

  return (
    <OverflowMenu
      label={`Account: ${email}`}
      className="overflow-account"
      // As a row it takes the rail's own row class, so it is the same target as the rows
      // above it and the address truncates the way a long notebook name does.
      triggerClassName={withAddress ? 'avatar-trigger drawer-item' : 'avatar-trigger'}
      trigger={
        <>
          <span className="avatar" aria-hidden="true">
            {initialOf(email)}
          </span>
          {withAddress && (
            <span className="drawer-item-label" aria-hidden="true">
              {email}
            </span>
          )}
        </>
      }
      items={[
        // The address itself, so the menu says which account it belongs to. Static
        // rather than selectable: it names the account, it does not act on it. It
        // truncates to one line, so it carries the full address as a tooltip.
        { label: email, className: 'overflow-label overflow-email', static: true, title: email },
        // Which instance this is, when it is not production ("PR 222 · 00619da · notes
        // are its own"), with the build it is running, and on a preview, whose notes an
        // edit here changes. Under the address because it is the same kind of line: it
        // says where you are, it does nothing. Production's build is in Settings › About.
        ...(instance
          ? [
              {
                label: instance,
                className: `overflow-label overflow-instance instance-${config.data?.instanceKind ?? 'mark'}`,
                static: true,
                title: instance,
              },
            ]
          : []),
        { label: null, separator: true },
        // Here as well as in Settings › About because this menu is a click from every
        // view, and "where do I report this?" is asked from the view that broke, not from
        // Settings. GitHub's chooser rather than one form: the person picks bug or
        // request there, with each described. About links the two forms directly, the
        // bug report with the version already filled in.
        ...(feedback ? [{ label: 'Send feedback', external: feedback, newTab: true }] : []),
        // Findable once signed in, which is the half the sign-in screen's own links cannot
        // cover. They are reference, not something to act on, and they sit above Sign out
        // so the destructive item stays last.
        //
        // Absent entirely on an instance that publishes neither, rather than pointing at a
        // page that says there is nothing there: a menu offering Privacy and answering
        // "not published" reads as a broken app rather than an unconfigured one. They are
        // also whichever kind of link this instance needs: the built-in documents are
        // routes, an operator's own are another site.
        ...(legal ? [legalItem('Privacy', legal.privacy), legalItem('Terms', legal.terms)] : []),
        /*
         * With no connection a browser cannot sign anyone out: the session cookie is
         * HttpOnly, so only the server can end it, and a sign-out that only cleared this
         * page would be undone by the next load. Said, rather than pretended. The Android
         * app can (it clears its own cookies when told), so there it stays available.
         */
        signOutNeedsConnection
          ? { label: 'Sign out', tone: 'danger', disabled: true, title: 'Signing out needs a connection' }
          : { label: 'Sign out', onSelect: onSignOut, tone: 'danger' },
      ]}
    />
  );
}
