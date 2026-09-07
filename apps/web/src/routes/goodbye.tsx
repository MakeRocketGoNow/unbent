import { createFileRoute, Link } from '@tanstack/react-router';

export const Route = createFileRoute('/goodbye')({
  component: GoodbyePage,
});

/**
 * The far end of the account-deletion mail.
 *
 * Outside the signed-in layout for the same reason `/reset-password` is, only more so:
 * there is no session here by construction, because the account it belonged to no longer
 * exists. Without the exemption in `shellFor` this page would redirect to the sign-in
 * screen — which is exactly the ending it was written to replace, since Better Auth's
 * default `callbackURL` of `/` lands on the note list and the gate bounces it onward.
 *
 * Nothing here can fail, so nothing here has a state. The deletion already happened,
 * server-side, before the redirect that rendered this.
 */
function GoodbyePage() {
  return (
    <div className="login">
      <h1>Unbent</h1>
      <p>
        Your account is deleted. Every note, tag and attached file went with it, and
        nothing here can bring them back.
      </p>
      <p className="muted small">
        Signing up again starts an empty account rather than restoring this one.
      </p>
      {/* Navigation, so a link — it can be middle-clicked and copied, and it promises
          nothing a button would. See AGENTS.md on buttons versus links. */}
      <Link to="/login">Go to the sign-in screen</Link>
    </div>
  );
}
